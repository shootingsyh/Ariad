import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

function invalid(reason) {
  const error = new Error('ITERATION_REQUEST_INVALID: ' + reason);
  error.code = 'ITERATION_REQUEST_INVALID';
  throw error;
}
function writeJsonAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid;
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(temp, file);
}

/**
 * Activate a deferred, independently reviewed iteration only after the old
 * migration has finished. Database request IDs make retries idempotent.
 */
export function activateDeferredIterations({ store, projectId, workspace }) {
  const project = store.getProject(projectId);
  if (!project) return [];
  if (project.planningModelMigration?.status !== 'COMPLETED') return [];
  if (store.listPlanningRequests(projectId).some(r => r.state !== 'PLANNED')) return [];
  const root = join(workspace, '.ariad', 'iterations', 'requests');
  if (!existsSync(root)) return [];
  const activated = [];
  for (const name of readdirSync(root).filter(n => n.endsWith('.json')).sort()) {
    const file = join(root, name);
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    if (entry.projectId !== projectId || entry.status !== 'DEFERRED_UNTIL_MIGRATION_COMPLETE') continue;
    if (entry.kind !== 'ITERATE' || entry.request?.purpose !== 'UPDATE_DELIVERY_PLAN') invalid(name + ': unsupported kind');
    if (entry.targetVersion !== project.activeVersion || entry.baselineCompletedVersion !== project.projectVersion) {
      invalid(name + ': version tuple disagrees with durable project');
    }
    const review = entry.reviewReport;
    if (!review || !existsSync(review)) invalid(name + ': missing reviewed proposal');
    if (createHash('sha256').update(readFileSync(review)).digest('hex') !== entry.reviewSha256) {
      invalid(name + ': review report hash mismatch');
    }
    const existing = store.getPlanningRequest(entry.id);
    if (!existing) {
      store.enqueuePlanningRequest({
        id: entry.id, projectId,
        request: entry.request,
        context: {
          sourceKind: 'iterate',
          targetVersion: entry.targetVersion,
          reviewReport: review,
          reviewSha256: entry.reviewSha256,
          changeType: entry.request.changeType,
        },
      });
    }
    const current = store.getProject(projectId);
    if (current.deliveryEnabled !== false) {
      store.updateProject(projectId, current.version, { deliveryEnabled: false });
    }
    writeJsonAtomic(file, { ...entry, status: 'QUEUED', activatedAt: new Date().toISOString() });
    activated.push(entry.id);
    // One iteration at a time: do not coalesce requests across plan versions.
    break;
  }
  return activated;
}
