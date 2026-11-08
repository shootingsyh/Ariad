import { DatabaseSync } from 'node:sqlite';
import { openGuardedDatabase } from './db-open-guard.js';
import { createHash } from 'node:crypto';

// Versioned spec store (DB-first architecture, 2026-10-31):
// - Task/contract SPECS live in spec_versions (draft -> prod via promotion).
// - EXECUTION records live in exec_tasks and persist across spec versions.
// - The scheduler-facing task view is prod specs joined with exec records.

export const DELIVERY_KINDS = ['FEATURE_TASK', 'INTEGRATION_TASK', 'MILESTONE_TASK'];
const GATE_STATES_FROZEN = ['DONE', 'NEEDS_HUMAN', 'SYSTEM_BLOCKED'];
const GATE_STATES_IN_FLIGHT = ['WORKING', 'RESULT_READY'];
// Terminal states carry no unfinished work, so a draft may drop their
// specs without losing anything the promotion gate exists to protect.
const GATE_STATES_TERMINAL = ['SKIPPED', 'OBSOLETE'];

// Executed work survives in the exec record even when the task itself is
// back in READY between stages: a recorded role result, a consumed
// interruption (the attempt ran and may have left working-tree changes),
// or a live execution handle. A task with none of these has never started.
function hasExecutedWork(data) {
  if (!data) return false;
  if (data.execution) return true;
  return (data.history ?? []).some(entry =>
    entry?.type === 'ROLE_RESULT'
    || (entry?.type === 'SYSTEM_INTERRUPTION' && entry?.consumeAttempt !== false));
}

// A started task sits between stages (typically READY) with executed
// stages already in its history: not frozen, not in flight, but dropping
// or re-signing its spec would orphan the finished stages.
function isStartedTask(state, data) {
  return !GATE_STATES_FROZEN.includes(state)
    && !GATE_STATES_IN_FLIGHT.includes(state)
    && !GATE_STATES_TERMINAL.includes(state)
    && hasExecutedWork(data);
}

function nowIso() { return new Date().toISOString(); }
function encode(v) { return JSON.stringify(v ?? null); }
function decode(v) { return v == null ? null : JSON.parse(v); }

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

export function gateSignature(spec) {
  if (!spec) return null;
  return stableStringify({
    parentId: spec.parentId ?? null,
    executionMode: spec.executionMode ?? null,
    dependsOn: [...(spec.dependsOn ?? [])].sort(),
    interfaceIds: [...(spec.interfaceIds ?? [])].sort(),
  });
}

function fail(code, message, details = undefined) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  throw err;
}

export class VersionedStore {
  constructor(file) {
    if (!file) throw new Error('VersionedStore requires a database file path');
    this.filePath = file;
    this.db = null;
    this.#open();
  }

  // (Re)opens the connection and (re)applies pragmas and schema; every
  // schema statement is CREATE IF NOT EXISTS, so reopening is idempotent.
  #open() {
    // Same guarded open as the runtime store (db-open-guard.js): an
    // existing empty/corrupt file hard-fails instead of initializing.
    this.db = openGuardedDatabase(this.filePath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS spec_versions (
        version INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        base_version INTEGER,
        created_by TEXT,
        created_at TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        requirements_hash TEXT,
        content_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS spec_tasks (
        version INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        PRIMARY KEY (version, task_id)
      );
      CREATE TABLE IF NOT EXISTS spec_contracts (
        version INTEGER NOT NULL,
        contract_id TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        PRIMARY KEY (version, contract_id)
      );
      CREATE TABLE IF NOT EXISTS exec_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        embedded INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_exec_tasks_project ON exec_tasks(project_id);
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  // See SQLiteV2Store.reopen: drop a stale cached handle so subsequent
  // operations run on a fresh connection.
  reopen() {
    if (this.db) {
      try { this.db.close(); } catch { /* already dead: reopening anyway */ }
      this.db = null;
    }
    this.#open();
  }

  close() { this.db.close(); }

  #metaGet(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }
  #metaSet(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  initProject(projectId) {
    if (!projectId) throw new Error('projectId is required');
    this.#metaSet('project_id', projectId);
    return projectId;
  }
  get projectId() { return this.#metaGet('project_id'); }

  #versionRow(version) {
    return this.db.prepare('SELECT * FROM spec_versions WHERE version = ?').get(version) ?? null;
  }
  listVersions() {
    return this.db.prepare('SELECT * FROM spec_versions ORDER BY version').all();
  }
  getProdVersion() {
    const v = this.#metaGet('prod_version');
    return v == null ? null : Number(v);
  }
  getOpenDraft() {
    return this.db.prepare("SELECT * FROM spec_versions WHERE state = 'draft' ORDER BY version DESC LIMIT 1").get() ?? null;
  }

  createDraft({ createdBy = null, requirementsHash = null } = {}) {
    if (this.getOpenDraft()) fail('DRAFT_ALREADY_OPEN', 'a draft version is already open');
    const prod = this.getProdVersion();
    const maxRow = this.db.prepare('SELECT MAX(version) AS m FROM spec_versions').get();
    const version = (maxRow?.m ?? 0) + 1;
    const ts = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO spec_versions (version, state, base_version, created_by, created_at, requirements_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(version, 'draft', prod, createdBy, ts, requirementsHash);
      if (prod != null) {
        this.db.prepare('INSERT INTO spec_tasks (version, task_id, spec_json) SELECT ?, task_id, spec_json FROM spec_tasks WHERE version = ?')
          .run(version, prod);
        this.db.prepare('INSERT INTO spec_contracts (version, contract_id, contract_json) SELECT ?, contract_id, contract_json FROM spec_contracts WHERE version = ?')
          .run(version, prod);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.#versionRow(version);
  }

  // The open draft named as the base of a live PM plan revision is the
  // lineage the next planning batch must CONTINUE, not a scratch draft:
  // discarding it forces the revision to be re-derived from prod, which
  // is how already-accepted fixes kept evaporating between revision
  // rounds (SRPG 2026-11-02: drafts v64-v69 were each re-seeded from
  // prod v63 and discarded, so the same PM findings survived five
  // rounds). The planning tables share this database file in
  // production; a store file without them (unit fixtures) simply has
  // no revision base.
  revisionBaseDraftVersion() {
    const draft = this.getOpenDraft();
    if (!draft) return null;
    try {
      const table = this.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'v2_planning_requests'").get();
      if (!table) return null;
      const rows = this.db.prepare("SELECT data_json FROM v2_planning_requests WHERE state IN ('PENDING', 'CLAIMED')").all();
      for (const row of rows) {
        let parsed = null;
        try { parsed = JSON.parse(row.data_json); } catch { continue; }
        const request = parsed?.request ?? null;
        if (request?.purpose === 'PM_PLAN_REVISION' && Number(request?.rejectedDraftVersion) === draft.version) return draft.version;
      }
    } catch { return null; }
    return null;
  }

  discardDraft({ force = false } = {}) {
    const draft = this.getOpenDraft();
    if (!draft) fail('NO_OPEN_DRAFT', 'no draft version is open');
    if (!force && this.openDraftIsRevisionLineage()) {
      fail('DRAFT_IS_REVISION_BASE', `draft v${draft.version} belongs to the lineage of a pending PM plan revision; discarding it would drop the fixes that revision exists to carry - continue the lineage with openRevisionDraft instead (an operator may force-discard through the debug checkpoint)`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM spec_tasks WHERE version = ?').run(draft.version);
      this.db.prepare('DELETE FROM spec_contracts WHERE version = ?').run(draft.version);
      this.db.prepare("UPDATE spec_versions SET state = 'discarded' WHERE version = ?").run(draft.version);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return draft.version;
  }

  // The open draft is protected while a live PM revision targets its
  // lineage: either it IS the named rejected draft, or it is the
  // revision continuation minted from a superseded named draft
  // (createRevisionDraft below). Discarding either drops the fixes the
  // revision exists to carry.
  openDraftIsRevisionLineage() {
    if (this.revisionBaseDraftVersion() != null) return true;
    const draft = this.getOpenDraft();
    if (!draft) return false;
    try {
      const table = this.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'v2_planning_requests'").get();
      if (!table) return false;
      const rows = this.db.prepare("SELECT data_json FROM v2_planning_requests WHERE state IN ('PENDING', 'CLAIMED')").all();
      for (const row of rows) {
        let parsed = null;
        try { parsed = JSON.parse(row.data_json); } catch { continue; }
        const request = parsed?.request ?? null;
        if (request?.purpose !== 'PM_PLAN_REVISION') continue;
        const named = this.#versionRow(Number(request?.rejectedDraftVersion));
        if (named && named.state === 'superseded' && named.base_version === draft.base_version && named.created_at <= draft.created_at) return true;
      }
    } catch { return false; }
    return false;
  }

  // A PM revision continues the rejected draft's LINEAGE but not its
  // version identity: mint the next version seeded from the rejected
  // draft and close the rejected one as 'superseded', its content
  // retained for diffing and audit (owner directive 2026-11-02: an
  // update gets a new minor version). Editing the rejected version in
  // place left every round answering to the same version number, so
  // PM reports named a draft whose content had already changed
  // underneath the name (SRPG batch-75: repairs landed in v70 in
  // place; PM, owner and TL all still called it "v70").
  createRevisionDraft({ createdBy = null } = {}) {
    const draft = this.getOpenDraft();
    if (!draft) fail('NO_OPEN_DRAFT', 'no open draft exists to continue as a new version');
    if (this.revisionBaseDraftVersion() !== draft.version) {
      fail('NOT_A_REVISION_BASE', `draft v${draft.version} is not the rejected draft named by a pending PM plan revision - if this batch's revision draft is already open, continue it with applyOps; openRevisionDraft only mints the next version from the named rejected draft`);
    }
    const maxRow = this.db.prepare('SELECT MAX(version) AS m FROM spec_versions').get();
    const version = (maxRow?.m ?? 0) + 1;
    const ts = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE spec_versions SET state = 'superseded' WHERE version = ?").run(draft.version);
      this.db.prepare('INSERT INTO spec_versions (version, state, base_version, created_by, created_at, requirements_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(version, 'draft', draft.base_version, createdBy, ts, draft.requirements_hash);
      this.db.prepare('INSERT INTO spec_tasks (version, task_id, spec_json) SELECT ?, task_id, spec_json FROM spec_tasks WHERE version = ?')
        .run(version, draft.version);
      this.db.prepare('INSERT INTO spec_contracts (version, contract_id, contract_json) SELECT ?, contract_id, contract_json FROM spec_contracts WHERE version = ?')
        .run(version, draft.version);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { ...this.#versionRow(version), supersededVersion: draft.version };
  }

  listSpecTasks(version) {
    return this.db.prepare('SELECT task_id, spec_json FROM spec_tasks WHERE version = ? ORDER BY rowid')
      .all(version).map(r => ({ ...decode(r.spec_json), id: r.task_id }));
  }
  getSpecTask(version, taskId) {
    const row = this.db.prepare('SELECT spec_json FROM spec_tasks WHERE version = ? AND task_id = ?').get(version, taskId);
    return row ? { ...decode(row.spec_json), id: taskId } : null;
  }
  listSpecContracts(version) {
    return this.db.prepare('SELECT contract_id, contract_json FROM spec_contracts WHERE version = ? ORDER BY rowid')
      .all(version).map(r => ({ ...decode(r.contract_json), id: r.contract_id }));
  }
  getSpecContract(version, contractId) {
    const row = this.db.prepare('SELECT contract_json FROM spec_contracts WHERE version = ? AND contract_id = ?').get(version, contractId);
    return row ? { ...decode(row.contract_json), id: contractId } : null;
  }

  // ---- TL draft writes -------------------------------------------------

  #validateTaskSpec(task, errors) {
    if (!task || typeof task !== 'object') { errors.push('task spec must be an object'); return; }
    if (!task.id || typeof task.id !== 'string') errors.push('task.id is required');
    if (!DELIVERY_KINDS.includes(task.taskKind)) errors.push(`task ${task.id ?? '?'}: taskKind must be one of ${DELIVERY_KINDS.join('/')}`);
    if (!task.title || typeof task.title !== 'string' || !task.title.trim()) errors.push(`task ${task.id ?? '?'}: title is required`);
    if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) errors.push(`task ${task.id}: dependsOn must be an array`);
    if (task.interfaceIds !== undefined && !Array.isArray(task.interfaceIds)) errors.push(`task ${task.id}: interfaceIds must be an array`);
  }

  #validateContract(contract, errors) {
    if (!contract || typeof contract !== 'object') { errors.push('contract must be an object'); return; }
    const id = contract.id ?? contract.nodeId;
    if (!id) errors.push('contract.id is required');
    const nodeType = contract.nodeType ?? contract.kind;
    if (!['feature', 'milestone'].includes(nodeType)) errors.push(`contract ${id ?? '?'}: nodeType must be feature|milestone`);
    const scenarios = contract.integrationScenarios ?? [];
    if (!Array.isArray(scenarios)) errors.push(`contract ${id}: integrationScenarios must be an array`);
    if (nodeType === 'milestone') {
      if (Array.isArray(contract.behavior) && contract.behavior.length) {
        errors.push(`contract ${id}: milestone contracts must not carry behavior clauses`);
      }
    } else if (nodeType === 'feature') {
      if (scenarios.length) {
        scenarios.forEach((s, i) => {
          if (!Array.isArray(s?.acceptanceCriteria) || !s.acceptanceCriteria.length) {
            errors.push(`contract ${id}: integrationScenarios[${i}] requires acceptanceCriteria`);
          }
        });
      } else {
        const b = contract.behavior;
        if (!Array.isArray(b) || !b.length || b.some(x => typeof x !== 'string' || !x.trim())) {
          errors.push(`contract ${id}: leaf feature contracts require a non-empty behavior clause list`);
        }
      }
    }
  }

  validateVersion(version) {
    const errors = [];
    const tasks = this.listSpecTasks(version);
    const contracts = this.listSpecContracts(version);
    const taskIds = new Set(tasks.map(t => t.id));
    for (const t of tasks) this.#validateTaskSpec(t, errors);
    for (const t of tasks) {
      if (t.parentId != null && !taskIds.has(t.parentId)) errors.push(`task ${t.id}: parentId ${t.parentId} not in version ${version}`);
      for (const dep of t.dependsOn ?? []) {
        if (dep === t.id) errors.push(`task ${t.id}: dependsOn itself`);
        else if (!taskIds.has(dep)) errors.push(`task ${t.id}: dependsOn ${dep} not in version ${version}`);
      }
    }
    // dependency cycle check (DFS over dependsOn edges)
    const byId = new Map(tasks.map(t => [t.id, t]));
    const mark = new Map();
    const visit = (id, path) => {
      if (mark.get(id) === 1) { errors.push(`dependency cycle: ${[...path, id].join(' -> ')}`); return; }
      if (mark.get(id) === 2) return;
      mark.set(id, 1);
      for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep, [...path, id]);
      mark.set(id, 2);
    };
    for (const t of tasks) visit(t.id, []);
    // contract refs: exported interface ids across this version's contracts
    const exported = new Set();
    for (const c of contracts) {
      this.#validateContract(c, errors);
      for (const x of c.exportedInterfaces ?? []) exported.add(typeof x === 'string' ? x : x?.id);
      exported.add(c.id ?? c.nodeId);
    }
    for (const t of tasks) {
      for (const iid of t.interfaceIds ?? []) {
        if (!exported.has(iid)) errors.push(`task ${t.id}: interfaceId ${iid} is not exported by any contract in version ${version}`);
      }
    }
    // Two trees, kept separate (owner model, 2026-10-31): contracts form the
    // FEATURE tree - the reference SoT, organized by parentId - while spec
    // tasks form the milestone/task tree and REFERENCE feature nodes via
    // featureId. Milestones never appear as feature structure.
    const contractById = new Map(contracts.map(c => [c.id ?? c.nodeId, c]));
    for (const c of contracts) {
      const cid = c.id ?? c.nodeId;
      if (c.parentId != null) {
        if (c.parentId === cid) errors.push(`contract ${cid}: parentId must not be itself`);
        else if (!contractById.has(c.parentId)) errors.push(`contract ${cid}: parentId ${c.parentId} not in version ${version}`);
        else if ((contractById.get(c.parentId).nodeType ?? contractById.get(c.parentId).kind) !== 'feature') {
          errors.push(`contract ${cid}: parentId ${c.parentId} is not a feature node`);
        }
      }
    }
    const cmark = new Map();
    const cvisit = (id, path) => {
      if (cmark.get(id) === 1) { errors.push(`feature tree cycle: ${[...path, id].join(' -> ')}`); return; }
      if (cmark.get(id) === 2) return;
      cmark.set(id, 1);
      const parent = contractById.get(id)?.parentId;
      if (parent != null && contractById.has(parent)) cvisit(parent, [...path, id]);
      cmark.set(id, 2);
    };
    for (const c of contracts) cvisit(c.id ?? c.nodeId, []);
    for (const t of tasks) {
      const target = t.featureId != null ? contractById.get(t.featureId) : null;
      if (t.taskKind === 'FEATURE_TASK') {
        if (t.featureId == null) errors.push(`task ${t.id}: FEATURE_TASK requires featureId referencing a feature-tree node`);
        else if (!target) errors.push(`task ${t.id}: featureId ${t.featureId} not in version ${version}`);
        else if ((target.nodeType ?? target.kind) !== 'feature') errors.push(`task ${t.id}: featureId ${t.featureId} is not a feature node`);
      } else if (t.taskKind === 'MILESTONE_TASK') {
        if (t.featureId != null) errors.push(`task ${t.id}: MILESTONE_TASK must not carry featureId - milestones organize the task tree, features live in the feature tree`);
      } else if (t.featureId != null && !target) {
        errors.push(`task ${t.id}: featureId ${t.featureId} not in version ${version}`);
      }
    }
    return errors;
  }

  applyTreeOps(ops) {
    const draft = this.getOpenDraft();
    if (!draft) fail('NO_OPEN_DRAFT', 'no draft version is open');
    if (typeof ops === 'string') {
      // Same string-encoded-ops tolerance as the tool layer: parse it
      // here too so direct store callers get the same behaviour.
      try { ops = JSON.parse(ops); } catch {
        fail('OPS_NOT_ARRAY', 'ops must be an array of operation objects like [{"op":"upsertTask","task":{...}}]; the string passed was not valid JSON');
      }
    }
    if (!Array.isArray(ops) || !ops.length) fail('OPS_NOT_ARRAY', 'ops must be a non-empty ARRAY of operation objects like [{"op":"upsertTask","task":{"id":"...","taskKind":"FEATURE_TASK","title":"..."}}] - pass the array itself, not a JSON string or a single object');
    const version = draft.version;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      ops.forEach((op, index) => {
        const at = `ops[${index}]`;
        if (!op || typeof op !== 'object' || !op.op) fail('BAD_OP', `${at}: op.op is required - each ops entry must be an object like {"op":"upsertTask","task":{...}}, {"op":"removeTask","taskId":"..."}, {"op":"upsertContract","contract":{...}} or {"op":"removeContract","contractId":"..."}`);
        if (op.op === 'upsertTask') {
          const task = op.task ?? {};
          const { id, ...spec } = task;
          if (!id) fail('BAD_OP', `${at}: upsertTask requires task.id`);
          this.db.prepare('INSERT INTO spec_tasks (version, task_id, spec_json) VALUES (?, ?, ?) ON CONFLICT(version, task_id) DO UPDATE SET spec_json = excluded.spec_json')
            .run(version, id, encode(spec));
        } else if (op.op === 'removeTask') {
          if (!op.taskId) fail('BAD_OP', `${at}: removeTask requires taskId`);
          this.db.prepare('DELETE FROM spec_tasks WHERE version = ? AND task_id = ?').run(version, op.taskId);
        } else if (op.op === 'upsertContract') {
          const contract = op.contract ?? {};
          const cid = contract.id ?? contract.nodeId;
          if (!cid) fail('BAD_OP', `${at}: upsertContract requires contract.id`);
          const { id, ...rest } = contract;
          this.db.prepare('INSERT INTO spec_contracts (version, contract_id, contract_json) VALUES (?, ?, ?) ON CONFLICT(version, contract_id) DO UPDATE SET contract_json = excluded.contract_json')
            .run(version, cid, encode(rest));
        } else if (op.op === 'removeContract') {
          if (!op.contractId) fail('BAD_OP', `${at}: removeContract requires contractId`);
          this.db.prepare('DELETE FROM spec_contracts WHERE version = ? AND contract_id = ?').run(version, op.contractId);
        } else {
          fail('BAD_OP', `${at}: unknown op ${op.op}`);
        }
      });
      const errors = this.validateVersion(version);
      if (errors.length) fail('TREE_VALIDATION_FAILED', `draft version ${version} failed validation`, errors);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { draftVersion: version, applied: ops.length };
  }

  diffDraft() {
    const draft = this.getOpenDraft();
    if (!draft) fail('NO_OPEN_DRAFT', 'no draft version is open');
    const base = draft.base_version;
    const baseTasks = new Map((base == null ? [] : this.listSpecTasks(base)).map(t => [t.id, t]));
    const draftTasks = new Map(this.listSpecTasks(draft.version).map(t => [t.id, t]));
    const baseContracts = new Map((base == null ? [] : this.listSpecContracts(base)).map(c => [c.id, c]));
    const draftContracts = new Map(this.listSpecContracts(draft.version).map(c => [c.id, c]));
    const changed = (a, b) => stableStringify(a) !== stableStringify(b);
    const out = {
      draftVersion: draft.version, baseVersion: base,
      tasks: { added: [], removed: [], changed: [] },
      contracts: { added: [], removed: [], changed: [] },
    };
    for (const [id, t] of draftTasks) {
      if (!baseTasks.has(id)) out.tasks.added.push(id);
      else if (changed(baseTasks.get(id), t)) out.tasks.changed.push(id);
    }
    for (const id of baseTasks.keys()) if (!draftTasks.has(id)) out.tasks.removed.push(id);
    for (const [id, c] of draftContracts) {
      if (!baseContracts.has(id)) out.contracts.added.push(id);
      else if (changed(baseContracts.get(id), c)) out.contracts.changed.push(id);
    }
    for (const id of baseContracts.keys()) if (!draftContracts.has(id)) out.contracts.removed.push(id);
    out.protectedTasks = this.protectedTasks();
    out.promotionBlockers = this.promotionBlockers(draft.version);
    return out;
  }

  contentHash(version) {
    const tasks = this.listSpecTasks(version).sort((a, b) => a.id.localeCompare(b.id));
    const contracts = this.listSpecContracts(version).sort((a, b) => a.id.localeCompare(b.id));
    return sha256(stableStringify({ tasks, contracts }));
  }

  // Executed-work protection, made visible BEFORE promotion: the frozen
  // set (DONE / NEEDS_HUMAN / SYSTEM_BLOCKED), the in-flight set
  // (WORKING / RESULT_READY) and the started set (between stages, e.g.
  // READY, with executed stages in history) are execution-side facts
  // that spec drafts do not carry, so planners historically learned them
  // one promotion refusal at a time (SRPG batch-60: three gate rounds,
  // one task each). protectedTasks lists them; promotionBlockers checks
  // a draft against prod for ALL of them at once.
  protectedTasks() {
    const frozen = [];
    const inFlight = [];
    const started = [];
    for (const ex of this.listExecTasks()) {
      if (ex.embedded) continue;
      const state = ex.data?.state;
      if (GATE_STATES_FROZEN.includes(state)) frozen.push({ id: ex.id, state });
      else if (GATE_STATES_IN_FLIGHT.includes(state)) inFlight.push({ id: ex.id, state });
      else if (isStartedTask(state, ex.data)) started.push({ id: ex.id, state });
    }
    return { frozen, inFlight, started };
  }

  promotionBlockers(draftVersion) {
    const prod = this.getProdVersion();
    const blockers = [];
    for (const ex of this.listExecTasks()) {
      if (ex.embedded) continue;
      const state = ex.data?.state;
      const frozen = GATE_STATES_FROZEN.includes(state);
      const inFlight = GATE_STATES_IN_FLIGHT.includes(state);
      // Started tasks are executed work too (SRPG fix-cinematic,
      // 2026-11-06: developer PASS recorded, task back in READY at
      // test_engineer, a later promotion dropped its spec and the
      // orphan was silently reclassified OBSOLETE - the project
      // SUCCEEDED without it). Protect them like frozen tasks.
      const started = isStartedTask(state, ex.data);
      if (!frozen && !inFlight && !started) continue;
      const draftSpec = this.getSpecTask(draftVersion, ex.id);
      const prodSpec = prod == null ? null : this.getSpecTask(prod, ex.id);
      if (!draftSpec) {
        blockers.push(frozen
          ? { id: ex.id, state, reason: 'removed', code: 'PROMOTION_REMOVES_EXECUTED_TASK', message: `draft removes ${state} task ${ex.id}` }
          : started
            ? { id: ex.id, state, reason: 'removed', code: 'PROMOTION_REMOVES_STARTED_TASK', message: `draft removes ${state} task ${ex.id} with executed stages in its history` }
            : { id: ex.id, state, reason: 'removed', code: 'UNIFIED_TASK_DELIVERY_IN_FLIGHT', message: `draft touches in-flight task ${ex.id}; promotion defers` });
      } else if (prodSpec && gateSignature(draftSpec) !== gateSignature(prodSpec)) {
        blockers.push(frozen
          ? { id: ex.id, state, reason: 'gate-signature-changed', code: state === 'DONE' ? 'REVISE_COMPLETED_TASK' : 'REVISE_BLOCKED_TASK', message: `draft changes the gate signature of ${state} task ${ex.id}` }
          : started
            ? { id: ex.id, state, reason: 'gate-signature-changed', code: 'REVISE_STARTED_TASK', message: `draft changes the gate signature of ${state} task ${ex.id} with executed stages in its history` }
            : { id: ex.id, state, reason: 'gate-signature-changed', code: 'UNIFIED_TASK_DELIVERY_IN_FLIGHT', message: `draft touches in-flight task ${ex.id}; promotion defers` });
      }
    }
    return blockers;
  }

  promoteDraft({ approvedBy = null } = {}) {
    const draft = this.getOpenDraft();
    if (!draft) fail('NO_OPEN_DRAFT', 'no draft version is open');
    const errors = this.validateVersion(draft.version);
    if (errors.length) fail('TREE_VALIDATION_FAILED', `draft version ${draft.version} failed validation`, errors);
    // Promotion guards: executed work is never silently rewritten or
    // dropped. ALL blockers are reported at once - reporting only the
    // first turned every repair round into whack-a-mole (SRPG batch-60:
    // the gate named one DONE task per round, three rounds running).
    const blockers = this.promotionBlockers(draft.version);
    if (blockers.length === 1) {
      const b = blockers[0];
      fail(b.code, b.message, { taskId: b.id, state: b.state, violations: blockers });
    }
    if (blockers.length > 1) {
      fail('PROMOTION_BLOCKED_BY_EXECUTED_WORK',
        `draft violates executed-work protection on ${blockers.length} tasks - restore every one of them to its production spec (or restore the removed task) before resubmitting: ${blockers.map(b => `${b.id} (${b.state}: ${b.reason})`).join(', ')}`,
        { violations: blockers });
    }
    const hash = this.contentHash(draft.version);
    const ts = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE spec_versions SET state = 'archived' WHERE state = 'prod'").run();
      this.db.prepare("UPDATE spec_versions SET state = 'prod', approved_by = ?, approved_at = ?, content_hash = ? WHERE version = ?")
        .run(approvedBy, ts, hash, draft.version);
      this.#metaSet('prod_version', draft.version);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { version: draft.version, contentHash: hash };
  }

  // ---- execution side ----------------------------------------------------

  upsertExecTask(record, { embedded = false } = {}) {
    if (!record?.id) throw new Error('exec task record.id is required');
    const projectId = record.projectId ?? this.projectId;
    if (!projectId) throw new Error('exec task projectId is required (initProject first)');
    const { id, projectId: _p, version, updatedAt, ...data } = record;
    const existing = this.getExecTask(id);
    const nextVersion = (existing?.version ?? 0) + 1;
    this.db.prepare('INSERT INTO exec_tasks (id, project_id, embedded, data_json, version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, embedded = excluded.embedded, version = excluded.version, updated_at = excluded.updated_at')
      .run(id, projectId, embedded ? 1 : 0, encode(data), nextVersion, nowIso());
    return this.getExecTask(id);
  }

  getExecTask(id) {
    const row = this.db.prepare('SELECT * FROM exec_tasks WHERE id = ?').get(id);
    if (!row) return null;
    return { id: row.id, projectId: row.project_id, embedded: !!row.embedded, data: decode(row.data_json), version: row.version, updatedAt: row.updated_at };
  }

  listExecTasks() {
    return this.db.prepare('SELECT * FROM exec_tasks ORDER BY rowid').all()
      .map(row => ({ id: row.id, projectId: row.project_id, embedded: !!row.embedded, data: decode(row.data_json), version: row.version, updatedAt: row.updated_at }));
  }

  updateExecTask(id, patch = {}, historyEntry = null) {
    const current = this.getExecTask(id);
    if (!current) throw new Error(`unknown exec task: ${id}`);
    const data = { ...current.data, ...structuredClone(patch) };
    if (historyEntry) data.history = [...(data.history ?? []), historyEntry];
    return this.upsertExecTask({ id, projectId: current.projectId, ...data }, { embedded: current.embedded });
  }

  effectiveTasks() {
    const prod = this.getProdVersion();
    const specs = prod == null ? [] : this.listSpecTasks(prod);
    const specIds = new Set(specs.map(s => s.id));
    const execById = new Map(this.listExecTasks().map(e => [e.id, e]));
    // milestoneId is never stored on a spec: it is the task's nearest
    // MILESTONE_TASK ancestor in the task tree (a milestone task's own id).
    const specById = new Map(specs.map(s => [s.id, s]));
    const milestoneOf = (spec) => {
      if (spec.taskKind === 'MILESTONE_TASK') return spec.id;
      const seen = new Set([spec.id]);
      let cursor = specById.get(spec.parentId);
      while (cursor && !seen.has(cursor.id)) {
        if (cursor.taskKind === 'MILESTONE_TASK') return cursor.id;
        seen.add(cursor.id);
        cursor = specById.get(cursor.parentId);
      }
      return null;
    };
    const out = [];
    for (const spec of specs) {
      // Media-production tasks (art.required) enter delivery at the artist
      // stage: the artist produces the named deliverables first, then the
      // executor hands off to developer for integration. The entry stage
      // only fills a stage that execution has not established yet - it
      // never rewinds a task that already has one.
      const entryStage = spec.art?.required ? 'artist' : 'developer';
      const ex = execById.get(spec.id);
      if (ex && !ex.embedded) {
        // Exec data is the execution face of the spec task (state, stage,
        // history, execution, artifacts, result fields, input overrides);
        // it can never carry spec fields - writers strip them (see
        // VersionedTaskStore), and upsertExecTask strips id/projectId.
        out.push({
          ...spec, ...ex.data, projectId: this.projectId, milestoneId: milestoneOf(spec),
          input: { ...(spec.input ?? {}), ...(ex.data.input ?? {}) },
          state: ex.data.state ?? 'READY', stage: ex.data.stage ?? entryStage,
          history: ex.data.history ?? [], execution: ex.data.execution ?? null,
          artifacts: ex.data.artifacts ?? null,
          version: ex.version, updatedAt: ex.updatedAt,
        });
      } else {
        out.push({ ...spec, projectId: this.projectId, milestoneId: milestoneOf(spec), state: 'READY', stage: entryStage, history: [], execution: null, artifacts: null, version: 1, updatedAt: null });
      }
    }
    for (const ex of this.listExecTasks()) {
      if (ex.embedded) {
        out.push({ ...ex.data, id: ex.id, projectId: ex.projectId, version: ex.version, updatedAt: ex.updatedAt });
      } else if (!specIds.has(ex.id)) {
        out.push({ id: ex.id, projectId: ex.projectId, state: ex.data.state === 'DONE' ? 'DONE' : 'OBSOLETE', stage: ex.data.stage ?? null, history: ex.data.history ?? [], execution: ex.data.execution ?? null, artifacts: ex.data.artifacts ?? null, specMissing: true, version: ex.version, updatedAt: ex.updatedAt });
      }
    }
    return out;
  }

  getEffectiveTask(id) {
    return this.effectiveTasks().find(t => t.id === id) ?? null;
  }

  // ---- live issues ----------------------------------------------------------

  createIssue(issue) {
    if (!issue?.id) throw new Error('issue.id is required');
    const projectId = issue.projectId ?? this.projectId;
    const ts = nowIso();
    const { id, projectId: _p, state, ...data } = issue;
    this.db.prepare('INSERT INTO issues (id, project_id, state, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, state ?? 'OPEN', encode(data), ts, ts);
    return this.getIssue(id);
  }
  getIssue(id) {
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
    return row ? { ...decode(row.data_json), id: row.id, projectId: row.project_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  listIssues({ states = null } = {}) {
    const rows = this.db.prepare('SELECT * FROM issues ORDER BY rowid').all();
    return rows.map(row => ({ ...decode(row.data_json), id: row.id, projectId: row.project_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }))
      .filter(i => !states || states.includes(i.state));
  }
  updateIssue(id, patch) {
    const current = this.getIssue(id);
    if (!current) throw new Error(`unknown issue: ${id}`);
    const { id: _i, projectId, state, createdAt, updatedAt, ...data } = { ...current, ...patch };
    this.db.prepare('UPDATE issues SET state = ?, data_json = ?, updated_at = ? WHERE id = ?')
      .run(state ?? current.state, encode(data), nowIso(), id);
    return this.getIssue(id);
  }
}
