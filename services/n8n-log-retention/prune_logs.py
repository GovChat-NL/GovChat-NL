import os
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


LOG_DIR = Path(os.getenv("N8N_LOG_DIR", "/var/log/n8n"))
LOG_FILE = LOG_DIR / "n8n.log"
def positive_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value >= minimum else default


def prune_once(now: datetime | None = None) -> tuple[int, bool]:
    now = now or datetime.now(timezone.utc)
    retention_days = positive_int("N8N_LOG_RETENTION_DAYS", 30)
    cutoff = now - timedelta(days=retention_days)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    rotation_marker = LOG_DIR / ".govchat-last-n8n-log-rotation"

    removed = 0
    for candidate in LOG_DIR.iterdir():
        if not candidate.is_file() or not candidate.name.startswith("n8n.log") or candidate == LOG_FILE:
            continue
        if datetime.fromtimestamp(candidate.stat().st_mtime, timezone.utc) <= cutoff:
            candidate.unlink(missing_ok=True)
            removed += 1

    if not LOG_FILE.is_file() or LOG_FILE.stat().st_size == 0:
        if not rotation_marker.exists():
            rotation_marker.write_text(str(now.timestamp()), encoding="ascii")
        return removed, False

    interval = positive_int("N8N_LOG_PRUNE_INTERVAL_SECONDS", 3600, minimum=60)
    try:
        previous_rotation = float(rotation_marker.read_text(encoding="ascii").strip())
    except (OSError, ValueError):
        previous_rotation = 0
    previous_active_mtime = LOG_FILE.stat().st_mtime
    rotation_gap = now.timestamp() - previous_rotation

    # If the pruner was absent for more than two intervals, active-file contents
    # may span the retention boundary. Drop them rather than restart their TTL.
    if (
        previous_rotation <= 0
        or rotation_gap > interval * 2
        or previous_active_mtime <= cutoff.timestamp()
    ):
        with LOG_FILE.open("r+b") as active:
            active.truncate(0)
        rotation_marker.write_text(str(now.timestamp()), encoding="ascii")
        return removed, False

    # Mark a segment as beginning one interval ago. This errs slightly early,
    # never retaining a log segment longer than the configured age.
    bucket_start = now - timedelta(seconds=interval)
    archive_stamp = now.strftime("%Y%m%dT%H%M%SZ")
    archive = LOG_DIR / f"n8n.log-{archive_stamp}.log"
    if archive.exists():
        archive = LOG_DIR / f"n8n.log-{archive_stamp}-{time.time_ns()}.log"

    shutil.copyfile(LOG_FILE, archive)
    os.chmod(archive, 0o600)
    try:
        os.chown(archive, 1000, 1000)
    except PermissionError:
        pass
    os.utime(archive, (bucket_start.timestamp(), bucket_start.timestamp()))

    # n8n keeps the active file open, so truncate in place rather than rename it.
    with LOG_FILE.open("r+b") as active:
        active.truncate(0)
    rotation_marker.write_text(str(now.timestamp()), encoding="ascii")
    return removed, True


def main() -> None:
    interval = positive_int("N8N_LOG_PRUNE_INTERVAL_SECONDS", 3600, minimum=60)
    while True:
        try:
            removed, rotated = prune_once()
            if removed or rotated:
                print(
                    f"[n8n-log-retention] rotated={rotated} removed={removed} retention_days={positive_int('N8N_LOG_RETENTION_DAYS', 30)}",
                    flush=True,
                )
        except Exception as error:  # Log only a scrubbed error message; never file contents.
            print(f"[n8n-log-retention] cleanup failed: {type(error).__name__}", file=sys.stderr, flush=True)
        time.sleep(interval)


if __name__ == "__main__":
    main()
