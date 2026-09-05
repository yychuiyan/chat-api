/**
 * 炊烟小站 · 站内 AI 问答转发层（Vercel Serverless Function）
 *
 * 职责：
 *   1. 持有智谱 API Key（环境变量 GLM_API_KEY），不暴露给前端
 *   2. 拉取站点文章切片索引 ai-index.json，做关键词检索
 *   3. 拼 prompt → 调 GLM-4.7-Flash（流式）→ SSE 转发给前端
 *   4. 将上游各类错误归一化为友好提示
 *
 * 环境变量：
 *   GLM_API_KEY        必填，智谱开放平台 API Key
 *   GLM_MODEL          可选，默认 glm-4.7-flash
 *   INDEX_URL          可选，默认 https://docs.yychuiyan.com/ai-index.json
 *   ALLOWED_ORIGINS    可选，逗号分隔的 CORS 白名单（默认含 docs 站点与本地 dev）
 */
import { Readable } from 'node:stream';

const GLM_KEY = process.env.GLM_API_KEY || '';
const GLM_MODEL = process.env.GLM_MODEL || 'glm-4.7-flash';
const INDEX_URL =
  process.env.INDEX_URL || 'https://docs.yychuiyan.com/ai-index.json';
const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const DEFAULT_ORIGINS = [
  'https://docs.yychuiyan.com',
  'http://localhost:5173',
  'http://localhost:4173',
];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .concat(DEFAULT_ORIGINS);

const MAX_HISTORY = 8; // 携带的历史消息条数（不含 system）
const TOP_K = 4; // 检索返回的切片数
const INDEX_TTL = 10 * 60 * 1000; // 索引内存缓存 10 分钟

let indexCache = { at: 0, chunks: [] };
let indexLoading = null;

/* ---------------- 索引加载 ---------------- */
async function loadIndex() {
  if (indexCache.chunks.length && Date.now() - indexCache.at < INDEX_TTL) {
    return indexCache.chunks;
  }
  if (indexLoading) return indexLoading;
  indexLoading = (async () => {
    const resp = await fetch(INDEX_URL, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`索引下载失败 HTTP ${resp.status}`);
    const data = await resp.json();
    indexCache = { at: Date.now(), chunks: data.chunks || [] };
    console.log(`[chat] 索引已加载 ${indexCache.chunks.length} 个切片`);
    return indexCache.chunks;
  })().finally(() => {
    indexLoading = null;
  });
  return indexLoading;
}

// 实例启动时预热索引，避免第一次提问再等下载
loadIndex().catch((e) => console.warn('[chat] 索引预热失败:', e.message));

/* ---------------- 关键词检索 ---------------- */
/** 查询拆词：英文词 + 连续中文 bigram */
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

function search(chunks, query, top = TOP_K) {
  const terms = tokenize(query);
  if (!terms.length) return [];
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
  return scored.slice(0, top).map((s) => s.c);
}

/* ---------------- 错误归一化 ---------------- */
function friendlyError(status, body = {}) {
  const code = body?.error?.code ?? body?.code;
  const strCode = String(code ?? '');
  // 智谱错误码：1302 限流 / 1305 过载
  if (status === 401 || status === 403 || strCode === '1001') {
    return { code: 'auth_invalid', message: 'AI 服务配置异常，请联系站长', http: 502 };
  }
  if (status === 404) {
    return { code: 'model_unavailable', message: 'AI 模型正在升级维护，暂时无法使用', http: 503 };
  }
  if (status === 429 || strCode === '1302') {
    return { code: 'rate_limited', message: 'AI 服务繁忙，请稍后再试', http: 429 };
  }
  if (strCode === '1305' || status >= 500) {
    return { code: 'upstream_error', message: 'AI 服务暂时不可用，请稍后再试', http: 503 };
  }
  if (status >= 400) {
    return { code: 'request_error', message: '请求未通过校验，请稍后再试', http: 400 };
  }
  return { code: 'unknown', message: 'AI 服务开小差了，请稍后再试', http: 500 };
}

/* ---------------- CORS ---------------- */
function corsHeaders(origin) {
  const allow = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/* ---------------- 主处理 ---------------- */
export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'method', message: '仅支持 POST' } }));
    return;
  }
  if (!GLM_KEY) {
    res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_configured', message: 'AI 服务未配置，请联系站长' } }));
    return;
  }

  // 读 body 与拉索引并行，缩短首字前等待
  const indexPromise = loadIndex().catch((e) => {
    console.warn('[chat] 检索失败，降级为通用回答:', e.message);
    return [];
  });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'bad_request', message: '请求格式不正确' } }));
    return;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  if (!question.trim()) {
    res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'empty_question', message: '请输入问题' } }));
    return;
  }

  let hits = [];
  try {
    const chunks = await indexPromise;
    hits = search(chunks, question);
  } catch (e) {
    console.warn('[chat] 检索失败，降级为通用回答:', e.message);
  }

  const context = hits
    .map(
      (c, i) =>
        `[资料 ${i + 1}]《${c.title}》${c.path}${c.section ? `（章节：${c.section}）` : ''}\n${c.text}`
    )
    .join('\n\n');

  const system = [
    '你是「炊烟小站」的站内 AI 助手。该站点是站长 yychuiyan 的个人博客与文档站，包含 Git、Python、JavaScript、MySQL、自动化测试（Playwright/pytest）、性能测试等教程，以及读书感悟、工具使用等随笔。',
    context
      ? '请优先依据下方站内资料回答，不要编造资料里没有的细节。'
      : '本次未能检索到站内相关资料，请如实说明“站内暂时没有找到相关内容”，再基于通用知识简要回答。',
    '回答要求：',
    '1. 中文，简洁有条理，结论/步骤优先；',
    '2. 不要使用 markdown 表格或代码块，可用“-”列表；',
    '3. 若引用了站内资料，在回答末尾另起一行，每篇一行，严格按此格式输出：',
    '参考文章：《标题》路径',
    '（路径如 /automation/test-case-standard，不含域名）',
    context ? `\n===== 站内资料 =====\n${context}` : '',
  ].join('\n');

  // 截断历史，避免会话无限膨胀
  const recent = messages.slice(-MAX_HISTORY).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000),
  }));

  // 调智谱（流式）
  let upstream;
  try {
    upstream = await fetch(GLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GLM_KEY}`,
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        messages: [{ role: 'system', content: system }, ...recent],
        thinking: { type: 'enabled' },
        stream: true,
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    const f = friendlyError(0);
    res.writeHead(f.http, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: f.code, message: 'AI 服务连接超时，请稍后再试' } }));
    return;
  }

  if (!upstream.ok) {
    let body = {};
    try {
      body = await upstream.json();
    } catch {}
    console.warn('[chat] 智谱返回错误:', upstream.status, JSON.stringify(body).slice(0, 300));
    const f = friendlyError(upstream.status, body);
    res.writeHead(f.http, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: f.code, message: f.message } }));
    return;
  }

  // SSE 透传
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...cors,
  });
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.end());
  stream.pipe(res);
}

/* ---------------- 工具 ---------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
