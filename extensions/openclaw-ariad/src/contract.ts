import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';

export const contract = defineFeatureContract({
  pluginId: 'ariad',
  operations: {
    project: {
      kind: 'action',
      description: 'Create, list, inspect, start, stop, bind or unbind a project Frontdesk, inspect its binding, or answer a pending human decision. The creating conversation becomes the default Frontdesk binding.',
      input: Type.Object({
        action: Type.Union([
          Type.Literal('create'),
          Type.Literal('list'),
          Type.Literal('status'),
          Type.Literal('start'),
          Type.Literal('stop'),
          Type.Literal('decide'),
          Type.Literal('bind_frontdesk'),
          Type.Literal('unbind_frontdesk'),
          Type.Literal('frontdesk_status'),
        ]),
        name: Type.Optional(Type.String({ description: 'Project name. Required except for list.' })),
        goal: Type.Optional(Type.String({ description: 'Initial project goal when creating a project.' })),
        decision: Type.Optional(Type.String({ description: 'User decision answering the current NEEDS_HUMAN request. Required for decide.' })),
        agentId: Type.Optional(Type.String({ description: 'OpenClaw agent id to bind as Frontdesk. Defaults to the calling agent.' })),
        sessionKey: Type.Optional(Type.String({ description: 'OpenClaw session key to bind as Frontdesk. Defaults to the calling session.' })),
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
