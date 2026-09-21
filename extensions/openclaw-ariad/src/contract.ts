import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';

const RoleModelsSchema = Type.Object({
  artist: Type.Optional(Type.String()),
  developer: Type.Optional(Type.String()),
  tester: Type.Optional(Type.String()),
  reviewer: Type.Optional(Type.String()),
  project_debugger: Type.Optional(Type.String()),
  tech_lead: Type.Optional(Type.String()),
  tech_lead_critic: Type.Optional(Type.String()),
  pm: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const contract = defineFeatureContract({
  pluginId: 'ariad',
  operations: {
    project: {
      kind: 'action',
      description: 'Create, list, inspect, start, pause, resume, iterate a completed project into its next version, stop, bind or unbind a project Frontdesk, inspect its binding, or answer a pending human decision. Pause is a direct control-plane action that freezes scheduling without cancelling in-flight role runs. The creating conversation becomes the default Frontdesk binding.',
      input: Type.Object({
        action: Type.Union([
          Type.Literal('create'),
          Type.Literal('list'),
          Type.Literal('status'),
          Type.Literal('adopt'),
          Type.Literal('start'),
          Type.Literal('pause'),
          Type.Literal('resume'),
          Type.Literal('iterate'),
          Type.Literal('stop'),
          Type.Literal('decide'),
          Type.Literal('bind_frontdesk'),
          Type.Literal('unbind_frontdesk'),
          Type.Literal('frontdesk_status'),
          Type.Literal('models'),
          Type.Literal('set_role_models'),
        ]),
        name: Type.Optional(Type.String({ description: 'Project name. Required except for list.' })),
        goal: Type.Optional(Type.String({ description: 'Initial project goal when creating a project.' })),
        request: Type.Optional(Type.String({ description: 'New work request for iterate. Creates the next project version and replans without reopening completed tasks by default.' })),
        mode: Type.Optional(Type.Union([
          Type.Literal('NEW'),
          Type.Literal('TAKEOVER'),
        ], { description: 'Project lifecycle mode. Use TAKEOVER for reconstructing an existing non-Ariad project; this forces a human review gate before delivery.' })),
        sourcePath: Type.Optional(Type.String({ description: 'Existing Git repository path. On TAKEOVER create it is adopted directly as the Ariad workspace; for adopt it is the target repository.' })),
        decision: Type.Optional(Type.String({ description: 'User decision answering the current NEEDS_HUMAN request. Required for decide.' })),
        agentId: Type.Optional(Type.String({ description: 'OpenClaw agent id to bind as Frontdesk. Defaults to the calling agent.' })),
        sessionKey: Type.Optional(Type.String({ description: 'OpenClaw session key to bind as Frontdesk. Defaults to the calling session.' })),
        roleModels: Type.Optional(RoleModelsSchema),
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
