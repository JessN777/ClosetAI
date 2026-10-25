"""Tiny health/metrics surface for the Next.js demo status proxy."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI
from health import moss_health

load_dotenv(Path(__file__).with_name(".env"))
app = FastAPI(docs_url=None, redoc_url=None)
metrics_file = Path(os.getenv("MOSS_METRICS_PATH", Path(__file__).with_name(".data") / "metrics.json"))
deployment_file = Path(os.getenv("MOSS_DEPLOYMENT_STATUS_PATH", Path(__file__).with_name(".data") / "deployment.json"))


@app.get("/health")
def health() -> dict[str, object]:
    return moss_health(deployment_path=deployment_file)


@app.get("/metrics")
async def metrics() -> dict[str, Any]:
    if not metrics_file.exists():
        return {"latest_latency_ms": None}
    try:
        data = json.loads(metrics_file.read_text(encoding="utf-8"))
        latency = data.get("latest_latency_ms") if isinstance(data, dict) else None
        return {"latest_latency_ms": latency if isinstance(latency, (int, float)) else None}
    except (OSError, json.JSONDecodeError):
        return {"latest_latency_ms": None}
