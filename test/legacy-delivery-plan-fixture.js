// Legacy-only fixture for historical test cases; never imported by production code.
import {isApprovalGateTask,developerTaskPolicyFailure} from '../src/v2/developer-task-policy.js';
export function legacyApplyDeliveryPlan(store, projectId, plan) {
    if (!store.getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
    // A legacy plan must never silently obsolete promoted aggregate tasks or
    // restore legacy integration IDs after a unified-tree migration.
    if (store.listTasks(projectId, { scope: 'delivery' }).some(task => task.taskTreeSchemaVersion === 1)) {
      throw new Error('APPROVED_TASK_TREE_REQUIRES_TREE_AWARE_RECONCILIATION');
    }
    if (store.listTasks(projectId, { scope: 'delivery' }).some(task => task.unifiedTaskSchemaVersion === 1)) {
      throw new Error('UNIFIED_TASK_TREE_REQUIRES_COMPATIBLE_COMPILER');
    }
    const deliverySpecs = plan?.tasks;
    if (!Array.isArray(deliverySpecs) || deliverySpecs.length === 0) {
      throw new Error('delivery plan requires tasks');
    }
    if (plan?.version !== 3 && !plan?.rootTaskId) {
      throw new Error('legacy delivery plan requires rootTaskId');
    }

    // Never compile an administrative approval gate as developer work.
    // It remains in the plan for traceability but must be resolved by the
    // PM/control-plane authorization mechanism, not a coding agent.
    for (const spec of deliverySpecs) {
      if (isApprovalGateTask(spec)) {
        throw new Error(`DELIVERY_PLAN_CONTROL_TASK: ${spec.id} is an approval gate; move authorization to the PM control flow instead of Delivery`);
      }
      const plannedStage = spec.revisionMode === 'regression'
        ? 'tester' : (spec.art?.required ? 'artist' : 'developer');
      const failure = developerTaskPolicyFailure({
        ...spec, stage: plannedStage, scope: 'delivery',
      });
      // Legacy v1/v2 task plans may have synthetic root tasks without milestone
      // ownership. Full v3 compiled plans require explicit milestone ownership.
      if (failure && (failure !== 'DEVELOPER_REQUIRES_MILESTONE' || plan.version === 3)) {
        throw new Error(`${failure}: ${spec.id}`);
      }
    }

    const incoming = new Map(deliverySpecs.map(task => [task.id, task]));
    if (incoming.size !== deliverySpecs.length) throw new Error('delivery plan contains duplicate task ids');

    store.db.exec('BEGIN IMMEDIATE');
    try {
      const current = store.listTasks(projectId, { scope: 'delivery' });
      for (const task of current) {
        if (incoming.has(task.id)) continue;
        if (task.state === 'DONE') {
          // Completed work is immutable historical truth across project versions.
          // A later milestone plan may stop referencing it, but must not rewrite
          // prior completion as OBSOLETE.
          continue;
        }
        if (task.state === 'WORKING') {
          throw new Error(`cannot obsolete WORKING delivery task: ${task.id}`);
        }
        store.updateTask(task.id, task.version, {
          state: 'OBSOLETE',
          execution: null,
        });
      }

      for (const spec of deliverySpecs) {
        const existing = store.getTask(spec.id);
        const patch = {
          parentId: spec.parentId ?? null,
          dependsOn: [...(spec.dependsOn ?? [])],
          logicalRefs: [...(spec.logicalRefs ?? [])],
          title: spec.title,
          intent: spec.intent,
          acceptanceCriteria: [...(spec.acceptanceCriteria ?? [])],
          testStrategy: spec.testStrategy,
          verification: structuredClone(spec.verification ?? []),
          interfaceIds: [...(spec.interfaceIds ?? [])],
          issueRefs: [...(spec.issueRefs ?? [])],
          taskKind: spec.taskKind ?? null,
          ownerFeatureId: spec.ownerFeatureId ?? null,
          ownerMilestoneId: spec.ownerMilestoneId ?? null,
          art: spec.art == null ? null : structuredClone(spec.art),
          ux: spec.ux == null ? null : structuredClone(spec.ux),
          revisionMode: spec.revisionMode ?? 'implementation',
          milestoneId: spec.milestoneId ?? null,
          input: {
            ...(existing?.input ?? {}),
            intent: spec.intent,
            acceptanceCriteria: [...(spec.acceptanceCriteria ?? [])],
            testStrategy: spec.testStrategy,
            verification: structuredClone(spec.verification ?? []),
            interfaceIds: [...(spec.interfaceIds ?? [])],
            issueRefs: [...(spec.issueRefs ?? [])],
            taskKind: spec.taskKind ?? null,
            ownerFeatureId: spec.ownerFeatureId ?? null,
            ownerMilestoneId: spec.ownerMilestoneId ?? null,
            art: spec.art == null ? null : structuredClone(spec.art),
          ux: spec.ux == null ? null : structuredClone(spec.ux),
            revisionMode: spec.revisionMode ?? 'implementation',
            milestoneId: spec.milestoneId ?? null,
            logicalRefs: [...(spec.logicalRefs ?? [])],
          },
        };

        if (!existing) {
          store.createTask({
            id: spec.id,
            projectId,
            scope: 'delivery',
            stage: spec.revisionMode === 'regression'
              ? 'tester'
              : (spec.art?.required ? 'artist' : 'developer'),
            state: 'READY',
            history: structuredClone(spec.history ?? []),
            artifacts: [],
            execution: null,
            ...patch,
          });
          continue;
        }

        if (existing.projectId !== projectId || existing.scope !== 'delivery') {
          throw new Error(`delivery plan task id collides outside project delivery graph: ${spec.id}`);
        }

        const existingHistory = existing.history ?? [];
        const incomingHistory = spec.history ?? [];
        const serializedExisting = new Set(existingHistory.map(entry => JSON.stringify(entry)));
        const appendedHistory = incomingHistory.filter(entry => !serializedExisting.has(JSON.stringify(entry)));
        const resetForPlan = ['OBSOLETE', 'WAITING_REPLAN'].includes(existing.state);
        const newlyRequiresArt = existing.state === 'READY'
          && existing.stage === 'developer'
          && spec.art?.required
          && !existing.art?.required;
        const plannedStartStage = spec.revisionMode === 'regression'
          ? 'tester'
          : (spec.art?.required ? 'artist' : 'developer');
        store.updateTask(existing.id, existing.version, {
          ...patch,
          history: [...existingHistory, ...structuredClone(appendedHistory)],
          // Preserve execution progress for stable task ids across replans.
          // Re-activated iteration tasks follow the derived revision mode.
          stage: (resetForPlan || newlyRequiresArt) ? plannedStartStage : existing.stage,
          state: resetForPlan ? 'READY' : existing.state,
        });
      }

      const project = store.getProject(projectId);
      store.updateProject(projectId, project.version, {
        deliveryPlanVersion: (project.deliveryPlanVersion ?? 0) + 1,
        deliveryRootTaskId: plan.rootTaskId ?? null,
        deliveryPlanSummary: plan.projectSummary ?? '',
        logicalRootId: plan.logicalRootId ?? null,
        logicalNodes: structuredClone(plan.logicalNodes ?? []),
        milestones: structuredClone(plan.milestones ?? []),
      });

      store.db.exec('COMMIT');
      return store.listTasks(projectId, { scope: 'delivery' });
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
  }

