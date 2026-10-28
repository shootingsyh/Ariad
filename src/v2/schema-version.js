export const CURRENT_STORAGE_VERSION = 1;

export function projectStorageVersion(project) {
  return Number.isInteger(project?.storageVersion)
    ? project.storageVersion
    : 1;
}
