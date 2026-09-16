# Runtime adapters

Ariad treats runtimes as replaceable execution backends. Workflow Core must not import or depend on OpenClaw, OpenCode, local model servers, CLI processes, or any vendor-specific API.

## Logical contract

Every runtime adapter implements the same minimal lifecycle:

```js
{
  id,
  config,
  async start(request),
  async resume(request),
  async poll(runHandle),
  async cancel(runHandle)
}
```

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
} = require('../runtime-adapter');

function createRuntimeAdapter(config = {}) {
  return {
    id: 'my-runtime',
    config,

    async start(request) {
      // translate Ariad request -> runtime-specific create/spawn call
      const externalId = await runtimeCreate(config, request);
      return normalizeRunHandle('my-runtime', request.runId, externalId);
    },

    async resume(request) {
      // translate checkpoint/resume request -> runtime-specific operation
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
- context-compaction policy.

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
- `start` creates a normalized run handle;
- `resume` can continue from a checkpoint;
- `poll` produces normalized states/results;
- `cancel` is idempotent or safely repeatable;
- vendor-specific configuration never leaks into Workflow Core;
- provider errors are translated into normalized execution failures rather than semantic task outcomes.

`fake-runtime.js` is the executable reference implementation for the contract.
