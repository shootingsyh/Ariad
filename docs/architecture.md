# Ariad v1 architecture

## Logical layers

### 0. Domain model
Shared vocabulary: Workflow, Task, Run, Tool Invocation, Resource Lease, Incident, Artifact, Checkpoint.

### 1. Workflow Core
Owns semantic task flow and counters. `devCycle` changes only on Tester/Reviewer NOT_PASS. `strategyEpoch` changes only after Project Debugger returns WRONG_IMPLEMENTATION_APPROACH.

### 2. Execution
A RoleExecutor contract. v1 uses ScriptedFakeExecutor. Future implementations may use OpenClaw/OpenCode/etc.

### 3. Context & Memory
Not implemented in v1. Durable state will eventually be independent from chat/session context.

### 4. Resources & Scheduling
ResourceManager owns capacity/leases. A local LLM runtime and a ComfyUI tool invocation can declare the same GPU resource and therefore contend deterministically.

### 5. Reliability
Intentionally small. Each detected failure may create an independent Incident. Reliability does not attempt sophisticated incident correlation in v1. Recovery actions are bounded and guarded by a recovery key so duplicate incidents cannot concurrently perform the same destructive recovery.

System Debugger is a future diagnostic worker invoked only after deterministic recovery is exhausted. It is not part of Workflow Core.

### 6. Interface
Not implemented in v1. Future project chat/UI should be a single human-facing entry point.

## Two control planes

```text
Workflow control plane
  flow entity: Task
  question: what business work should happen next?

Reliability control plane
  flow entity: Incident
  question: can the execution system safely continue, recover, or escalate?
```

Workflow owns desired business state. Reliability owns execution health. Neither directly mutates the other's counters/state.

## Project Debugger vs System Debugger

Project Debugger:
- invoked by Workflow Core after semantic non-convergence;
- diagnoses task size, contradiction, or wrong approach;
- never performs recovery actions.

System Debugger:
- invoked by Reliability after bounded deterministic recovery fails;
- diagnoses runtime/tool/model/resource failure;
- returns a recommendation only;
- RecoveryService validates and executes allowed actions.

## Installation vs project initialization

Plugin install is host-level and should happen rarely:

```text
validate host -> install plugin -> register service -> health check
```

Project init is per-project and interactive:

```text
validate repo -> configure source control -> bootstrap project metadata
-> collect requirements -> start workflow
```

Source-control policy is a project concern, not a plugin-install concern.
