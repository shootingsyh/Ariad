import test from 'node:test';
import assert from 'node:assert/strict';
import { bashConfinementViolation, deliveryToolPolicy } from '../src/runtime/pi-agent-session-provider.js';

const WS = '/home/test/project';
const ws = { workspace: WS };

// --- edit/write workspace boundary (deliveryToolPolicy) ---

test('edit with an absolute path outside the workspace is blocked', () => {
  const v = deliveryToolPolicy('developer', 'edit', { ...ws, input: { path: '/home/test/ariad-standalone/src/runtime/x.js' } });
  assert.equal(v?.block, true);
  assert.match(v.reason, /WORKSPACE_BOUNDARY/);
});

test('write with a ../ relative path outside the workspace is blocked', () => {
  const v = deliveryToolPolicy('developer', 'write', { ...ws, input: { path: '../other-project/file.txt' } });
  assert.equal(v?.block, true);
  assert.match(v.reason, /WORKSPACE_BOUNDARY/);
});

test('edit inside the workspace is allowed', () => {
  assert.equal(deliveryToolPolicy('developer', 'edit', { ...ws, input: { path: 'src/main.js' } }), null);
  assert.equal(deliveryToolPolicy('developer', 'write', { ...ws, input: { path: `${WS}/src/main.js` } }), null);
});

test('read outside the workspace is not blocked by the boundary rule', () => {
  assert.equal(deliveryToolPolicy('developer', 'read', { ...ws, input: { path: '/home/test/ariad-standalone/src/runtime/x.js' } }), null);
});

test('boundary applies to roles beyond the delivery set (project_debugger)', () => {
  const v = deliveryToolPolicy('project_debugger', 'edit', { ...ws, input: { path: '/tmp/../home/test/ariad-standalone/x.js' } });
  assert.equal(v?.block, true);
});

// --- bash confinement: relative escapes (bashConfinementViolation) ---

test('bash: ../../ relative path is a violation', () => {
  assert.match(bashConfinementViolation('cat ../../ariad-standalone/src/x.js', WS) ?? '', /relative path escapes/);
});

test('bash: redirect target outside via ../.. is a violation', () => {
  assert.match(bashConfinementViolation('cp a.txt ../../tmp/x', WS) ?? '', /relative path escapes/);
});

test('bash: cd into a subdir then ../ back inside is allowed', () => {
  assert.equal(bashConfinementViolation('cd tools && python3 ../scripts/run.py', WS), null);
});

test('bash: cd two levels down then ../../ back to root is allowed', () => {
  assert.equal(bashConfinementViolation('cd a/b && cat ../../root.txt', WS), null);
});

test('bash: cd into a subdir then one ../ too many is a violation', () => {
  assert.match(bashConfinementViolation('cd tools && cat ../../outside.txt', WS) ?? '', /relative path escapes/);
});

test('bash: plain in-workspace relative paths are allowed', () => {
  assert.equal(bashConfinementViolation('python3 tools/run.py && ls src/', WS), null);
});

test('bash: absolute path outside the workspace is still a violation', () => {
  assert.match(bashConfinementViolation('cat /etc/passwd', WS) ?? '', /absolute path outside/);
});

test('bash: bare cd is a violation', () => {
  assert.match(bashConfinementViolation('cd', WS) ?? '', /bare cd/);
});

test('bash: assignment with an escaping relative path is a violation', () => {
  assert.match(bashConfinementViolation('OUT=../../x node build.js', WS) ?? '', /relative path escapes/);
});
