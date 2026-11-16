"""Offline checks for the side-by-side Linux worker deployment and instructions."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ExistingServerRunbookTests(unittest.TestCase):
    def test_standalone_project_cannot_replace_existing_govchat_services(self):
        text = (ROOT / 'docker-compose.openbesluitvorming-worker.yml').read_text(encoding='utf-8')
        services = text.split('services:\n', 1)[1].split('\nnetworks:', 1)[0]
        names = set(re.findall(r'^  ([a-zA-Z0-9_-]+):$', services, re.M))
        self.assertEqual(names, {'openbesluitvorming-ingest', 'obv-ingest-tika'})
        self.assertNotRegex(text, re.compile(r'^\s+container_name:', re.M))
        self.assertNotRegex(text, re.compile(r'^\s+ports:', re.M))
        self.assertIn('external: true', text)
        self.assertIn('OBV_DOCKER_NETWORK:?', text)
        self.assertIn('OBV_QDRANT_URL:?', text)
        self.assertIn('mem_limit: 2g', text)
        self.assertIn('OBV_ATTACHMENT_MAX_BYTES: "268435456"', text)

    def test_instructions_create_but_do_not_start_empty_worker_before_import(self):
        guide = (ROOT / 'docs/openbesluitvorming-server-existing-linux.md').read_text(encoding='utf-8')
        preparation = guide.split('## 6.', 1)[1].split('## 9.', 1)[0]
        self.assertIn('create --no-deps openbesluitvorming-ingest', preparation)
        self.assertNotIn('obvcompose run ', preparation)
        self.assertIn('--dry-run', preparation)
        self.assertIn('--qdrant-container "$OBV_QDRANT_CONTAINER"', preparation)
        self.assertIn('--state-volume "$OBV_STATE_VOLUME"', preparation)
        self.assertLess(guide.index('## 9.'), guide.index('refresh --run-id'))
        self.assertIn('set -e', guide)
        self.assertIn("STOP: doelvolume bestaat al'; false;", preparation)

    def test_server_run_commands_have_positive_bounds_and_approval(self):
        guide = (ROOT / 'docs/openbesluitvorming-server-existing-linux.md').read_text(encoding='utf-8')
        runs = [line for line in guide.splitlines() if '--max-documents' in line]
        self.assertTrue(runs)
        for line in runs:
            match = re.search(r'--max-documents (\d+) --max-pages (\d+)', line)
            self.assertIsNotNone(match)
            self.assertGreater(int(match[1]), 0)
            self.assertGreater(int(match[2]), 0)
            self.assertIn('--approve-full-run', line)
        self.assertIn('--container govchat-obv-server-run', guide)


if __name__ == '__main__':
    unittest.main()
