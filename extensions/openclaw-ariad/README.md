# Ariad OpenClaw Plugin

This package exposes the `ariad_project` OpenClaw tool and hosts Ariad's V2 event-driven project runtime.

## Install for local development

```bash
cd extensions/openclaw-ariad
npm install
npm run plugin:build
npm run plugin:validate
openclaw plugins install --link .
npm run mcp:register
openclaw gateway restart
```

`mcp:register` writes `ariad-role-result` into OpenClaw's authoritative `mcp.servers` registry using an absolute path to the bundled stdio server, then probes it. This remains required for Codex app-server compatibility. Re-run it after moving or relinking the plugin so the absolute path stays current.

## Runtime model

Ariad V2 uses one Gateway-owned event-driven scheduler. Durable execution state lives in each project's SQLite database. Ordinary mutations explicitly wake the scheduler; mutations originating in another OpenClaw process use a local file notification to wake the Gateway-owned scheduler. SQLite generation tracking prevents mutations that happen during reconcile from being lost. A 10-minute safety wake is retained as recovery insurance; there is no 250 ms polling loop.

Ariad roles run as first-class OpenClaw agent sessions through `runEmbeddedAgent`, not through the old subagent execution path. Attempt-scoped roles receive isolated session keys. Roles with persistent session policy, such as PM, reuse a project-and-role session across attempts. Structured role-result tools are the authoritative completion signal. If a completed role misses its result submission, Ariad opens a recovery turn in the same session and asks only for the missing structured result instead of redoing the task.

Runtime scheduler state is not checkpointed into Git. SQLite is the execution-history truth. Normal product source-control finalization still creates product commits when appropriate.

## Per-role model policy

Installing or linking the plugin does **not** grant model-override authority automatically. Configure the models Ariad may dispatch:

```json
{
  "plugins": {
    "entries": {
      "ariad": {
        "enabled": true,
        "roleExecution": {
          "allowModelOverride": true,
          "allowedModels": [
            "llamacpp/qwen3.8-27b",
            "openai/gpt-5.6-terra",
            "muse/muse-code"
          ]
        }
      }
    }
  }
}
```

The former `subagent.allowModelOverride` / `subagent.allowedModels` fields are still accepted as a compatibility fallback, but `roleExecution` is the current configuration name.

`ariad_project set_role_models` stores the project-specific role-to-model mapping. Newly created Ariad projects require a complete mapping for all Ariad roles. The OpenClaw plugin policy above is the independent host-level allowlist authorizing those model refs.

## Project lifecycle

`ariad_project` supports:

- `create`, `list`, `status`, `adopt`
- `start`, `pause`, `resume`, `stop`
- `iterate` for creating the next project version from an immutable completed-version snapshot
- `set_role_models` and `models`
- Frontdesk binding and human-decision actions

Projects are isolated under `~/.openclaw/ariad/projects/<project-id>/` by default. The workspace owns its `.ariad/state.db`, project manifest, version snapshots, and product Git repository. Multiple projects may run concurrently; Ariad's resource pool and role scheduling determine dispatch rather than one daemon process per project.
