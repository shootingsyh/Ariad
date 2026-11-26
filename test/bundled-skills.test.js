import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledSkillPaths,
  bundledSkillsCatalog,
  bundledSkillsDir,
  deliverySystemPrompt,
  loadBundledSkills,
} from '../src/runtime/bundled-skills.js';

test('the install ships the godot audio testing skill', () => {
  const { skills, diagnostics } = loadBundledSkills();
  assert.deepEqual(diagnostics.filter(d => d.type === 'error'), []);
  for (const name of ['godot-audio-testing', 'godot-tilemap-production', 'visual-evidence-capture']) {
    assert.ok(skills.some(s => s.name === name), `${name} skill is bundled`);
  }
  const audio = skills.find(s => s.name === 'godot-audio-testing');
  assert.ok(audio, 'godot-audio-testing skill is bundled');
  assert.match(audio.description, /Godot 4 game audio/);
  assert.ok(audio.filePath.endsWith(join('godot-audio-testing', 'SKILL.md')));
});

test('catalog lists bundled skills with their file locations', () => {
  const catalog = bundledSkillsCatalog();
  assert.match(catalog, /godot-audio-testing/);
  assert.match(catalog, /SKILL\.md/);
  assert.match(catalog, /read tool/);
});

test('delivery system prompt appends the catalog in a skills section', () => {
  const catalog = bundledSkillsCatalog();
  const prompt = deliverySystemPrompt('BASE', catalog);
  assert.ok(prompt.startsWith('BASE\n\n<skills>\n'));
  assert.ok(prompt.endsWith('\n</skills>'));
  assert.match(prompt, /godot-audio-testing/);
  assert.equal(deliverySystemPrompt('BASE', ''), 'BASE');
});

test('a missing skills directory loads as empty, never throws', () => {
  const missing = join(tmpdir(), 'ariad-no-such-skills-dir');
  assert.deepEqual(loadBundledSkills(missing), { skills: [], diagnostics: [] });
  assert.equal(bundledSkillsCatalog(missing), '');
});

test('skill discovery parses SKILL.md frontmatter from a fixture dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'ariad-skills-'));
  mkdirSync(join(root, 'demo-skill'));
  writeFileSync(join(root, 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A demo skill for tests.\n---\n\n# Demo\n');
  const { skills } = loadBundledSkills(root);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'demo-skill');
  assert.equal(skills[0].description, 'A demo skill for tests.');
  assert.match(bundledSkillsCatalog(root), /demo-skill/);
});

test('ARIAD_NO_BUNDLED_SKILLS disables the loader paths', () => {
  process.env.ARIAD_NO_BUNDLED_SKILLS = '1';
  try {
    assert.deepEqual(bundledSkillPaths(), []);
  } finally {
    delete process.env.ARIAD_NO_BUNDLED_SKILLS;
  }
  assert.deepEqual(bundledSkillPaths(), [bundledSkillsDir()]);
});
