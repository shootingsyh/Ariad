import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Check } from 'typebox/value';

import { issueAnchor } from '../src/v2/interface-seal.js';
import { ARIAD_PROJECT_TOOL_NAMES, registerAriadProjectTools } from '../src/runtime/pi-project-tools.js';
import { ARIAD_PI_DELIVERY_TOOLS, ARIAD_PI_REVIEW_TOOLS } from '../src/runtime/pi-runtime-config.js';
import { piDeclaredRoleResultToolSchema, piRoleResultToolSchema } from '../src/runtime/pi-agent-session-provider.js';

function workspaceWith(files) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ariad-anchor-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(workspace, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return workspace;
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const STORE_JS = [
  '// task store',
  'export function createTaskStore() {',
  '  const tasks = [];',
  '  return { tasks };',
  '}',
  '',
  'export const hydrateTasks = (raw) => raw;',
  '',
].join('\n');

test('issueAnchor resolves a JS function symbol into canonical sealed form', () => {
  const workspace = workspaceWith({ 'src/store.js': STORE_JS });
  const issued = issueAnchor({ workspace, anchor: { kind: 'symbol', file: 'src/store.js', symbol: 'createTaskStore' } });
  assert.equal(issued.ok, true);
  assert.equal(issued.anchor.kind, 'symbol');
  assert.equal(issued.anchor.file, 'src/store.js');
  assert.equal(issued.anchor.symbol, 'createTaskStore');
  assert.equal(issued.anchor.startLine, 2);
  // The shared resolver's span heuristic may include the trailing blank
  // line; the contract is that the span covers the whole definition.
  assert.ok(issued.anchor.endLine >= 5, `span covers the definition (endLine ${issued.anchor.endLine})`);
  assert.equal(issued.anchor.fileHash, sha256(STORE_JS));
  assert.equal(issued.anchor.status, 'VALID');
});

test('issueAnchor resolves const arrow definitions and range anchors', () => {
  const workspace = workspaceWith({ 'src/store.js': STORE_JS });
  const bySymbol = issueAnchor({ workspace, anchor: { kind: 'symbol', file: 'src/store.js', symbol: 'hydrateTasks' } });
  assert.equal(bySymbol.ok, true);
  assert.equal(bySymbol.anchor.startLine, 7);
  const byRange = issueAnchor({ workspace, anchor: { kind: 'range', file: 'src/store.js', startLine: 2, endLine: 3 } });
  assert.equal(byRange.ok, true);
  assert.equal(byRange.anchor.fileHash, sha256(STORE_JS));
  assert.equal(byRange.anchor.status, 'VALID');
});

test('issueAnchor reports unresolved symbols and missing files instead of guessing', () => {
  const workspace = workspaceWith({ 'src/store.js': STORE_JS });
  const missing = issueAnchor({ workspace, anchor: { kind: 'symbol', file: 'src/nope.js', symbol: 'x' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'FILE_MISSING');
  const unknown = issueAnchor({ workspace, anchor: { kind: 'symbol', file: 'src/store.js', symbol: 'doesNotExist' } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'SYMBOL_UNRESOLVED');
});

test('ariad_anchor_lookup tool issues anchors by symbol search, file+symbol, and range', async () => {
  const workspace = workspaceWith({
    'src/store.js': STORE_JS,
    'src/other.js': 'export function unrelated() {\n  return 1;\n}\n',
  });
  const registered = new Map();
  registerAriadProjectTools({ registerTool(tool) { registered.set(tool.name, tool); } }, { workspace });
  const tool = registered.get('ariad_anchor_lookup');
  assert.ok(tool, 'tool is registered');
  assert.ok(ARIAD_PROJECT_TOOL_NAMES.includes('ariad_anchor_lookup'));
  assert.ok(ARIAD_PI_DELIVERY_TOOLS.includes('ariad_anchor_lookup'));
  assert.ok(ARIAD_PI_REVIEW_TOOLS.includes('ariad_anchor_lookup'));

  const searched = (await tool.execute('t1', { symbol: 'createTaskStore' })).details;
  assert.equal(searched.anchors.length, 1);
  assert.equal(searched.anchors[0].file, 'src/store.js');
  assert.equal(searched.anchors[0].status, 'VALID');

  const direct = (await tool.execute('t2', { symbol: 'hydrateTasks', file: 'src/store.js' })).details;
  assert.equal(direct.anchors.length, 1);
  assert.equal(direct.anchors[0].startLine, 7);

  const ranged = (await tool.execute('t3', { file: 'src/other.js', startLine: 1, endLine: 2 })).details;
  assert.equal(ranged.anchors.length, 1);
  assert.equal(ranged.anchors[0].kind, 'range');

  const unknown = (await tool.execute('t4', { symbol: 'neverDefined' })).details;
  assert.deepEqual(unknown.anchors, []);
  assert.ok(unknown.unresolved.length >= 1);
});

test('seal fields are required in delivery result schemas, not optional', () => {
  const anchor = { kind: 'symbol', file: 'src/store.js', symbol: 'createTaskStore', startLine: 2, endLine: 5, fileHash: 'abc123', status: 'VALID' };
  const full = {
    outcome: 'PASS',
    summary: 'done',
    result: {
      interfaceRealizations: [{ interfaceId: 'store', anchors: [anchor] }],
      interfaceVerifications: [],
      interfaceReviews: [],
    },
  };
  const declared = piDeclaredRoleResultToolSchema('developer');
  assert.equal(Check(declared, full), true, 'complete delivery result validates (incl. hash-pinned anchor)');
  for (const field of ['interfaceRealizations', 'interfaceVerifications', 'interfaceReviews']) {
    const incomplete = structuredClone(full);
    delete incomplete.result[field];
    assert.equal(Check(declared, incomplete), false, `missing ${field} must not validate`);
  }
  const perRole = piRoleResultToolSchema('developer');
  assert.equal(Check(perRole, full), true);
  const perRoleMissing = structuredClone(full);
  delete perRoleMissing.result.interfaceRealizations;
  assert.equal(Check(perRole, perRoleMissing), false, 'per-role developer schema also requires interfaceRealizations');
});
