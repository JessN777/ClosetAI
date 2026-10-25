"""Credential-safe Moss readiness checks shared by the health endpoint and tests."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping

REQUIRED_MOSS_VARS = ("MOSS_PROJECT_ID", "MOSS_PROJECT_KEY", "MOSS_VOICE_AGENT_ID")


def moss_health(
    env: Mapping[str, str] | None = None,
    deployment_path: Path | None = None,
) -> dict[str, object]:
    values = os.environ if env is None else env
    missing = next((name.lower() for name in REQUIRED_MOSS_VARS if not values.get(name, "").strip()), None)
    agent_id = values.get("MOSS_VOICE_AGENT_ID", "").strip()
    prefix = agent_id[:8] if agent_id else None
    if missing:
        return {
            "status": "offline",
            "reason": f"missing_{missing}",
            "credentials_present": False,
            "agent_deployed": False,
            "agent_id_prefix": prefix,
        }

    path = deployment_path or Path(os.getenv("MOSS_DEPLOYMENT_STATUS_PATH", Path(__file__).with_name(".data") / "deployment.json"))
    try:
        deployment = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        deployment = None
    deployed = bool(
        isinstance(deployment, dict)
        and deployment.get("deployed") is True
        and deployment.get("agent_id_prefix") == prefix
    )
    return {
        "status": "ok" if deployed else "offline",
        "reason": None if deployed else "not_deployed",
        "credentials_present": True,
        "agent_deployed": deployed,
        "agent_id_prefix": prefix,
    }
