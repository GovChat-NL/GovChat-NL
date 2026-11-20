<img src="assets/icon.svg" width="64" height="64" alt="">

# GovChatLibre

A bare GovChat on Kubernetes: [LibreChat](https://www.librechat.ai) installed with its
official Helm chart, plus the settings that make it GovChat. An employee logs in with the
organisation's account, asks a question and gets an answer. Nothing else is switched on.

There is no fork, no own image and no own chart. This repo holds settings only.

| File | What |
|---|---|
| `values.yaml` | The core, the same for every organisation: login through SSO only, one fixed assistant, 30 days retention, everything else off. Contains the whole `librechat.yaml`. |
| `values-gemeente.yaml` | What differs per organisation: web address, Entra IDs, the Azure model, ingress. |
| `scripts/create-secrets.sh` | Creates the two Secrets in the cluster. Secrets never go into Git. |
| `fleet.yaml` | Only for Rancher Fleet: which chart, which version, which values files. |
| `local/` | A local test without Azure and without Entra. |
| `docs/adding-a-tool.md` | Step-by-step plan for adding a tool (an MCP server, an action, an own app). |

What runs: two pods, LibreChat and the MongoDB that comes with the chart.

## Versions

| What | Where it is pinned | Now |
|---|---|---|
| LibreChat chart | `--version` in the commands below and `version` in `fleet.yaml` | `3.2.1` |
| LibreChat image | follows the chart (`appVersion`) | `v0.8.9` |
| MongoDB | follows the chart | `8.0.13` |

One number to raise for an update. Test it locally first.

## Install

You need `kubectl` and `helm`, and a cluster with an ingress controller.

1. Fill in `values-gemeente.yaml`.
2. Create the Secrets. Without the two variables the script stores `not-set`.

   ```sh
   AZURE_MODEL_KEY=... OPENID_CLIENT_SECRET=... scripts/create-secrets.sh govchat
   ```

3. Install. The same command updates an existing installation.

   ```sh
   helm upgrade --install librechat oci://ghcr.io/librechat-ai/librechat-chart/librechat \
     --version 3.2.1 --namespace govchat -f values.yaml -f values-gemeente.yaml
   ```

With Rancher Fleet, skip step 3: point a GitRepo at your copy of this repo. Fleet reads
`fleet.yaml` and rolls out what is on the branch it follows. A change is a pull request;
going back is a `git revert`.

In Entra ID the app registration needs the redirect URI
`https://<your address>/oauth/openid/callback` and the app roles `govchat-user` and
`govchat-admin`. The roles must be in the ID token (`roles` claim).

## Test locally

On a throwaway cluster, with a local account instead of Entra. `local/services.yaml`
brings a stub instead of the language model, and its own MongoDB without a password. Needs
Docker and [kind](https://kind.sigs.k8s.io). The LibreChat image is a large download.

```sh
kind create cluster --name govchat-test
scripts/create-secrets.sh govchat
kubectl -n govchat apply -f local/services.yaml
helm upgrade --install librechat oci://ghcr.io/librechat-ai/librechat-chart/librechat \
  --version 3.2.1 --namespace govchat -f values.yaml -f local/values.yaml
kubectl -n govchat rollout status deployment/librechat-librechat --timeout=10m
kubectl -n govchat port-forward service/librechat-librechat 3080:3080
```

Open http://localhost:3080, create an account and ask a question. The stub always answers
"Dit is een testantwoord van het stubmodel."

Clean up with `kind delete cluster --name govchat-test`.

## Check an installation

```sh
scripts/check.sh https://govchat.example.nl
```

It checks from the outside that local login, registration and password reset are refused,
and that the API gives nothing without a login. The requests change nothing. By hand: an
account with the role `govchat-user` can chat, an account without it is refused.

## Changing things

Everything is a setting in `values.yaml`, documented at
[librechat.ai/docs](https://www.librechat.ai/docs/configuration/librechat_yaml).

- **Another assistant** (for example a writing aid): a new entry under `modelSpecs.list`
  with its own `promptPrefix`. No new component.
- **Turning a feature on** (uploads, search, agents): flip its line under `interface`.
- **A tool**: see [docs/adding-a-tool.md](docs/adding-a-tool.md).
- **Another model or provider**: the `endpoints` block.
