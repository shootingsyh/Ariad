import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSogouResults,
  parseBilibiliResults,
  htmlToText,
  extractImageUrls,
  searchWeb,
  fetchWebPage,
  WEB_FETCH_TEXT_MAX_CHARS,
} from '../src/runtime/web-research.js';
import { piToolsForTask } from '../src/runtime/pi-runtime-config.js';

const SOGOU_FIXTURE = `
<div class="vrwrap" data-url="https://www.bilibili.com/video/BV1xx411c7mD">
  <h3 class="vr-title  " vrcid="title.1">
    <a target="_blank" href="/link?url=hedJjaC291ObqPUCEo1zMu">《<em>炎龙骑士团</em>》战斗画面赏析</a>
  </h3>
  <p class="str-text-info">攻击时切入战斗特写，前冲挥砍，受击后仰闪白。</p>
</div>
<div class="vrwrap" data-url="https://example.com/angel-empire-ui">
  <h3 class="vr-title"><a href="/link?url=abc123">天使帝国 界面截图集</a></h3>
  <div class="fz-mid">描边对话框与花纹按钮，商店整备共用一套框体。</div>
</div>`;

test('parseSogouResults pairs titles with their data-url targets', () => {
  const results = parseSogouResults(SOGOU_FIXTURE);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '《炎龙骑士团》战斗画面赏析');
  assert.equal(results[0].url, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.match(results[0].snippet, /战斗特写/);
  assert.equal(results[1].url, 'https://example.com/angel-empire-ui');
  assert.match(results[1].snippet, /花纹按钮/);
});

const BILIBILI_FIXTURE = JSON.stringify({
  code: 0,
  data: {
    result: [
      {
        bvid: 'BV1Yv4y1K7iz',
        title: '【经典怀旧游戏】<em class="keyword">炎龙骑士团</em>2攻略',
        description: '全道具全隐藏结局实况',
        author: '怀旧玩家',
        pic: '//i1.hdslb.com/bfs/archive/abc.jpg',
      },
      { bvid: 'BV1DK4y1i7CY', title: '天使帝国3 通关流程', description: '-', author: '某UP', pic: '' },
    ],
  },
});

test('parseBilibiliResults maps api results with https thumbnails', () => {
  const results = parseBilibiliResults(BILIBILI_FIXTURE);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '【经典怀旧游戏】炎龙骑士团2攻略');
  assert.equal(results[0].url, 'https://www.bilibili.com/video/BV1Yv4y1K7iz');
  assert.equal(results[0].image, 'https://i1.hdslb.com/bfs/archive/abc.jpg');
  assert.match(results[0].snippet, /全道具/);
  assert.match(results[1].snippet, /某UP/);
  assert.deepEqual(parseBilibiliResults('not json'), []);
  assert.deepEqual(parseBilibiliResults('{"code":-404,"data":null}'), []);
});

test('htmlToText strips scripts and tags; extractImageUrls resolves relatives', () => {
  const html = '<html><head><style>.x{}</style><script>var a=1;</script></head>'
    + '<body><p>Hello <b>world</b></p><img src="/img/a.png"><img src="https://cdn.example.com/b.jpg"></body></html>';
  assert.equal(htmlToText(html), 'Hello world');
  assert.deepEqual(extractImageUrls(html, 'https://example.com/base/page'), [
    'https://example.com/img/a.png',
    'https://cdn.example.com/b.jpg',
  ]);
});

function stubResponse({ body = '', url = '', contentType = 'text/html', ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    url,
    headers: { get: name => (name === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

test('searchWeb uses bilibili first and falls back to sogou', async () => {
  const fetchImpl = async url => {
    if (String(url).includes('bilibili.com')) return stubResponse({ body: BILIBILI_FIXTURE, url });
    return stubResponse({ body: SOGOU_FIXTURE, url });
  };
  const biliHit = await searchWeb('炎龙骑士团 战斗画面', { fetchImpl });
  assert.equal(biliHit.engine, 'bilibili');
  assert.equal(biliHit.results.length, 2);
  assert.match(biliHit.results[0].image, /hdslb\.com/);

  const fallbackFetch = async url => {
    if (String(url).includes('bilibili.com')) return stubResponse({ body: '{"code":-404,"data":null}', url });
    return stubResponse({ body: SOGOU_FIXTURE, url });
  };
  const sogouHit = await searchWeb('天使帝国 界面', { fetchImpl: fallbackFetch });
  assert.equal(sogouHit.engine, 'sogou');
  assert.equal(sogouHit.results[0].url, 'https://www.bilibili.com/video/BV1xx411c7mD');

  const deadFetch = async () => { throw new Error('offline'); };
  const empty = await searchWeb('anything', { fetchImpl: deadFetch });
  assert.equal(empty.engine, null);
  assert.deepEqual(empty.results, []);
});

test('fetchWebPage returns truncated text plus image urls', async () => {
  const longText = 'word '.repeat(5000);
  const body = `<html><head><title>参考页面</title></head><body><p>${longText}</p>`
    + '<img src="https://img.example.com/shot1.png"></body></html>';
  const page = await fetchWebPage('https://example.com/gallery', {
    fetchImpl: async url => stubResponse({ body, url: 'https://example.com/gallery' }),
  });
  assert.equal(page.title, '参考页面');
  assert.equal(page.text.length, WEB_FETCH_TEXT_MAX_CHARS);
  assert.equal(page.textTruncated, true);
  assert.deepEqual(page.images, ['https://img.example.com/shot1.png']);
  await assert.rejects(() => fetchWebPage('file:///etc/passwd', { fetchImpl: async () => stubResponse({}) }), /WEB_FETCH_URL_MUST_BE_HTTP/);
});

test('only the PM tier receives the web research tools', () => {
  const pm = piToolsForTask({ role: 'pm', taskKind: 'PLANNING_TASK' });
  assert.equal(pm.includes('ariad_web_search'), true);
  assert.equal(pm.includes('ariad_web_fetch'), true);
  for (const role of ['tech_lead', 'tech_lead_critic', 'plan_validator', 'project_debugger', 'developer', 'reviewer']) {
    const tools = piToolsForTask({ role, taskKind: 'PLANNING_TASK' });
    assert.equal(tools.includes('ariad_web_search'), false, `${role} must not have web search`);
    assert.equal(tools.includes('ariad_web_fetch'), false, `${role} must not have web fetch`);
  }
});
