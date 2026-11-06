import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientIoError, isTransientIoText } from '../src/v2/db-open-guard.js';

test('integrity reports with read failures are transient, not corruption', () => {
  // Verbatim shape of the 2026-11-06 SRPG batch-108 final-validate report.
  const report = '*** in database main *** Tree 353 page 353: unable to get the page. error code=522; Tree 4 page 7996: unable to get the page. error code=522; Tree 4 page 4 cell 0: Child page depth differs; Page 670: never used';
  assert.equal(isTransientIoText(report), true);
  assert.equal(isTransientIoText('integrity_check failed: disk I/O error'), true);
});

test('structural integrity findings without read failures are not transient', () => {
  assert.equal(isTransientIoText('Page 670: never used'), false);
  assert.equal(isTransientIoText('Tree 4 page 4 cell 0: Child page depth differs'), false);
  assert.equal(isTransientIoText('database disk image is malformed'), false);
  assert.equal(isTransientIoText('wrong # of entries in index idx_v2_tasks_project'), false);
});

test('SQLite error objects classify by primary result code', () => {
  assert.equal(isTransientIoError({ errcode: 10 }), true);   // SQLITE_IOERR
  assert.equal(isTransientIoError({ errcode: 522 }), true);  // SQLITE_IOERR_SHORT_READ
  assert.equal(isTransientIoError({ errcode: 266 }), true);  // SQLITE_IOERR_READ
  assert.equal(isTransientIoError({ errcode: 11 }), false);  // SQLITE_CORRUPT
  assert.equal(isTransientIoError({ errcode: 26 }), false);  // SQLITE_NOTADB
  assert.equal(isTransientIoError(new Error('disk I/O error')), true);
  assert.equal(isTransientIoError(new Error('file is not a database')), false);
  assert.equal(isTransientIoError(null), false);
});
