import { ARIAD_MODEL_ROLES } from './role-models.js';

/**
 * Interactive configuration navigation (CLI). All IO and all persistence
 * are injected: IO is a terminal in production and a script in tests; the
 * config service owns every write. The flow is detect -> choose access ->
 * choose role models -> validate -> save. API keys are collected through
 * io.secret (never echoed, never printed) and handed straight to the
 * config service's credential writer - the wizard itself never logs them.
 *
 * The same flow is what the guided setup assistant (bootstrap model) will
 * drive later through the config service directly; this is the human,
 * no-model-needed version.
 */

export const WIZARD_KEY_PROVIDERS = Object.freeze([
  { id: 'openai', label: 'OpenAI', hint: 'platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', hint: 'console.anthropic.com' },
  { id: 'google', label: 'Google (Gemini)', hint: 'aistudio.google.com/apikey - has a free tier' },
  { id: 'deepseek', label: 'DeepSeek', hint: 'platform.deepseek.com' },
  { id: 'meta', label: 'Meta', hint: 'Muse Spark API' },
]);

export const PLANNING_ROLES = Object.freeze(['tech_lead', 'tech_lead_critic', 'pm', 'project_debugger']);
export const EXECUTION_ROLES = Object.freeze(['developer', 'tester', 'reviewer', 'artist']);

const LOCAL_DEFAULT_CONTEXT = { contextWindow: 32768, maxTokens: 8192 };

function tierModels(models) {
  const usable = models.filter(model => model.id);
  if (!usable.length) return null;
  const flagship = usable[0];
  const balanced = usable[Math.floor(usable.length / 2)] ?? flagship;
  const cheap = usable[usable.length - 1] ?? flagship;
  return { flagship, balanced, cheap };
}

function formatCost(model) {
  if (!model?.cost) return 'price n/a';
  return `$${model.cost.input ?? 0}/$${model.cost.output ?? 0} per 1M in/out`;
}

export async function runConfigWizard({ service, io, localBaseUrlDefault = 'http://127.0.0.1:18080/v1' }) {
  const addedProviders = [];
  io.print('Ariad 配置向导 - 探测 -> 选择 -> 验证 -> 保存');
  io.print('');

  // --- Detect -------------------------------------------------------------
  const readiness = service.readiness();
  const configured = service.configuredProviders();
  const existingDefaults = service.roleDefaults();
  io.print('探测结果:');
  for (const [providerId, info] of Object.entries(readiness.providers ?? {})) {
    io.print(`  ${info.ready ? '✓' : '·'} ${providerId} (${info.source})`);
  }
  for (const provider of service.customProviders()) {
    io.print(`  ✓ ${provider.id} (自定义 provider, ${provider.baseUrl})`);
  }
  if (existingDefaults) io.print('  已有安装级角色配置（可在下面保留或覆盖）。');
  io.print('');

  // --- Choose access ------------------------------------------------------
  const access = new Set(configured.map(entry => entry.id));
  for (const provider of service.customProviders()) access.add(provider.id);
  let localModels = null;

  for (;;) {
    const options = [];
    if (access.size) options.push({ id: 'done', label: `接入已就绪（${[...access].join(', ')}），继续配置角色模型` });
    options.push({ id: 'key', label: '输入 API key（OpenAI / Anthropic / Google / DeepSeek / Meta）' });
    options.push({ id: 'local', label: '连接本地端点（llama.cpp / Ollama 等 OpenAI 兼容服务）' });
    if (existingDefaults) options.push({ id: 'keep', label: '保留现有角色配置，结束' });
    options.push({ id: 'abort', label: '退出向导（不保存角色配置）' });
    const pick = options[await io.choose('选择接入方式:', options)];

    if (pick.id === 'done') break;
    if (pick.id === 'keep') {
      io.print('已保留现有角色配置。');
      return { saved: false, keptExisting: true, addedProviders };
    }
    if (pick.id === 'abort') {
      io.print('已退出。角色配置未保存。');
      return { saved: false, aborted: true, addedProviders };
    }

    if (pick.id === 'key') {
      const provider = WIZARD_KEY_PROVIDERS[await io.choose('选择 provider:', WIZARD_KEY_PROVIDERS.map(p => ({ label: p.label, hint: p.hint })))];
      io.print(`申请地址: ${provider.hint}`);
      const key = await io.secret(`粘贴 ${provider.label} 的 API key（输入不回显）`);
      if (!key) { io.print('未输入 key，跳过。'); continue; }
      try {
        service.saveApiKey(provider.id, key);
        access.add(provider.id);
        addedProviders.push(provider.id);
        io.print(`✓ ${provider.id} 的 key 已存入 Pi 凭证存储。`);
      } catch (error) {
        io.print(`✗ 保存失败: ${error.message}`);
      }
      continue;
    }

    if (pick.id === 'local') {
      let url = await io.input('本地端点 base URL', { default: localBaseUrlDefault });
      let probe = await service.probeLocalEndpoint(url);
      for (let attempt = 0; !probe.reachable && attempt < 2; attempt += 1) {
        io.print(`✗ 连不上 ${url}: ${probe.error ?? 'unknown error'}`);
        if (!await io.confirm('换个地址重试?', { default: true })) break;
        url = await io.input('本地端点 base URL', { default: url });
        probe = await service.probeLocalEndpoint(url);
      }
      if (!probe.reachable) { io.print('本地端点未接通，跳过。'); continue; }
      io.print(`✓ 已连通，加载的模型: ${probe.models.join(', ') || '(未报告)'}`);
      const models = probe.models.length
        ? probe.models.map(id => ({ id, ...LOCAL_DEFAULT_CONTEXT }))
        : [{ id: await io.input('模型 ID（端点未报告模型列表，手动输入）'), ...LOCAL_DEFAULT_CONTEXT }];
      service.upsertCustomProvider('local', { baseUrl: url, models });
      access.add('local');
      addedProviders.push('local');
      localModels = models;
      io.print('✓ 已登记为自定义 provider "local"（上下文参数为默认值，可在 models.json 里改）。');
      continue;
    }
  }

  if (!access.size) {
    io.print('没有任何可用接入，无法配置角色模型。');
    return { saved: false, aborted: true, addedProviders };
  }

  // --- Choose role models ---------------------------------------------------
  const roleProviders = [...access];
  const strategyOptions = [
    { id: 'quality', label: '预设: 质量优先（规划用旗舰，执行用均衡）' },
    { id: 'value', label: '预设: 性价比（规划用均衡，执行用廉价）' },
  ];
  if (access.has('local')) strategyOptions.push({ id: 'local', label: '预设: 全本地（所有角色用本地模型）' });
  strategyOptions.push({ id: 'manual', label: '逐个角色选择' });
  const strategy = strategyOptions[await io.choose('角色模型策略:', strategyOptions)];

  let roleModels = null;
  if (strategy.id === 'local') {
    const models = localModels ?? service.customProviders().find(p => p.id === 'local')?.models ?? [];
    if (!models.length) { io.print('本地 provider 没有可用模型。'); return { saved: false, aborted: true, addedProviders }; }
    const model = models.length === 1 ? models[0] : models[await io.choose('本地模型:', models.map(m => ({ label: m.id })))];
    roleModels = Object.fromEntries(ARIAD_MODEL_ROLES.map(role => [role, `local/${model.id}`]));
  } else if (strategy.id === 'manual') {
    roleModels = {};
    for (const role of ARIAD_MODEL_ROLES) {
      const providerId = roleProviders.length === 1
        ? roleProviders[0]
        : roleProviders[await io.choose(`${role} 用哪个 provider:`, roleProviders.map(id => ({ label: id })))];
      const models = await service.listProviderModels(providerId);
      const modelOptions = models.slice(0, 10).map(m => ({ label: m.id, hint: formatCost(m) }));
      modelOptions.push({ label: '手动输入模型 ID' });
      const pickIndex = await io.choose(`${role} 用哪个模型（${providerId}）:`, modelOptions);
      const modelId = pickIndex < models.slice(0, 10).length
        ? models[pickIndex].id
        : await io.input('模型 ID');
      roleModels[role] = `${providerId}/${modelId}`;
    }
  } else {
    const catalogProviders = roleProviders.filter(id => id !== 'local');
    if (!catalogProviders.length) { io.print('没有可用的云端 provider 做预设。'); return { saved: false, aborted: true, addedProviders }; }
    const primary = catalogProviders.length === 1
      ? catalogProviders[0]
      : catalogProviders[await io.choose('预设用哪个 provider:', catalogProviders.map(id => ({ label: id })))];
    const tiers = tierModels(await service.listProviderModels(primary));
    if (!tiers) { io.print(`${primary} 没有可用模型。`); return { saved: false, aborted: true, addedProviders }; }
    const planningModel = strategy.id === 'quality' ? tiers.flagship : tiers.balanced;
    const executionModel = strategy.id === 'quality' ? tiers.balanced : tiers.cheap;
    io.print(`预设（${primary}）: 规划 -> ${planningModel.id}（${formatCost(planningModel)}），执行 -> ${executionModel.id}（${formatCost(executionModel)}）`);
    roleModels = {};
    for (const role of PLANNING_ROLES) roleModels[role] = `${primary}/${planningModel.id}`;
    for (const role of EXECUTION_ROLES) roleModels[role] = `${primary}/${executionModel.id}`;
  }

  // --- Validate -------------------------------------------------------------
  const validation = await service.validateRoleModels(roleModels);
  io.print('');
  io.print('验证（对 Pi 目录/models.json 解析）:');
  let allOk = validation.complete;
  for (const role of ARIAD_MODEL_ROLES) {
    const result = validation.roles[role];
    if (result?.ok) io.print(`  ✓ ${role} -> ${roleModels[role]}（${formatCost(result)}）`);
    else { allOk = false; io.print(`  ✗ ${role} -> ${roleModels[role]}（${result?.reason ?? validation.completenessError ?? '无效'}）`); }
  }
  if (!allOk) {
    if (!await io.confirm('有角色未能通过验证，仍要保存?', { default: false })) {
      io.print('未保存。已登记的 provider/key 保留，可改完后重跑向导。');
      return { saved: false, aborted: true, stage: 'validation', addedProviders, validation };
    }
  }

  if (await io.confirm('发送一次最小测试请求，验证模型真的能答?', { default: false })) {
    const probeRef = roleModels.pm ?? roleModels[ARIAD_MODEL_ROLES[0]];
    const result = await service.testModelRef(probeRef);
    io.print(result.ok ? `  ✓ 测试请求成功（${probeRef}）` : `  ✗ 测试请求失败（${probeRef}）: ${result.reason}`);
  }

  // --- Save -------------------------------------------------------------------
  const saved = service.setRoleDefaults(roleModels);
  io.print('');
  io.print('✓ 已保存安装级角色配置。下次可随时重跑向导或用 ariad config 修改。');
  return { saved: true, roleModels: saved, addedProviders, validation };
}
