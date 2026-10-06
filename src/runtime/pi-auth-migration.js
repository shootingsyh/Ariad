import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

function decodeJwtExpiryMs(token) {
  try {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? Number(payload.exp) * 1000 : null;
  } catch {
    return null;
  }
}

function importCodexCredential() {
  const source = readJson(join(homedir(), '.codex', 'auth.json'));
  const tokens = source?.tokens;
  if (!tokens?.access_token || !tokens?.refresh_token) return null;
  const accountId = tokens.account_id ?? null;
  if (!accountId) return null;
  const expires = decodeJwtExpiryMs(tokens.access_token)
    ?? decodeJwtExpiryMs(tokens.id_token)
    ?? (Date.now() + 30 * 60 * 1000);
  return {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires,
    accountId,
  };
}

function importOpenClawMetaCredential() {
  const stateDb = join(homedir(), '.openclaw', 'state', 'openclaw.sqlite');
  if (!existsSync(stateDb)) return null;
  let db;
  try {
    db = new DatabaseSync(stateDb, { readOnly: true });
    const row = db.prepare(
      "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'"
    ).get();
    const profiles = row?.value_json ? JSON.parse(row.value_json)?.profiles : null;
    const meta = profiles?.['meta:default'];
    if (meta?.type !== 'api_key' || !meta.key) return null;
    return { type: 'api_key', key: meta.key };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function migrateLegacyPiAuth(authPath, { providers = [] } = {}) {
  const requested = new Set(providers);
  const current = readJson(authPath) ?? {};
  const added = [];

  if (requested.has('openai-codex') && !current['openai-codex']) {
    const credential = importCodexCredential();
    if (credential) {
      current['openai-codex'] = credential;
      added.push('openai-codex');
    }
  }

  if (requested.has('meta') && !current.meta && !process.env.META_API_KEY) {
    const credential = importOpenClawMetaCredential();
    if (credential) {
      current.meta = credential;
      added.push('meta');
    }
  }

  if (added.length > 0) writePrivateJson(authPath, current);
  return { added };
}
