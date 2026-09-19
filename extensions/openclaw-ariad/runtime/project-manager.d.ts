export interface FrontdeskBinding {
  host: string;
  agentId?: string | null;
  sessionKey?: string | null;
}

export interface AriadProjectStatus {
  id: string;
  name: string;
  goal: string | null;
  createdAt: string;
  workspace: string;
  stateDb: string;
  root: string;
  desiredState: 'RUNNING' | 'STOPPED';
  executionState: 'IDLE' | 'PLANNING' | 'RUNNING' | 'NEEDS_HUMAN' | 'FAILED' | 'SUCCEEDED';
  frontdeskBinding: FrontdeskBinding | null;
}

export interface AriadProjectManagerOptions {
  projectsRoot: string;
  now?: () => Date;
}

export class AriadProjectManager {
  constructor(options: AriadProjectManagerOptions);
  create(name: string, options?: { goal?: string | null; frontdeskBinding?: FrontdeskBinding | null; projectAgent?: FrontdeskBinding | null }): AriadProjectStatus;
  list(): AriadProjectStatus[];
  status(name: string): AriadProjectStatus;
  setDesiredState(name: string, desiredState: 'RUNNING' | 'STOPPED'): AriadProjectStatus;
  setExecutionState(name: string, executionState: AriadProjectStatus['executionState']): AriadProjectStatus;
  bindFrontdesk(name: string, frontdeskBinding: FrontdeskBinding | null): AriadProjectStatus;
  unbindFrontdesk(name: string): AriadProjectStatus;
  bindProjectAgent(name: string, projectAgent: FrontdeskBinding | null): AriadProjectStatus;
}

export function defaultProjectsRoot(homeDir: string): string;
export function slugify(name: string): string;
