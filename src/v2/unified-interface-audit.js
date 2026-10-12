import { loadBoundaryContracts, validateBoundaryContracts } from './interface-contracts.js';
import { compileUnifiedTaskTree } from './unified-task-compiler.js';

// Pure read-only structural audit. Source anchors and behavioral verification
// must be checked separately; a declared interface is not proof it works.
export function auditUnifiedInterfaceBindings(artifactRoot) {
  const issues = [];
  const contracts = {};
  const defined = new Map();
  for (const kind of ['feature', 'milestone']) {
    contracts[kind] = validateBoundaryContracts(artifactRoot, kind);
    for (const contract of loadBoundaryContracts(artifactRoot, kind).values()) {
      for (const iface of contract.interfaces) {
        if (defined.has(iface.id)) issues.push({ code:'DUPLICATE_INTERFACE_ID', interfaceId:iface.id });
        defined.set(iface.id, {kind,nodeId:contract.nodeId});
      }
      for (const binding of contract.bindings ?? []) {
        if (!contract.interfaces.some(i=>i.id===binding.interfaceId)) {
          issues.push({code:'UNKNOWN_BOUND_INTERFACE',nodeId:contract.nodeId,interfaceId:binding.interfaceId});
        }
      }
    }
  }
  const tasks = compileUnifiedTaskTree(artifactRoot).tasks;
  for (const task of tasks) {
    const refs = task.interfaceIds ?? [];
    for (const id of refs) if (!defined.has(id)) {
      issues.push({code:'UNKNOWN_TASK_INTERFACE',taskId:task.id,interfaceId:id});
    }
    if (JSON.stringify(refs)!==JSON.stringify(task.input?.interfaceIds??[])) {
      issues.push({code:'TASK_INPUT_INTERFACE_DRIFT',taskId:task.id});
    }
  }
  return {ok:issues.length===0,issues,contractCounts:{feature:contracts.feature.count,milestone:contracts.milestone.count},taskCount:tasks.length,definedInterfaceCount:defined.size};
}
