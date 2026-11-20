# Adding a tool

How to give the chat something extra, step by step. Written 20 November 2026 for chart
3.2.1 (LibreChat v0.8.9). The last section says what was run and what was only read.

## 1. Which kind of tool

| Need | Pick | What changes |
|---|---|---|
| A fixed instruction or tone ("write at B1 level") | An extra entry under `modelSpecs.list` with its own `promptPrefix`. Not a tool. | `deploy/values.yaml` |
| The model must look something up or do something | **An MCP server** as its own pod (section 2) | a folder `apps/<name>/` and `deploy/values.yaml` |
| An existing REST API with an OpenAPI description, and no MCP server for it | An agent with an Action (section 4) | `deploy/values.yaml`, plus an agent built in the screen |
| An own app that writes the whole answer itself | A custom endpoint (section 4) | a folder `apps/<name>/` and `deploy/values.yaml` |

Prefer an MCP server. It is switched on and off with one small change in Git, and nothing
is stored in the database.

## 2. An MCP server, step by step

### Step 0. Decide

- Get the tool approved the same way as any other app. Write down which data leaves the
  chat and where the server sends it.
- The server must speak **streamable HTTP**. Do not use stdio servers: they run inside the
  LibreChat container and need `npx` or `uvx` there.
- Pin the image to a version and a digest. Never `latest`.
- The model must support tool calls, otherwise it never uses the tool.
- Choose how users get it:
  - **Pinned** (recommended): the tool is always part of an assistant. Users see no menu.
  - **Chosen**: users switch it on themselves in the chat's tool menu.

### Step 1. Run the server (pull request 1)

Add a folder `apps/<name>/deploy/` with a Deployment, a Service and a NetworkPolicy. Section 3
has a complete example, and it is in this repo as `apps/mcp-time/`. Same namespace as
LibreChat, no Ingress, and the NetworkPolicy lets only LibreChat in. The `fleet.yaml` next
to the manifests is for Rancher Fleet only, so name the manifest file for `kubectl`:

```sh
kubectl -n govchat apply -f apps/<name>/deploy/<name>.yaml
```

Add `apps/<name>/app.yaml` too (copy the one of `mcp-time`): with it the app shows up in
the admin panel, which then does step 3 for you.

Users notice nothing yet: LibreChat does not know the server.

### Step 2. A secret, if the server wants one

Add a key such as `MCP_<NAME>_TOKEN` to the Secret `librechat-credentials-env` (and to
`scripts/create-secrets.sh` for new installations). Give the server pod its own Secret; do
not mount LibreChat's Secret there. A changed Secret does not restart LibreChat by itself:

```sh
kubectl -n govchat rollout restart deployment/librechat-librechat
```

### Step 3. Switch it on (pull request 2)

All lines are inside `librechat.configYamlContent` in `deploy/values.yaml`. The admin panel
(`admin/`, tab Apps) writes exactly these lines; by hand works as well.

```diff
     interface:
-      mcpServers: { use: false, create: false, share: false, public: false }
+      mcpServers: { use: true, create: false, share: false, public: false }

+    mcpSettings:
+      allowedAddresses: ["<service>:<port>"]
+    mcpServers:
+      <name>:
+        type: streamable-http
+        url: "http://<service>:<port>/mcp"
+        title: "<name shown to users>"
+        chatMenu: false            # pinned; leave out to let users choose
+        headers:                   # only if the server wants a token
+          Authorization: "Bearer ${MCP_<NAME>_TOKEN}"

     modelSpecs:
       list:
         - name: govchat-standaard
+          mcpServers: ["<name>"]   # pinned to this assistant
```

- `use: true` is needed, also for a pinned server. `create: false` keeps users from adding
  servers of their own.
- `interface.agents` stays `false` and `ENDPOINTS` stays `"azureOpenAI"`.
- `mcpSettings.allowedAddresses` is needed. A Service has a private address, and LibreChat
  refuses private addresses unless they are listed, with the port.
- Use the short Service name in `url`, not a name ending in `.svc.cluster.local`.
- A tool for one assistant only: make a second entry under `modelSpecs.list` and pin the
  server there instead.

### Step 4. Test locally

Follow "Test locally" in the README, and apply the app before the `helm upgrade`:

```sh
kubectl -n govchat apply -f apps/<name>/deploy/<name>.yaml
kubectl -n govchat logs deployment/librechat-librechat | grep '\[MCP\]'
```

The log must list the server with its tools. The stub model cannot call tools, so the real
test of a tool call needs a real model.

### Step 5. Check

1. A user with the role `govchat-user` asks something only the tool can answer. The answer
   shows a tool call.
2. Pinned: the user sees no tool menu. Chosen: the server is in the menu.
3. From another pod in the namespace the server does not answer (the NetworkPolicy works).
4. Undo step 3 and roll out again: the model answers without the tool.
5. Stop the server pod and ask a question. Write down what the user sees.

### Step 6. Roll out, switch off, go back

- Merge pull request 1 and check that the pod is Ready. Then merge pull request 2. The
  chart restarts LibreChat because its configuration changed.
- **Off:** `git revert` pull request 2. The server still runs, nothing calls it.
- **Gone:** also `git revert` pull request 1 and remove the key from the Secret.
- **New version:** change the image tag and digest in `apps/<name>/deploy/`, in a pull request.

## 3. Worked example: date and time

[`mcp-time`](https://github.com/TheoBrigitte/mcp-time) is a small server with five tools
for dates and times. It needs no secret and no network access, which makes it a safe first
test. It is a small community project: use it to try the route, not as a product choice.

`apps/mcp-time/deploy/mcp-time.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-time
spec:
  selector:
    matchLabels: { app: mcp-time }
  template:
    metadata:
      labels: { app: mcp-time }
    spec:
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: mcp-time
          image: docker.io/theo01/mcp-time:0.4.0@sha256:68f2a2d78dc66efa84f30b7a5209c90da64bf936de923c20861122062ef8ff0f
          args: ["--transport", "stream", "--address", "http://0.0.0.0:8080/mcp"]
          ports:
            - containerPort: 8080
          readinessProbe: { tcpSocket: { port: 8080 } }
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
          resources: { requests: { cpu: 10m, memory: 32Mi }, limits: { memory: 64Mi } }
---
apiVersion: v1
kind: Service
metadata:
  name: mcp-time
spec:
  selector: { app: mcp-time }
  ports:
    - port: 8080
---
# Only LibreChat may reach the server, and the server may reach nothing.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: mcp-time
spec:
  podSelector:
    matchLabels: { app: mcp-time }
  policyTypes: ["Ingress", "Egress"]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app.kubernetes.io/name: librechat-librechat }
      ports:
        - port: 8080
```

In `deploy/values.yaml`, inside `librechat.configYamlContent`:

```yaml
    interface:
      mcpServers: { use: true, create: false, share: false, public: false }

    mcpSettings:
      allowedAddresses: ["mcp-time:8080"]
    mcpServers:
      mcp-time:
        type: streamable-http
        url: "http://mcp-time:8080/mcp"
        title: "Datum en tijd"
        chatMenu: false

    modelSpecs:
      list:
        - name: govchat-standaard
          mcpServers: ["mcp-time"]
```

Test question: "Hoe laat is het nu in Amsterdam, en welke datum is het over 45 dagen?"

## 4. The two other routes, in short

**An agent with an Action.** For a REST API with an OpenAPI description.

1. Set `ENDPOINTS: "azureOpenAI,agents"` and
   `interface.agents: { use: true, create: false, share: false, public: false }`.
2. Limit where actions may go: `actions.allowedDomains: ["api.example.nl"]`, or for a
   Service in the cluster `actions.allowedAddresses: ["<service>:<port>"]`.
3. An administrator builds the agent in the screen, pastes the OpenAPI description and
   shares the agent with all users.
4. Add an entry under `modelSpecs.list` with `preset: { endpoint: "agents", agent_id: "agent_..." }`.

The drawback: the agent lives in the database, not in Git. Save its instruction and its
OpenAPI description in the repo for the review.

**An own app as a custom endpoint.** For an app that writes the whole answer itself. The
app must offer an OpenAI-compatible `/chat/completions`. Run it from `apps/<name>/` like
in step 1.

```yaml
    endpoints:
      custom:
        - name: "MijnApp"
          apiKey: "${MIJNAPP_API_KEY}"
          baseURL: "http://mijnapp:8000/v1"
          models: { default: ["mijnapp"], fetch: false }
    modelSpecs:
      list:
        - name: mijnapp
          label: "Mijn app"
          preset: { endpoint: "MijnApp", model: "mijnapp" }
```

`ENDPOINTS` must then also name `custom`.

## 5. What was tested

**Run on 20 November 2026**, on a local cluster with chart 3.2.1, the stub model and the
`mcp-time` example exactly as in section 3:

- LibreChat connects to the server at start-up and lists its five tools.
- A chat with the assistant "GovChat standaard" gets the five tools attached, with
  `interface.agents: false` and `ENDPOINTS: "azureOpenAI"`.
- From another pod the server is not reachable.
- The image `theo01/mcp-time:0.4.0` runs as non-root on a read-only file system.

**Not tested:**

- A real tool call. The stub model cannot ask for one.
- That going back to `use: false` takes the permission away again in an existing database.
  LibreChat keeps role permissions in MongoDB and updates them at start-up; the log line
  `Updating 'USER' role permission 'MCP_SERVERS'` shows it. Check 4 in step 5 covers this.
- What a user sees when the server is down.
- A server that needs a token (`headers`).
- The folder `apps/<name>/deploy/` with Rancher Fleet. It has its own `fleet.yaml` with
  `defaultNamespace`, and its path must be added to the GitRepo.
- Section 4, both routes. They come from the documentation and the source code only.

**Good to know:**

- The tool descriptions go to the model with every question (2,245 tokens for the five
  tools of `mcp-time`) and can steer it. Review the tool list, not only the image.
- A NetworkPolicy only works if the cluster's network plugin enforces it.
- If the deployment name of the model is also the start of the server's host name,
  LibreChat cuts the address in the wrong place. This applies to the Azure address of the
  model, not to MCP servers.

Documentation used:
[MCP servers](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers) ·
[MCP settings](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_settings) ·
[model specs](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/model_specs) ·
[interface](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/interface) ·
[agents](https://www.librechat.ai/docs/features/agents) ·
[custom endpoints](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/custom_endpoint)
