import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStandaloneRolePrompt,
  deriveExecutionHandoff,
} from '../src/runtime/role-run-prompt.js';

test('standalone role prompt contains assigned task contract and bounded prior context', () => {
  const history = [
    {
      type: 'TAKEOVER_NOTE',
      summary: 'Reuse the existing entry lifecycle path.',
      files: ['scripts/ui/title.gd', 'scripts/autoload/game_state.gd'],
    },
    {
      type: 'ROLE_RESULT',
      role: 'developer',
      outcome: 'NOT_PASS',
      summary: 'Located the entry path but did not implement.',
      executionContext: {
        readFiles: [
          'scripts/ui/title.gd',
          'scripts/autoload/game_state.gd',
          'scripts/ui/map_select.gd',
        ],
        writtenFiles: [],
        commands: [
          { command: "rg -n 'new_game|record_victory' scripts", exitCode: 0 },
        ],
      },
    },
  ];

  const prompt = buildStandaloneRolePrompt({
    v2Prompt: 'You are the developer.',
    task: {
      id: 'T1',
      title: 'Entry prefix route',
      intent: 'Build the title-to-CH1 route manifest and checkpoint harness.',
      acceptanceCriteria: ['Route all 18 prefix maps through normal UI progression.'],
      history,
    },
    devCycle: 2,
  });

  assert.match(prompt, /ASSIGNED TASK/);
  assert.match(prompt, /Entry prefix route/);
  assert.match(prompt, /Route all 18 prefix maps/);
  assert.match(prompt, /RELEVANT PRIOR TASK HISTORY/);
  assert.match(prompt, /Reuse the existing entry lifecycle path/);
  assert.match(prompt, /ARIAD EXECUTION HANDOFF/);
  assert.match(prompt, /scripts\/ui\/title\.gd/);
  assert.match(prompt, /scripts\/autoload\/game_state\.gd/);
  assert.match(prompt, /Start from them instead of repeating repository-wide discovery/);
});

test('execution handoff deduplicates and bounds concrete tool-derived anchors', () => {
  const history = [
    {
      type: 'SYSTEM_INTERRUPTION',
      executionContext: {
        readFiles: ['a.gd', 'b.gd', 'a.gd'],
        writtenFiles: ['out.gd'],
        commands: [{ command: 'rg foo', exitCode: 0 }],
      },
    },
    {
      type: 'ROLE_RESULT',
      executionContext: {
        readFiles: ['b.gd', 'c.gd'],
        writtenFiles: ['out.gd', 'test.gd'],
        commands: [{ command: 'godot --headless --script test.gd', exitCode: 1 }],
      },
    },
  ];

  assert.deepEqual(deriveExecutionHandoff(history), {
    confirmedFiles: ['a.gd', 'b.gd', 'c.gd'],
    modifiedFiles: ['out.gd', 'test.gd'],
    recentCommands: [
      { command: 'rg foo', exitCode: 0 },
      { command: 'godot --headless --script test.gd', exitCode: 1 },
    ],
  });
});
