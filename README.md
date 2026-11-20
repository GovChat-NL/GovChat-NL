<img src="assets/icon.svg" width="64" height="64" alt="">

# GovChatLibre

A bare GovChat on Kubernetes: [LibreChat](https://www.librechat.ai) installed with its
official Helm chart, plus the settings that make it GovChat. An employee logs in with the
organisation's account, asks a question and gets an answer. Nothing else is switched on.

There is no fork, no own image and no own chart. This repo holds settings only.

| Where | What |
|---|---|
| `deploy/` | Everything that is rolled out. The only folder Rancher Fleet reads. |
| `deploy/values.yaml` | The core, the same for every organisation: login through SSO only, one fixed assistant, 30 days retention, everything else off. Contains the whole `librechat.yaml`. |
| `deploy/values-gemeente.yaml` | What differs per organisation: web address, Entra IDs, the Azure model, ingress. |
| `deploy/fleet.yaml` | Only for Rancher Fleet: which chart, which version, which values files. |
| `scripts/create-secrets.sh` | Creates the two Secrets in the cluster. Secrets never go into Git. |
| `local/` | A local test without Azure and without Entra. |
| `docs/adding-a-tool.md` | Step-by-step plan for adding a tool (an MCP server, an action, an own app). |

What runs: two pods, LibreChat and the MongoDB that comes with the chart.

## Versions

| What | Where it is pinned | Now |
|---|---|---|
| LibreChat chart | `--version` in the commands below and `version` in `deploy/fleet.yaml` | `3.2.1` |
| LibreChat image | follows the chart (`appVersion`) | `v0.8.9` |
| MongoDB | follows the chart | `8.0.13` |

One number to raise for an update. Test it locally first.

## Install

You need `kubectl` and `helm`, and a cluster with an ingress controller.

1. Fill in `deploy/values-gemeente.yaml`.
2. Create the Secrets. Without the two variables the script stores `not-set`.

   ```sh
   AZURE_MODEL_KEY=... OPENID_CLIENT_SECRET=... scripts/create-secrets.sh govchat
   ```

3. Install. The same command updates an existing installation.

   ```sh
   helm upgrade --install librechat oci://ghcr.io/librechat-ai/librechat-chart/librechat \
     --version 3.2.1 --namespace govchat \
     -f deploy/values.yaml -f deploy/values-gemeente.yaml
   ```

In Entra ID the app registration needs the redirect URI
`https://<your address>/oauth/openid/callback` and the app roles `govchat-user` and
`govchat-admin`. The roles must be in the ID token (`roles` claim).

## Install with Rancher Fleet

Fleet rolls out what is in Git, so the real values of your organisation must be in Git
too. Keep them in a private copy of this repo, for example in Gitea.

1. Make the copy, with this repo as second remote:

   ```sh
   git clone -b swf/modulairKern https://github.com/GovChat-NL/GovChat-NL.git govchat && cd govchat
   git remote rename origin upstream
   git remote add origin https://gitea.example.nl/<org>/govchat.git
   git push -u origin HEAD:main
   ```

2. Fill in `deploy/values-gemeente.yaml` and commit it in your copy. It is the only file
   that differs from this repo.
3. Create the Secrets, as in step 2 of Install.
4. Create a GitRepo in Rancher that reads only the folder `deploy/`. Use the namespace
   `fleet-local` for the cluster Fleet runs on, `fleet-default` for other clusters.

   ```yaml
   apiVersion: fleet.cattle.io/v1alpha1
   kind: GitRepo
   metadata:
     name: govchat
     namespace: fleet-local
   spec:
     repo: https://gitea.example.nl/<org>/govchat.git
     branch: main
     paths:
       - deploy
   ```

A change is a pull request in your copy; going back is a `git revert`. To take over a new
version of this repo: `git pull upstream swf/modulairKern`, also in a pull request.

## Test locally

On a throwaway cluster, with a local account instead of Entra. `local/services.yaml`
brings a stub instead of the language model, and its own MongoDB without a password. Needs
Docker and [kind](https://kind.sigs.k8s.io). The LibreChat image is a large download.

```sh
kind create cluster --name govchat-test
scripts/create-secrets.sh govchat
kubectl -n govchat apply -f local/services.yaml
helm upgrade --install librechat oci://ghcr.io/librechat-ai/librechat-chart/librechat \
  --version 3.2.1 --namespace govchat \
  -f deploy/values.yaml -f local/values.yaml
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

Everything is a setting in `deploy/values.yaml`, documented at
[librechat.ai/docs](https://www.librechat.ai/docs/configuration/librechat_yaml).

- **Another assistant** (for example a writing aid): a new entry under `modelSpecs.list`
  with its own `promptPrefix`. No new component.
- **Turning a feature on** (uploads, search, agents): flip its line under `interface`.
- **A tool**: see [docs/adding-a-tool.md](docs/adding-a-tool.md).
- **Another model or provider**: the `endpoints` block.
