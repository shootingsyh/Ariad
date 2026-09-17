import { TaskGraph } from './task-graph.js';

const TASK_KINDS = new Set(['CONTRACT_INTERFACE', 'CONTRACT_TEST', 'FAKE_PROVIDER', 'VERTICAL_SKELETON', 'IMPLEMENTATION', 'REFACTOR']);

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

export function validateProjectModel(model, { requireTasks = true } = {}) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('Tech Lead returned no projectModel');
  if (!model.currentState || typeof model.currentState !== 'object') throw new Error('projectModel.currentState is required');
  if (!model.architecture || typeof model.architecture !== 'object') throw new Error('projectModel.architecture is required');

  const horizontals = requireArray(model.architecture.horizontals, 'projectModel.architecture.horizontals');
  const verticals = requireArray(model.architecture.verticals, 'projectModel.architecture.verticals');
  if (horizontals.length === 0) throw new Error('Tech Lead plan requires at least one horizontal shared-infrastructure component');
  if (verticals.length === 0) throw new Error('Tech Lead plan requires at least one vertical product-feature component');

  const components = [...horizontals, ...verticals];
  const componentIds = new Set();
  for (const component of components) {
    if (!component?.id || !component?.name || !component?.responsibility) throw new Error('every architecture component requires id, name, and responsibility');
    if (componentIds.has(component.id)) throw new Error(`duplicate architecture component id ${component.id}`);
    componentIds.add(component.id);
  }

  const contracts = requireArray(model.contracts, 'projectModel.contracts');
  const contractIds = new Set();
  for (const contract of contracts) {
    if (!contract?.id) throw new Error('every contract requires an id');
    if (contractIds.has(contract.id)) throw new Error(`duplicate contract id ${contract.id}`);
    contractIds.add(contract.id);
    if (!componentIds.has(contract.provider)) throw new Error(`contract ${contract.id} has unknown provider ${contract.provider}`);
    if (!Array.isArray(contract.consumers) || contract.consumers.length === 0) throw new Error(`contract ${contract.id} requires consumers`);
    for (const consumer of contract.consumers) if (!componentIds.has(consumer)) throw new Error(`contract ${contract.id} has unknown consumer ${consumer}`);
    if (!contract.purpose || contract.interface == null || !contract.testBoundary) throw new Error(`contract ${contract.id} requires purpose, interface, and testBoundary`);
    if (!['PROVISIONAL', 'VALIDATED', 'STABLE'].includes(contract.maturity)) throw new Error(`contract ${contract.id} requires maturity PROVISIONAL, VALIDATED, or STABLE`);
    if (!Array.isArray(contract.justifiedByVerticals) || contract.justifiedByVerticals.length === 0) throw new Error(`contract ${contract.id} must be justified by at least one vertical slice`);
    if (!contract.interfaceTaskId) throw new Error(`contract ${contract.id} requires interfaceTaskId`);
    if (!contract.contractTestTaskId) throw new Error(`contract ${contract.id} requires contractTestTaskId`);
    if (contract.fakeTaskId !== null && contract.fakeTaskId !== undefined && typeof contract.fakeTaskId !== 'string') throw new Error(`contract ${contract.id} fakeTaskId must be a task id or null`);
  }

  const dependencies = requireArray(model.dependencies, 'projectModel.dependencies');
  for (const dependency of dependencies) {
    if (!componentIds.has(dependency?.from) || !componentIds.has(dependency?.to)) throw new Error('every dependency edge must reference known components');
    if (dependency.from === dependency.to) throw new Error(`dependency ${dependency.from} -> ${dependency.to} cannot be self-referential`);
    if (dependency.contractId != null && !contractIds.has(dependency.contractId)) throw new Error(`dependency references unknown contract ${dependency.contractId}`);
    if (typeof dependency.implementationRequired !== 'boolean') throw new Error('dependency implementationRequired must be boolean');
    if (!dependency.rationale) throw new Error('dependency rationale is required');
  }

  if (!model.technicalDirection || typeof model.technicalDirection !== 'object') throw new Error('projectModel.technicalDirection is required');
  if (!model.technicalDirection.summary) throw new Error('technicalDirection.summary is required');
  const languages = requireArray(model.technicalDirection.languages, 'projectModel.technicalDirection.languages');
  if (languages.length === 0) throw new Error('technicalDirection.languages must identify major language choices');
  for (const language of languages) if (!language?.scope || !language?.language || !language?.rationale) throw new Error('every language choice requires scope, language, and rationale');

  if (!model.decomposition || typeof model.decomposition !== 'object') throw new Error('projectModel.decomposition is required');
  const nodes = requireArray(model.decomposition.nodes, 'projectModel.decomposition.nodes');
  if (nodes.length === 0) throw new Error('Tech Lead plan requires recursive decomposition nodes');
  const nodeIds = new Set(nodes.map((node) => node?.id));
  if (nodeIds.size !== nodes.length || nodeIds.has(undefined)) throw new Error('decomposition node ids must be present and unique');
  for (const node of nodes) {
    if (!['component', 'subcomponent', 'task'].includes(node.kind)) throw new Error(`decomposition node ${node.id} has invalid kind`);
    if (!componentIds.has(node.componentId)) throw new Error(`decomposition node ${node.id} has unknown component ${node.componentId}`);
    if (!Array.isArray(node.children)) throw new Error(`decomposition node ${node.id} requires children`);
    for (const child of node.children) if (!nodeIds.has(child)) throw new Error(`decomposition node ${node.id} references unknown child ${child}`);
  }

  const tasks = requireArray(model.tasks ?? [], 'projectModel.tasks');
  if (requireTasks && tasks.length === 0) throw new Error('Tech Lead returned no executable project tasks');
  const taskIds = new Set(tasks.map((task) => task?.id));
  if (taskIds.size !== tasks.length || taskIds.has(undefined)) throw new Error('Tech Lead task ids must be present and unique');
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const decompositionTaskIds = new Set(nodes.filter((node) => node.kind === 'task' && node.children.length === 0).map((node) => node.taskId));

  const verticalSlices = requireArray(model.verticalSlices, 'projectModel.verticalSlices');
  if (requireTasks && verticalSlices.length === 0) throw new Error('Tech Lead plan requires at least one vertical slice');
  const sliceIds = new Set();
  for (const slice of verticalSlices) {
    if (!slice?.id || !slice?.name || !slice?.goal) throw new Error('every vertical slice requires id, name, and goal');
    if (sliceIds.has(slice.id)) throw new Error(`duplicate vertical slice id ${slice.id}`);
    sliceIds.add(slice.id);
    if (!Array.isArray(slice.componentIds) || slice.componentIds.length === 0) throw new Error(`vertical slice ${slice.id} requires componentIds`);
    for (const id of slice.componentIds) if (!componentIds.has(id)) throw new Error(`vertical slice ${slice.id} references unknown component ${id}`);
    if (!Array.isArray(slice.contractIds)) throw new Error(`vertical slice ${slice.id} requires contractIds`);
    for (const id of slice.contractIds) if (!contractIds.has(id)) throw new Error(`vertical slice ${slice.id} references unknown contract ${id}`);
    if (!Array.isArray(slice.taskIds)) throw new Error(`vertical slice ${slice.id} requires taskIds`);
    if (requireTasks && slice.taskIds.length === 0) throw new Error(`vertical slice ${slice.id} requires executable tasks`);
    for (const id of slice.taskIds) if (!taskIds.has(id)) throw new Error(`vertical slice ${slice.id} references unknown task ${id}`);
    if (!slice.skeletonTest) throw new Error(`vertical slice ${slice.id} requires a skeletonTest`);
    if (requireTasks && !slice.skeletonTaskId) throw new Error(`vertical slice ${slice.id} requires skeletonTaskId`);
  }

  for (const contract of contracts) {
    for (const sliceId of contract.justifiedByVerticals) if (!sliceIds.has(sliceId)) throw new Error(`contract ${contract.id} is justified by unknown vertical slice ${sliceId}`);
  }

  for (const task of tasks) {
    if (!TASK_KINDS.has(task.kind)) throw new Error(`Tech Lead task ${task.id} has invalid kind ${task.kind}`);
    if (typeof task.componentId !== 'string' || !componentIds.has(task.componentId)) throw new Error(`Tech Lead task ${task.id} has invalid componentId`);
    if (!sliceIds.has(task.verticalSliceId)) throw new Error(`Tech Lead task ${task.id} must reference a vertical slice`);
    if (!Array.isArray(task.dependsOn)) throw new Error(`Tech Lead task ${task.id} has invalid dependsOn`);
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) throw new Error(`Tech Lead task ${task.id} has no acceptance criteria`);
    if (typeof task.testStrategy !== 'string' || !task.testStrategy) throw new Error(`Tech Lead task ${task.id} has no test strategy`);
    if (task.atomic !== true) throw new Error(`Tech Lead task ${task.id} must be explicitly atomic`);
    if (!decompositionTaskIds.has(task.id)) throw new Error(`Tech Lead task ${task.id} must be a leaf in decomposition`);
  }

  const requireTaskKind = (taskId, kind, label) => {
    if (!taskIds.has(taskId)) throw new Error(`${label} references unknown task ${taskId}`);
    if (taskById.get(taskId)?.kind !== kind) throw new Error(`${label} must reference a ${kind} task`);
  };

  if (requireTasks) {
    for (const contract of contracts) {
      requireTaskKind(contract.interfaceTaskId, 'CONTRACT_INTERFACE', `contract ${contract.id} interfaceTaskId`);
      requireTaskKind(contract.contractTestTaskId, 'CONTRACT_TEST', `contract ${contract.id} contractTestTaskId`);
      if (contract.fakeTaskId) requireTaskKind(contract.fakeTaskId, 'FAKE_PROVIDER', `contract ${contract.id} fakeTaskId`);
    }
    for (const slice of verticalSlices) {
      requireTaskKind(slice.skeletonTaskId, 'VERTICAL_SKELETON', `vertical slice ${slice.id} skeletonTaskId`);
      if (!slice.taskIds.includes(slice.skeletonTaskId)) throw new Error(`vertical slice ${slice.id} skeletonTaskId must be included in taskIds`);
    }
  }

  if (requireTasks) new TaskGraph(tasks);
  return model;
}
