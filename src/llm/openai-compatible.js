function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function extractJson(text) {
  if (typeof text !== 'string') throw new Error('LLM response content must be a string');
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error('LLM response did not contain valid JSON');
}

export class OpenAICompatibleLLM {
  constructor(options = {}) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey ?? '';
    this.model = options.model;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!this.baseUrl) throw new Error('baseUrl is required');
    if (!this.model) throw new Error('model is required');
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch implementation is required');
  }

  async complete({ messages, json = false, temperature = this.temperature, maxTokens = 800 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const body = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };
      if (json) body.response_format = { type: 'json_object' };

      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`LLM request failed: HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('LLM response missing choices[0].message.content');
      return json ? extractJson(content) : content;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function llmFromEnv(env = process.env, overrides = {}) {
  const baseUrl = overrides.baseUrl ?? env.ARIAD_LLM_BASE_URL;
  const model = overrides.model ?? env.ARIAD_LLM_MODEL;
  if (!baseUrl || !model) return null;
  return new OpenAICompatibleLLM({
    baseUrl,
    model,
    apiKey: overrides.apiKey ?? env.ARIAD_LLM_API_KEY ?? '',
    timeoutMs: Number(overrides.timeoutMs ?? env.ARIAD_LLM_TIMEOUT_MS ?? 30_000),
    temperature: Number(overrides.temperature ?? env.ARIAD_LLM_TEMPERATURE ?? 0),
  });
}
