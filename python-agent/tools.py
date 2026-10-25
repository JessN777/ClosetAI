"""LiveKit function tools. Moss credentials never enter this module."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from livekit.agents import RunContext, function_tool


NEXT_API_BASE = os.getenv("CLOSETAI_API_URL", "http://localhost:3000").rstrip("/")
TOOL_SECRET = os.getenv("VOICE_TOOLS_SHARED_SECRET", "")


def _userdata(ctx: RunContext[Any]) -> dict[str, Any]:
    data = getattr(ctx, "userdata", None)
    return data if isinstance(data, dict) else {}


async def _call_tool(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    if os.getenv("DEMO_OFFLINE") == "1":
        raise RuntimeError("Offline demo uses the browser's bundled tool cache.")
    if not TOOL_SECRET:
        raise RuntimeError("Voice tools are not configured.")
    async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
        response = await client.post(
            f"{NEXT_API_BASE}/api/voice-tools/{path}",
            json=payload,
            headers={"x-closetai-agent-secret": TOOL_SECRET},
        )
    if not response.is_success:
        raise RuntimeError("Closet service is temporarily unavailable.")
    return response.json()


@function_tool()
async def search_closet(ctx: RunContext[Any], query: str) -> str:
    """Search the user's current closet inventory by item, category, or color."""
    items = _userdata(ctx).get("closet_items", [])
    result = await _call_tool("closet/search", {"query": query[:120], "items": items if isinstance(items, list) else []})
    matches = result.get("matches", [])
    return json.dumps({"matches": matches[:12], "count": len(matches)})


@function_tool()
async def suggest_outfit(ctx: RunContext[Any], occasion: str = "everyday") -> str:
    """Suggest a look for an occasion using pieces from the user's closet."""
    data = _userdata(ctx)
    items = data.get("closet_items", [])
    result = await _call_tool("closet/suggest", {"occasion": occasion[:100], "styleNotes": data.get("style_notes", ""), "preferences": data.get("preferences", {}), "items": items if isinstance(items, list) else []})
    return json.dumps(result)


@function_tool()
async def start_tryon(ctx: RunContext[Any], garment_id: str = "") -> str:
    """Start a high-quality try-on using the user's current photo and selected closet garment; return its job ID."""
    data = _userdata(ctx)
    photo_data_url = data.get("photo_data_url", "")
    garment_data_url = data.get("garment_data_url", "")
    if not photo_data_url or not garment_data_url:
        return "I need the current person photo and a selected garment from the browser to start that try-on."
    result = await _call_tool("tryon", {"garmentId": garment_id[:100], "photoDataUrl": photo_data_url, "garmentDataUrl": garment_data_url})
    if not result.get("jobId"):
        return str(result.get("error", "Try-on could not be started."))
    if result.get("status") == "succeeded":
        # The POST response is not enough to announce readiness. Confirm the
        # committed record through the public read-after-write status endpoint.
        job_id = str(result["jobId"])
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                status = await client.get(f"{NEXT_API_BASE}/api/tryon/{job_id}")
            if status.is_success:
                committed = status.json()
                if committed.get("status") == "succeeded" and committed.get("resultUrl"):
                    return json.dumps({"jobId": job_id, "status": "succeeded", "resultUrl": committed["resultUrl"]})
        except (httpx.HTTPError, ValueError):
            pass
        return json.dumps({"jobId": job_id, "status": "queued"})
    return json.dumps({"jobId": result["jobId"], "status": result.get("status", "queued")})


@function_tool()
async def search_shopping(ctx: RunContext[Any], query: str = "I'm looking for this shirt") -> str:
    """Prepare product search results for an item. This tool never purchases anything."""
    data = _userdata(ctx)
    items = data.get("closet_items", [])
    result = await _call_tool("shopping/search", {"query": query[:160] or "I'm looking for this shirt", "preferences": data.get("preferences", {}), "items": items if isinstance(items, list) else []})
    return json.dumps(result)


@function_tool()
async def remember_preference(ctx: RunContext[Any], category: str, value: str) -> str:
    """Save a user-approved style preference to the persistent preferences store."""
    user_id = str(_userdata(ctx).get("user_id", ""))
    if not user_id:
        return "I can't save that preference until your ClosetAI profile is connected."
    result = await _call_tool("preferences", {"userId": user_id, "category": category, "value": value[:160]})
    profile = result.get("profile", {})
    data = _userdata(ctx)
    data["preferences"] = profile
    agent = data.get("agent")
    if agent is not None:
        base_prompt = str(data.get("base_prompt", "You are ClosetAI, a helpful stylist."))
        await agent.update_instructions(f"{base_prompt}\nCurrent user preferences (refresh after every update): {json.dumps(profile, ensure_ascii=True)}")
    return f"Saved {category}: {result.get('saved', value)}."


@function_tool()
async def dress_like(ctx: RunContext[Any], look_name: str) -> str:
    """Build a sourced text-only style profile and return closet matches, close matches, and shopping gaps."""
    data = _userdata(ctx)
    items = data.get("closet_items", [])
    result = await _call_tool("style/dress-like", {"lookName": look_name[:100], "items": items if isinstance(items, list) else []})
    if result.get("error"):
        return str(result["error"])
    return json.dumps({"summary": result.get("summary", "Style profile ready."), "profile": result.get("profile", {}), "matches": result.get("matches", {})}, ensure_ascii=True)


@function_tool()
async def shop_the_look(ctx: RunContext[Any], look_name: str, occasion: str = "") -> str:
    """Prepare cited outfit pieces, closet matches, and retailer alternatives; never purchase anything."""
    data = _userdata(ctx)
    user_id = str(data.get("user_id", ""))
    items = data.get("closet_items", [])
    result = await _call_tool("shop/the-look", {"lookName": look_name[:100], "occasion": occasion[:120], "userId": user_id, "items": items if isinstance(items, list) else [], "preferences": data.get("preferences", {})})
    if result.get("error"):
        return str(result["error"])
    return str(result.get("summary", "The outfit list is ready. Nothing was purchased."))


async def load_preferences(user_id: str) -> dict[str, Any]:
    if os.getenv("DEMO_OFFLINE") == "1":
        return {"favoriteColors": [], "fit": ["relaxed"], "occasions": ["everyday"], "budget": {"currency": "USD", "max": 120}, "sizes": {"top": "M"}, "version": 0}
    if not user_id:
        return {"favoriteColors": [], "fit": [], "occasions": [], "budget": {"currency": "USD"}, "sizes": {}, "version": 0}
    try:
        response = await _call_tool("preferences", {"userId": user_id})
        profile = response.get("profile")
        return profile if isinstance(profile, dict) else {}
    except Exception:
        return {"favoriteColors": [], "fit": [], "occasions": [], "budget": {"currency": "USD"}, "sizes": {}, "version": 0}


FUNCTION_TOOLS = [search_closet, suggest_outfit, start_tryon, search_shopping, remember_preference, dress_like, shop_the_look]
