// Web research primitives for planning roles (the PM): keyless search
// over public endpoints (a JSON search API plus HTML web search) and
// a guarded page fetch. No API key is required. Every result is
// hard-capped so one tool call can never
// flood a session's context window. The default transport shells out
// to curl: the search endpoints fingerprint TLS clients and serve an
// antispider page to Node's fetch, while curl passes (verified live).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SNIPPET_MAX_CHARS = 280;
export const WEB_FETCH_TEXT_MAX_CHARS = 12000;
export const WEB_FETCH_MAX_IMAGES = 20;
const REQUEST_TIMEOUT_MS = 15000;

export function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const CJK_CHAR = '\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uff65';

export function stripHtml(html) {
  // Inline tags become spaces for word separation, but spaces adjacent
  // to CJK characters are typographic noise (e.g. highlighted keywords
  // inside a Chinese title), so drop those.
  return decodeHtmlEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`([${CJK_CHAR}]) `, 'g'), '$1')
    .replace(new RegExp(` ([${CJK_CHAR}])`, 'g'), '$1')
    .trim();
}

export function htmlToText(html) {
  const body = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(body)
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function extractImageUrls(html, baseUrl) {
  const seen = new Set();
  const images = [];
  const candidates = [
    ...[...String(html ?? '').matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/gi)].map(m => m[1]),
    ...[...String(html ?? '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]),
  ];
  for (const raw of candidates) {
    try {
      const url = new URL(raw, baseUrl);
      if (!/^https?:$/.test(url.protocol)) continue;
      const value = url.toString();
      if (seen.has(value)) continue;
      seen.add(value);
      images.push(value);
      if (images.length >= WEB_FETCH_MAX_IMAGES) break;
    } catch { /* ignore unparseable src */ }
  }
  return images;
}

// Sogou result blocks: <h3 class="vr-title"><a href="/link?url=...">title</a></h3>;
// the real target rides in a data-url attribute on the result container,
// so pair each title with the nearest data-url in document order.
export function parseSogouResults(html, limit = WEB_SEARCH_MAX_RESULTS) {
  const source = String(html ?? '');
  const titles = [];
  for (const match of source.matchAll(/<h3 class="vr-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    titles.push({ index: match.index, href: match[1], title: stripHtml(match[2]), end: match.index + match[0].length });
  }
  const dataUrls = [];
  for (const match of source.matchAll(/data-url="(https?:\/\/[^"]+)"/g)) {
    dataUrls.push({ index: match.index, url: decodeHtmlEntities(match[1]) });
  }
  const results = [];
  for (const [i, item] of titles.entries()) {
    let url = null;
    let best = Infinity;
    for (const candidate of dataUrls) {
      const distance = Math.abs(candidate.index - item.index);
      if (distance < best) { best = distance; url = candidate.url; }
    }
    if (best > 6000) url = null;
    if (!url) url = item.href.startsWith('/') ? `https://www.sogou.com${item.href}` : item.href;
    const blockEnd = i + 1 < titles.length ? titles[i + 1].index : Math.min(source.length, item.end + 8000);
    const block = source.slice(item.end, blockEnd);
    const snippetMatch = block.match(/<(?:p|div)[^>]*class="[^"]*(?:str-text-info|text-info|fz-mid)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i);
    results.push({
      title: item.title,
      url,
      snippet: snippetMatch ? stripHtml(snippetMatch[1]).slice(0, WEB_SNIPPET_MAX_CHARS) : '',
    });
    if (results.length >= limit) break;
  }
  return results;
}

// Bilibili's keyless search API indexes Chinese-language video
// material deeply (for this product: gameplay footage of classic
// Chinese SRPGs), and returns JSON with real thumbnail image URLs -
// the most reliable visual-reference source reachable from here.
export function parseBilibiliResults(jsonText, limit = WEB_SEARCH_MAX_RESULTS) {
  let data = null;
  try { data = JSON.parse(String(jsonText ?? '')); } catch { return []; }
  const list = data?.data?.result;
  if (!Array.isArray(list)) return [];
  const results = [];
  for (const item of list) {
    if (!item?.bvid || !item?.title) continue;
    const description = stripHtml(item.description ?? '');
    results.push({
      title: stripHtml(item.title),
      url: `https://www.bilibili.com/video/${item.bvid}`,
      snippet: (description && description !== '-' ? description : `视频 · UP主 ${item.author ?? ''}`).slice(0, WEB_SNIPPET_MAX_CHARS),
      image: item.pic ? (item.pic.startsWith('//') ? `https:${item.pic}` : item.pic) : '',
    });
    if (results.length >= limit) break;
  }
  return results;
}

async function curlRequest(url, extraHeaders = {}, { cookieJar = null } = {}) {
  const metaMarker = '\n__ARIAD_META__';
  const headerArgs = Object.entries(extraHeaders).flatMap(([name, value]) => ['-H', `${name}: ${value}`]);
  const { stdout } = await execFileAsync('curl', [
    '-sS', '-L', '--max-time', '20',
    '-A', USER_AGENT,
    '-H', 'accept: text/html,application/xhtml+xml,application/json',
    '-H', 'accept-language: zh-CN,zh;q=0.9,en;q=0.6',
    ...headerArgs,
    ...(cookieJar ? ['-b', cookieJar, '-c', cookieJar] : []),
    '-w', `${metaMarker}%{url_effective}\t%{content_type}\t%{http_code}`,
    url,
  ], { maxBuffer: 16 * 1024 * 1024, timeout: 25000 });
  const markerAt = stdout.lastIndexOf(metaMarker);
  const meta = markerAt >= 0 ? stdout.slice(markerAt + metaMarker.length).split('\t') : [];
  const [finalUrl = url, contentType = '', httpCode = '200'] = meta;
  if (Number(httpCode) >= 400) throw new Error(`HTTP ${httpCode}`);
  return { text: markerAt >= 0 ? stdout.slice(0, markerAt) : stdout, finalUrl, contentType };
}

async function getText(fetchImpl, url, extraHeaders = {}, transportOptions = {}) {
  if (!fetchImpl) return curlRequest(url, extraHeaders, transportOptions);
  const response = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', ...extraHeaders },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { text: await response.text(), finalUrl: response.url || url, contentType: response.headers?.get?.('content-type') ?? '' };
}

// Search the public web. Bilibili's keyless JSON API is the primary
// backend (deep Chinese-language video coverage, real thumbnail URLs);
// Sogou web search is the general-web fallback, best-effort - it serves
// an antispider page under automated bursts. Returns structured
// emptiness - never throws - so the calling role can report honestly
// that a search found nothing.
// Bilibili's API intermittently answers HTTP 412 (risk control) to
// cookieless clients: prime a cookie jar on the main site first, and
// retry a 412/429 once after a short pause.
async function searchBilibili(query, capped, fetchImpl) {
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}&page_size=${capped}`;
  const headers = { referer: 'https://www.bilibili.com/' };
  const cookieJar = fetchImpl ? null : join(tmpdir(), `ariad-web-bili-${process.pid}.cookies`);
  if (cookieJar) {
    try { await curlRequest('https://www.bilibili.com/', {}, { cookieJar }); } catch { /* priming is best-effort */ }
  }
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { text } = await getText(fetchImpl, url, headers, { cookieJar });
      return parseBilibiliResults(text, capped);
    } catch (error) {
      lastError = error;
      if (!/HTTP (412|429)/.test(String(error?.message ?? error))) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  throw lastError ?? new Error('bilibili search failed');
}

export async function searchWeb(query, { limit = 8, fetchImpl = null } = {}) {
  const capped = Math.max(1, Math.min(WEB_SEARCH_MAX_RESULTS, Math.trunc(Number(limit) || 8)));
  const attempts = [];
  const engines = [
    { name: 'bilibili', run: () => searchBilibili(query, capped, fetchImpl) },
    {
      name: 'sogou',
      run: async () => parseSogouResults((await getText(fetchImpl, `https://www.sogou.com/web?query=${encodeURIComponent(query)}`)).text, capped),
    },
  ];
  for (const engine of engines) {
    try {
      const results = (await engine.run()).filter(result => result.title && result.url);
      if (results.length > 0) return { query, engine: engine.name, results, attempts };
      attempts.push({ engine: engine.name, outcome: 'no results parsed' });
    } catch (error) {
      attempts.push({ engine: engine.name, outcome: String(error?.message ?? error) });
    }
  }
  return { query, engine: null, results: [], attempts, note: 'No search backend returned parseable results for this query.' };
}

// Fetch one page for research: readable text (truncated) plus the
// page's image URLs, so a role can cite real visual references instead
// of describing them from memory.
export async function fetchWebPage(url, { fetchImpl = null } = {}) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('WEB_FETCH_URL_MUST_BE_HTTP');
  const { text, finalUrl, contentType } = await getText(fetchImpl, parsed.toString());
  if (/^image\//.test(contentType)) {
    return { url: parsed.toString(), finalUrl, contentType, note: 'Binary image content is not inlined; cite this URL as the reference.' };
  }
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageText = htmlToText(text);
  return {
    url: parsed.toString(),
    finalUrl,
    title: titleMatch ? stripHtml(titleMatch[1]) : '',
    text: pageText.slice(0, WEB_FETCH_TEXT_MAX_CHARS),
    textTruncated: pageText.length > WEB_FETCH_TEXT_MAX_CHARS,
    images: extractImageUrls(text, finalUrl),
  };
}
