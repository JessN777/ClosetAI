"""The /health route handler reports missing credentials without exposing values."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from service import health  # noqa: E402


class HealthRouteTests(unittest.TestCase):
    def test_health_reports_missing_moss_project_key(self) -> None:
        values = {
            "MOSS_PROJECT_ID": "test-project",
            "MOSS_PROJECT_KEY": "",
            "MOSS_VOICE_AGENT_ID": "test-agent-id",
        }
        with patch.dict(os.environ, values, clear=False):
            response = health()

        self.assertEqual(response["reason"], "missing_moss_project_key")
        self.assertFalse(response["credentials_present"])
        self.assertNotIn("test-project", str(response))
        self.assertNotIn("test-agent-id", str(response))


if __name__ == "__main__":
    unittest.main()
