import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from health import moss_health


class MossHealthTests(unittest.TestCase):
    def test_health_reports_the_first_missing_credential_without_values(self):
        response = moss_health(
            {"MOSS_PROJECT_ID": "", "MOSS_PROJECT_KEY": "", "MOSS_VOICE_AGENT_ID": ""},
            Path("missing-deployment-status.json"),
        )

        self.assertEqual(response["status"], "offline")
        self.assertEqual(response["reason"], "missing_moss_project_id")
        self.assertFalse(response["credentials_present"])
        self.assertFalse(response["agent_deployed"])
        self.assertNotIn("MOSS_PROJECT_KEY", response)

    def test_health_reports_missing_project_key_specifically(self):
        response = moss_health(
            {"MOSS_PROJECT_ID": "present", "MOSS_PROJECT_KEY": "", "MOSS_VOICE_AGENT_ID": "present"},
            Path("missing-deployment-status.json"),
        )
        self.assertEqual(response["reason"], "missing_moss_project_key")

    def test_health_reports_not_deployed_when_status_is_missing(self):
        response = moss_health(
            {"MOSS_PROJECT_ID": "present", "MOSS_PROJECT_KEY": "present", "MOSS_VOICE_AGENT_ID": "12345678-agent"},
            Path("missing-deployment-status.json"),
        )
        self.assertEqual(response["reason"], "not_deployed")
        self.assertTrue(response["credentials_present"])
        self.assertFalse(response["agent_deployed"])
        self.assertEqual(response["agent_id_prefix"], "12345678")


if __name__ == "__main__":
    unittest.main()
