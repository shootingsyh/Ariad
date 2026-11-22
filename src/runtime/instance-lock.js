import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function readHolderPid(file) {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

const sleepMs = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Acquires the single-instance lock for one daemon runtime directory,
// or returns null when a live daemon already owns it.
//
// The lock file is created with O_EXCL ('wx'): the kernel hands it to
// exactly one process, so two starters firing in the same instant
// cannot both win. That closes the check-then-spawn race in the old
// ping-based guard, which let duplicate daemons serve one projects
// root on 2026-11-22 - each recycled the other's WAL view and stole
// its role sessions until both were unusable.
//
// A lock whose recorded pid is dead is stale - its holder was killed
// before it could clean up - and is broken. Breaking is safe under
// races: after the unlink, only one contender's O_EXCL create wins;
// the loser loops and then sees the winner's live pid. A lock whose
// pid cannot be read yet is given a short grace period first: the
// winner creates the file and writes its pid in adjacent calls, and
// a contender must not mistake that gap for staleness.
export function acquireInstanceLock(dir, { pid = process.pid } = {}) {
  const file = join(dir, 'ariad.lock');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let fd;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let holder = readHolderPid(file);
      if (holder === null) {
        for (let spin = 0; spin < 25 && holder === null; spin += 1) {
          sleepMs(20);
          holder = readHolderPid(file);
        }
      }
      if (holder !== null && pidAlive(holder)) return null;
      try { unlinkSync(file); } catch { /* already gone */ }
      continue;
    }
    try { writeSync(fd, `${pid}\n`); } finally { closeSync(fd); }
    return {
      file,
      release() {
        // Only the owner removes its lock; after a stale-break the
        // file may already belong to a successor.
        try {
          if (readHolderPid(file) === pid) unlinkSync(file);
        } catch { /* already gone */ }
      },
    };
  }
  return null;
}
