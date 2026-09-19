# Ariad v2: Minimal durable task runtime

Ariad v2 deliberately reduces the durable business model to two entities:

- **Project** — project-level intent/specification and bindings such as the persistent PM agent/session.
- **Task** — graph membership, dependency edges, current stage/state, execution handle, artifacts, and append-only history.

There is no durable Graph entity. Graphs are views over Tasks:

- the project's **delivery graph** is every task with `scope: "delivery"`;
- each **control flow** is a small ad-hoc graph containing tasks with `scope: "control"` and the same `flowId`.

Dependencies may only point inside the same graph group. A planning or restore flow therefore cannot accidentally become part of the delivery dependency graph.

Retry counts are derived from task history.

## Active components

- **AriadStore / SQLiteV2Store**: the only durable-state authority. It owns Project/Task persistence and atomic creation of control flows; it does not decide what should run next.
- **Scheduler**: mechanically advances `RESULT_READY` tasks via role transition rules, computes deterministic topological readiness independently for each graph group, allocates resources, claims tasks, and starts provider executions.
- **Supervisor**: audits `WORKING` tasks through their provider handles, appends role results or system interruptions, releases resources, and emits `SYSTEM_INCIDENT` records through an optional sink.
- **RoleRegistry**: static behavior/configuration. A role defines how to prepare an execution, how to transition after a result, resource requirements, and session policy.
- **ProviderRegistry**: runtime integration boundary (OpenClaw, OpenCode, local model servers, Codex/Muse, etc.).
- **ResourcePool**: runtime capacity such as one local GPU. Resource ownership is reconstructed from durable `WORKING` tasks after restart rather than persisted as another business entity.

Roles have no runtime identity. An Execution has a lifecycle; a Role is only a definition used to prepare and interpret that execution.

## Task lifecycle

```text
READY
  -> WORKING
  -> RESULT_READY
  -> READY (next role)
  -> ...
  -> DONE
```

A provider never starts the next role. It only produces a result. The Supervisor attaches that result to the Task. The Scheduler observes it and applies the role's mechanical transition.

Infrastructure failure is separate from business failure:

```text
provider crash / lost execution
  -> SYSTEM_INTERRUPTION history
  -> optional SYSTEM_INCIDENT
  -> task back to READY
```

Business outcomes such as tester/reviewer rejection remain `ROLE_RESULT` entries and are handled by role transition policy.

## Delivery graph and control flows

Normal implementation work lives in one delivery graph:

```text
scope = delivery

feature-A -> feature-B -> feature-C
                 \-> feature-D
```

Project coordination work is represented by independent control flows:

```text
scope = control
flowId = plan-42

TL plan -> PM review
```

A later replan is another flow:

```text
scope = control
flowId = replan-43

TL replan -> PM review
```

All of these are stored as Tasks in the same table and scheduled by the same Scheduler, but topological dependency semantics remain isolated per graph group. They still compete through the same resource pool.

## PM, bootstrap, and planning

PM uses the same role/provider abstraction but is project-scoped and normally `sessionPolicy: persistent`. A persistent PM session does not imply a persistent worker.

User messages remain outside the Ariad core event model. The host invokes the PM binding directly. If PM decides durable work is needed, it creates a control flow.

Project bootstrap behaves differently depending on the workspace:

```text
empty directory:
  invoke persistent PM with WELCOME
  no Task is created

non-empty directory:
  invoke persistent PM with WELCOME_AND_RESTORE_STARTED

  control:bootstrap
    TL restore/discover
      -> PM review restored state
```

Welcome itself is not durable work. Restore/discovery is durable because it can be slow, fail, require review, and must survive restart.

Planning is also an ad-hoc control flow:

```text
PM conversation
  -> create control:plan-N
       TL plan
         -> PM review
             -> later apply graph patch to delivery tasks
```

The task-graph patch/apply step is intentionally the next migration slice; it should be implemented as one atomic Store operation so ongoing delivery execution can continue while planning/refinement happens concurrently.

## Provider boundary

A provider only needs to support:

```text
start(spec) -> external handle
poll(handle) -> RUNNING | COMPLETED | FAILED/LOST
cancel(handle)
```

OpenClaw-specific agent/session/subagent details stay inside the OpenClaw provider. The durable Task only records the provider key and external execution id required for restart recovery.

This v2 implementation initially lives alongside v1 so the old execution path remains intact while vertical slices migrate.
