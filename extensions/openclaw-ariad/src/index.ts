import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { AriadProjectManager, defaultProjectsRoot } from '../runtime/project-manager.js';

const configSchema = Type.Object({
  projectsRoot: Type.Optional(Type.String({ description: 'Root directory containing isolated Ariad projects.' })),
}, { additionalProperties: false });

const outputSchema = Type.Object({
  action: Type.String(),
  project: Type.Optional(Type.Any()),
  projects: Type.Optional(Type.Array(Type.Any())),
}, { additionalProperties: false });

export default defineToolPlugin({
  id: 'ariad',
  name: 'Ariad',
  description: 'Create and manage isolated Ariad autonomous engineering projects.',
  configSchema,
  tools: (tool) => [
    tool({
      name: 'ariad_project',
      description: 'Create, list, inspect, start, or stop isolated Ariad projects. Each project owns its workspace, state database, daemon pid/lock, heartbeat, and log files.',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('create'),
          Type.Literal('list'),
          Type.Literal('status'),
          Type.Literal('start'),
          Type.Literal('stop'),
        ]),
        name: Type.Optional(Type.String({ description: 'Project name. Required except for list.' })),
        goal: Type.Optional(Type.String({ description: 'Initial project goal when creating a project.' })),
      }, { additionalProperties: false }),
      outputSchema,
      execute: ({ action, name, goal }, config) => {
        const projectsRoot = config.projectsRoot || defaultProjectsRoot(homedir());
        const daemonEntry = fileURLToPath(new URL('../runtime/daemon-worker.js', import.meta.url));
        const manager = new AriadProjectManager({ projectsRoot, daemonEntry });

        if (action === 'list') return { action, projects: manager.list() };
        if (!name) throw new Error(`name is required for action ${action}`);
        if (action === 'create') return { action, project: manager.create(name, { goal: goal ?? null }) };
        if (action === 'status') return { action, project: manager.status(name) };
        if (action === 'start') return { action, project: manager.start(name) };
        if (action === 'stop') return { action, project: manager.stop(name) };
        throw new Error(`unsupported Ariad action: ${action}`);
      },
    }),
  ],
});
