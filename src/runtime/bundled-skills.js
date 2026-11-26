// Bundled skills: Agent Skills (SKILL.md) shipped with the Ariad install.
// The pi resource loader receives the bundled directory through
// additionalSkillPaths, so every role session's system prompt carries the
// skill catalog (name + description + file location) and the model reads a
// skill's full text with the read tool only when the task matches it.
// Sessions stay hermetic (noSkills remains on): user- and project-level
// skill directories are NOT discovered - the bundled set is the whole set.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSkillsForPrompt, loadSkillsFromDir } from '@earendil-works/pi-coding-agent';

export function bundledSkillsDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../skills');
}

// Paths handed to the resource loader. ARIAD_NO_BUNDLED_SKILLS=1 is the
// kill switch for the whole mechanism.
export function bundledSkillPaths() {
  if (process.env.ARIAD_NO_BUNDLED_SKILLS === '1') return [];
  const dir = bundledSkillsDir();
  return existsSync(dir) ? [dir] : [];
}

export function loadBundledSkills(dir = bundledSkillsDir()) {
  if (!existsSync(dir)) return { skills: [], diagnostics: [] };
  return loadSkillsFromDir({ dir, source: 'ariad-bundled' });
}

// The catalog text exactly as the SDK renders it into non-delivery system
// prompts (the loader wraps it in a <skills> section). Empty when the
// install ships no skills.
export function bundledSkillsCatalog(dir = bundledSkillsDir()) {
  const { skills } = loadBundledSkills(dir);
  if (!skills.length) return '';
  return formatSkillsForPrompt(skills, 'read').trim();
}

// Delivery roles replace the SDK system prompt with Ariad's own, which
// would discard the loader's skills section; append the same catalog in
// the same <skills> wrapping so delivery sessions see it too.
export function deliverySystemPrompt(basePrompt, catalog) {
  return catalog ? `${basePrompt}\n\n<skills>\n${catalog}\n</skills>` : basePrompt;
}
