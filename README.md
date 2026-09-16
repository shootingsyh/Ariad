# Ariad v1

Ariad is a test-first engineering execution core for coordinating deterministic project workflows across agents, tools, source control, resources, and reliability boundaries.

This repository contains the first fake-executor implementation used to harden the domain model before connecting OpenClaw or real model runtimes.

## Current scope

- workflow state machine for Developer -> Tester -> Reviewer
- project-debugger escalation after bounded development cycles
- system failures routed to reliability without corrupting semantic development counters
- scripted fake agent executor for deterministic tests
- thin reliability incidents with bounded recovery and recovery locks
- resource contention between local model runtimes and tools such as ComfyUI
- append-only event store
- project initialization distinct from plugin installation
- source-control finalization controlled by the coordinator, not the Reviewer

## TDD

The project is developed test-first. Behavioral changes should start with a failing test, then the minimum implementation to make it pass, followed by refactoring while keeping the suite green.

Run:

```bash
npm test
```

The current suite covers workflow convergence, failure isolation, source-control boundaries, resource conflicts, fake-agent behavior, and reliability recovery behavior.

## Project initialization vs plugin installation

Ariad treats these as separate lifecycle operations.

Project initialization prepares a specific engineering project:

```text
validate repository
  -> configure source control
  -> bootstrap Ariad metadata
  -> validate project policy
  -> create project state
```

Plugin installation configures the host/runtime integration and does not initialize project source control.

## Source-control ownership

Reviewer roles do not receive commit/push authority by default. After Reviewer PASS, the workflow enters a coordinator-controlled source-control finalization step. A commit/push failure is an execution/system failure, not a Reviewer rejection.

## Reliability

Reliability is deliberately small in v1:

```text
observe -> recover -> escalate
```

It allows independent incidents and avoids complex incident correlation. Destructive recovery actions are guarded by recovery-key locks so duplicate detections cannot cause duplicate restarts.

See `docs/architecture.md` for the logical boundaries.