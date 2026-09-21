export interface FrontdeskBinding {
  host: string;
  agentId?: string | null;
  sessionKey?: string | null;
}

export type AriadRoleModels = Partial<Record<
  'developer' | 'tester' | 'reviewer' | 'project_debugger' | 'tech_lead' | 'tech_lead_critic' | 'pm',
  string
>>;

export interface AriadProjectStatus {
  id: string;
  name: string;
  goal: string | null;
  mode: 'NEW' | 'TAKEOVER';
  sourcePath: string | null;
  adopted: boolean;
  createdAt: string;
  workspace: string;
  stateDb: string;
  root: string;
  desiredState: 'RUNNING' | 'STOPPED';
  executionState: 'IDLE' | 'PLANNING' | 'RUNNING' | 'NEEDS_HUMAN' | 'FAILED' | 'SUCCEEDED';
  frontdeskBinding: FrontdeskBinding | null;
  roleModels: AriadRoleModels;
}

export interface AriadProjectManagerOptions {
  projectsRoot: string;
  now?: () => Date;
}

export class AriadProjectManager {
  constructor(options: AriadProjectManagerOptions);
  create(name: string, options?: { goal?: string | null; mode?: 'NEW' | 'TAKEOVER' | null; sourcePath?: string | null; roleModels?: AriadRoleModels; frontdeskBinding?: FrontdeskBinding | null; projectAgent?: FrontdeskBinding | null }): AriadProjectStatus;
  adopt(name: string, sourcePath?: string | null): AriadProjectStatus;
  list(): AriadProjectStatus[];
  status(name: string): AriadProjectStatus;
  setRoleModels(name: string, roleModels: AriadRoleModels): AriadProjectStatus;
  setDesiredState(name: string, desiredState: 'RUNNING' | 'STOPPED'): AriadProjectStatus;
  setExecutionState(name: string, executionState: AriadProjectStatus['executionState']): AriadProjectStatus;
  bindFrontdesk(name: string, frontdeskBinding: FrontdeskBinding | null): AriadProjectStatus;
  unbindFrontdesk(name: string): AriadProjectStatus;
  bindProjectAgent(name: string, projectAgent: FrontdeskBinding | null): AriadProjectStatus;
}

export function defaultProjectsRoot(homeDir: string): string;
export function slugify(name: string): string;
