# Ariad

Ariad is a durable project-orchestration runtime for multi-role engineering work. Ariad owns project state, planning, scheduling, verification boundaries, retries, debugger routing, human gates, and source-control policy. Pi owns one model/tool session at a time.

The default standalone runtime is now the bundled Pi coding-agent SDK. OpenClaw is no longer required to execute Ariad roles.

## Runtime architecture

```text
Ariad
  project/task graph
  SQLite durable state
  scheduler + supervisor
  PM/TL/Debugger routing
  role seals + acceptance semantics
  human gates
        |
        v
PiAgentSessionProvider
        |
        +-- PM / Tech Lead / Project Debugger: persistent sessions
        +-- Developer / Tester / Reviewer / Artist: fresh persisted sessions
        |
        +-- coding tools
        +-- Ariad project tools
        +-- ariad_role_result
        |
        v
provider/model
  openai-codex/*
  openai/*
  meta/*
  llamacpp/*
```

Pi owns provider/model/auth mechanics, context persistence/compaction, the model tool loop, and cancellation. Ariad does not reimplement those responsibilities.

## Install and provider setup

Install Node dependencies:

```bash
npm install
```

Prepare/check global Pi provider authentication:

```bash
npx ariad setup
```

`ariad setup` never prints credentials. It reports only whether each provider namespace is ready and where the credential came from.

Ariad currently recognizes:

- `openai-codex/*` — Codex / ChatGPT subscription auth
- `openai/*` — OpenAI API auth
- `meta/*` — Meta/Muse provider auth
- `llamacpp/*` — local OpenAI-compatible llama.cpp/Ollama endpoint; no auth required

Pi auth is global by default at `~/.pi/agent/auth.json`. Projects do not store provider credentials.

For local models, configure the OpenAI-compatible endpoint when needed:

```bash
export ARIAD_LLAMACPP_BASE_URL=http://127.0.0.1:11434/v1
```

## Project model configuration

Every Ariad project stores explicit `provider/model` refs for:

```text
artist
developer
tester
reviewer
project_debugger
tech_lead
tech_lead_critic
pm
```

The external control MCP exposes:

- `models` — show required roles, provider namespaces, current mapping, and missing roles
- `set_role_models` — update one or more role mappings

`start` and `resume` reject incomplete model configuration. Existing projects resume without asking again once their model mapping is complete.

## External project control

Run the stdio control server:

```bash
npx ariad-control-mcp
```

It hosts `AriadService` and exposes one `ariad_project` MCP tool with actions:

```text
list
status
models
set_role_models
create
takeover
adopt
start
pause
resume
stop
```

The MCP process owns the live standalone service while it is running. Lifecycle actions reuse Ariad's existing project manager and scheduler rather than duplicating state logic.

## Pi role tools

In addition to Pi's normal coding tools, Ariad role sessions expose:

- `ariad_code_search` — live repository search; uses ripgrep when available and a Node fallback otherwise
- `ariad_interface_search` — searches current Ariad planner interface artifacts
- `ariad_memory_search` / `ariad_memory_write` — simple artifact-bound project memory
- `ariad_session_history` — reads persisted Pi session history for debugging/curation
- `ariad_role_result` — authoritative terminal structured result for the current role

Role semantics remain in Ariad prompts and state transitions. Tools do not decide workflow policy.

## Session policy

Ariad decides logical session identity; Pi decides how conversation state is persisted and compacted.

- PM: persistent per project
- Tech Lead: persistent per project
- Project Debugger: persistent per project
- Developer / Tester / Reviewer / Artist: fresh context per run, but transcript still persisted for audit/debugging

Session files live under the project workspace:

```text
.ariad/pi/sessions/
  persistent/<session-key-hash>/
  fresh/<attempt-hash>/
```


## Standalone Dashboard

The web dashboard is hosted by Ariad itself; **OpenClaw is not required**.
It preserves the read-only project explorer, version navigation, feature and milestone trees, and task/planning status from the former OpenClaw plugin. During migration the current version can also read partially rebuilt planner artifacts.

```bash
ariad dashboard start --port 18793
ariad dashboard status
ariad dashboard stop
```

Dashboard state persists across daemon restarts under `~/.ariad/projects/.runtime/config.json` (or the chosen project root); `ariad daemon start` automatically restores a dashboard configured as enabled. The web listener is restricted to `127.0.0.1` and is **read-only**. External HTTPS reverse proxies or Cloudflare Tunnels are configured separately.

For the existing hosted instance, `https://ariad.shootingsyh.xyz` is routed to `http://127.0.0.1:18793` via Cloudflare Tunnel. An older OC listener on `18791` may remain for compatibility but is no longer on the public route.

## Testing

Run the complete deterministic suite:

```bash
npm test
```

Run the Pi standalone runtime lane:

```bash
npm run test:pi-runtime
```

The Pi lane covers provider/model config, session policy, cancellation, role-result protocol, project tools, planning/replanning, and the PM -> Tech Lead -> Developer -> Tester -> Reviewer lifecycle using deterministic bottom-model fixtures.

Real-provider smoke tests are intentionally not required in CI. Development validation has also been run against local Qwen, Codex subscription auth, and Meta/Muse auth.

## Legacy compatibility

The earlier Pydantic standalone provider remains in the repository only for legacy/test coverage while those deterministic tests are migrated. It is not the default production runtime and is not the standalone CI lane.

The OpenClaw extension remains for compatibility/migration surfaces and legacy deployment paths. OpenClaw credential stores may be used once as migration inputs for Pi auth, but OpenClaw is not required for the default standalone role runtime.

## Ownership rules

Ariad owns:

- durable project/task/interface state
- planning and replanning
- scheduler/resource policy
- retry/debugger/human-gate policy
- role acceptance/seals
- source-control finalization policy

Pi owns:

- provider/model/auth
- model conversation/session storage
- context compaction
- coding/tool execution loop
- provider retries
- abort/cancellation mechanics

See `docs/runtime-adapters.md` for the runtime boundary.
