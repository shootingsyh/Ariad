# Ariad v1

Ariad is a test-first engineering execution core for coordinating deterministic project workflows across agents, tools, source control, resources, and reliability boundaries.

This repository contains the first fake-executor implementation used to harden the domain model before connecting OpenClaw or real model runtimes.

## Current scope

- workflow state machine for Developer -> Tester -> Reviewer
- project-debugger escalation after bounded development cycles
- system failures routed to reliability without corrupting semantic development counters
- scripted fake agent executor for deterministic tests
- abstract runtime adapter contract and runtime registry
- thin reliability incidents with bounded recovery and recovery locks
- resource contention between local model runtimes and tools such as ComfyUI
- append-only event store
- project initialization distinct from plugin installation
- source-control finalization controlled by the coordinator, not the Reviewer
- optional OpenAI-compatible live LLM semantic eval lane

## TDD

The project is developed test-first. Behavioral changes should start with a failing test, then the minimum implementation to make it pass, followed by refactoring while keeping the suite green.

Run deterministic tests:

```bash
npm test
```

The current suite covers workflow convergence, failure isolation, source-control boundaries, resource conflicts, fake-agent behavior, runtime-adapter conformance, runtime registry behavior, LLM contract validation, and reliability recovery behavior.

## Live LLM evals

Ariad keeps real-model evaluation separate from required deterministic CI. The live lane uses an OpenAI-compatible chat-completions endpoint and currently exercises PM decomposition, Reviewer semantic rejection, and Project Debugger classification.

Configure any compatible endpoint:

```bash
export ARIAD_LLM_BASE_URL=https://router.huggingface.co/v1
export ARIAD_LLM_API_KEY=<token>
export ARIAD_LLM_MODEL=<chat-completion-model>
npm run test:llm
```

For local testing, the same variables can point at llama.cpp, vLLM, or another OpenAI-compatible server. If `ARIAD_LLM_BASE_URL` or `ARIAD_LLM_MODEL` is absent, live tests skip instead of failing normal CI.

Hugging Face Inference Providers exposes `GET /v1/models`; use that to choose a currently served chat model rather than hard-coding provider availability. Lightweight instruction models are useful for testing Ariad's role contracts because the evals assert structured properties, not exact prose.

## Runtime adapters

Ariad Core does not depend on OpenClaw, OpenCode, local model servers, or any other concrete runtime. It resolves a logical runtime key through `RuntimeRegistry` and talks only to a minimal contract:

```text
start
resume
poll
cancel
```

The preferred integration shape is one runtime per adapter file:

```text
src/adapters/
  fake-runtime.js
  openclaw.js
  opencode.js
  local-cli.js
```

Runtime-specific endpoint, session, model, provider, and authentication details stay inside the adapter. See `docs/runtime-adapters.md` for the contract and implementation pattern.

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