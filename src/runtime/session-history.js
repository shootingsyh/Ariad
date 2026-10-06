import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ariadPiPaths } from './pi-runtime-config.js';

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

function readMeta(file) {
  const path = join(file.slice(0, file.lastIndexOf('/')), 'ariad-session.json');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function messageText(message) {
  const value = message?.content;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n');
}

export function sessionHistory(workspace, {
  sinceHours = 24,
  role = null,
  taskId = null,
  limit = 200,
  maxChars = 20000,
  includeMaintenance = false,
} = {}) {
  const root = ariadPiPaths(workspace).sessionsDir;
  const cutoff = Date.now() - Math.max(0, Number(sinceHours) || 24) * 60 * 60 * 1000;
  const events = [];
  for (const file of walk(root).sort()) {
    const meta = readMeta(file);
    if (!includeMaintenance && meta.role === 'memory_curator') continue;
    if (role && meta.role !== role) continue;
    if (taskId && meta.taskId !== taskId) continue;
    let lines;
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      const at = Date.parse(entry.timestamp ?? '');
      if (Number.isFinite(at) && at < cutoff) continue;
      if (entry.type === 'compaction' && entry.summary) {
        events.push({
          ...meta, source: relative(workspace, file), line: i + 1,
          at: entry.timestamp ?? null, role: meta.role ?? null,
          messageRole: 'compaction', text: String(entry.summary),
        });
        continue;
      }
      if (entry.type !== 'message') continue;
      const text = messageText(entry.message).trim();
      if (!text) continue;
      const messageRole = entry.message?.role ?? 'unknown';
      if (!['user', 'assistant', 'toolResult', 'custom'].includes(messageRole)) continue;
      events.push({
        ...meta, source: relative(workspace, file), line: i + 1,
        at: entry.timestamp ?? null, role: meta.role ?? null,
        messageRole, text,
      });
    }
  }
  events.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  const capped = events.slice(-Math.max(1, Math.min(Number(limit) || 200, 1000)));
  let chars = 0;
  const result = [];
  for (let i = capped.length - 1; i >= 0; i -= 1) {
    const item = capped[i];
    const size = item.text.length;
    if (result.length && chars + size > maxChars) break;
    chars += size;
    result.push(item);
  }
  return result.reverse();
}
