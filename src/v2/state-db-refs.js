// Detector for references to the Ariad state databases in authored
// task text. Delivery tasks change project files only: a published task
// that points a delivery role at the state store (where task records
// and stored test plans live) is a planning defect - the Tech Lead
// changes that data through the tree patch in the same batch, never by
// delegating it (2026-11-22 tc6 incident: a developer task told to
// repair a stored test-plan entry edited the live store directly and
// wedged the daemon).
export const ARIAD_STATE_DB_REF_RE = /\bstate2?\.db(?:-wal|-shm|-journal)?\b|\.ariad\/[^\s'"]*?\.db(?:-wal|-shm|-journal)?\b/i;

export function ariadStateDbRefInText(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(ARIAD_STATE_DB_REF_RE);
  return match ? match[0] : null;
}

export function ariadStateDbRefInTask(task) {
  const fields = [task?.title, task?.intent, task?.testStrategy,
    ...(Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [])];
  for (const field of fields) {
    const ref = ariadStateDbRefInText(field);
    if (ref) return ref;
  }
  return null;
}
