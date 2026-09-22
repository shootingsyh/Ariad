# Ariad OpenClaw Plugin

This package exposes one OpenClaw agent tool, `ariad_project`, for creating and managing isolated Ariad projects.

## Install for local development

```bash
cd extensions/openclaw-ariad
npm install
npm run plugin:build
npm run plugin:validate
openclaw plugins install --link .
```

After OpenClaw reloads the plugin, the model can call `ariad_project` with one of:

- `create` — create an isolated project folder
- `list` — list Ariad projects
- `status` — inspect one project's daemon state
- `start` — launch that project's daemon process
- `stop` — stop that project's daemon process

## Per-role model overrides

Installing or linking the plugin does **not** grant model-override authority automatically.
Configure the Ariad plugin once in OpenClaw with the models it may dispatch:

```json
{
  "plugins": {
    "entries": {
      "ariad": {
        "enabled": true,
        "subagent": {
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

`ariad_project set_role_models` stores the project-specific role-to-model mapping.
The OpenClaw plugin policy above is separate: it is the host-level allowlist authorizing Ariad to use those model refs.
## Isolation model

The default root is `~/.openclaw/ariad/projects`. Each project owns a separate folder:

```text
~/.openclaw/ariad/projects/<project-id>/
  project.json
  workspace/
  .ariad/
    state.db
    daemon.pid
    daemon.lock
    daemon.heartbeat.json
    daemon.log
```

Projects do not share workflow databases, pid files, locks, logs, or workspace paths. Running two projects concurrently is allowed. Ariad does not coordinate scheduling between projects in this version, so they may independently contend for host CPU/GPU resources.

The current daemon is intentionally only a project-lifecycle shell: it owns project identity, heartbeat, process lifecycle, and the future state DB path. The next integration step is to host the durable GraphRunner/Coordinator stack inside this daemon.
