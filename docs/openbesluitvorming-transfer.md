# Portable OpenBesluitvorming transfer and server runbook

## Scope and safety boundary

This runbook is for the one-shot Python worker, **not** the retired n8n ingestion
pipeline or the old public release/test-data restore. It transfers one Limburg
run and its collection, including refresh history. It does not export MongoDB,
LiteLLM databases, n8n, other collections, credentials or private branding.

The host orchestrator is [the transfer utility](../scripts/openbesluitvorming-transfer.py).
It uses Python's standard library and Docker CLI on either Windows or Linux.
The actual state/Qdrant operations run in a Linux helper as UID/GID 10001 with no
capabilities, no environment-secret forwarding, read-only scripts/root filesystem,
and the **explicitly selected Qdrant container's network namespace**. Loopback is
used inside that namespace: there is no guessed Compose hostname or exposed API.
This narrow utility does not support API-key-protected Qdrant; adapt/review secure
credential injection separately rather than putting keys in command arguments.

**Operator preconditions:** administratively stop all source writers (including
any point backfill script, other worker sharing state, and external Qdrant writes).
The source worker container must already be stopped. The utility never stops or
starts it. Its actual named `/state` volume is discovered from container mounts;
bind mounts and multiple runs in one state database are deliberately refused.

The helper acquires the same global `worker.lock` kernel flock as the worker and
holds it across read-only SQLite backup, native Qdrant snapshot creation/download,
and completion of the state archive. A running mutation command holding that lock
is refused, even if the selected source container itself is stopped. The lock is
not merely a PID or stale-file check. All other writers must obey this protocol
or be stopped: there is no distributed lock against arbitrary Qdrant clients.

SQLite uses a read-only connection's backup API, not a raw database file copy.
Committed WAL contents are included in the standalone backup; WAL/SHM files are
not archived. All regular state files, including vector history and other lockfiles,
are preserved. Symlinks, links/devices in archives, secret-looking names, environment
files and n8n-related state are refused. Do not place secrets anywhere in worker
state; filename checks cannot detect secrets embedded in otherwise public records.

Code is a Git archive of **exact committed HEAD**, not a working-tree copy. Tracked
changes are refused; the utility and this guide must be committed first. Ignored
exports are allowed. Root environment files, local deployment overrides, private
branding, private overlay data and local test-data payloads are excluded. The
utility never commits. The parent/operator must test, review and commit these new
files **before export**, otherwise code cannot reproduce the exporter/importer.

## Host/Compose matrix (no assumed server OS)

| Host | Docker engine | Python/Compose | Paths and permissions |
| --- | --- | --- | --- |
| Windows workstation or server | Docker Desktop or another supported Linux-container engine | Python 3.12+; Docker Compose v2 | Use PowerShell/cmd, Windows bind paths handled as argument arrays; ensure Docker drive sharing and UID10001 write access to the output bind. Windows containers are not supported. |
| Linux workstation or server | Linux Docker engine | Python 3.12+; Docker Compose v2 | Operator prepares UID10001-writable state/output; use a POSIX shell and Linux bind paths. No automatic root chown is performed. |

Commands below are one line each and run from the GovChat repository root. On
Linux use `python3` if that is the available executable. PowerShell uses its own
environment-assignment syntax, not POSIX `export`; cmd uses `set`. No server OS,
SSH account, destination address or existing deployment project is inferred.

## Tests before the parent commits/exports

Offline synthetic transfer coverage (no Docker/network/source data):

```text
python -B -m unittest discover -s tests/agents -p test_openbesluitvorming_transfer.py -v
node --test tests/agents/openbesluitvorming-transfer-monitor.test.js
```

Run the same command on Linux to exercise flock/WAL backup and staged publication
tests, which skip on Windows. An optional isolated Linux Python container runs all
offline tests without mounting real state or granting network access:

```text
docker run --rm --network none --user 10001:10001 --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --mount type=bind,src=REPOSITORY_ABSOLUTE_PATH,dst=/repo,readonly python:3.12-slim python -B -m unittest discover -s /repo/tests/agents -p test_openbesluitvorming_transfer.py -v
```

Replace the single absolute path argument for the host; use a quoted argument when
it contains spaces. These tests make only tiny synthetic files in ephemeral `/tmp`.

Parent regression commands (77 ingest/refresh cases and the existing 7 monitor cases):

```text
python -B -m unittest discover -s tests/agents -p test_openbesluitvorming_ingest.py -v
python -B -m unittest discover -s tests/agents -p test_openbesluitvorming_refresh.py -v
node --test tests/agents/openbesluitvorming-progress.test.js
```

Optional **explicitly approved**, synthetic full native-snapshot/state Docker smoke:

```text
python -B scripts/openbesluitvorming-transfer-smoke.py --approve-isolated-docker-smoke --output exports/state-import-smoke
```

Pre-create that empty output directory with UID10001 write access. This script
starts only a randomly named disposable Qdrant 1.16.2 with network isolation,
seeds one synthetic 3072-dimensional Cosine point and downloads a native snapshot.
It mounts the repository read-only at `/repo`, calls only `worker.connect` to create
a tiny fixture SQLite schema, and uses SQLite backup for the standalone archive.
The fixture checkpoint uses collection `limburg_synthetic_restored`, source
`provincie_limburg`, and the exact seeded point's record/run/ID. It includes a
document-history row, compressed vector history and lockfiles, actual schema
metadata and artifact hashes. Its code archive is clearly labeled **synthetic
placeholders, not executable deployment code or committed HEAD**; never deploy it.

It calls the real `import_state` dry-run and proves target state/collections are
untouched, then runs real staged and final native Qdrant restores and state
publication. It checks both collections' counts/schema/full checkpoint hashes,
SQLite metadata/counts/bytes, history file counts/bytes and live worker-lock
preservation, and proves repeat dry-run/import refuses nonempty state without
changing it. A concise success summary is printed. The native snapshot remains at
the output root; fixture source state, bundle and target have separate subpaths.
It stops only its own disposable container. No actual named volumes are created
or mounted; no source state is mounted, source worker started, real records exported,
or volumes pruned. Keep this opt-in: it is not part of offline tests.

## Source export (parent only, after commit)

Prepare an empty output directory or allow the utility to create one. On Windows,
Docker Desktop commonly makes the output bind writable by UID10001; verify drive
sharing. On Linux the creator's default directory mode normally does **not** let
UID10001 write. For example, an operator may create the directory and grant a
narrow ACL (where supported):

```text
mkdir -p exports/limburg-transfer
setfacl -m u:10001:rwx exports/limburg-transfer
```

The utility accepts an existing **empty** directory, so this permission preparation
does not require a root helper or automatic recursive ownership changes. The host
operator also needs write access. Do not broadly change permissions on source
volumes. If permissions fail, no ownership repair is attempted. A partial output
directory is retained; inspect it before removing/retrying with a new empty path.

Actual source run and container names from the existing monitor:

```text
python -B scripts/openbesluitvorming-transfer.py export --source-container govchat-obv-full-run --qdrant-container librechat-qdrant --run-id limburg-full-20261111 --output exports/limburg-transfer
python -B scripts/openbesluitvorming-transfer.py validate --bundle exports/limburg-transfer
```

There is intentionally **no collection flag**: the collection comes from this run's
SQLite checkpoint. There are no source deletes, requeues, retry/refresh calls,
alias switches or workers scheduled. Native snapshots created on the source are
left intact, including on failure. Make sufficient disk space available for the
bundle and standalone SQLite backup; backup staging is disk-backed under output,
not a multi-gigabyte in-memory buffer.

The exporter uses Qdrant's native snapshot creation endpoint, then streams the
returned snapshot name over **internal loopback HTTP in the selected Qdrant
container's namespace**, in bounded chunks. It does not use `docker cp`, guess a
host-visible snapshot file, or expose a public API. The manifest records the native
name and the stock image's source-native path
`/qdrant/snapshots/<collection>/<returned-name>` (explicitly labeled as the default;
confirm `storage.snapshots_path` if customized), plus the actual transport. If doing
a separately reviewed manual `docker cp`, use the actual returned name and confirmed
container snapshot directory, not the bundle filename `dataset.snapshot` as a
source path. Such manual copying is not required by this utility.

The bundle has exactly six regular files:

* [manifest.json](../exports/limburg-transfer/manifest.json): format, actual schema metadata,
  SQL fingerprint and actual user version (currently **0**, not an invented migration
  number), table/status counts, source/run/model alias, refresh generation/phase/audit,
  Git commit/date, UTC export timestamp, source stopped status/exit code/finished
  time (no environment dump), native snapshot identity/transport, Qdrant
  version/count/schema and deterministic checkpoint samples.
* [code.tar.gz](../exports/limburg-transfer/code.tar.gz): sanitized tracked HEAD archive.
* [dataset.snapshot](../exports/limburg-transfer/dataset.snapshot): one native Qdrant collection snapshot.
* [ingest-state.tar.gz](../exports/limburg-transfer/ingest-state.tar.gz): standalone SQLite and regular history/state files.
* [README.md](../exports/limburg-transfer/README.md): dynamic run/collection, completeness,
  embedding alias/model/dimensions, point/checkpoint/status counts, code commit and export time.
* [server-guide.md](../exports/limburg-transfer/server-guide.md): this guide.

Every payload artifact has SHA256 and byte length in the manifest. The manifest
cannot hash itself. Hashes provide corruption detection, **not authenticity**;
send the manifest digest separately over a trusted channel or sign it separately.
Inspect the Git commit and trust the producer before running transferred code.

The embedding mapping is declared by the operator: the stored LiteLLM alias
(normally `govchat-embedding`) maps to Azure **text-embedding-3-large**, 3072
dimensions. An alias is not an immutable model/deployment identity. The utility
cannot prove what underlying Azure deployment generated historical vectors without
provider evidence. The server must use its **own** credentials and a deployment
matching that underlying model and dimensions; a matching alias string alone is
insufficient for future refresh or query embeddings.

Actual exact point count must equal checkpoint `has_vector` and `indexed`. A source
snapshot can be exhausted while ingestion remains incomplete. In particular,
**203 dead-letter documents imply `complete: false`** and must remain explicit;
the exporter does not fabricate success, retry them, or drop their history. This
narrow exporter refuses unsettled pending/processing/retry queues and has-vector
versus indexed mismatches. Finish/settle an active refresh before portable export.
All existing phases/generations and retained-missing audit outcomes are recorded.

## Copy, but do not deploy credentials

Use SCP over SSH, or WinSCP with verified host keys, to transfer the **bundle only**
to an operator-selected private directory on the target. For example, after
replacing the account, host and destination yourself:

```text
scp -r exports/limburg-transfer operator@target.example:/operator-selected-private-directory/
```

No upload is performed by either script. Do not include the workstation environment
file, Windows local Compose override or organization-private branding. Use a
separately provisioned target environment and secure provider credentials. Code
extraction does not supply those files; configure them on the server yourself.
The conservative archive exclusion currently also omits `.env.example`. Obtain a
separately reviewed **original example from the recorded commit** via a trusted
checkout/channel, inspect it for placeholders, and use it only as a checklist for
the target's independently provisioned `.env`. Never copy the source `.env` or
`root.env`, and never assume archive extraction bootstraps provider credentials.

## Target deployment, empty-volume setup and restore

Choose an explicit Compose project such as `govchat-obv-target`. Use the tracked
[base Compose file](../docker-compose.yml), **not** the workstation's Windows
local override. A reviewed production override is optional and must be passed
explicitly to every Compose command and importer resolution call. The base file
already pins Qdrant **1.16.2**, the safest compatible version; the importer requires
exact runtime equality on both source and target, not just a compatible major.
The base file has fixed dependency container names (for example
`librechat-qdrant`): a different project name alone does **not** avoid name/port
collisions on the same Docker engine. Use a separate target engine, or explicitly
review target-specific dependency names/ports in the production override. Never
resolve a collision by stopping/removing a source container.

Provision the target's own environment file and configure target-specific data
root, LiteLLM provider mapping and bind mounts. Base Compose uses a configurable
data root with a Linux-looking default; on Windows choose a Docker-shared Windows
directory explicitly. Do not assume that default exists or is appropriate. Supply
all environment settings required by the base file, even though only named services
will start. Do not print rendered Compose configuration because it can expose secrets.

A reviewed production override may change deployment paths, attachment budget,
worker count and approved target LiteLLM configuration, but must not change the
Qdrant version, dimensions, state-volume identity or add an ingestion scheduler.
Pass it as another explicit file; never rely on automatically loaded local overrides.

First validate the bundle **offline** from a trusted, reviewed utility checkout
(not code first extracted from an untrusted bundle). Verify producer authenticity
and the recorded commit separately. This standard-library one-liner loads that
reviewed utility with importlib and uses its `check_archive` to validate every code
member before manual regular-file extraction. It creates a **new empty**
`./restored-code`; an existing directory is refused, not merged. Do not use a
general-purpose untar command before validation. No extraction CLI is necessary.

```text
python -B scripts/openbesluitvorming-transfer.py validate --bundle exports/limburg-transfer
python -B -c "import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('reviewed_transfer', 'scripts/openbesluitvorming-transfer.py'); t=importlib.util.module_from_spec(s); s.loader.exec_module(t); d=Path('restored-code'); d.mkdir(); t.check_archive(Path('exports/limburg-transfer/code.tar.gz'), 'code', d)"
cd restored-code
```

Now provision the target's own environment and any required excluded local-config
replacement from the reviewed original example as described above. Subsequent
commands run **inside restored-code**; the bundle remains in the sibling trusted
checkout's `exports/limburg-transfer` directory, hence the explicit `../` paths.
If the target bundle is elsewhere, use its actual absolute path instead.

```text
docker compose -p govchat-obv-target -f docker-compose.yml build openbesluitvorming-ingest
docker compose -p govchat-obv-target -f docker-compose.yml up -d qdrant
docker compose -p govchat-obv-target -f docker-compose.yml create --no-deps openbesluitvorming-ingest
```

The last command creates, but **does not start**, the worker container. Its image
has a UID10001-owned empty state directory which Docker uses to populate the new
named volume. This is preferable to silently chowning an existing volume. Confirm
the target state is genuinely empty and writable by UID10001. If an existing
volume is incorrectly owned, an operator must repair/provision it explicitly;
the utility never becomes root. Existing files, **including a stale worker lock**,
are refused before import. Do not start even a status command against empty target
state before import: the worker initializes schema/lockfiles and makes it nonempty.

The default target state volume is
`<compose-project>_openbesluitvorming-ingest-state`. The utility inspects it and
refuses a missing volume rather than creating one silently. For external/custom
names, pass `--state-volume` explicitly after reviewing the Compose mount. The
actual running `qdrant` service container ID is resolved via the **explicit project
and file list**, or use `--qdrant-container` explicitly. No hostname is inferred.

```text
python -B scripts/openbesluitvorming-transfer.py import --bundle ../exports/limburg-transfer --compose-project govchat-obv-target -f docker-compose.yml --dry-run
python -B scripts/openbesluitvorming-transfer.py import --bundle ../exports/limburg-transfer --compose-project govchat-obv-target -f docker-compose.yml
```

With a production override, append `-f docker-compose.production.yml` to both
import commands and every Compose command. The importer supports repeated file
arguments. The override filename here is an operator-created example, not bundled
configuration. Explicit container/volume alternative:

```text
python -B scripts/openbesluitvorming-transfer.py import --bundle ../exports/limburg-transfer --compose-project govchat-obv-target -f docker-compose.yml --qdrant-container TARGET_QDRANT_CONTAINER_ID --state-volume TARGET_STATE_VOLUME --dry-run
```

Dry-run verifies bundle hashes/lengths, archive safety, SQLite integrity/schema/run
counts, exact target Qdrant version, collection absence and empty target volume.
It makes **no target writes**, does not acquire/create a target lockfile, restore
a snapshot or pretend that offline tar inspection proves native snapshot semantics.

Real import refuses running containers sharing target state. It first acquires the
global lock on the initially empty volume and stages/validates state on disk inside
that volume. It then atomically reserves a randomly named staging collection and
uploads the snapshot via streamed multipart with a known content length, bounded
1 MiB chunks (not a 2 GB in-memory upload). Qdrant natively validates/restores it.
Exact count, 3072/Cosine configuration, payload indexes and deterministic sample
IDs/full point hashes are checked against checkpoint records and the manifest.
Only after both staged artifacts pass does import atomically reserve the final
absent collection, upload the snapshot there, verify it again, and publish state.
Native upload uses snapshot priority only for the utility's own empty reservations,
never an existing operator collection. Keep all target writers administratively
stopped throughout: nobody may mutate utility reservations concurrently.

The live target worker-lock inode is **never replaced** with the archived lockfile;
all other checkpoint/history lockfiles are restored normally. State publication
uses same-volume moves under that live lock. Filesystem + Qdrant cannot be one
atomic transaction: final snapshot or state publication failures leave diagnostic
collections and/or staged/partial state intact. No automatic delete, overwrite,
rollback, alias change or volume prune happens. The successful diagnostic staging
collection is retained too (allow roughly two collections' storage until manual review).

### Partial failure / retry policy

Keep the fixed diagnostic identifiers printed by import: staging collection, final
collection and state staging directory. Errors deliberately omit response bodies,
credentials and arbitrary Docker stderr. A failed reservation/upload may leave an
empty or partially restored collection; do not interpret its existence as success.

Stop target writers, inspect the retained state and collections privately, and
decide on operator-controlled recovery. Re-running import into that now nonempty
volume or an existing collection is refused. A stale lock is not an active kernel
lock, but still counts as nonempty for initial import; do not blindly unlink a lock
while a worker could hold its inode. Prefer a **new empty volume/project** and absent
collection after investigating failure, or perform separately reviewed manual
recovery/cleanup. Never run `docker compose down -v` or volume-prune to resolve this.

## Verify first, then explicitly authorize future refresh

Once import reports success, start only the dependencies needed for verification
and future ingestion; no daemon/scheduler is introduced:

```text
docker compose -p govchat-obv-target -f docker-compose.yml up -d qdrant litellm tika
docker compose -p govchat-obv-target -f docker-compose.yml run --rm --no-deps openbesluitvorming-ingest verify --run-id limburg-full-20261111 --sample-size 10
docker compose -p govchat-obv-target -f docker-compose.yml run --rm --no-deps openbesluitvorming-ingest status --run-id limburg-full-20261111
```

LiteLLM's own required PostgreSQL dependency can start through Compose. No unrelated
services or profile-wide ingestion jobs are requested. Compare counts, collection,
sample verification, completeness/dead-letter count and refresh checkpoint to the
manifest before exposing search. No alias is switched automatically. Query smoke
with the worker's optional query flag uses target provider credentials and is a
separate operator-approved action, not part of import.

The worker's actual approval flag is **`--approve-full-run`**, not `--approve`.
Only after the operator approves source API traffic and verifies the target model:

```text
docker compose -p govchat-obv-target -f docker-compose.yml run --rm --no-deps openbesluitvorming-ingest refresh --run-id limburg-full-20261111 --approve-full-run
docker compose -p govchat-obv-target -f docker-compose.yml run -d --no-deps --name govchat-obv-target-run openbesluitvorming-ingest run --run-id limburg-full-20261111 --max-documents 0 --max-pages 0 --page-size 100 --workers 2 --approve-full-run
node scripts/openbesluitvorming-progress.js --container govchat-obv-target-run --run-id limburg-full-20261111
node scripts/openbesluitvorming-progress.js logs --container govchat-obv-target-run --run-id limburg-full-20261111
```

Use one constant operator-chosen container name for the long-running one-shot job
and monitor; the monitor also accepts an actual container ID. Its original source
defaults remain unchanged, so **always pass target arguments** on the target.
Do not use `--rm` for the named run container (including a future source run): its
stopped identity, mounts, exit status and logs must remain inspectable for export.
Do not remove it until checkpoint/log review is complete. To resume **the identical
recorded command** after confirming it is stopped and no other writer is active:

```text
docker start govchat-obv-target-run
```

This restarts the same one-shot command; it does not change flags or start refresh
automatically. To change its command/budget, first review logs/checkpoint and
confirm the named container is stopped, then remove **only that completed target
container** with `docker rm govchat-obv-target-run` (no `-v`) and deliberately issue
the named Compose run command again. Never schedule overlapping writers, remove
the source export container, or recreate volumes to reuse a container name.

A completed source-page snapshot with dead letters can start an explicit refresh
if the prior queue is settled; dead letters are not silently requeued. The optional
size-failure retry-once refresh flag requires an operator-approved increased
attachment budget; consult [the ingestion guide](openbesluitvorming-ingestion.md).
No transfer command calls refresh, retry, run or fresh on either source or target.
