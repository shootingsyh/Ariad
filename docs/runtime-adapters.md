# Runtime adapters

Ariad treats runtimes as replaceable execution backends. Workflow Core must not import or depend on OpenClaw, OpenCode, local model servers, CLI processes, or any vendor-specific API.

## Logical contract

Every runtime adapter implements the same minimal lifecycle:

```js
{
  id,
  config,
  async install(context),
  async probe(),
  async start(request),
  async resume(request),
  async poll(runHandle),
  async cancel(runHandle)
}
```

`install()` prepares the runtime integration and must be safe to call repeatedly. It may validate dependencies, create runtime-specific directories, register local integration metadata, or perform another deterministic setup step. It must not initialize a specific engineering project; project initialization is a separate Ariad lifecycle.

`probe()` returns normalized health such as `HEALTHY`, `DEGRADED`, `UNHEALTHY`, or `UNKNOWN`. Runtime-specific health details may be attached, but the normalized health field is required.

`start()` and `resume()` return a normalized run handle:

```js
{
  runtimeId,
  runId,
  externalId,
  state
}
```

`poll()` returns normalized execution state/result data. Runtime-specific session IDs, process IDs, thread IDs, provider metadata, model names, endpoints, and authentication remain inside the adapter.

## One runtime, one adapter file

The preferred implementation shape is:

```text
src/adapters/
  fake-runtime.js
  openclaw.js
  opencode.js
  local-cli.js
```

A normal runtime integration should be possible in one file. That file may import a small shared transport/client helper when unavoidable, but it must own all runtime-specific translation logic.

Canonical adapter shape:

```js
'use strict';

const {
  normalizeRunHandle,
  normalizeRuntimeResult,
  normalizeHealth,
} = require('../runtime-adapter');

function createRuntimeAdapter(config = {}) {
  return {
    id: 'my-runtime',
    config,

    async install(context) {
      await ensureRuntimeAvailable(config, context);
      return { state: 'INSTALLED' };
    },

    async probe() {
      const status = await runtimeHealth(config);
      return normalizeHealth(translateHealth(status));
    },

    async start(request) {
      const externalId = await runtimeCreate(config, request);
      return normalizeRunHandle('my-runtime', request.runId, externalId);
    },

    async resume(request) {
      const externalId = await runtimeResume(config, request);
      return normalizeRunHandle('my-runtime', request.runId, externalId);
    },

    async poll(handle) {
      const vendorState = await runtimeStatus(config, handle.externalId);
      return normalizeRuntimeResult(translateStatus(vendorState));
    },

    async cancel(handle) {
      await runtimeCancel(config, handle.externalId);
      return { state: 'CANCELLED' };
    },
  };
}

module.exports = { createRuntimeAdapter };
```

## Monitoring ownership

Adapters expose facts; Ariad owns monitoring loops. A runtime adapter should not normally start a hidden permanent timer/thread during `install()`.

Ariad's `RuntimeMonitor` starts and stops a lightweight async polling job around `probe()`:

```text
RuntimeMonitor
  -> adapter.probe()
  -> normalized health
  -> RUNTIME_HEALTH_CHANGED / RUNTIME_PROBE_FAILED
  -> Reliability layer
```

This keeps monitor lifecycle, shutdown, tests, and failures under Ariad control. The fake runtime uses the exact same path and can script health changes or probe errors for deterministic reliability tests.

A future runtime that has a genuine event stream may optionally add a runtime-specific subscription helper, but the Core contract remains probe-based and does not require background threads inside the adapter.

## Registry boundary

Workflow/Execution code uses a logical runtime key rather than importing an implementation:

```js
registry.register('local_execution', createQwenRuntime(config));
registry.register('planning', createMuseRuntime(config));
registry.register('agent_runtime', createOpenClawRuntime(config));
```

Core then resolves `local_execution` or `planning`; it does not know what concrete runtime is behind the key.

## What does not belong in the adapter

Adapters must not own:

- workflow transitions;
- development-cycle counters;
- project-debugger policy;
- reliability recovery ladders;
- resource scheduling policy;
- project source-control policy;
- context-compaction policy;
- long-lived monitoring policy.

They may report runtime facts required by those layers, but those layers make the decisions.

## Configuration

Runtime-specific configuration is intentionally opaque to Core:

```js
{
  endpoint: 'http://localhost:1234',
  model: 'qwen-local',
  timeoutMs: 300000,
  vendorSpecificFlag: true
}
```

Only the adapter interprets these fields. This lets configuration evolve without changing the logical contract.

## Conformance testing

Every adapter should run the shared behavioral expectations:

- valid stable adapter id;
- install is repeatable/idempotent;
- probe returns normalized health;
- `start` creates a normalized run handle;
- `resume` can continue from a checkpoint;
- `poll` produces normalized states/results;
- `cancel` is idempotent or safely repeatable;
- vendor-specific configuration never leaks into Workflow Core;
- provider errors are translated into normalized execution failures rather than semantic task outcomes.

`fake-runtime.js` is the executable reference implementation for the contract.
