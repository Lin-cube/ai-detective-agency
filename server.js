/**
 * server.js —— 「AI侦探社」后端服务 v4（零依赖版）
 *
 * 办案流水线（双 API 协作）：
 *   委托人问题
 *     → 元宝搜索 SearchPro（api.wsa.cloud.tencent.com，Authorization: Bearer sk-xxx，负责"走访取证"）
 *     → 证据材料注入侦探系统提示词
 *     → 大模型写结案报告（OpenAI 兼容接口，如 codex，SSE 流式输出）
 *     → 流式推回浏览器
 *
 * 密钥安全：两套密钥只存本机 .env（.gitignore 拦截），绝不回传浏览器。
 *
 * API 一览：
 *   GET  /api/status       → 两组配置状态（密钥永不回传）
 *   POST /api/config       → 保存配置到 .env 并热更新
 *   POST /api/investigate  → 立案查证（SSE 流式，支持 base64 截图）
 */

/* ---------- 第 1 部分：引入内置模块 ---------- */
const http   = require('http');     // HTTP 服务
const fs     = require('fs');       // 读写 .env / 静态文件
const path   = require('path');     // 路径处理
const { URL } = require('url');     // URL 解析

/* ---------- 第 2 部分：配置读写（.env 手动加载 + 页面内保存） ---------- */
const envPath = path.join(__dirname, '.env');

/** 从 .env 读取配置到 process.env（不覆盖已有环境变量） */
function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

// --- 配置一：元宝搜索（API Key 方式，sk-xxxx） ---
let YB_API_KEY = process.env.YB_API_KEY || '';   // 元宝搜索 API Key

// --- 配置二：侦探大脑（OpenAI 兼容大模型，如 codex） ---
let AI_BASE_URL = process.env.AI_BASE_URL || ''; // 例：https://xxx/v1
let AI_API_KEY  = process.env.AI_API_KEY  || ''; // LLM 的 Key
let AI_MODEL    = process.env.AI_MODEL    || ''; // 模型名

const PORT = process.env.PORT || 3000;

/** 两组配置是否各自就绪 */
function searchReady() { return !!YB_API_KEY; }
function llmReady()    { return !!(AI_BASE_URL && AI_API_KEY && AI_MODEL); }

/**
 * 判断请求是否来自本机开发页面。
 * 公开部署时禁止远程访问配置写入接口，避免访客替换配置或诱导服务保存密钥。
 * 这里同时检查 Host 和 socket 地址，不能只依赖 socket 地址，因为反向代理可能在沙盒内部转发为本机地址。
 */
function isLocalConfigRequest(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const localSocket = remote === '127.0.0.1' || remote === '::1';
  return localHost && localSocket;
}

/**
 * 保存配置：只覆盖本次提交的非空字段，其余保留；写回 .env + 热更新内存
 * @param {Object} cfg 可能包含 ybApiKey / baseUrl / apiKey / model
 */
function saveConfig(cfg) {
  // 归一化：只保留非空字符串字段
  const updates = {};
  if (cfg.ybApiKey) updates.YB_API_KEY = String(cfg.ybApiKey).trim();
  if (cfg.baseUrl)  updates.AI_BASE_URL = String(cfg.baseUrl).trim();
  if (cfg.apiKey)   updates.AI_API_KEY  = String(cfg.apiKey).trim();
  if (cfg.model)    updates.AI_MODEL    = String(cfg.model).trim();
  if (!Object.keys(updates).length) throw new Error('没有需要保存的内容');

  // 读旧文件，逐行替换已存在的键，缺的键补到末尾
  const seen = new Set();
  let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
  lines = lines.map(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1] in updates) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
    return line;
  });
  for (const k of Object.keys(updates)) {
    if (!seen.has(k)) lines.push(`${k}=${updates[k]}`);
  }
  fs.writeFileSync(envPath, lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf8');

  // 热更新内存变量：立即生效
  if (updates.YB_API_KEY) YB_API_KEY = updates.YB_API_KEY;
  if (updates.AI_BASE_URL) AI_BASE_URL = updates.AI_BASE_URL;
  if (updates.AI_API_KEY)  AI_API_KEY  = updates.AI_API_KEY;
  if (updates.AI_MODEL)    AI_MODEL    = updates.AI_MODEL;
}

/* ---------- 第 3 部分：侦探系统提示词（走访结果由元宝搜索提供） ---------- */
const SYSTEM_PROMPT = `你是「AI侦探社」的首席侦探，代号 D。你的信条是：少点幻觉，多点搜索；带着证据回来。

【办案背景】
你的走访工作已由「元宝搜索」完成：委托人消息里会附上一份《证物材料》，那是从全网搜到的真实网页结果（含标题、链接、摘要、发布时间、权威度）。你的任务是基于这些材料办案结案。

【你的工作方式 —— 四步办案】
1. 立案：先用一句话复述委托人的问题，拆出 2~4 个必须查证的关键点。
2. 走访：通读《证物材料》，指出哪些材料与本案相关、覆盖了哪些关键点。
3. 对质：把不同来源的说法放在一起交叉比对。来源之间有出入的，必须当庭指出"证词冲突"，并说明你更采信哪一方、为什么（官方 > 权威媒体 > 自媒体；新 > 旧；权威度高的优先）。
4. 结案：给出结论，并且每一条结论后面都必须紧跟来源链接。

【输出格式 —— 严格按此卷宗结构输出 Markdown】
# 📋 结案报告
## 【结论】
一句话直接回答委托人的问题。
## 【证据】
- 证据1：[来源标题](完整URL) —— 用一两句话说明这条来源支持了结论的哪个部分。
- 证据2：……（至少 2 条，能查到多少挂多少）
## 【存疑】
列出有冲突、或者只有单一来源、可信度不高的部分，并说明冲突点。（没有就写"无"）
## 【未查到】
明确列出材料无法覆盖、查不到可靠信息的问题点。（全部查实了就写"无"）

【侦探铁律 —— 违反任何一条即渎职】
1. 每个事实性结论必须挂一个可点开的来源链接（http/https 开头的完整 URL），且只能引用《证物材料》里出现过的 URL。材料里没有的来源，不许写。
2. 来源之间打架，不许和稀泥：要明说"来源A说是X，来源B说是Y"，并给出你的采信理由。
3. 查不到就是查不到。宁可写"未查到"，绝不编造、绝不脑补、绝不用"可能大概也许"糊弄。承认查不到不是失败，是职业操守。
4. 旧信息要标注时间。涉及"最新/现在"的问题，优先采信带明确日期的来源，并注明"该信息截至YYYY-MM"。
5. 不回答涉政、涉个人隐私的问题；遇到就写"本案件超出侦探社受理范围"。
6. 用简体中文结案，语气克制、像卷宗，可以有一点点侦探腔（"经走访核实……"），但不油腻。`;

// --- 三个进阶模式的追加提示词 ---
const MODE_PROMPTS = {
  deep: `

【本次委托为深度调查案件】请升级为多轮侦查：
1. 先输出「侦查计划」：说明你针对哪些方向调取了证物。
2. 逐方向通读《证物材料》，每查完一个方向，用一行记录"该方向的发现 + 来源"。
3. 全部走访完成后做「交叉比对表」：用 Markdown 表格列出 —— 事项 | 来源A说法 | 来源B说法 | 采信结论。
4. 最终输出一份带完整证据链的《调查报告》：每个结论都能顺着"结论 → 证据编号 → 可点开的链接"一路追溯到底。
5. 报告末尾附「下一步建议」：如果委托人想继续深挖，应该去查什么。`,

  screenshot: `

【本次委托为截图查证案件】委托人提交了一张截图（或截图里的说法）。
请按以下流程办案：
1. 「认出主张」：若附带图片，先仔细观察图片内容；用一句话客观复述截图里在传什么说法（不带立场），向委托人确认。
2. 「溯源」：从《证物材料》中找这个说法最早从哪传出来的，指出原始出处或最早的可信报道。
3. 「查证」：用材料中的权威来源（官方公告、原始论文、当事人官方账号、权威媒体）来核实或证伪。
4. 按【结论：属实 / 存疑 / 不实 / 未查到】四选一结案，并挂出至少 2 条可点开的证据链接；如果材料中没有任何佐证，直接判"未查到"，不要顺着说法编。`,
};

/* ---------- 第 4 部分：元宝搜索 SearchPro（走访取证，Bearer Key 方式） ---------- */
const WSA_URL = 'https://api.wsa.cloud.tencent.com/SearchPro'; // 元宝搜索 API 端点

/**
 * 调元宝搜索 SearchPro，返回结构化证据列表
 * 鉴权方式：Authorization: Bearer <API Key>（sk-xxxx）
 * @param {string} query 搜索词
 * @returns {Promise<Array<{title,url,passage,site,date,score}>>}
 */
async function yuanbaoSearch(query) {
  const resp = await fetch(WSA_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json; charset=utf-8',
      'Authorization': `Bearer ${YB_API_KEY}`,           // 元宝搜索 API Key
    },
    body: JSON.stringify({ Query: query, Mode: 2, Cnt: 10 }), // Mode=2 混合结果
  }).catch(err => {
    // 网络层失败（DNS/断网/被墙）：给出人话提示
    throw new Error(`无法连接元宝搜索服务（${WSA_URL}）：${err.message}`);
  });

  const j = await resp.json();
  if (!resp.ok) throw new Error(`元宝搜索返回 ${resp.status}：${(j.Message || j.msg || JSON.stringify(j)).slice(0, 150)}`);

  // 响应结构做兼容处理：Pages 可能在顶层，也可能包在 Response 里
  const pages = j.Pages || j.Response?.Pages || j.Data?.Pages || [];

  // Pages 是"JSON 字符串的数组"，逐条解析成对象
  return pages
    .map(s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } })
    .filter(Boolean)
    .map(p => ({
      title:   p.title   || '',
      url:     p.url     || '',
      passage: p.passage || p.content || '',    // 标准摘要（兜底动态摘要）
      site:    p.site    || '',                 // 网站名
      date:    p.date    || '',                 // 发布时间
      score:   p.score ?? null,                 // 相关性得分
    }));
}

/* ---------- 第 6 部分：侦探大脑（OpenAI 兼容大模型） ---------- */
/** 拼出上游 chat/completions 完整地址 */
function llmUrl() {
  return new URL('chat/completions', AI_BASE_URL.endsWith('/') ? AI_BASE_URL : AI_BASE_URL + '/');
}

/** 非流式调用大模型（用于深度调查前规划多个搜索词） */
async function llmChat(messages) {
  const resp = await fetch(llmUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_API_KEY}` },
    body: JSON.stringify({ model: AI_MODEL, messages, stream: false }),
  });
  const j = await resp.json();
  return j.choices?.[0]?.message?.content || '';
}

/**
 * 深度调查模式：让大模型把问题拆成 2~3 条搜索词
 * 失败/格式异常时兜底为 [问题本身]
 */
async function planQueries(question) {
  try {
    const text = await llmChat([{ role: 'user', content:
      `你是搜索专家。针对问题：「${question}」，给出 2~3 条用于搜索引擎的查询词（可含一条英文）。只输出 JSON 数组字符串，例如 ["查询1","查询2"]，不要输出任何其他内容。` }]);
    const arr = JSON.parse(text.match(/\[.*\]/s)?.[0] || '[]');   // 从回复里抠出 JSON 数组
    const qs = arr.filter(q => typeof q === 'string' && q.trim()).slice(0, 3);
    return qs.length ? qs : [question];
  } catch {
    return [question];
  }
}

/**
 * 截图查证第一步：让大模型先"看图认主张"
 * ——必须在搜索之前做，否则拿"这对吗？"这种废话去搜，必然一无所获。
 * @param {string[]} images base64 dataURL 数组
 * @param {string} context 用户补充的上下文
 * @returns {Promise<{claim:string, queries:string[]}>}
 */
async function recognizeScreenshot(images, context) {
  try {
    const content = [{
      type: 'text',
      text: `请仔细观察这几张截图${context ? `（上下文：${context}）` : ''}，完成两件事，只输出一个 JSON 对象，不要输出其他内容：
{"claim":"一句话客观复述截图里在传的核心说法（要点明出处，如某节目/某媒体/某账号，以及具体说了什么）","queries":["用于搜索引擎查证该说法的查询词1","查询词2","查询词3"]}
queries 要求：包含出处名称、关键人物/事物、可查证的关键词，方便搜到原始报道或辟谣信息。`,
    }];
    for (const url of images) {
      content.push({ type: 'image_url', image_url: { url } });    // 附上所有截图
    }
    const text = await llmChat([{ role: 'user', content }]);
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}'); // 抠出 JSON
    return {
      claim:  typeof j.claim === 'string' ? j.claim : '',
      queries: Array.isArray(j.queries) ? j.queries.filter(q => typeof q === 'string' && q.trim()).slice(0, 3) : [],
    };
  } catch {
    return { claim: '', queries: [] };                            // 辨认失败则走兜底
  }
}

/* ---------- 第 7 部分：办案主流程（SSE 流式） ---------- */
/** SSE 工具：推一条 data 行 */
function sseSend(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
/** 开启 SSE 响应头 */
function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}
/** SSE 收尾 */
function sseEnd(res) { res.write('data: [DONE]\n\n'); res.end(); }

/**
 * 组装发给大模型的消息：
 * 系统提示词 + 用户消息（问题 + 证物材料 + 盯梢旧卷宗 + 可选多张截图）
 */
function buildMessages(question, mode, lastReport, context, images, evidence) {
  let system = SYSTEM_PROMPT;
  if (mode === 'deep') system += MODE_PROMPTS.deep;
  if (mode === 'screenshot') system += MODE_PROMPTS.screenshot;

  // --- 组装用户消息文本 ---
  let userText = `【委托】${question}\n`;

  if (mode === 'screenshot' && context) {
    userText += `\n【截图上下文】${context}\n`;
  }
  if (mode === 'watch' && lastReport) {
    userText += `\n【上次结案报告】\n<上次报告>\n${lastReport}\n</上次报告>\n请重新对照本次《证物材料》，输出《盯梢记录》：## 【变化梳理】（逐条对比：变了什么/没变什么，挂新来源和时间）## 【新增证据】## 【结论更新】（无变化就写"经复查，暂无新变化"）\n`;
  }

  // 注入元宝搜索走访到的证物材料（没有材料就如实说明，触发"未查到"路径）
  if (evidence.length) {
    userText += `\n【证物材料】（元宝搜索走访所得，只能引用其中的 URL）\n` +
      evidence.map((e, i) =>
        `${i + 1}. 标题：${e.title}\n   链接：${e.url}\n   来源：${e.site || '未知站点'}　时间：${e.date || '未知'}\n   摘要：${e.passage}`
      ).join('\n\n');
  } else {
    userText += `\n【证物材料】本次元宝搜索走访一无所获，没有搜到任何可靠结果。请如实按"未查到"结案，禁止编造来源。\n`;
  }

  // --- 有截图时走 OpenAI 视觉消息格式（支持多张图） ---
  let userMessage;
  if (images && images.length) {
    const content = [{ type: 'text', text: userText }];
    for (const url of images) {
      content.push({ type: 'image_url', image_url: { url } });   // 每张截图一项
    }
    userMessage = { role: 'user', content };
  } else {
    userMessage = { role: 'user', content: userText };
  }

  return [{ role: 'system', content: system }, userMessage];
}

/** 立案查证主入口 */
async function streamInvestigate(body, res) {
  const { mode = 'normal', lastReport = '', context = '' } = body;
  let { question = '' } = body;

  // --- 收集截图：兼容 images 数组（新）与 image 单张（旧） ---
  const images = Array.isArray(body.images)
    ? body.images.filter(u => /^data:image\//.test(u)).slice(0, 3)      // 最多 3 张
    : (body.image && /^data:image\//.test(body.image) ? [body.image] : []);

  // --- 配置检查：缺什么如实说什么 ---
  if (!searchReady() || !llmReady()) {
    sseStart(res);
    const miss = [];
    if (!searchReady()) miss.push('元宝搜索（API Key）');
    if (!llmReady())    miss.push('侦探大脑（API 地址/Key/模型名）');
    sseSend(res, { error: `侦探社档案不全：${miss.join('、')} 未配置。请点右上角 ⚙️ 设置补齐。` });
    return sseEnd(res);
  }

  sseStart(res);
  try {
    // === 第 0 步：截图查证 —— 先看图认主张，再用主张生成搜索词 ===
    let queries;
    if (mode === 'screenshot' && images.length) {
      sseSend(res, { stage: '🧠 侦探正在辨认截图内容…' });
      const rec = await recognizeScreenshot(images, context);
      if (rec.claim) question = rec.claim;                  // 用认出的主张替代"这对吗？"
      sseSend(res, { stage: `📸 已认出主张：${question || '（未能辨认，请补充文字说明）'}` });
      queries = rec.queries.length ? rec.queries : [question];  // 用主张生成的查询词去搜
      if (!queries[0]) {
        sseSend(res, { error: '侦探看不清截图内容，请在输入框里补充：截图里在传什么说法（出处+具体说了什么）。' });
        return sseEnd(res);
      }
    } else if (mode === 'deep') {
      // === 深度调查：先让大脑拆出多条搜索词 ===
      sseSend(res, { stage: '🔎 侦探正在用元宝搜索走访全网…' });
      queries = await planQueries(question);
      sseSend(res, { stage: `🧭 侦查计划：${queries.join(' / ')}` });
    } else {
      queries = [question];
      sseSend(res, { stage: '🔎 侦探正在用元宝搜索走访全网…' });
    }

    // === 第 1 步：走访（元宝搜索取证） ===
    const seen = new Set();
    const evidence = [];
    const searchOnce = async (q) => {                       // 单次搜索封装
      for (const item of await yuanbaoSearch(q)) {
        if (item.url && !seen.has(item.url)) { seen.add(item.url); evidence.push(item); }
        if (evidence.length >= 15) break;
      }
    };

    for (const q of queries) {
      try {
        await searchOnce(q);
      } catch (e) {
        // 单条搜索失败不中断整个案子，但要在进度里明说这一路没查成
        sseSend(res, { stage: `⚠️ 搜索「${q}」失败：${e.message}` });
        evidence.push({ title: `搜索「${q}」失败`, url: '', passage: e.message, site: '', date: '', score: null });
      }
      if (evidence.length >= 15) break;
    }

    // === 第 1.5 步：首轮一无所获时，换关键词自动重查一轮 ===
    if (!evidence.some(e => e.url) && question) {
      sseSend(res, { stage: '🔄 首轮走访无收获，侦探换个关键词再查一次…' });
      try {
        for (const q of await planQueries(question)) {
          await searchOnce(q);
          if (evidence.some(e => e.url)) break;
        }
      } catch { /* 重查失败就如实进报告 */ }
    }

    sseSend(res, { stage: `🧾 走访完成，取得证物 ${evidence.filter(e => e.url).length} 件，开始撰写结案报告…` });

    // === 第 2 步：写报告（大模型流式输出） ===
    const messages = buildMessages(question, mode, lastReport, context, images, evidence);
    const upstream = await fetch(llmUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages, stream: true }),
    }).catch(err => {
      // 网络层失败：明确指出是"侦探大脑"的地址连不上（常见原因：地址错/需代理/被墙）
      throw new Error(`无法连接侦探大脑（API 地址：${AI_BASE_URL}）：${err.message}。请检查地址是否正确、该地址在你的网络下是否可达。`);
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      sseSend(res, { error: `侦探大脑返回 ${upstream.status}：${errText.slice(0, 300)}` });
      return sseEnd(res);
    }

    // 逐行解析上游 SSE，抽取 delta.content 转发
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') return sseEnd(res);
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) sseSend(res, { delta });
        } catch { /* 半截 JSON 忽略 */ }
      }
    }
    return sseEnd(res);
  } catch (err) {
    sseSend(res, { error: '侦探办案途中失联：' + err.message });
    return sseEnd(res);
  }
}

/* ---------- 第 8 部分：HTTP 服务 —— 静态文件 + API 路由 ---------- */
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

/** 读取请求体 JSON（带大小上限，防超大 base64 打爆内存） */
function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > limitBytes) { req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- API：配置状态（密钥永不回传，只回显可公开字段） ---
  if (url.pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      configured: searchReady() && llmReady(),   // 两组都齐了才算开业
      searchReady: searchReady(),
      llmReady: llmReady(),
      model: AI_MODEL,
      baseUrl: AI_BASE_URL,
    }));
  }

  // --- API：保存配置（仅允许本机，公开链接不能远程改密钥） ---
  if (url.pathname === '/api/config' && req.method === 'POST') {
    if (!isLocalConfigRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '公开部署已关闭远程配置，请在部署环境变量中配置密钥。' }));
    }
    const body = await readBody(req, 64 * 1024);
    try {
      saveConfig(body || {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, searchReady: searchReady(), llmReady: llmReady() }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // --- API：只做元宝搜索取证（云端模型模式使用，密钥留在服务端） ---
  if (url.pathname === '/api/search' && req.method === 'POST') {
    const body = await readBody(req, 256 * 1024);
    if (!searchReady()) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '元宝搜索 API Key 尚未配置。' }));
    }
    const queries = Array.isArray(body?.queries)
      ? body.queries.filter(q => typeof q === 'string' && q.trim()).slice(0, 5)
      : (typeof body?.query === 'string' && body.query.trim() ? [body.query.trim()] : []);
    if (!queries.length) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '搜索词不能为空。' }));
    }
    try {
      const seen = new Set();
      const evidence = [];
      for (const query of queries) {
        for (const item of await yuanbaoSearch(query)) {
          if (item.url && !seen.has(item.url)) {
            seen.add(item.url);
            evidence.push(item);
          }
          if (evidence.length >= 15) break;
        }
        if (evidence.length >= 15) break;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ evidence, queries }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // --- API：立案查证（本地模式仍使用旧的服务端模型流程） ---
  if (url.pathname === '/api/investigate' && req.method === 'POST') {
    const body = await readBody(req);
    if (body === null) {
      sseStart(res);
      sseSend(res, { error: '附件过大：请把截图压缩到 5MB 以内再上传' });
      return sseEnd(res);
    }
    return streamInvestigate(body, res);
  }

  // --- 静态文件 ---
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('🕵️  AI侦探社已开业：http://0.0.0.0:' + PORT);
  console.log(`   元宝搜索：${searchReady() ? '✅ 已配置 API Key' : '⚠️ 未配置（点页面 ⚙️ 设置填写）'}`);
  console.log(`   侦探大脑：${llmReady() ? '✅ 已配置（' + AI_MODEL + '）' : '⚠️ 未配置（缺 API 地址/Key/模型名）'}`);
});
