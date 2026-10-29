/**
 * Guided configuration assistant: after bootstrap ignition, a working
 * model walks the user through finishing configuration - but it can
 * only PROPOSE. Every change is validated by the config service, shown
 * to the user, and applied solely on the user's confirmation.
 *
 * The iron rule holds here too: API keys never travel through the
 * model. When a key is needed the assistant emits a request_api_key
 * action and the harness collects the key through the local hidden
 * input, straight into the credential store; the transcript records
 * only the fact that a key was saved.
 *
 * The conversation runs over single-message completions (the proven
 * testModelRef path): each turn the harness renders the transcript as
 * text and asks for the assistant's next message. That keeps the loop
 * provider-agnostic, from hosted flagships down to a local llama.
 */
import { ARIAD_MODEL_ROLES } from './role-models.js';
import { WIZARD_KEY_PROVIDERS } from './config-wizard.js';

export const ASSISTANT_MAX_TURNS = 24;

export const ASSISTANT_SYSTEM_PROMPT = [
  '你是 Ariad 的配置引导助手。Ariad 是一个自动写代码的系统，有 8 个角色各需一个模型：',
  '规划侧 tech_lead、tech_lead_critic、pm、project_debugger 用强模型；执行侧 developer、tester、reviewer、artist 可以用便宜或本地模型。',
  '你的目标：帮用户把 8 个角色的默认模型配齐（这是能跑项目的最低要求），需要时先补 provider 或 key。',
  '每轮你可以正常说话，或在回复末尾附带一个动作块（三个反引号 + ariad-action + JSON + 三个反引号）。可用动作：',
  '{"action":"propose_role_models","roleModels":{"tech_lead":"provider/model", ... 8 个角色都要有}}',
  '{"action":"propose_provider","id":"...","baseUrl":"https://...","models":[{"id":"..."}]}',
  '{"action":"request_api_key","providerId":"openai"}',
  '{"action":"finish"}',
  '硬规则：',
  '1. 绝不要让用户在聊天里粘贴 API key；需要 key 时用 request_api_key，系统会打开本地隐藏输入。',
  '2. 只能用上下文列出的模型 ID，不要编造。价格如实引用上下文。',
  '3. 你不能直接写配置：提案会被系统验证、并经用户确认后才落盘；被拒或验证失败时按系统反馈调整。',
  '4. 说话简短，一次只推进一件事。配置齐了就用 finish 收尾。',
].join('\n');

const ACTION_FENCE = /```ariad-action\s*\n([\s\S]*?)```/;

export function parseAssistantAction(text) {
  const match = ACTION_FENCE.exec(String(text ?? ''));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed.action === 'string' ? parsed : null;
  } catch {
    return { action: '__invalid__', raw: match[1].slice(0, 200) };
  }
}

export function stripAssistantAction(text) {
  return String(text ?? '').replace(ACTION_FENCE, '').trim();
}

function priceLabel(model) {
  return model?.cost ? `$${model.cost.input}/$${model.cost.output}` : '价格未知';
}

export async function buildAssistantContext({ service }) {
  const snapshot = await service.snapshot();
  const configured = service.configuredProviders();
  const lines = ['[当前配置状态]'];
  lines.push(`已接入的 provider: ${configured.length ? configured.map(p => `${p.id}(${p.source})`).join(', ') : '无'}`);
  lines.push(`自定义 provider: ${snapshot.customProviders.length ? snapshot.customProviders.map(p => p.id).join(', ') : '无'}`);
  lines.push(`现有角色默认: ${snapshot.roleDefaults ? JSON.stringify(snapshot.roleDefaults) : '未配置'}`);
  lines.push('[可为角色选用的模型（仅已接入 provider）]');
  for (const provider of configured) {
    const models = await service.listProviderModels(provider.id).catch(() => []);
    if (!models.length) { lines.push(`${provider.id}: (目录未列出模型)`); continue; }
    for (const model of models.slice(0, 12)) {
      lines.push(`${provider.id}/${model.id} — ${priceLabel(model)}`);
    }
    if (models.length > 12) lines.push(`${provider.id}: 另有 ${models.length - 12} 个模型未列出`);
  }
  lines.push(`[可申请 key 的 provider] ${WIZARD_KEY_PROVIDERS.map(p => `${p.id}(${p.label})`).join(', ')}`);
  lines.push('请先向用户打招呼，说明现状和你建议的配法，然后推进。');
  return lines.join('\n');
}

function renderTranscript(transcript) {
  return transcript.map(entry => {
    const who = entry.role === 'assistant' ? '助手' : entry.role === 'system' ? '系统' : '用户';
    return `[${who}] ${entry.content}`;
  }).join('\n');
}

export async function runConfigAssistant({ service, io, complete, igniterRef, maxTurns = ASSISTANT_MAX_TURNS }) {
  const context = await buildAssistantContext({ service });
  const transcript = [{ role: 'user', content: context }];
  const applied = [];
  io.print(`Ariad 引导配置助手（点火模型: ${igniterRef}）`);
  io.print('说明: 助手的每项提案都会先验证、经你确认才落盘；API key 只走本地隐藏输入，助手看不到。输入 /done 随时结束。');
  io.print('');

  const feedSystem = content => transcript.push({ role: 'system', content });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const prompt = `${renderTranscript(transcript)}\n[系统] 请只输出你（助手）这一轮的话。`;
    let reply;
    try {
      reply = await complete(prompt);
    } catch (error) {
      io.print(`✗ 助手模型调用失败: ${error?.message ?? error}（已保存的配置不受影响，可随时重跑）`);
      break;
    }
    transcript.push({ role: 'assistant', content: String(reply ?? '') });
    const display = stripAssistantAction(reply);
    if (display) io.print(`助手: ${display}`);
    const action = parseAssistantAction(reply);

    if (!action) {
      const answer = (await io.input('你')).trim();
      if (answer === '/done') break;
      transcript.push({ role: 'user', content: answer || '（继续）' });
      continue;
    }

    if (action.action === 'finish') break;

    if (action.action === '__invalid__') {
      feedSystem(`你上轮的动作块不是合法 JSON，未执行。原始内容: ${action.raw}`);
      continue;
    }

    if (action.action === 'request_api_key') {
      const providerId = String(action.providerId ?? '');
      const known = WIZARD_KEY_PROVIDERS.find(p => p.id === providerId);
      if (!providerId) { feedSystem('request_api_key 缺少 providerId，未执行。'); continue; }
      if (known) io.print(`申请地址: ${known.hint}`);
      const key = await io.secret(`粘贴 ${providerId} 的 API key（输入不回显）`);
      if (!key) { feedSystem(`用户没有输入 ${providerId} 的 key，key 未保存。`); continue; }
      try {
        service.saveApiKey(providerId, key);
        io.print(`✓ ${providerId} 的 key 已存入本机凭证存储。`);
        feedSystem(`${providerId} 的 key 已由用户在本地输入并保存（你看不到 key 本身）。该 provider 现在可用。`);
      } catch (error) {
        feedSystem(`保存 ${providerId} 的 key 失败: ${error?.message ?? error}`);
      }
      continue;
    }

    if (action.action === 'propose_provider') {
      const { id, baseUrl, models } = action;
      if (!id || !/^https?:\/\//.test(String(baseUrl ?? '')) || !Array.isArray(models) || !models.length) {
        feedSystem('propose_provider 形状不合法（需要 id、http(s) baseUrl、非空 models），未执行。');
        continue;
      }
      io.print(`提案: 新增 provider ${id} — ${baseUrl}，模型 ${models.map(m => m?.id).join(', ')}`);
      if (!await io.confirm('应用这个 provider?', { default: false })) {
        feedSystem(`用户拒绝了 provider ${id} 提案，未保存。`);
        continue;
      }
      try {
        service.upsertCustomProvider(id, { baseUrl, models });
        applied.push(`provider:${id}`);
        feedSystem(`provider ${id} 已保存，其模型现在可以用于角色提案。`);
      } catch (error) {
        feedSystem(`保存 provider ${id} 失败: ${error?.message ?? error}`);
      }
      continue;
    }

    if (action.action === 'propose_role_models') {
      const roleModels = action.roleModels ?? {};
      const validation = await service.validateRoleModels(roleModels);
      if (!validation.complete) {
        feedSystem(`角色提案不完整，未提交用户确认。${validation.completenessError ?? ''} 必须一次给齐 8 个角色: ${ARIAD_MODEL_ROLES.join(', ')}。`);
        continue;
      }
      const bad = Object.entries(validation.roles).filter(([, v]) => !v.ok);
      if (bad.length) {
        feedSystem(`角色提案验证失败，未提交用户确认: ${bad.map(([r, v]) => `${r}=${v.ref} (${v.reason})`).join('; ')}。请换成上下文里列出的模型。`);
        continue;
      }
      const configuredIds = new Set(service.configuredProviders().map(p => p.id));
      io.print('提案: 角色默认模型');
      for (const role of ARIAD_MODEL_ROLES) {
        const v = validation.roles[role];
        const warn = configuredIds.has(v.provider) ? '' : '（该 provider 还没有 key，配完需补 key 才能真正调用）';
        io.print(`  ${role}: ${v.ref} — ${v.cost ? `$${v.cost.input}/$${v.cost.output}` : '价格未知'}${warn}`);
      }
      if (!await io.confirm('应用这组角色模型?', { default: false })) {
        feedSystem('用户拒绝了这组角色模型提案，未保存。请调整方案（比如换更便宜或更强的搭配）。');
        continue;
      }
      const saved = service.setRoleDefaults(roleModels);
      applied.push('role-models');
      feedSystem(`角色模型已保存: ${JSON.stringify(saved)}。配置已齐，可以 finish 收尾，或继续优化。`);
      continue;
    }

    feedSystem(`未知动作 ${action.action}，未执行。可用动作只有 propose_role_models / propose_provider / request_api_key / finish。`);
  }

  const defaults = service.snapshot ? (await service.snapshot()).roleDefaults : null;
  io.print('');
  io.print(`引导结束。本次落盘: ${applied.length ? applied.join(', ') : '无'}。`);
  io.print(`当前角色默认: ${defaults ? '已配置齐全' : '尚未配齐（可用 ariad config guide 手动完成，或重跑本助手）'}`);
  return { applied, roleDefaults: defaults };
}
