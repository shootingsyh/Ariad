# Runtime boundary

Ariad's current standalone execution backend is Pi. The useful boundary is not a second general runtime framework; it is a narrow provider/session seam between Ariad orchestration and one Pi agent run.

## Ownership

```text
Ariad orchestration
  - project/task graph
  - SQLite state
  - scheduler/supervisor
  - planning/replanning
  - debugger routing
  - human gates
  - role-result validation/seals
  - resource policy
        |
        v
PiAgentSessionProvider
  - create one role session
  - choose explicit provider/model
  - expose tools
  - persist/compact conversation
  - run tool loop
  - abort/cancel
        |
        v
provider/model
```

Ariad must not duplicate Pi's provider auth, message-history, compaction, or tool-loop implementation.

Pi must not decide Ariad task transitions, acceptance, retry budgets, debugger routing, or project policy.

## Provider contract used by Ariad

The scheduler/supervisor needs only a small execution surface:

```js
{
  id,
  async start(spec),
  async poll(handle),
  async cancel(handle),
  async close()
}
```

`PiAgentSessionProvider` implements this contract.

A role `spec` includes project/task/role identity, workspace, session policy, prompt/context, and an explicit role model ref. Pi runtime details stay inside the provider.

## Model namespaces

Ariad persists explicit provider namespaces rather than guessing:

```text
openai-codex/gpt-...
openai/gpt-...
meta/...
llamacpp/...
```

`openai-codex/*` means subscription/Codex auth.
`openai/*` means OpenAI API auth.

Legacy projects that used historical `openai/*` refs before the namespace split migrate once to `openai-codex/*`.

## Authentication

Authentication is global Pi state, not project state.

Default path:

```text
~/.pi/agent/auth.json
```

Override for controlled environments/tests:

```bash
export ARIAD_PI_AUTH_PATH=/path/to/auth.json
```

`ariad setup` may import compatible legacy Codex/Meta credentials into global Pi auth. It reports readiness only and never prints credential material.

Each project keeps only:

```text
.ariad/pi/models.json
.ariad/pi/sessions/...
```

## Session policy

Persistent roles:

- PM
- Tech Lead
- Project Debugger

Fresh roles:

- Artist
- Developer
- Tester
- Reviewer

Fresh means no conversational carry-over into the next attempt. It does not mean history is discarded; fresh sessions are still persisted as separate Pi JSONL files.

## Structured completion

Every normal Ariad role run must terminate through the registered `ariad_role_result` tool. Ariad validates the role-specific schema and only then lets the scheduler/supervisor advance state.

Ordinary assistant prose is not completion.

Provider errors are execution failures, not semantic task failures.

## Cancellation and restart

Ariad owns the decision to cancel; Pi owns the actual session abort.

A project stop:

```text
Ariad marks STOPPED
  -> locate WORKING tasks
  -> provider.cancel(handle)
  -> Pi session.abort()
  -> durable SYSTEM_INTERRUPTION
  -> task returns to recoverable state without consuming a semantic attempt
```

Restart-orphan recovery similarly belongs to Ariad's supervisor because only Ariad knows whether the durable role result was already sealed.

## Project tools

Pi extensions expose read/write/query capabilities, but they do not own workflow policy:

- live code search
- current interface search
- small artifact-bound memory
- persisted session-history access
- terminal role result

Code search prefers `rg` when installed and has a Node fallback so runtime correctness does not depend on a host utility.

## External control

`ariad-control-mcp` is the standalone process boundary for project management. It creates one `AriadService` plus one `PiAgentSessionProvider` and exposes lifecycle/model configuration through MCP.

It supports:

```text
list / status
models / set_role_models
create / takeover / adopt
start / pause / resume / stop
```

No control action reimplements scheduler logic; it delegates to `AriadProjectManager` and `AriadService`.

## Legacy backends

The repository still contains older Pydantic/OpenClaw integration code for migration and deterministic legacy tests. Those paths are not the default standalone runtime.

New runtime work should target Pi unless a concrete missing Pi capability is demonstrated. If such a gap exists, prefer extending Pi or its tool layer over expanding Ariad's orchestration responsibilities.
