import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireInstanceLock } from '../src/runtime/instance-lock.js';

function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ariad-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('first acquisition wins and records the pid', (t) => {
  const dir = makeDir(t);
  const lock = acquireInstanceLock(dir);
  assert.ok(lock);
  assert.equal(readFileSync(join(dir, 'ariad.lock'), 'utf8').trim(), String(process.pid));
  lock.release();
  assert.equal(existsSync(join(dir, 'ariad.lock')), false);
});

test('a second acquisition is refused while a live daemon holds the lock', (t) => {
  const dir = makeDir(t);
  const lock = acquireInstanceLock(dir);
  assert.ok(lock);
  assert.equal(acquireInstanceLock(dir, { pid: 123456 }), null);
  lock.release();
  assert.ok(acquireInstanceLock(dir, { pid: 123456 }));
});

test('release only removes the lock its owner still holds', (t) => {
  const dir = makeDir(t);
  const lock = acquireInstanceLock(dir);
  // A successor has taken over the file (stale-break): release must
  // not delete the successor's lock.
  writeFileSync(join(dir, 'ariad.lock'), '424242\n');
  lock.release();
  assert.equal(existsSync(join(dir, 'ariad.lock')), true);
});

test('a lock left by a dead pid is broken and re-acquired', async (t) => {
  const dir = makeDir(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid;
  await new Promise(resolve => child.on('exit', resolve));
  writeFileSync(join(dir, 'ariad.lock'), `${deadPid}\n`);
  const lock = acquireInstanceLock(dir);
  assert.ok(lock);
  assert.equal(readFileSync(join(dir, 'ariad.lock'), 'utf8').trim(), String(process.pid));
  lock.release();
});

test('two processes racing: exactly one holds the lock', async (t) => {
  const dir = makeDir(t);
  const mod = new URL('../src/runtime/instance-lock.js', import.meta.url).pathname;
  const childCode = [
    `const m = await import(${JSON.stringify(mod)});`,
    `const lock = m.acquireInstanceLock(${JSON.stringify(dir)});`,
    `console.log(lock ? 'WON' : 'LOST');`,
    'if (lock) setTimeout(() => {}, 1200);',
  ].join('\n');
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('exit', () => resolve(out.trim()));
    child.on('error', reject);
  });
  const first = runChild();
  await new Promise(r => setTimeout(r, 250));
  const second = await runChild();
  assert.equal(second, 'LOST');
  assert.equal(await first, 'WON');
  // The winner exited without releasing: its lock is stale (dead pid)
  // and the next contender breaks it.
  const third = await runChild();
  assert.equal(third, 'WON');
});
