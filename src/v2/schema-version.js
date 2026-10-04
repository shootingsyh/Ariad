export const CURRENT_STORAGE_VERSION = 1;
export const CURRENT_PLANNING_MODEL_VERSION = 2;

export function projectPlanningModelVersion(project) {
  return Number.isInteger(project?.planningModelVersion)
    ? project.planningModelVersion
    : 1;
}

export function projectStorageVersion(project) {
  return Number.isInteger(project?.storageVersion)
    ? project.storageVersion
    : 1;
}
