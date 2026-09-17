export interface AriadProjectStatus {
  id: string;
  name: string;
  goal: string | null;
  createdAt: string;
  workspace: string;
  stateDb: string;
  root: string;
  running: boolean;
  pid: number | null;
  heartbeat: unknown;
  log: string;
}

export interface AriadProjectManagerOptions {
  projectsRoot: string;
  daemonEntry: string;
  spawn?: (...args: any[]) => any;
  isProcessAlive?: (pid: number | null) => boolean;
  kill?: (pid: number, signal?: string) => unknown;
  now?: () => Date;
}

export class AriadProjectManager {
  constructor(options: AriadProjectManagerOptions);
  create(name: string, options?: { goal?: string | null }): AriadProjectStatus;
  list(): AriadProjectStatus[];
  status(name: string): AriadProjectStatus;
  start(name: string): AriadProjectStatus;
  stop(name: string): AriadProjectStatus;
}

export function defaultProjectsRoot(homeDir: string): string;
export function slugify(name: string): string;
