import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateBoundaryContracts } from './interface-contracts.js';
import { loadPlannerArtifactPlan } from './planner-artifacts.js';

// Structured patching for planner artifacts (milestone delivery trees and
// boundary contracts). Until this existed, the Tech Lead hand-edited the
// live planner JSON with the generic edit/write tools: a single degenerate
// model generation landed verbatim in a shared artifact and parked the
// whole project (2026-10-30, batch-52: a garbage token stream written into
// milestones/V2.2.json by an edit call). Here the model only ever submits
// structured operations; Ariad parses, applies, strictly validates the
// whole planner tree on a staged copy, and only then atomically replaces
// the live file. A bad op set is returned to the model as a tool error
// with the live artifacts byte-identical.

const PATCHABLE_PREFIXES = [
  'planner/milestones/',
  'planner/interfaces/features/',
  'planner/interfaces/milestones/',
  'planner/logical/',
];

export function normalizePlannerPatchFile(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('PLANNER_PATCH_FILE_REQUIRED');
  const rel = file.trim().replace(/\\/g, '/').replace(/^\.ariad\/artifacts\//, '');
  if (rel.startsWith('/') || rel.split('/').includes('..')) {
    throw new Error(`PLANNER_PATCH_FILE_NOT_ALLOWED: ${file}`);
  }
  const prefix = PATCHABLE_PREFIXES.find(candidate => rel.startsWith(candidate));
  const rest = prefix ? rel.slice(prefix.length) : null;
  if (!prefix || !rest.endsWith('.json') || rest.includes('/')) {
    throw new Error(`PLANNER_PATCH_FILE_NOT_ALLOWED: ${file} (patchable: planner/milestones/<id>.json, planner/interfaces/features/<id>.json, planner/interfaces/milestones/<id>.json, planner/logical/<id>.json)`);
  }
  return rel;
}

const itemIdentity = (item) => {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id === 'string') return `id:${item.id}`;
  if (typeof item.taskId === 'string') return `taskId:${item.taskId}`;
  if (typeof item.featureId === 'string' && typeof item.interfaceId === 'string') return `featureUse:${item.featureId}::${item.interfaceId}`;
  if (typeof item.interfaceId === 'string') return `interfaceId:${item.interfaceId}`;
  return null;
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const matchesItem = (item, match) => Object.entries(match ?? {})
  .every(([field, value]) => deepEqual(item?.[field], value));

function requireArray(doc, name, { create = false } = {}) {
  if (typeof name !== 'string' || !name) throw new Error('PLANNER_PATCH_OP_INVALID: array name required');
  if (doc[name] === undefined && create) doc[name] = [];
  if (!Array.isArray(doc[name])) throw new Error(`PLANNER_PATCH_NOT_AN_ARRAY: ${name}`);
  return doc[name];
}

function applySetAndLists(target, op, index) {
  for (const [field, value] of Object.entries(op.set ?? {})) {
    target[field] = structuredClone(value);
  }
  for (const [field, values] of Object.entries(op.addToList ?? {})) {
    if (!Array.isArray(values)) throw new Error(`PLANNER_PATCH_OP_INVALID: ops[${index}] addToList.${field} must be an array`);
    const list = requireArray(target, field, { create: true });
    for (const value of values) {
      if (!list.some(existing => deepEqual(existing, value))) list.push(structuredClone(value));
    }
  }
  for (const [field, values] of Object.entries(op.removeFromList ?? {})) {
    if (!Array.isArray(values)) throw new Error(`PLANNER_PATCH_OP_INVALID: ops[${index}] removeFromList.${field} must be an array`);
    if (target[field] === undefined) continue;
    const list = requireArray(target, field);
    target[field] = list.filter(existing => !values.some(value => deepEqual(existing, value)));
  }
}

function requireMatch(op, index, kind) {
  if (!op.match || typeof op.match !== 'object' || Array.isArray(op.match) || Object.keys(op.match).length === 0) {
    throw new Error(`PLANNER_PATCH_OP_INVALID: ops[${index}] ${kind} requires a non-empty match object`);
  }
}

function applyOp(doc, op, index) {
  const kind = op?.op;
  if (kind === 'addItem') {
    const list = requireArray(doc, op.array, { create: true });
    if (!op.item || typeof op.item !== 'object' || Array.isArray(op.item)) {
      throw new Error(`PLANNER_PATCH_OP_INVALID: ops[${index}] addItem.item must be a JSON object`);
    }
    const identity = itemIdentity(op.item);
    if (identity && list.some(existing => itemIdentity(existing) === identity)) {
      throw new Error(`PLANNER_PATCH_ITEM_EXISTS: ${op.array} already contains ${identity}; use updateItem to change it`);
    }
    list.push(structuredClone(op.item));
    return `addItem ${op.array}${identity ? ` ${identity}` : ''}`;
  }
  if (kind === 'updateItem' || kind === 'removeItem') {
    requireMatch(op, index, kind);
    const list = requireArray(doc, op.array);
    const hits = list.filter(item => matchesItem(item, op.match));
    if (hits.length !== 1) {
      throw new Error(`PLANNER_PATCH_MATCH_COUNT: ops[${index}] ${kind} on ${op.array} matched ${hits.length} items; exactly 1 required`);
    }
    if (kind === 'removeItem') {
      list.splice(list.indexOf(hits[0]), 1);
      return `removeItem ${op.array} ${itemIdentity(hits[0]) ?? ''}`.trim();
    }
    applySetAndLists(hits[0], op, index);
    return `updateItem ${op.array} ${itemIdentity(hits[0]) ?? ''}`.trim();
  }
  if (kind === 'setTop') {
    applySetAndLists(doc, op, index);
    return 'setTop';
  }
  throw new Error(`PLANNER_PATCH_OP_INVALID: ops[${index}] unknown op ${JSON.stringify(kind ?? null)}`);
}

export function validatePlannerArtifacts(artifactRoot, { touchedFile = null } = {}) {
  // Contract behavior layer: when a patch writes a feature contract, that
  // contract must satisfy the behavior layer; untouched stored contracts
  // are not retroactively re-judged.
  const featureScope = typeof touchedFile === 'string' && touchedFile.startsWith('planner/interfaces/features/')
    ? [touchedFile.slice('planner/interfaces/features/'.length, -'.json'.length)]
    : null;
  validateBoundaryContracts(artifactRoot, 'feature', featureScope ? { requireBehaviorFor: featureScope } : {});
  validateBoundaryContracts(artifactRoot, 'milestone');
  loadPlannerArtifactPlan(artifactRoot);
}

export function applyPlannerPatch({ artifactRoot, file, ops, validate = validatePlannerArtifacts }) {
  if (!artifactRoot) throw new Error('PLANNER_PATCH_ARTIFACT_ROOT_REQUIRED');
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('PLANNER_PATCH_OPS_REQUIRED');
  if (ops.length > 200) throw new Error('PLANNER_PATCH_TOO_MANY_OPS: at most 200 ops per call');
  const rel = normalizePlannerPatchFile(file);
  const livePath = join(artifactRoot, rel);
  const existed = existsSync(livePath);
  let doc = null;
  const applied = [];
  ops.forEach((op, index) => {
    if (op?.op === 'createDocument') {
      if (index !== 0 || existed || doc) {
        throw new Error('PLANNER_PATCH_CREATE_MISPLACED: createDocument must be the first op and the file must not exist yet');
      }
      if (!op.document || typeof op.document !== 'object' || Array.isArray(op.document)) {
        throw new Error('PLANNER_PATCH_CREATE_INVALID: document must be a JSON object');
      }
      doc = structuredClone(op.document);
      applied.push('createDocument');
      return;
    }
    if (!doc) {
      if (!existed) throw new Error(`PLANNER_PATCH_FILE_MISSING: ${rel} (start with a createDocument op)`);
      try {
        doc = JSON.parse(readFileSync(livePath, 'utf8'));
      } catch (error) {
        throw new Error(`PLANNER_PATCH_TARGET_UNPARSEABLE: ${rel}: ${error.message}`);
      }
    }
    applied.push(applyOp(doc, op, index));
  });
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  const staging = mkdtempSync(join(tmpdir(), 'ariad-planner-patch-'));
  try {
    const livePlanner = join(artifactRoot, 'planner');
    if (existsSync(livePlanner)) cpSync(livePlanner, join(staging, 'planner'), { recursive: true });
    else mkdirSync(join(staging, 'planner'), { recursive: true });
    const stagedPath = join(staging, rel);
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, serialized);
    try {
      validate(staging, { touchedFile: rel });
    } catch (error) {
      throw new Error(`PLANNER_PATCH_VALIDATION_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  mkdirSync(dirname(livePath), { recursive: true });
  const temporary = `${livePath}.patch-tmp-${process.pid}`;
  writeFileSync(temporary, serialized);
  renameSync(temporary, livePath);
  return { file: rel, created: !existed, applied, bytes: serialized.length };
}
