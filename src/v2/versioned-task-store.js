import { VersionedStore, DELIVERY_KINDS } from './versioned-store.js';
import { scopeOfTask } from './control-task-policy.js';

// De-materialized task store for DB-first (versionedTree) projects
// (owner model, 2026-10-31). Two trees, one store file:
// - the FEATURE tree (contracts in the versioned store) is the reference
//   SoT and is never executed;
// - the MILESTONE/task tree lives as versioned specs (draft -> prod);
// - the scheduler executes the prod task tree directly: this facade
//   presents the runtime store's task interface, but delivery tasks are
//   read as prod spec joined with their exec record (VersionedStore
//   .effectiveTasks) and written to the exec record only. No spec is
//   ever copied into the runtime task table.
// Planning/control tasks, the project record, planning requests and
// issues remain in the runtime store - that is control-plane machinery,
// not a copy of the plan. Anything not implemented here is delegated to
// the runtime store via the Proxy fallback.
//
// insertTriagedFixTask is implemented on the facade: triaged fixes
// land in the standalone issue queue as embedded exec records.
const SPEC_OWNED_FIELDS = new Set([
  'taskKind', 'title', 'intent', 'parentId', 'dependsOn', 'interfaceIds',
  'featureId', 'executionMode', 'acceptanceCriteria', 'testStrategy',
  'logicalRefs', 'milestoneId', 'unifiedTaskSchemaVersion',
]);

export class VersionedTaskStore {
  constructor(runtimeStore) {
    if (!runtimeStore?.filePath) throw new Error('VersionedTaskStore requires a runtime store with filePath');
    this.runtime = runtimeStore;
    this.versioned = new VersionedStore(runtimeStore.filePath);
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        const delegated = target.runtime[prop];
        return typeof delegated === 'function' ? delegated.bind(target.runtime) : delegated;
      },
      set(target, prop, value) {
        if (prop in target) { target[prop] = value; return true; }
        target.runtime[prop] = value;
        return true;
      },
    });
  }

  get filePath() { return this.runtime.filePath; }
  get db() { return this.runtime.db; }

  close() {
    try { this.versioned.close(); } catch { /* already closed */ }
  }

  #effectiveById() {
    return new Map(this.versioned.effectiveTasks().map(t => [t.id, t]));
  }

  #isVersionedTask(id) {
    return this.#effectiveById().has(id);
  }

  getTask(id) {
    const eff = this.#effectiveById().get(id);
    if (eff) return eff;
    return this.runtime.getTask(id);
  }

  listTasks(projectId, filter = {}) {
    const merged = new Map();
    for (const task of this.runtime.listTasks(projectId)) merged.set(task.id, task);
    for (const task of this.versioned.effectiveTasks()) {
      if (task.projectId === projectId) merged.set(task.id, task);
    }
    return [...merged.values()].filter(task => {
      if (filter.scope && scopeOfTask(task) !== filter.scope) return false;
      if (filter.flowId && task.flowId !== filter.flowId) return false;
      return true;
    });
  }

  createTask(task) {
    if (scopeOfTask(task) === 'delivery') {
      if (this.getTask(task.id)) throw new Error(`task id already exists: ${task.id}`);
      this.versioned.upsertExecTask(structuredClone(task), { embedded: true });
      return this.getTask(task.id);
    }
    return this.runtime.createTask(task);
  }

  updateTask(id, expectedVersion, patch) {
    const eff = this.#effectiveById().get(id);
    if (!eff) return this.runtime.updateTask(id, expectedVersion, patch);
    if (eff.version !== expectedVersion) throw new Error(`task version conflict: ${id}`);
    const execPatch = {};
    for (const [key, value] of Object.entries(structuredClone(patch ?? {}))) {
      if (SPEC_OWNED_FIELDS.has(key)) continue;
      if (['id', 'projectId', 'version', 'updatedAt', 'specMissing'].includes(key)) continue;
      execPatch[key] = value;
    }
    const existing = this.versioned.getExecTask(id);
    if (existing) {
      this.versioned.updateExecTask(id, execPatch);
    } else {
      // A spec task with no exec record reports version 1; seed the
      // record first so this write lands at version 2 and optimistic
      // concurrency keeps the runtime store's semantics.
      this.versioned.upsertExecTask({ id, projectId: eff.projectId }, { embedded: false });
      this.versioned.updateExecTask(id, execPatch);
    }
    return this.getTask(id);
  }

  appendTaskHistory(id, expectedVersion, entry, patch = {}) {
    if (!this.#isVersionedTask(id)) return this.runtime.appendTaskHistory(id, expectedVersion, entry, patch);
    const current = this.getTask(id);
    if (!current) throw new Error(`unknown task: ${id}`);
    if (current.version !== expectedVersion) throw new Error(`task version conflict: ${id}`);
    return this.updateTask(id, expectedVersion, {
      ...patch,
      history: [...(current.history ?? []), structuredClone(entry)],
    });
  }

  // Issue queue (owner model, 2026-10-31): a TL-triaged fix becomes a
  // standalone embedded exec task in the issue queue - never a spec
  // node, never adopted into the task tree at the next version. Issue
  // records themselves live in the runtime store (the live issue path);
  // only the fix task lands on the versioned side.
  insertTriagedFixTask({ projectId, issueId, actor, task, beforeTaskIds = [] }) {
    if (actor !== 'tech_lead') throw new Error('FIX_TASK_REQUIRES_TECH_LEAD');
    if (!this.runtime.getProject(projectId)) throw new Error('unknown project');
    const issue = this.runtime.getIssue(issueId);
    if (!issue || issue.projectId !== projectId) throw new Error('unknown project issue');
    if (['RESOLVED', 'CLOSED', 'REJECTED', 'DUPLICATE'].includes(issue.state)) throw new Error('issue is closed');
    if (!task?.id || (task.taskKind != null && !DELIVERY_KINDS.includes(task.taskKind))) throw new Error('delivery fix task id required');
    if (!Array.isArray(beforeTaskIds) || new Set(beforeTaskIds).size !== beforeTaskIds.length) throw new Error('invalid insertion targets');
    if (this.getTask(task.id)) throw new Error('fix task id already exists');
    const existing = new Set(this.listTasks(projectId).map(item => item.id));
    for (const dep of task.dependsOn ?? []) {
      if (dep === task.id) throw new Error('fix task cannot depend on itself');
      if (!existing.has(dep)) throw new Error(`unknown dependency: ${dep}`);
    }
    const refs = [...new Set([...(task.issueRefs ?? []), issueId])];
    const fix = {
      ...structuredClone(task), projectId,
      taskKind: task.taskKind ?? 'FEATURE_TASK', issueRefs: refs,
      parentId: null, milestoneId: null, queue: 'issue',
      stage: task.stage ?? 'developer', state: task.state ?? 'READY', execution: task.execution ?? null,
      input: { ...(task.input ?? {}), issueRefs: refs, queue: 'issue' },
      history: [...(task.history ?? []), { type: 'TL_INSERT_FIX_TASK', issueId, at: new Date().toISOString() }],
    };
    if (fix.state !== 'READY' || fix.stage !== 'developer' || fix.execution) throw new Error('fix task must start READY/developer');
    const created = this.createTask(fix);
    const assignedTaskIds = [...new Set([...(issue.assignedTaskIds ?? []), fix.id])];
    this.runtime.updateIssue(issueId, {
      state: 'ASSIGNED', assignedTaskIds,
      triage: { ...(issue.triage ?? {}), disposition: 'ASSIGNED', decidedBy: 'tech_lead', insertedBefore: beforeTaskIds },
    });
    return created;
  }

  // Same rule as the runtime store, evaluated over the merged task view
  // so fixes living in the issue queue (embedded exec records) resolve
  // their issues when they finish.
  reconcileAssignedIssues(projectId) {
    const resolved = [];
    for (const issue of this.runtime.listIssues(projectId, { states: ['ASSIGNED'] })) {
      const ids = issue.assignedTaskIds ?? [];
      if (ids.length === 0) continue;
      if (!ids.every(id => this.getTask(id)?.state === 'DONE')) continue;
      this.runtime.updateIssue(issue.id, {
        state: 'RESOLVED',
        resolution: { kind: 'ASSIGNED_TASKS_DONE', taskIds: [...ids], at: new Date().toISOString() },
      });
      resolved.push(issue.id);
    }
    return resolved;
  }

  // Composite executor routes, composed over the routed primitives (the
  // runtime store's own versions transact inside its task table only;
  // here the two sides share one file but not one transaction - the
  // same atomicity the promotion path always had).
  applyExecutorBlockedRoute({ taskId, expectedVersion, patch, transitionHistory, blockedRoute, planningRequest = null }) {
    if (!blockedRoute?.taskId || blockedRoute.taskId === taskId) throw new Error('invalid blocked task route');
    const blocked = this.getTask(blockedRoute.taskId);
    if (!blocked) throw new Error(`unknown blocked task: ${blockedRoute.taskId}`);
    const current = this.getTask(taskId);
    if (!current || current.version !== expectedVersion) throw new Error(`task version conflict: ${taskId}`);
    if (blocked.projectId !== current.projectId) throw new Error('cross-project debugger route');
    if (current.input?.blockedTaskId !== blocked.id) throw new Error('debugger blocked task mismatch');
    if (current.stage !== 'project_debugger' || current.state !== 'RESULT_READY') throw new Error('debugger not ready to route');
    if (blocked.state !== 'SYSTEM_BLOCKED') throw new Error('blocked task is not system blocked');
    const updatedBlocked = this.appendTaskHistory(blocked.id, blocked.version, blockedRoute.history, blockedRoute.patch);
    let updated = this.updateTask(taskId, expectedVersion, patch);
    if (transitionHistory) updated = this.appendTaskHistory(taskId, updated.version, transitionHistory);
    if (planningRequest) this.runtime.enqueuePlanningRequest({ ...planningRequest, projectId: current.projectId });
    return { task: updated, blockedTask: updatedBlocked };
  }

  applyExecutorPlanningRequest({ taskId, expectedVersion, patch, transitionHistory, planningRequest, skipTaskIds = [] }) {
    if (!planningRequest?.id) throw new Error('missing executor planning request');
    const current = this.getTask(taskId);
    if (!current || current.version !== expectedVersion) throw new Error(`task version conflict: ${taskId}`);
    let updated = this.updateTask(taskId, expectedVersion, patch);
    if (transitionHistory) updated = this.appendTaskHistory(taskId, updated.version, transitionHistory);
    this.runtime.enqueuePlanningRequest({ ...planningRequest, projectId: current.projectId });
    for (const id of skipTaskIds) {
      const skipped = this.getTask(id);
      if (skipped && skipped.projectId !== current.projectId) throw new Error('cross-project skipped task');
      if (skipped?.state === 'READY') this.updateTask(id, skipped.version, { state: 'SKIPPED', execution: null });
    }
    return updated;
  }
}
