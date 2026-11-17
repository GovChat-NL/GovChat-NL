import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SecurityHardeningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.nginx = (ROOT / "nginx/librechat-overlay.conf").read_text(encoding="utf-8")
        cls.compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        cls.admin = (ROOT / "services/admin-overlay/admin/server.js").read_text(encoding="utf-8")
        workflow_doc = json.loads(
            (ROOT / "agents/n8n/workflows/algemeen/image-generator-litellm.json").read_text(encoding="utf-8")
        )
        cls.workflow = workflow_doc[0] if isinstance(workflow_doc, list) else workflow_doc
        cls.workflow_nodes = {node["name"]: node for node in cls.workflow["nodes"]}

    def test_image_delivery_is_owner_authorized_and_legacy_paths_are_denied(self):
        self.assertIn("auth_request /_internal/image-auth", self.nginx)
        self.assertIn("location /images/ {\n    return 404;", self.nginx)
        self.assertIn('req.get("x-image-owner")', self.admin)
        self.assertIn("user.id !== owner", self.admin)
        self.assertNotIn("$http_referer", self.nginx)

    def test_image_jobs_require_verified_user_and_owner_scoped_polling(self):
        self.assertNotIn("IMAGE_JOBS_TOKEN", self.admin)
        self.assertIn("resolveUserFromVerifiedRefreshToken(req)", self.admin)
        self.assertIn("job.user_id !== req.librechatUser.id", self.admin)
        self.assertIn("activeUserJobs >= 2", self.admin)
        self.assertIn("req.get(\"origin\")", self.admin)

    def test_workflow_authenticates_and_writes_only_to_user_directory(self):
        prepare = self.workflow_nodes["Prepare Image Request"]["parameters"]["jsCode"]
        response = self.workflow_nodes["Build Image Response"]["parameters"]["jsCode"]
        self.assertIn("crypto.timingSafeEqual", prepare)
        self.assertIn("Authenticated user context is missing", prepare)
        self.assertIn("events.length >= 6", prepare)
        self.assertIn("createHash('sha256').update(ownerId)", prepare)
        self.assertIn("path.resolve(root, userId)", response)
        self.assertIn("image.subarray(0, 8).equals", response)
        self.assertIn("image[0] === 0xff", response)
        self.assertIn("/images/' + encodeURIComponent(userId) + '/'", response)
        self.assertIn("ownsLock = true", prepare)
        self.assertIn("if (ownsLock)", prepare)

    def test_n8n_editor_is_not_host_published_and_admin_is_loopback_only(self):
        n8n_match = re.search(r"(?ms)^  n8n:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)", self.compose)
        self.assertIsNotNone(n8n_match)
        self.assertNotRegex(n8n_match.group(1), r"(?m)^    ports:")
        admin_match = re.search(r"(?ms)^  govchat-overlay-admin:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)", self.compose)
        self.assertIsNotNone(admin_match)
        self.assertIn('"127.0.0.1:${GOVCHAT_OVERLAY_ADMIN_PORT:-3002}:3002"', admin_match.group(1))
        self.assertIn('"127.0.0.1:${LITELLM_PORT:-4000}:4000"', self.compose)
        self.assertIn('"127.0.0.1:${ADMIN_PANEL_PORT:-3100}:3000"', self.compose)


if __name__ == "__main__":
    unittest.main()
