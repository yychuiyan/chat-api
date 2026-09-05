# 炊烟小站 · 站内问答 API

Cloudflare Worker，给 [炊烟小站](https://docs.yychuiyan.com/) 右下角「问AI」用。只根据站内 `ai-index.json` 里的文章切片回答，不把 Key 写进前端或本仓库。

线上入口：`https://docs.yychuiyan.com/api/chat`

## 它做什么

1. 问候、闲聊、导出 md、越狱等固定短句直接回，不调模型。
2. 按问题检索站内切片（文章页优先本篇；「这篇 / 本文 / 总结」锁定当前页）。
3. 检索分太低则口语提示换问法，不调模型。
4. 命中后再调 DeepSeek（`deepseek-v4-flash`，关闭思考），SSE 流式返回。

前端组件在站点仓库 `docs/.vitepress/theme/components/ChatWidget.vue`。索引由站点构建时 `scripts/ai-index.mjs` 生成，线上地址：`https://docs.yychuiyan.com/ai-index.json`。

## 仓库结构

```
chat-api/
├── src/index.js      # Worker 入口
├── wrangler.toml     # 名称、模型、索引地址（不含密钥）
├── package.json
└── README.md
```

## 环境变量

| 名称 | 放哪 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | **Secret** | DeepSeek Key，必填。不要写进 `wrangler.toml`、`.env` 或前端 `VITE_*` |
| `DS_MODEL` | `[vars]` | 默认 `deepseek-v4-flash` |
| `INDEX_URL` | `[vars]` | 默认 `https://docs.yychuiyan.com/ai-index.json` |
| `ALLOWED_ORIGINS` | 可选 vars | 额外允许的 CORS 源，逗号分隔。默认已含站点域名和本地 `5173` / `4173` |

写入密钥：

```bash
npx wrangler secret put DEEPSEEK_API_KEY
```

本地调试可建 `.dev.vars`（已 gitignore），一行一个 `KEY=value`，不要提交。

## 本地

```bash
npm install
npm run dev
```

`wrangler dev` 会起本地 Worker。站点开发服默认仍打线上 `https://docs.yychuiyan.com/api/chat`，改 Worker 逻辑后必须再部署，本地前端才会看到新行为。

## 部署

```bash
npm install
npx wrangler secret put DEEPSEEK_API_KEY   # 每个账号做一次即可
npx wrangler deploy
```

部署后在 Cloudflare Dashboard → Workers → `docs-chat-api` → Settings → Domains & Routes 加上：

```
docs.yychuiyan.com/api/chat*
```

改了 `src/index.js` 或 `wrangler.toml` 都要再 `npx wrangler deploy`，git push 不会自动发布 Worker。

索引变更要等 **docs 站点重新构建上线** 后，`ai-index.json` 才会更新。

## 请求约定

`POST`，`Content-Type: application/json`。

```json
{
  "messages": [{ "role": "user", "content": "这篇讲了什么" }],
  "summary": "已聊：pytest 登录",
  "lastHits": [],
  "pagePath": "/blog/automation-testing/pytest-login-from-zero/",
  "pageTitle": "pytest 如何从 0 到 1 实现登录"
}
```

- 拒答 / 问候等：`200` + `{ "reply": "..." }`
- 模型回答：`text/event-stream`。首条是 `{ "hits": [...] }`，后面是 DeepSeek 的 SSE chunk
- 错误：`{ "error": { "code": "...", "message": "..." } }`

`lastHits` 用于同题追问复用切片，少打一次索引。路径必须是站内相对路径。

## 注意

- Key 只放 Worker Secret。构建后的站点 JS 是公开的，前端不能带 Key。
- 本仓库已从 Vercel 迁走，`api/chat.js` / `vercel.json` 不再使用。
- `.wrangler/`、`.dev.vars`、`.env*` 不要提交。
