import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "n8n-log-retention"))
import prune_logs


class N8nLogRetentionTests(unittest.TestCase):
    def test_rotation_truncates_active_log_and_removes_expired_archives(self):
        now = datetime(2026, 10, 30, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as temp_dir:
            log_dir = Path(temp_dir)
            active_log = log_dir / "n8n.log"
            active_log.write_text("ERROR confidential diagnostic\n", encoding="utf-8")
            old_archive = log_dir / "n8n.log-20260928T000000Z.log"
            old_archive.write_text("old log\n", encoding="utf-8")
            recent_archive = log_dir / "n8n.log.1"
            recent_archive.write_text("recent rotated log\n", encoding="utf-8")
            unrelated = log_dir / "other.log"
            unrelated.write_text("keep\n", encoding="utf-8")
            old_stamp = (now - timedelta(days=31)).timestamp()
            os.utime(old_archive, (old_stamp, old_stamp))
            os.utime(recent_archive, ((now - timedelta(days=2)).timestamp(),) * 2)
            active_stamp = (now - timedelta(minutes=5)).timestamp()
            os.utime(active_log, (active_stamp, active_stamp))
            (log_dir / ".govchat-last-n8n-log-rotation").write_text(
                str((now - timedelta(hours=1)).timestamp()), encoding="ascii"
            )

            with patch.object(prune_logs, "LOG_DIR", log_dir), patch.object(
                prune_logs, "LOG_FILE", active_log
            ), patch.dict(
                os.environ,
                {"N8N_LOG_RETENTION_DAYS": "30", "N8N_LOG_PRUNE_INTERVAL_SECONDS": "3600"},
            ):
                removed, rotated = prune_logs.prune_once(now)

            self.assertEqual(removed, 1)
            self.assertTrue(rotated)
            self.assertEqual(active_log.read_text(encoding="utf-8"), "")
            self.assertFalse(old_archive.exists())
            self.assertTrue(recent_archive.exists())
            self.assertTrue(unrelated.exists())
            archives = [entry for entry in log_dir.iterdir() if entry.name.startswith("n8n.log-")]
            self.assertEqual(len(archives), 1)
            self.assertEqual(archives[0].read_text(encoding="utf-8"), "ERROR confidential diagnostic\n")

    def test_stale_active_file_is_deleted_instead_of_refreshing_its_retention(self):
        now = datetime(2026, 10, 30, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as temp_dir:
            log_dir = Path(temp_dir)
            active_log = log_dir / "n8n.log"
            active_log.write_text("stale log\n", encoding="utf-8")
            old_stamp = (now - timedelta(days=31)).timestamp()
            os.utime(active_log, (old_stamp, old_stamp))
            with patch.object(prune_logs, "LOG_DIR", log_dir), patch.object(
                prune_logs, "LOG_FILE", active_log
            ), patch.dict(os.environ, {"N8N_LOG_RETENTION_DAYS": "30"}):
                _, rotated = prune_logs.prune_once(now)
            self.assertFalse(rotated)
            self.assertEqual(active_log.read_text(encoding="utf-8"), "")
            self.assertEqual(list(log_dir.glob("n8n.log-*.log")), [])


if __name__ == "__main__":
    unittest.main()
