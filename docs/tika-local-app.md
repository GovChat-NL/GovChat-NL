# Retained local Tika UI

## Current local availability

The standalone local application is available at **http://127.0.0.1:3099**.
It uses the operator-approved existing local GovChat bridge, not a synthetic model
mock. Existing Docling UI/services and unrelated stacks were not recreated or stopped.

The new [local Compose](../docker-compose.tika-local-app.yml) owns its app, MongoDB,
upload parser and extractor. MongoDB, original uploads and images use dedicated named
volumes. App signing/encryption keys and generated configuration are independent and
retained in the ignored local output directory. Only the bridge bearer credential was
connected with explicit operator permission; no SSO, production DB or webhook credentials
were copied. The bridge workflow and real model calls can produce their normal execution
records/costs; use synthetic/non-sensitive documents until acceptance is complete.

**Do not run disposable-validation cleanup against this retained project.** Do not delete
its volumes, regenerate its keys/configuration or prune shared Docker state. After real
local records exist, treating this UI as disposable would lose data.

## Manual login and test

A separate local test user was provisioned through LibreChat's installed upstream
account helper, without changing any existing user. Open the ignored local
`.tika-upload-local/app/manual-account.json` file in the editor to obtain its email and
password. These values were not printed, committed or included in test images. Log in
at the URL above and choose **GovChat Orchestrator**.

1. Upload a small synthetic PDF or DOCX through the usual attachment control.
2. Ask a document-specific question whose answer is not present in the prompt.
3. Reload the conversation and ask a second question without uploading again.
4. Try a normal text question, then an image question in a new conversation.

The first automated probes exhausted the normal signup/login attempt windows. The
limits were not disabled, enlarged or cleared. Automated test accounts are now retained
privately for reuse; the manual user is separate. If a legitimate login is rate-limited,
wait the standard five-minute login window rather than repeatedly retrying. Signup uses
the standard five-attempt/hour window. No Microsoft/Entra account is impersonated in this
independent email-login UI; Entra-only tools require their real, separately reviewed auth.

The operator subsequently reported successful manual local testing. This is recorded as
user feedback alongside the automated checks, not as exhaustive corpus/release acceptance.

## Local verification actually completed

- Ready app, independent Mongo/extractor/parser and approved bridge/model availability.
- Actual DOCX upload, actual stored-text preview and rejection of the same preview to
  a second authenticated test account.
- A newly generated random document code reached the actual bridge/model; no extracted
  text was supplied by the chat client. A subsequent turn used the prior conversation
  without reupload, and a fresh login still retrieved the original stored text.
- Headless Chromium performed normal UI login, file upload, document chat, page reload,
  follow-up chat, an ordinary arithmetic question and a native-provider image question
  successfully. The synthetic image answer was stored and exactly correct.
- An additional real local API probe uploaded a newly generated image-only PDF with
  an independently verified empty text layer. Its random code was present in actual
  stored OCR text and the real model answer, without client-supplied extracted text.
- The original warm-client/installed-handler proof remains three complete 53-case
  workloads plus eight preload/handler tests per cycle. It is separate from the local
  browser proof, which currently uses small synthetic DOCX documents.
- The extended Python suite passed **87 tests**, with the same upstream test-client
  deprecation warning. Local-volume separation, initializer refusal to overwrite keys
  or use unapproved credentials, and build-context privacy are regression-tested.
- A real testimage inspection confirmed that the private local runtime and Git metadata
  were excluded by the [Dockerfile-specific ignore rules](../tests/document-processing/Dockerfile.dockerignore).

Safe local API/browser/OCR summaries stay in the ignored output directory. They are scoped
to the checks actually completed. The latest browser summary includes the full image
check; earlier document-only summaries were not treated as image success.

## Image failure diagnosis and verified local correction

The installed upload resolver preserves PNG **native-provider delivery**. The real image
upload is persisted and attached to the new test message; it is not routed as extracted
document text. An initial test wrongly expected an `image` delivery label and was
corrected to the installed `provider` contract without changing application routing.

Earlier browser probes did not obtain the expected answer to the synthetic image
question; an interrupted probe was also not counted as successful. A read-only inspection,
limited to the owned synthetic account and fixed test prompt, subsequently proved that
the stored response exactly matched the existing Detect Image Messages node's fixed
image-intent-failure response. The attachment was present: Tika had not removed it.

The local vision alias was absent from the model list available to the configured key.
The classifier call returned HTTP 400 (invalid model name); calling the available
`gpt-5.4` alias with the same classifier contract returned HTTP 200 and a valid result.
This established the local configuration fault without dumping model/request contents
or weakening the classifier's strict failure behavior.

With explicit operator approval, only the local vision alias was changed. Before the
controlled n8n-only recreate, active execution count was zero. The original Compose
had seven other environment differences from the live service, so a private override
preserved the actual running environment while changing just the approved alias.
Same image, mount/volume identities, network, ports, resource/security limits,
workflow-logic digest and credential count were checked before/after. Other containers
were not recreated or restarted. The single vision setting was also persisted in the
existing private local environment file; all other source-environment bytes were preserved.

The complete browser probe then passed the original synthetic image question, and a
scoped read-only DB check confirmed an attached image and the exact expected stored answer,
not the old intent-failure response. Document API/owner checks, ordinary chat and a new
image-only PDF OCR/model probe also passed again. **The local image gate is now passed.**

This is a local modelalias correction, not a Tika runtime or n8n workflow-code change.
The intended architecture remains: documents are extracted once through Tika and supplied
as stored text; images keep their native provider payload and existing Detect Images/LLM
analysis. The vision setting selects a vision-capable language-model alias and may point
to the same model used for ordinary chat; it does not require another OCR service.

The [bounded local recovery helper](../scripts/fix-tika-local-vision-model.py) and its
private snapshots/override support this exact operator-approved recovery. Snapshots include
private configuration and must never be committed, printed or included in images. The
effective private override is part of the current local Compose selection. During later
maintenance, reconcile its preserved settings deliberately with the current source config;
do not blindly reuse stale environment snapshots over future secret/policy updates.

## Remaining release boundaries

Additional unproved scope includes broad browser-level OCR/legacy/near-limit corpus coverage,
crash/recovery and remote-job lifecycle, negative attachment-resolution tests beyond the
preview check, and production networking/SSO review. Local email-login success is not
production-authentication acceptance. The candidate remains WIP, not release-approved.

## Operation and preservation

The [initializer](../scripts/prepare-tika-local-app.py) is a one-time operation. It refuses
existing local output and requires explicit permission before reading the existing bridge
credential. Never rerun it to rotate keys on this retained application.

From the repository root, readiness can be inspected without dumping configuration:

```sh
docker compose --env-file .tika-upload-local/app/runtime.env -f docker-compose.tika-local-app.yml ps
```

To stop only this local application deliberately while retaining data:

```sh
docker compose --env-file .tika-upload-local/app/runtime.env -f docker-compose.tika-local-app.yml stop
```

Never use a volume-deleting cleanup, recreate unrelated containers or reset an extractor
latch while uncertain remote work may exist. Parser recovery requires an idle operator
window and confirmed termination of that owned parser's work. Keep app keys/configuration
and named data volumes together for later local use/backups; none belong in Git.

The [API probe](../scripts/smoke-tika-local-app.py), [Chromium probe](../scripts/browser-tika-local-app.py)
and [scoped image inspection](../scripts/inspect-tika-local-image-probe.py) operate only on
the owned local port/project and newly created synthetic test data. Do not reuse them
against production or another user's account. They never dump parser/application logs,
document text, model answers or credentials.
