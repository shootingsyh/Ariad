import { DELIVERY_KINDS } from './versioned-store.js';

// Legacy seeding for begin-iteration: distills the old store into the new
// store's read-only legacy zone per the approved carry list (2026-10-31):
// DONE delivery completion cards, SKIPPED delivery index lines, resolved
// issues, project-level conclusions, and an incident digest. Unresolved
// issues become live issues in the new store. Process tasks, history
// streams and raw incident rows are NOT carried; they stay in the
// archived old DB. The project memory DB is a separate workspace file
// and is carried by reference, not copied.
const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function seedLegacyFromOldDb(oldDb, store, projectId) {
  const entries = [];
  let doneCards = 0;
  let skippedIdx = 0;
  let resolvedIssues = 0;

  const taskRows = tableExists(oldDb, 'v2_tasks')
    ? oldDb.prepare('SELECT id, project_id, data_json, updated_at FROM v2_tasks WHERE project_id = ?').all(projectId)
      .map(r => ({ ...parse(r.data_json), id: r.id, updatedAt: r.updated_at }))
    : [];
  const delivery = taskRows.filter(t => DELIVERY_KINDS.includes(t.taskKind) && t.title);

  for (const t of delivery.filter(t => t.state === 'DONE')) {
    const history = Array.isArray(t.history) ? t.history : [];
    const verdictEntry = [...history].reverse().find(h => h && (h.verdict || h.decision || /REVIEW/i.test(h.type ?? '')));
    entries.push({
      kind: 'done_card', oldId: t.id, summary: t.title,
      payload: {
        title: t.title, taskKind: t.taskKind, parentId: t.parentId ?? null,
        ownerFeatureId: t.ownerFeatureId ?? null, ownerMilestoneId: t.ownerMilestoneId ?? t.milestoneId ?? null,
        acceptanceCriteria: t.acceptanceCriteria ?? [], testStrategy: t.testStrategy ?? null,
        interfaceIds: t.interfaceIds ?? [], dependsOn: t.dependsOn ?? [],
        completedAt: t.updatedAt, verdict: verdictEntry?.verdict ?? verdictEntry?.decision ?? null,
        historyTail: history.slice(-3).map(h => h?.type ?? 'entry'),
      },
    });
    doneCards++;
  }
  for (const t of delivery.filter(t => t.state === 'SKIPPED')) {
    entries.push({ kind: 'skipped_index', oldId: t.id, summary: t.title, payload: { title: t.title, taskKind: t.taskKind } });
    skippedIdx++;
  }

  const liveIssues = [];
  if (tableExists(oldDb, 'v2_issues')) {
    const issueRows = oldDb.prepare('SELECT id, data_json FROM v2_issues WHERE project_id = ?').all(projectId)
      .map(r => ({ ...parse(r.data_json), id: r.id }));
    for (const issue of issueRows) {
      if (issue.resolution) {
        entries.push({
          kind: 'issue_resolved', oldId: issue.id, summary: issue.title,
          payload: {
            title: issue.title, severity: issue.severity, blocking: issue.blocking,
            affectedComponent: issue.affectedComponent, affectedInterface: issue.affectedInterface,
            evidence: issue.evidence ?? [], resolution: issue.resolution,
          },
        });
        resolvedIssues++;
      } else {
        liveIssues.push(issue);
      }
    }
  }

  if (tableExists(oldDb, 'v2_projects')) {
    const projRow = oldDb.prepare('SELECT data_json FROM v2_projects WHERE id = ?').get(projectId);
    if (projRow) {
      const p = parse(projRow.data_json);
      entries.push({
        kind: 'project_facts', oldId: projectId, summary: 'project conclusions carried from old DB',
        payload: {
          activeVersion: p.activeVersion ?? null, mode: p.mode ?? null,
          unifiedTaskHistoricalExceptions: p.unifiedTaskHistoricalExceptions ?? [],
          versionHistory: p.versionHistory ?? [],
        },
      });
    }
  }

  const incidentCount = tableExists(oldDb, 'v2_system_incidents')
    ? oldDb.prepare('SELECT COUNT(*) AS n FROM v2_system_incidents WHERE project_id = ?').get(projectId).n
    : 0;
  entries.push({
    kind: 'incident_digest', oldId: projectId, summary: `${incidentCount} system incidents in old DB (digest only)`,
    payload: { count: incidentCount, note: 'Raw incident stream stays in the archived old DB; settled lessons live in project memory and done cards.' },
  });

  store.putLegacyEntries(entries);
  let liveIssuesInserted = 0;
  for (const issue of liveIssues) {
    if (store.getIssue(issue.id)) continue;
    store.createIssue({
      id: issue.id, title: issue.title, description: issue.description ?? '',
      severity: issue.severity ?? 'medium', blocking: !!issue.blocking,
      affectedComponent: issue.affectedComponent ?? null, affectedInterface: issue.affectedInterface ?? null,
      evidence: issue.evidence ?? [], carriedFrom: 'old-db',
    });
    liveIssuesInserted++;
  }
  return { doneCards, skippedIdx, resolvedIssues, liveIssuesInserted, legacyTotal: store.listLegacy().length };
}
