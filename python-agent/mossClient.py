"""The only module that imports the Moss voice SDK."""

from __future__ import annotations

import importlib
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger("closetai.moss")


class _SecretRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = moss_client.safe_error_message(record.getMessage())
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        return True


class MossClient:
    """Small adapter around moss-voice-agent-manager's public client/session APIs."""

    def __init__(self) -> None:
        self._sdk: Any | None = None

    def _load(self) -> Any:
        if self._sdk is None:
            self._sdk = importlib.import_module("moss_voice_agent_manager")
        return self._sdk

    def configured(self) -> bool:
        return not self.missing_configuration()

    def missing_configuration(self) -> list[str]:
        return [name for name in ("MOSS_PROJECT_ID", "MOSS_PROJECT_KEY", "MOSS_VOICE_AGENT_ID") if not os.getenv(name, "").strip()]

    def install_log_redaction(self) -> None:
        root = logging.getLogger()
        filter_instance = next((item for item in root.filters if isinstance(item, _SecretRedactionFilter)), None)
        if filter_instance is None:
            filter_instance = _SecretRedactionFilter()
            root.addFilter(filter_instance)
        for handler in root.handlers:
            if not any(isinstance(item, _SecretRedactionFilter) for item in handler.filters):
                handler.addFilter(filter_instance)

    @staticmethod
    def safe_error_message(error: BaseException) -> str:
        message = str(error) or type(error).__name__
        for name in ("MOSS_PROJECT_KEY", "MOSS_PROJECT_ID", "MOSS_VOICE_AGENT_ID"):
            secret = os.getenv(name, "").strip()
            if secret:
                message = message.replace(secret, "[redacted]")
        message = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[redacted]", message)
        message = re.sub(r"(?i)(moss[_-]?(?:project[_-]?key|api[_-]?key)\s*[:=]\s*)[^\s,;]+", r"\1[redacted]", message)
        return message[:500]

    def deploy(self, prompt: str, function_tools: list[Callable[..., Any]]) -> Any:
        if not self.configured():
            missing = ", ".join(self.missing_configuration())
            raise RuntimeError(f"Missing required Moss environment variables: {missing}.")
        sdk = self._load()
        client_type = getattr(sdk, "MossVoiceClient", None)
        if client_type is None:
            raise RuntimeError("The installed moss-voice-agent-manager package does not expose MossVoiceClient.")
        client = client_type()
        result = client.deploy(
            voice_agent_id=os.environ["MOSS_VOICE_AGENT_ID"],
            prompt=prompt,
            initial_greeting="Hi, I'm your ClosetAI stylist. What are you looking for today?",
            function_tools=function_tools,
        )
        status_file = Path(os.getenv("MOSS_DEPLOYMENT_STATUS_PATH", Path(__file__).with_name(".data") / "deployment.json"))
        status_file.parent.mkdir(parents=True, exist_ok=True)
        temp = status_file.with_suffix(".tmp")
        temp.write_text(json.dumps({"deployed": True, "agent_id_prefix": os.environ["MOSS_VOICE_AGENT_ID"][:8]}), encoding="utf-8")
        temp.replace(status_file)
        return result

    def create_session(self, *, userdata: dict[str, Any], function_tools: list[Callable[..., Any]]) -> Any:
        sdk = self._load()
        session_type = getattr(sdk, "MossAgentSession")
        # This SDK version exposes tools on the LiveKit Agent, not on its
        # MossAgentSession constructor. The adapter keeps the callsite stable.
        return session_type(userdata=userdata, max_tool_steps=8)

    @staticmethod
    def _json_safe(value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, dict):
            return {str(key): MossClient._json_safe(item) for key, item in value.items()}
        if isinstance(value, (tuple, list)):
            return [MossClient._json_safe(item) for item in value]
        for method in ("model_dump", "to_dict", "dict"):
            serializer = getattr(value, method, None)
            if callable(serializer):
                try:
                    return MossClient._json_safe(serializer())
                except Exception:
                    pass
        return str(value)

    def save_session_diagnostics(self, session: Any) -> dict[str, Any]:
        """Persist a compact, non-sensitive snapshot for the demo status endpoint."""
        payload = {
            "metrics": self._json_safe(getattr(session, "metrics", None)),
            "diagnostics": self._json_safe(getattr(session, "diagnostics", None)),
        }
        latency = self._find_latency(payload)
        if latency is not None:
            payload["latest_latency_ms"] = latency
        destination = Path(os.getenv("MOSS_METRICS_PATH", Path(__file__).with_name(".data") / "metrics.json"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
        temp.replace(destination)
        try:
            session.save_metrics()
        except Exception as exc:  # Metrics must never break the voice session.
            logger.warning(json.dumps({"event": "moss_metrics_save_failed", "error_type": type(exc).__name__}))
        return payload

    @staticmethod
    def _find_latency(payload: dict[str, Any]) -> float | None:
        keys = ("latency_ms", "end_to_end_latency_ms", "total_latency_ms", "turn_latency_ms")
        pending = [payload]
        while pending:
            value = pending.pop()
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in keys and isinstance(item, (int, float)) and 0 <= item < 120_000:
                        return float(item)
                    if isinstance(item, (dict, list)):
                        pending.append(item)
            elif isinstance(value, list):
                pending.extend(value)
        return None

    def diagnostics_report(self, session: Any) -> str:
        try:
            return str(session.generate_diagnostics_report())
        except Exception as exc:
            return f"Diagnostics unavailable ({type(exc).__name__})."


moss_client = MossClient()
