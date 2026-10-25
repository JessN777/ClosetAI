"""ClosetAI LiveKit worker, deployable and hosted through Moss."""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from uuid import uuid4
from typing import Any

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from mossClient import moss_client

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(message)s")
logger = logging.getLogger("closetai.agent")
moss_client.install_log_redaction()

SYSTEM_PROMPT = """You are ClosetAI, a warm, concise personal closet stylist. Help the user find pieces they own, suggest outfits, start virtual try-ons, search for products, remember style preferences, and emulate named styles with dress_like. Use shop_the_look for a named look or event outfit: it checks the closet first, returns cited piece details and retailer listings, and only prepares a wishlist; it never buys. Use search_closet and suggest_outfit against the current closet inventory. dress_like builds its profile from public text sources only, never face recognition or photos, and returns closet matches. The user may choose a match for try-on using only their own photo. Use start_tryon only when a photo and garment are available; report the returned job ID as queued, never as completed. search_shopping only prepares product results and never buys. Save preferences only when the user explicitly asks. Never claim an action succeeded unless its tool returns success. Ask before any purchase or external sharing; there are no purchase tools."""

def session_userdata(room: Any) -> dict[str, Any]:
    candidates = [getattr(room, "metadata", None)]
    participants = getattr(room, "remote_participants", {})
    if isinstance(participants, dict):
        candidates.extend(getattr(participant, "metadata", None) for participant in participants.values())
    for raw in candidates:
        try:
            value = json.loads(raw) if raw else {}
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(value, dict) and value.get("user_id"):
            return value
    return {}


def run_worker() -> None:
    from livekit.agents import Agent, AgentServer, JobContext, cli
    from tools import FUNCTION_TOOLS, load_preferences

    server = AgentServer()

    @server.rtc_session()
    async def closet_agent(ctx: JobContext) -> None:
        userdata = session_userdata(ctx.room)
        user_id = str(userdata.get("user_id", ""))
        userdata["preferences"] = await load_preferences(user_id)
        personalized_prompt = f"{SYSTEM_PROMPT}\nCurrent user's saved preferences (apply on every turn): {json.dumps(userdata['preferences'], ensure_ascii=True)}"
        agent = Agent(instructions=personalized_prompt, tools=FUNCTION_TOOLS)
        userdata["agent"] = agent
        userdata["base_prompt"] = SYSTEM_PROMPT
        session = moss_client.create_session(userdata=userdata, function_tools=FUNCTION_TOOLS)
        try:
            current_turn: dict[str, Any] | None = None

            def start_turn() -> None:
                nonlocal current_turn
                current_turn = {"turn_id": str(uuid4()), "started": time.perf_counter(), "tool_calls": set()}

            def on_conversation_item(event: Any) -> None:
                nonlocal current_turn
                item = getattr(event, "item", None)
                role = getattr(item, "role", None)
                if role == "user":
                    start_turn()
                    return
                if role != "assistant" or current_turn is None:
                    return
                # Tool-call messages can also have the assistant role; only close
                # the turn once there is user-facing text to report.
                text = getattr(item, "text_content", None) or getattr(item, "raw_text_content", None)
                if not text:
                    return
                latency_ms = max(0, round((time.perf_counter() - current_turn["started"]) * 1000))
                metrics = getattr(item, "metrics", None)
                if metrics is not None:
                    raw_latency = getattr(metrics, "end_to_end_latency", None) or getattr(metrics, "latency_ms", None)
                    if isinstance(raw_latency, (int, float)) and 0 <= raw_latency < 120:
                        latency_ms = round(raw_latency * 1000)
                logger.info(json.dumps({
                    "event": "closet_voice_turn",
                    "turn_id": current_turn["turn_id"],
                    "tool_calls": sorted(current_turn["tool_calls"]),
                    "latency_ms": latency_ms,
                }, separators=(",", ":")))
                current_turn = None

            def on_tools_executed(event: Any) -> None:
                if current_turn is None:
                    return
                allowed = {"search_closet", "suggest_outfit", "start_tryon", "search_shopping", "remember_preference", "dress_like", "shop_the_look"}
                for call in getattr(event, "function_calls", []) or []:
                    name = getattr(call, "name", None)
                    if name in allowed:
                        current_turn["tool_calls"].add(name)

            session.on("conversation_item_added", on_conversation_item)
            session.on("function_tools_executed", on_tools_executed)

            def on_close(*_: Any) -> None:
                try:
                    payload = moss_client.save_session_diagnostics(session)
                    logger.info(json.dumps({"event": "closet_voice_session_metrics", "latest_latency_ms": payload.get("latest_latency_ms")}))
                    report = moss_client.diagnostics_report(session)
                    logger.info(json.dumps({"event": "closet_voice_diagnostics", "available": bool(report), "report_characters": len(report)}))
                except Exception as exc:
                    logger.warning(json.dumps({"event": "closet_voice_metrics_unavailable", "error_type": type(exc).__name__}))

            session.on("close", on_close)
            await session.start(agent=agent, room=ctx.room)
            logger.info(json.dumps({"event": "closet_voice_session_started", "agent_id": os.getenv("MOSS_VOICE_AGENT_ID", "")[:8]}))
        except Exception as exc:
            logger.error(json.dumps({"event": "closet_voice_session_failed", "error_type": type(exc).__name__}))
            raise

    cli.run_app(server)


def deploy() -> None:
    if not moss_client.configured():
        missing = ", ".join(moss_client.missing_configuration())
        raise RuntimeError(f"Missing required Moss environment variables: {missing}.")
    from tools import FUNCTION_TOOLS

    moss_client.deploy(SYSTEM_PROMPT, FUNCTION_TOOLS)
    logger.info(json.dumps({"event": "moss_agent_deploy_complete", "agent_id": os.getenv("MOSS_VOICE_AGENT_ID", "")[:8]}))


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "deploy":
    if os.getenv("DEMO_OFFLINE") == "1":
        logger.info(json.dumps({"event": "moss_deploy_skipped", "reason": "offline_demo"}))
    else:
        try:
            deploy()
        except Exception as exc:
            logger.error(json.dumps({"event": "moss_agent_deploy_failed", "error": moss_client.safe_error_message(exc)}))
            sys.exit(1)
elif __name__ == "__main__" and os.getenv("DEMO_OFFLINE") == "1":
    logger.info(json.dumps({"event": "moss_agent_skipped", "reason": "offline_demo"}))
else:
    run_worker()
