import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';

export const contract = defineFeatureContract({
  pluginId: 'ariad',
  operations: {
    project: {
      kind: 'action',
      description: 'Create, list, inspect, start, or stop isolated Ariad projects. The creating conversation becomes the project agent binding.',
      input: Type.Object({
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
      output: Type.Object({
        action: Type.String(),
        payloadJson: Type.String(),
      }, { additionalProperties: false }),
      tool: { name: 'ariad_project', label: 'Ariad project' },
    },
  },
  events: {},
});
