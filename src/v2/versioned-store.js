import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Versioned spec store (DB-first architecture, 2026-10-31):
// - Task/contract SPECS live in spec_versions (draft -> prod via promotion).
// - EXECUTION records live in exec_tasks and persist across spec versions.
// - The scheduler-facing task view is prod specs joined with exec records.
// - legacy_entries is a read-only reference zone seeded at cutover.

export const DELIVERY_KINDS = ['FEATURE_TASK', 'INTEGRATION_TASK', 'MILESTONE_TASK'];
const GATE_STATES_FROZEN = ['DONE', 'NEEDS_HUMAN', 'SYSTEM_BLOCKED'];
const GATE_STATES_IN_FLIGHT = ['WORKING', 'RESULT_READY'];

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
    this.db = new DatabaseSync(file);
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
      CREATE TABLE IF NOT EXISTS legacy_entries (
        kind TEXT NOT NULL,
        old_id TEXT NOT NULL,
        summary TEXT,
        payload_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        PRIMARY KEY (kind, old_id)
      );
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

  discardDraft() {
    const draft = this.getOpenDraft();
    if (!draft) fail('NO_OPEN_DRAFT', 'no draft version is open');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM spec_tasks WHERE version = ?').run(draft.version);
      this.db.prepare('DELETE FROM spec_contracts WHERE version = ?').run(draft.version);
      this.db.prepare("UPDATE spec_versions SET state = 'discarded' WHERE version = ?").run(draft.version);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return draft.version;
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
    return errors;
  }

  applyTreeOps(ops) {
    const draft = this.getOpenDraft();
    if (!draft) fail('NO_OPEN_DRAFT', 'no draft version is open');
    if (!Array.isArray(ops) || !ops.length) fail('EMPTY_OPS', 'ops must be a non-empty array');
    const version = draft.version;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      ops.forEach((op, index) => {
        const at = `ops[${index}]`;
        if (!op || typeof op !== 'object' || !op.op) fail('BAD_OP', `${at}: op.op is required`);
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
    return out;
  }

  contentHash(version) {
    const tasks = this.listSpecTasks(version).sort((a, b) => a.id.localeCompare(b.id));
    const contracts = this.listSpecContracts(version).sort((a, b) => a.id.localeCompare(b.id));
    return sha256(stableStringify({ tasks, contracts }));
  }

  promoteDraft({ approvedBy = null } = {}) {
    const draft = this.getOpenDraft();
    if (!draft) fail('NO_OPEN_DRAFT', 'no draft version is open');
    const errors = this.validateVersion(draft.version);
    if (errors.length) fail('TREE_VALIDATION_FAILED', `draft version ${draft.version} failed validation`, errors);
    const prod = this.getProdVersion();
    // Promotion guards: executed work is never silently rewritten or dropped.
    for (const ex of this.listExecTasks()) {
      if (ex.embedded) continue;
      const state = ex.data?.state;
      const draftSpec = this.getSpecTask(draft.version, ex.id);
      const prodSpec = prod == null ? null : this.getSpecTask(prod, ex.id);
      if (GATE_STATES_FROZEN.includes(state)) {
        if (!draftSpec) fail('PROMOTION_REMOVES_EXECUTED_TASK', `draft removes ${state} task ${ex.id}`, { taskId: ex.id, state });
        if (prodSpec && gateSignature(draftSpec) !== gateSignature(prodSpec)) {
          fail(state === 'DONE' ? 'REVISE_COMPLETED_TASK' : 'REVISE_BLOCKED_TASK',
            `draft changes the gate signature of ${state} task ${ex.id}`, { taskId: ex.id, state });
        }
      } else if (GATE_STATES_IN_FLIGHT.includes(state)) {
        if (!draftSpec || (prodSpec && gateSignature(draftSpec) !== gateSignature(prodSpec))) {
          fail('UNIFIED_TASK_DELIVERY_IN_FLIGHT', `draft touches in-flight task ${ex.id}; promotion defers`, { taskId: ex.id, state });
        }
      }
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
    const out = [];
    for (const spec of specs) {
      const ex = execById.get(spec.id);
      if (ex && !ex.embedded) {
        out.push({
          ...spec, projectId: this.projectId,
          state: ex.data.state ?? 'READY', stage: ex.data.stage ?? null,
          history: ex.data.history ?? [], execution: ex.data.execution ?? null,
          artifacts: ex.data.artifacts ?? null,
          version: ex.version, updatedAt: ex.updatedAt,
        });
      } else {
        out.push({ ...spec, projectId: this.projectId, state: 'READY', stage: null, history: [], execution: null, artifacts: null, version: 1, updatedAt: null });
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

  // ---- legacy zone (read-only after seeding) ------------------------------

  putLegacyEntries(entries) {
    if (!Array.isArray(entries)) throw new Error('entries must be an array');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of entries) {
        if (!e?.kind || !e?.oldId) throw new Error('legacy entry requires kind and oldId');
        const payload = e.payload ?? {};
        this.db.prepare('INSERT INTO legacy_entries (kind, old_id, summary, payload_json, source_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, old_id) DO UPDATE SET summary = excluded.summary, payload_json = excluded.payload_json, source_hash = excluded.source_hash')
          .run(e.kind, e.oldId, e.summary ?? null, encode(payload), sha256(stableStringify(payload)));
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return entries.length;
  }

  listLegacy(kind = null) {
    const rows = kind
      ? this.db.prepare('SELECT * FROM legacy_entries WHERE kind = ? ORDER BY old_id').all(kind)
      : this.db.prepare('SELECT * FROM legacy_entries ORDER BY kind, old_id').all();
    return rows.map(r => ({ kind: r.kind, oldId: r.old_id, summary: r.summary, payload: decode(r.payload_json), sourceHash: r.source_hash }));
  }

  getLegacy(kind, oldId) {
    const row = this.db.prepare('SELECT * FROM legacy_entries WHERE kind = ? AND old_id = ?').get(kind, oldId);
    return row ? { kind: row.kind, oldId: row.old_id, summary: row.summary, payload: decode(row.payload_json), sourceHash: row.source_hash } : null;
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
