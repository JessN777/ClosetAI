"""ClosetAI LiveKit worker, deployable and hosted through Moss."""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from livekit.agents import Agent, AgentServer, JobContext, cli
from mossClient import moss_client
from tools import FUNCTION_TOOLS, load_preferences

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(message)s")
logger = logging.getLogger("closetai.agent")

SYSTEM_PROMPT = """You are ClosetAI, a warm, concise personal closet stylist. Help the user find pieces they own, suggest outfits, start virtual try-ons, search for products, remember style preferences, and emulate named styles with dress_like. Use shop_the_look for a named look or event outfit: it checks the closet first, returns cited piece details and retailer listings, and only prepares a wishlist; it never buys. Use search_closet and suggest_outfit against the current closet inventory. dress_like builds its profile from public text sources only, never face recognition or photos, and returns closet matches. The user may choose a match for try-on using only their own photo. Use start_tryon only when a photo and garment are available; report the returned job ID as queued, never as completed. search_shopping only prepares product results and never buys. Save preferences only when the user explicitly asks. Never claim an action succeeded unless its tool returns success. Ask before any purchase or external sharing; there are no purchase tools."""

server = AgentServer()


def session_userdata(ctx: JobContext) -> dict[str, Any]:
    try:
        raw = ctx.room.metadata
        value = json.loads(raw) if raw else {}
        return value if isinstance(value, dict) else {}
    except (json.JSONDecodeError, AttributeError, TypeError):
        return {}


@server.rtc_session()
async def closet_agent(ctx: JobContext) -> None:
    userdata = session_userdata(ctx)
    user_id = str(userdata.get("user_id", ""))
    userdata["preferences"] = await load_preferences(user_id)
    personalized_prompt = f"{SYSTEM_PROMPT}\nCurrent user's saved preferences (apply on every turn): {json.dumps(userdata['preferences'], ensure_ascii=True)}"
    agent = Agent(instructions=personalized_prompt)
    userdata["agent"] = agent
    userdata["base_prompt"] = SYSTEM_PROMPT
    session = moss_client.create_session(userdata=userdata, function_tools=FUNCTION_TOOLS)
    try:
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


def deploy() -> None:
    moss_client.deploy(SYSTEM_PROMPT, FUNCTION_TOOLS)
    logger.info(json.dumps({"event": "moss_agent_deploy_complete", "agent_id": os.getenv("MOSS_VOICE_AGENT_ID", "")[:8]}))


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "deploy":
    if os.getenv("DEMO_OFFLINE") == "1":
        logger.info(json.dumps({"event": "moss_deploy_skipped", "reason": "offline_demo"}))
    else:
        deploy()
elif __name__ == "__main__" and os.getenv("DEMO_OFFLINE") == "1":
    logger.info(json.dumps({"event": "moss_agent_skipped", "reason": "offline_demo"}))
else:
    cli.run_app(server)
