#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./ariad-role-result-mcp.js', import.meta.url));
const config = {
  transport: 'stdio',
  command: process.execPath,
  args: [serverPath],
  toolFilter: { include: ['ariad_role_result'] },
  codex: { defaultToolsApprovalMode: 'auto' },
};

if (process.argv.includes('--print')) {
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
  process.exit(0);
}

const openclaw = process.env.OPENCLAW_BIN || 'openclaw';
execFileSync(openclaw, ['mcp', 'set', 'ariad-role-result', JSON.stringify(config)], {
  stdio: 'inherit',
});
execFileSync(openclaw, ['mcp', 'probe', 'ariad-role-result'], {
  stdio: 'inherit',
});
process.stdout.write('Ariad MCP server registered in OpenClaw mcp.servers. Restart the Gateway before launching Codex role attempts.\n');
