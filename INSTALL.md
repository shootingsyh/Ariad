# Ariad Installation & Readiness Guide

This is the authoritative install/runbook for the current Ariad + OpenClaw integration.

## 1. Readiness review

The current end-to-end path is:

```text
User
  ↕
Project Agent / PM
  ↓ durable ProjectBrief + decisions
Tech Lead
  ↓ current-state discovery for existing projects
  ↓ living component / contract / dependency / vertical-slice design
  ↓ executable TaskGraph
PM product review
  ↓
Developer → Tester → Reviewer
  ↓
Project Debugger / NEEDS_HUMAN when required
  ↓
Ariad source-control finalizer
  ↓
Git commit + optional push
```

The following are implemented and covered by deterministic tests / OpenClaw Gateway E2E:

- isolated durable projects under `~/.openclaw/ariad/projects/<project-id>`
- existing-project discovery before requirement planning
- PM acknowledgement of reconstructed current state
- TL living architecture: horizontal shared infrastructure + vertical product slices
- durable contracts, dependency edges, technical direction, decomposition, and task graph
- TL designs only; executable interfaces, contract tests, fakes, skeletons, implementation, and refactors are separate Tasks
- contract maturity: `PROVISIONAL → VALIDATED → STABLE`
- every executable Task goes through Developer → Tester → Reviewer
- semantic retries are separate from system/reliability retries
- Project Debugger escalation after bounded development cycles
- durable `NEEDS_HUMAN` notification to the originating Project Agent conversation
- user decision → durable decision journal → resume the exact stage that requested the decision
- source-control finalization owned by Ariad, not Reviewer
- process/restart recovery through durable SQLite state
- long TL JSON results recover from the full OpenClaw session transcript when `terminalReply` is display-truncated

### Known limitations (not install blockers)

1. **Role-specific model routing is not wired yet.** All roles currently execute through one OpenClaw runtime/agent id. The intended PM/TL/Debugger/local-Dev model pools are future wiring.
2. **Cross-project resource scheduling is not global yet.** Multiple Ariad projects may compete for CPU/GPU independently.
3. **Project execution is currently sequential at the Coordinator level.** The TaskGraph can express dependency parallelism, but production dispatch is not yet a general concurrent executor.
4. **Ariad manages its own project workspace.** Existing repositories should be fetched into that workspace before `start`; Ariad does not currently attach an arbitrary external folder in place.
5. **Production source-control push is enabled by default.** A real project must have a usable Git remote named `origin`. Use `ARIAD_SOURCE_CONTROL_PUSH=0` only for a local smoke test or deliberately local-only project.

## 2. Prerequisites

Recommended environment: Linux or WSL2.

Required:

- Git
- Node.js 24.x
- npm
- OpenClaw >= 2026.9.4
- a working OpenClaw model/provider configuration

Verify:

```bash
git --version
node --version
npm --version
openclaw --version
```

Node should be 24.x. OpenClaw must be 2026.9.4 or newer.

## 3. Clone and verify Ariad

```bash
git clone https://github.com/shootingsyh/Ariad.git
cd Ariad
git checkout main
git pull --ff-only
npm test
```

Do not continue if the root deterministic test suite fails.

## 4. Build and validate the OpenClaw plugin

```bash
cd extensions/openclaw-ariad
npm install
npm test
npm run plugin:validate
```

Expected: all plugin/runtime/controller tests pass and OpenClaw reports the Ariad plugin as valid.

## 5. Install the plugin into OpenClaw

From `Ariad/extensions/openclaw-ariad`:

```bash
openclaw plugins install --link .
openclaw plugins inspect ariad
```

The plugin id is `ariad` and it exposes one user-facing tool:

```text
ariad_project
```

Restart the OpenClaw Gateway after installation using the normal mechanism for the machine.

If running the Gateway manually for development, start it only after setting the environment variables described below.

## 6. Environment variables

### Local smoke test

For a first local test, disable push:

```bash
export ARIAD_SOURCE_CONTROL_PUSH=0
export ARIAD_OPENCLAW_AGENT_ID=main
```

Optional custom project root:

```bash
export ARIAD_PROJECTS_ROOT="$HOME/.openclaw/ariad/projects"
```

The shown project root is already the default; setting it explicitly is optional.

### Real project / normal production behavior

Production defaults to:

```text
ARIAD_SOURCE_CONTROL_PUSH = enabled
remote = origin
```

Therefore, before starting real work, make sure the managed workspace has a valid `origin`.

Do **not** set `ARIAD_SOURCE_CONTROL_PUSH=0` if automatic push is desired.

## 7. Project Agent binding

Create the project from the OpenClaw conversation that should remain the human-facing PM / Project Agent conversation.

This matters because Ariad binds the creating session to the project. Later:

- current-state summaries are delivered back to that session
- `NEEDS_HUMAN` questions are delivered there
- only that bound Project Agent session may submit the corresponding user decision

Example user request in that conversation:

```text
Create an Ariad project called demo-app with goal:
"Build a minimal health feature end to end."
Do not start it yet.
```

The Project Agent should call:

```text
ariad_project(action="create", name="demo-app", goal="...")
```

Ariad creates:

```text
~/.openclaw/ariad/projects/demo-app/
  project.json
  workspace/
    .git/
  .ariad/
```

A new workspace is initialized automatically as a Git repository on branch `main`.

## 8. New greenfield project

For a purely local smoke test with push disabled, creation is enough.

Start from the same Project Agent conversation:

```text
Start the Ariad project demo-app.
```

For a real project with push enabled, configure `origin` first:

```bash
cd ~/.openclaw/ariad/projects/demo-app/workspace
git remote add origin <YOUR_GIT_REMOTE_URL>
git remote -v
```

Then ask the bound Project Agent to start the project.

## 9. Existing repository

Create the Ariad project first, but **do not start it yet**.

Then populate the managed workspace from the existing remote repository.

Example for a repository whose desired branch is `main`:

```bash
cd ~/.openclaw/ariad/projects/<project-id>/workspace
git remote add origin <EXISTING_REPOSITORY_URL>
git fetch origin
git checkout -B main origin/main
git status
```

If the repository uses a different branch, replace `main` accordingly.

Only after the files are present should the Project Agent start Ariad.

On first start Ariad will:

```text
survey workspace
→ TL existing-project discovery
→ durable current-state / architecture reconstruction
→ PM current-state review
→ notify Project Agent with the reconstructed current state
→ TL requirement planning
→ PM plan review
→ TaskGraph execution
```

The discovery survey ignores generated/heavy folders such as:

```text
.git
.ariad
node_modules
dist
build
.next
coverage
```

## 10. What TL planning produces

Durable planning artifacts are stored under:

```text
<project>/.ariad/project/
  brief.json
  workspace-survey.json
  current-state.json
  current-state-review.json
  architecture.json
  contracts.json
  dependencies.json
  vertical-slices.json
  technical-direction.json
  decomposition.json
  project-model.json
  plan-review.json
  task-graph.json
  project-agent-events.jsonl
  human-decisions.jsonl
```

The planning rule is:

> Design globally, implement vertically.

And:

> TL designs; Developer implements.

If TL decides a vertical slice needs an interface, executable contract test, fake provider, or walking skeleton, those must become explicit Tasks. TL does not implement them directly.

Typical generated task sequence:

```text
CONTRACT_INTERFACE
  ↓
CONTRACT_TEST
  ↓
FAKE_PROVIDER   (only when useful)
  ↓
VERTICAL_SKELETON
  ↓
IMPLEMENTATION / REFACTOR tasks as the architecture evolves
```

Contracts are living architecture, not immutable upfront design.

## 11. Source-control behavior

Reviewer never commits or pushes.

After Reviewer PASS, Ariad's source-control finalizer runs:

```text
git add -A
git commit -m "Ariad: <taskId> (strategy <n>, cycle <n>)"
git push origin HEAD      # when push is enabled
```

Commit identity is currently:

```text
Ariad <ariad@localhost>
```

A commit/push failure is treated as a system failure, not a Reviewer rejection.

Before real use, verify:

```bash
cd ~/.openclaw/ariad/projects/<project-id>/workspace
git status
git branch --show-current
git remote -v
git ls-remote origin
```

## 12. Human decision flow

When Ariad needs a real product/user decision:

```text
TL / PM / Project Debugger
→ NEEDS_HUMAN
→ durable event
→ bound Project Agent conversation
→ user answers
→ Project Agent calls ariad_project(action="decide", ...)
→ durable decision
→ same requesting stage resumes
```

A decision may only be submitted once for each pending human request, and it must come from the bound Project Agent session.

## 13. Useful Project Agent operations

The exposed tool supports:

```text
create
list
status
start
stop
decide
```

Natural-language examples:

```text
List my Ariad projects.
Show the status of demo-app.
Start demo-app.
Stop demo-app.
```

For a pending decision, simply answer the Project Agent's question in the same conversation. The Project Agent should translate the answer into the `decide` action.

## 14. Smoke-test checklist

After installation:

1. Restart OpenClaw Gateway.
2. Confirm `openclaw plugins inspect ariad` sees the plugin.
3. Set `ARIAD_SOURCE_CONTROL_PUSH=0` for the smoke test.
4. Create a tiny project from an OpenClaw conversation.
5. Start it from the same conversation.
6. Verify the project progresses through TL → PM → Developer → Tester → Reviewer.
7. Verify files appear under `.ariad/project/`.
8. Verify `.ariad/state.db` exists.
9. Verify the workspace receives Ariad commits after accepted Tasks.
10. Stop/restart OpenClaw and confirm a RUNNING desired state is reconciled from durable project state.

For production, re-enable default push behavior and verify `origin` before starting work.

## 15. Troubleshooting

### Plugin is not visible

Re-run:

```bash
cd Ariad/extensions/openclaw-ariad
npm run plugin:validate
openclaw plugins install --link .
openclaw plugins inspect ariad
```

Then restart the Gateway.

### Project fails at source-control finalization

Check:

```bash
cd ~/.openclaw/ariad/projects/<project-id>/workspace
git rev-parse --is-inside-work-tree
git remote -v
git status
```

If this is intentionally a local-only test, restart the Gateway with:

```bash
export ARIAD_SOURCE_CONTROL_PUSH=0
```

### Existing repository was started before files were imported

Stop the project, populate the managed workspace, remove/recreate the project if necessary so discovery starts from a clean durable state, then start again.

### TL planning returns invalid JSON

Current runtime code automatically retries parsing from the full OpenClaw session transcript if the displayed `terminalReply` was truncated. If this still occurs, inspect the OpenClaw subagent session and Ariad project logs/state before changing the Project Model schema.

## 16. Current go/no-go

**Go for local installation and end-to-end testing.**

Before using Ariad as a production autonomous engineering runner, keep these constraints in mind:

- use a valid Git `origin` when push is enabled
- role-specific model routing is not implemented yet
- cross-project resource arbitration is not implemented yet
- true parallel Task dispatch is not implemented yet

None of those prevent a single-project, single-runtime installation from exercising the full current Ariad workflow.
