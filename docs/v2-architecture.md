# Ariad v2: Minimal durable task runtime

Ariad v2 deliberately reduces the durable business model to two entities:

- **Project** — project-level intent/specification and bindings such as the persistent PM agent/session.
- **Task** — graph edges, current stage/state, execution handle, artifacts, and append-only history.

The task graph is a view over `Task.dependsOn`; it is not a separate durable entity. Retry counts are derived from task history.

## Active components

- **Scheduler**: mechanically advances `RESULT_READY` tasks via role transition rules, computes a deterministic topological ready frontier, allocates resources, claims tasks, and starts provider executions.
- **Supervisor**: audits `WORKING` tasks through their provider handles, appends role results or system interruptions, releases resources, and emits `SYSTEM_INCIDENT` records through an optional sink.
- **RoleRegistry**: static behavior/configuration. A role defines how to prepare an execution, how to transition after a result, resource requirements, and session policy.
- **ProviderRegistry**: runtime integration boundary (OpenClaw, OpenCode, local model servers, Codex/Muse, etc.).
- **ResourcePool**: runtime capacity such as one local GPU. Resource ownership is reconstructed from durable `WORKING` tasks after restart rather than persisted as another business entity.

## Task lifecycle

```text
READY
  -> WORKING
  -> RESULT_READY
  -> READY (next role)
  -> ...
  -> DONE
```

A worker/provider never starts the next role. It only produces a result. The Supervisor attaches that result to the Task. The Scheduler observes it and applies the role's mechanical transition.

Infrastructure failure is separate from business failure:

```text
provider crash / lost execution
  -> SYSTEM_INTERRUPTION history
  -> optional SYSTEM_INCIDENT
  -> task back to READY
```

Business outcomes such as tester/reviewer rejection remain `ROLE_RESULT` entries and are handled by role transition policy.

## PM and planning

PM uses the same role/provider abstraction but is project-scoped and normally `sessionPolicy: persistent`. The host-facing Project Agent can invoke that persistent role directly; user messages do not need to enter the Ariad core event model.

Planning is normally a Tech Lead role execution. Its output should be a task-graph patch which can be merged atomically into the project's existing Tasks while execution continues.

## Provider boundary

A provider only needs to support:

```text
start(spec) -> external handle
poll(handle) -> RUNNING | COMPLETED | FAILED/LOST
cancel(handle)
```

OpenClaw-specific agent/session/subagent details stay inside the OpenClaw provider. The durable Task only records the provider key and external execution id required for restart recovery.

This v2 implementation initially lives alongside v1 so the old execution path remains intact while vertical slices migrate.
