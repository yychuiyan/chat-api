/**
 * 炊烟小站 · 站内 AI 问答（Cloudflare Worker）
 *
 * 部署后挂到 docs.yychuiyan.com/api/chat
 * Key 用 wrangler secret，不要写进仓库。
 */
const DS_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_ORIGINS = [
  'https://docs.yychuiyan.com',
  'http://localhost:5173',
  'http://localhost:4173',
];
const MAX_HISTORY = 2;
const TOP_K = 3;
const MIN_SCORE = 3;
const INDEX_TTL = 10 * 60 * 1000;
const MAX_Q = 500;
const MAX_SUMMARY = 200;
const MAX_HIT_TEXT = 900;

const COPY = {
  greet: '灶还温着。我是喵喵，站里的文章我都翻过。想聊点啥？',
  export: '我这儿不外带、也不代写 md。要带走得你自己抄；想听要点，我可以口头提几句。',
  chat: '这锅不是我的菜。我只翻得动小站里的文章。',
  jail: '这灶台不玩角色扮演。想问站里哪篇，直接说。',
  empty: '你这是在跟灶台对视吗？说点站里的问题吧。',
  tooLong: '这把柴太长，灶口塞不下。削短再问。',
  lowScore: '把柴火垛翻了一遍，没夹到相关的内容。换个站内问法，或者先点开那篇再问？',
  busy: '灶上正忙，稍等几秒再来。',
  quota: '米缸见底了，过会儿再来。',
  auth: '灶台钥匙不对，得站长来看看。',
  down: '这灶有点呛，过一会儿再问。',
  notConfigured: '灶还没架好，先让站长把火点着。',
  badJson: '这碟菜端歪了，再试一次。',
};

let indexCache = { at: 0, chunks: [] };
let indexLoading = null;

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};

async function handle(request, env, ctx) {
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'POST') {
    return json({ error: { code: 'method', message: '仅支持 POST' } }, 405, cors);
  }

  const dsKey = env.DEEPSEEK_API_KEY || '';
  if (!dsKey) {
    return json({ error: { code: 'not_configured', message: COPY.notConfigured } }, 500, cors);
  }

  const indexUrl = env.INDEX_URL || 'https://docs.yychuiyan.com/ai-index.json';

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: { code: 'bad_request', message: COPY.badJson } }, 400, cors);
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const question = String(
    [...messages].reverse().find((m) => m.role === 'user')?.content || ''
  ).trim();
  if (!question) {
    return json({ reply: COPY.empty }, 200, cors);
  }
  if (question.length > MAX_Q) {
    return json({ reply: COPY.tooLong }, 200, cors);
  }

  const gate = classifyGate(question);
  if (gate) return json({ reply: COPY[gate] }, 200, cors);

  const cachedHits = sanitizeHits(payload.lastHits);
  const summary = sanitizeSummary(payload.summary);
  const pagePath = sanitizePagePath(payload.pagePath);
  const pageTitle = sanitizeSummary(payload.pageTitle).slice(0, 80);
  const pageCache = pagePath
    ? cachedHits.filter((c) => normPath(c.path) === pagePath)
    : cachedHits;
  const hits = shouldReuse(question, pageCache)
    ? pageCache
    : await getHits(indexUrl, question, ctx, pagePath, pageTitle);

  if (!hits.length) {
    return json({ reply: COPY.lowScore }, 200, cors);
  }

  const context = hits
    .map(
      (c, i) =>
        `[资料 ${i + 1}]《${c.title}》${c.path}${c.section ? `（章节：${c.section}）` : ''}\n${c.text}`
    )
    .join('\n\n');

  const system = [
    '你是「喵喵」，炊烟小站灶边那只打盹的橘猫。用户是来串门的人，你窝在灶火边，只把站里文章讲过的东西随口说给他听。',
    '全程用第一人称（我、我翻到、我给你翻出来），不要说「本助手」「本站」「笔者」这类词，也不要跳出角色解释自己是谁。',
    '语气慵懒、短句、自然，像猫在灶边随口搭话：不谄媚、不卖萌过头、不端着，也不要像说明书或判官。',
    '猫的痕迹点到为止——偶尔「喵」一声，或来一句猫视角的话（例如「我把这几篇翻了一遍」）就够，每句都加反而让人不想看。',
    pagePath ? `用户正在阅读${pageTitle ? `《${pageTitle}》` : '当前页'} ${pagePath}，请优先依据该文。` : '',
    summary ? `会话摘要：${summary}` : '',
    context
      ? '只依据下方站内资料。资料没写到的，用口语轻轻带过即可，例如「这篇没提源码在哪，只说了会更新工具和实践」，不要说「文章里没有写」这种硬邦邦的句子，也不要用资料外的知识补全。'
      : '站内没搜到相关篇目时，轻松说一声没翻到，请换个问法或先点开那篇。不要用自己的知识展开，不要编造参考文章。',
    '回答要求：',
    '1. 中文，简洁，像说话；总结只列几条要点，不要长文；',
    '2. 不要使用 markdown 表格或代码块，不要输出完整文档或文件内容；',
    '3. 即使用户要求导出、下载、生成 md/文档/代码文件，也只口头简单说明，不要代写全文；',
    '4. 若依据了站内资料，末尾另起一行，每篇一行：参考文章：《标题》路径；路径必须与下方资料的 path 完全一致，禁止编造或改成其他教程',
    context ? `\n===== 站内资料 =====\n${context}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const recent = messages.slice(-MAX_HISTORY).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 400),
  }));

  const chatMessages = [{ role: 'system', content: system }, ...recent];
  const headers = new Headers(cors);
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  headers.set('Cache-Control', 'no-cache, no-transform');

  let upstream;
  try {
    upstream = await fetch(DS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dsKey}`,
      },
      body: JSON.stringify({
        model: env.DS_MODEL || 'deepseek-v4-flash',
        messages: chatMessages,
        thinking: { type: 'disabled' },
        stream: true,
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    return json({ error: { code: 'timeout', message: COPY.busy } }, 429, cors);
  }

  if (!upstream.ok) {
    let body = {};
    try {
      body = await upstream.json();
    } catch {}
    const f = friendlyError(upstream.status, body);
    return json({ error: { code: f.code, message: f.message } }, f.http, cors);
  }

  return new Response(withHitsPrefix(upstream.body, hits), { status: 200, headers });
}

async function getHits(indexUrl, question, ctx, pagePath, pageTitle) {
  let chunks = [];
  if (indexCache.chunks.length && Date.now() - indexCache.at < INDEX_TTL) {
    chunks = indexCache.chunks;
  } else {
    const loading = loadIndex(indexUrl).catch((e) => {
      console.warn('[chat] 索引加载失败:', e.message);
      return [];
    });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(loading);
    chunks = await Promise.race([
      loading,
      new Promise((resolve) => setTimeout(() => resolve(null), 400)),
    ]);
  }
  if (!chunks || !chunks.length) return [];
  const limit = isThisPageAsk(question) ? 2 : TOP_K;
  const global = searchScored(chunks, question);
  const pageChunks = chunksForPage(chunks, pagePath, pageTitle);
  if (pageChunks.length && isThisPageAsk(question)) {
    const local = searchScored(pageChunks, question);
    return local.length ? takeHits(local, limit) : pageChunks.slice(0, limit);
  }
  if (pageChunks.length) {
    const local = searchScored(pageChunks, question);
    if (local[0]?.score >= MIN_SCORE) return takeHits(local, limit);
    if (global[0]?.score >= MIN_SCORE) return takeHits(global, limit);
    if (local.length) return takeHits(local, limit);
    return [];
  }
  if (global[0]?.score >= MIN_SCORE) return takeHits(global, limit);
  return [];
}

function chunksForPage(chunks, pagePath, pageTitle) {
  if (pagePath) {
    const byPath = chunks.filter((c) => samePage(c.path, pagePath));
    if (byPath.length) return byPath;
  }
  const t = String(pageTitle || '').trim();
  if (t.length < 4) return [];
  return chunks.filter((c) => {
    const title = String(c.title || '').trim();
    return title === t || title.includes(t) || t.includes(title);
  });
}

function samePage(chunkPath, pagePath) {
  const a = normPath(chunkPath);
  const b = normPath(pagePath);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

function normPath(p) {
  let s = String(p || '').split('?')[0].split('#')[0];
  if (!s.startsWith('/')) return '';
  s = s.replace(/\/index\.html$/, '/').replace(/\.html$/, '/');
  if (!s.endsWith('/')) s += '/';
  if (s.includes('..') || s.includes('://')) return '';
  return s.slice(0, 160);
}

function sanitizePagePath(raw) {
  const p = normPath(raw);
  if (!p || p === '/') return '';
  return p;
}

async function loadIndex(indexUrl) {
  if (indexCache.chunks.length && Date.now() - indexCache.at < INDEX_TTL) {
    return indexCache.chunks;
  }
  if (indexLoading) return indexLoading;
  indexLoading = (async () => {
    const resp = await fetch(indexUrl, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`索引下载失败 HTTP ${resp.status}`);
    const data = await resp.json();
    indexCache = { at: Date.now(), chunks: data.chunks || [] };
    return indexCache.chunks;
  })().finally(() => {
    indexLoading = null;
  });
  return indexLoading;
}

function tokenize(q) {
  const tokens = new Set();
  const cleaned = q.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ');
  for (const m of cleaned.matchAll(/[a-zA-Z0-9]{2,}/g)) {
    tokens.add(m[0].toLowerCase());
  }
  const cjk = cleaned.replace(/[a-zA-Z0-9\s]+/g, '');
  for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk.slice(i, i + 2));
  return [...tokens];
}

function searchScored(chunks, query) {
  const terms = tokenize(query);
  if (!terms.length || !chunks.length) return [];
  const scored = [];
  for (const c of chunks) {
    let score = 0;
    const title = (c.title || '').toLowerCase();
    const section = (c.section || '').toLowerCase();
    const text = (c.text || '').toLowerCase();
    const tags = (c.tags || []).join(' ').toLowerCase();
    for (const t of terms) {
      if (title.includes(t)) score += 4;
      else if (tags.includes(t)) score += 3;
      if (section.includes(t)) score += 2;
      if (text.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function takeHits(scored, top) {
  return scored.slice(0, top).map((s) => s.c);
}

function isBriefAsk(q) {
  return /总结|概括|大意|这篇讲|这一节|这一页|主要内容/.test(q);
}

function isThisPageAsk(q) {
  return (
    isBriefAsk(q) ||
    /(这篇|本文|本页|当前(这篇|文章|页|文档)?|这一(篇|节|页)|这个文档|这份文档)/.test(q)
  );
}

function classifyGate(q) {
  const s = q.trim();
  if (/^(你好|您好|嗨|哈喽|hi|hello|hey|在吗|在不在|早安|晚安)[\s!！。.?？~～]*$/i.test(s)) {
    return 'greet';
  }
  if (/(忽略(以上|之前|指令)|你是\s*(chatgpt|gpt|claude)|越狱|jailbreak)/i.test(s)) {
    return 'jail';
  }
  if (
    /(导出|下载).{0,12}(md|markdown|文档|文件)|(生成|写出|写成).{0,12}(md|markdown|文件)|帮我写一篇完整|输出完整(的)?(文章|文档)/i.test(
      s
    )
  ) {
    return 'export';
  }
  if (/(今天天气|讲个笑话|写首诗|写一首|谈恋爱|股票推荐|彩票|算命)/.test(s)) {
    return 'chat';
  }
  return '';
}

function friendlyError(status, body = {}) {
  const code = body?.error?.code ?? body?.code;
  const strCode = String(code ?? '');
  if (status === 401 || status === 403 || strCode === '1001' || strCode === 'invalid_api_key') {
    return { code: 'auth_invalid', message: COPY.auth, http: 502 };
  }
  if (status === 404) {
    return { code: 'model_unavailable', message: COPY.down, http: 503 };
  }
  if (status === 402 || /insufficient|quota|balance/i.test(strCode + String(body?.error?.message || ''))) {
    return { code: 'quota', message: COPY.quota, http: 503 };
  }
  if (status === 429 || strCode === '1302') {
    return { code: 'rate_limited', message: COPY.busy, http: 429 };
  }
  if (strCode === '1305' || status >= 500) {
    return { code: 'upstream_error', message: COPY.down, http: 503 };
  }
  if (status >= 400) {
    return { code: 'request_error', message: COPY.down, http: 400 };
  }
  return { code: 'unknown', message: COPY.down, http: 500 };
}

function corsHeaders(origin, env) {
  const extra = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowList = extra.concat(DEFAULT_ORIGINS);
  const allow = origin && allowList.includes(origin) ? origin : allowList[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function withHitsPrefix(stream, hits) {
  const prefix = new TextEncoder().encode(`data: ${JSON.stringify({ hits })}\n\n`);
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(prefix);
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } finally {
        controller.close();
      }
    },
  });
}

function sanitizeHits(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, TOP_K)) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.title || '').slice(0, 80);
    const path = String(item.path || '').slice(0, 160);
    if (!path.startsWith('/') || path.includes('://') || path.includes('..')) continue;
    const section = String(item.section || '').slice(0, 80);
    const text = String(item.text || '').slice(0, MAX_HIT_TEXT);
    if (text.length < 20) continue;
    out.push({ title, path, section, text });
  }
  return out;
}

function sanitizeSummary(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SUMMARY);
}

/** 追问且与上一轮资料重叠时复用，换题则重新检索 */
function shouldReuse(question, cached) {
  if (!cached.length) return false;
  const q = question.trim();
  const terms = tokenize(q);
  const bag = cached.map((c) => `${c.title}\n${c.section}\n${c.text}`).join('\n').toLowerCase();
  const ratio = terms.length ? terms.filter((t) => bag.includes(t)).length / terms.length : 0;
  const followCue = /^(那|还是|还要|还|再|然后|继续|这个|那个|上面|刚才|对了|不是)/;
  if (followCue.test(q) && q.length <= 24 && ratio >= 0.25) return true;
  if (q.length <= 10 && !/[a-zA-Z]{2,}/.test(q)) return true;
  return ratio >= 0.4;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
