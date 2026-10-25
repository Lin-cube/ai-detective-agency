/* ============================================================
   app.js v6 —— 「AI侦探社」前端逻辑（紫色晨光沉浸式改版）
   新增：① 背景动态控制（Ken Burns 暂停/播放、系统减少动态适配、
          页面后台自动暂停）② 欣赏背景模式 ③ 示例问题填入
        ④ 多行输入、导航锚点滚动
   保留：模式页签 / 设置面板 / 截图多图上传 / SSE 流式 / 流程条 /
        判定印章 / 证物卡 / 诚实徽章 / 历史卷宗
   ============================================================ */

/* ---------- 0. 元素引用 ---------- */
const bgScene       = document.getElementById('bgScene');        // 背景场景容器
const motionBtn     = document.getElementById('motionBtn');      // 暂停/播放动态
const viewBtn       = document.getElementById('viewBtn');        // 欣赏背景/返回调查

const statusLamp    = document.getElementById('statusLamp');     // 顶栏状态灯
const settingsBtn   = document.getElementById('settingsBtn');    // ⚙️ 设置按钮
const settingsMask  = document.getElementById('settingsMask');   // 设置面板遮罩
const cfgYbKey      = document.getElementById('cfgYbKey');       // 设置：元宝搜索 API Key
const cfgBaseUrl    = document.getElementById('cfgBaseUrl');     // 设置：大脑 API 地址
const cfgApiKey     = document.getElementById('cfgApiKey');      // 设置：大脑 API Key
const cfgModel      = document.getElementById('cfgModel');       // 设置：大脑模型名
const settingsMsg   = document.getElementById('settingsMsg');    // 设置：提示信息
const settingsSave  = document.getElementById('settingsSave');   // 设置：保存按钮
const settingsCancel= document.getElementById('settingsCancel'); // 设置：取消按钮

const modeBtns      = document.querySelectorAll('.mode-btn');    // 四个模式页签
const modeDesc      = document.getElementById('modeDesc');       // 模式说明小字
const questionInput = document.getElementById('question');       // 多行问题输入
const fileBtn       = document.getElementById('fileBtn');        // 开始调查按钮
const stepsBar      = document.getElementById('stepsBar');       // 办案流程条
const steps         = stepsBar.querySelectorAll('.step');        // 流程条四个节点
const reportEl      = document.getElementById('report');         // 结案报告容器
const shotBox       = document.getElementById('screenshotBox');  // 截图查证区
const dropZone      = document.getElementById('dropZone');       // 图片上传区
const imageInput    = document.getElementById('imageInput');     // 隐藏的文件选择框
const dropHint      = document.getElementById('dropHint');       // 上传提示
const previewList   = document.getElementById('previewList');    // 图片预览列表
const claimInput    = document.getElementById('claimInput');     // 截图主张输入
const contextInput  = document.getElementById('contextInput');   // 截图上下文输入
const watchHint     = document.getElementById('watchHint');      // 盯梢提示
const caseListEl    = document.getElementById('caseList');       // 历史卷宗列表

let currentMode = 'normal';      // 当前选中的模式
let busy = false;                // 是否正在办案（防止重复提交）
let imageDataUrls = [];          // 已选截图列表 [{name, url}]，最多 3 张
let userPaused = false;          // 用户是否手动暂停了背景动态

/* ============================================================
   1. 背景动态控制：暂停/播放、减少动态适配、后台自动暂停
   ============================================================ */
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 根据用户偏好与系统设置，同步背景动画状态与按钮文案 */
function applyMotion() {
  if (prefersReduced) {
    // 系统要求减少动态：直接静态，按钮显示明确的静态状态且不再可切换
    bgScene.classList.add('static');
    motionBtn.textContent = '⏸ 动态已按系统设置关闭';
    motionBtn.disabled = true;
    return;
  }
  bgScene.classList.toggle('paused', userPaused);
  motionBtn.textContent = userPaused ? '▶️ 播放动态' : '⏸ 暂停动态';
}

motionBtn.addEventListener('click', () => {
  userPaused = !userPaused;      // 切换用户偏好
  applyMotion();
});

// 页面进入后台时自动暂停动画，回到前台按用户偏好恢复
document.addEventListener('visibilitychange', () => {
  if (prefersReduced) return;    // 本来就是静态
  if (document.hidden) {
    bgScene.classList.add('paused');
  } else {
    bgScene.classList.toggle('paused', userPaused);
  }
});

// 欣赏背景：暂时隐藏首屏输入内容，方便观看风景
viewBtn.addEventListener('click', () => {
  const enjoying = document.body.classList.toggle('enjoying');
  viewBtn.textContent = enjoying ? '🔍 返回调查' : '🏞️ 欣赏背景';
});

/* ---------- 2. 页面加载：探测配置状态 ---------- */
window.addEventListener('DOMContentLoaded', () => {
  applyMotion();     // 初始化背景动态状态
  renderCases();     // 渲染历史卷宗
  refreshStatus();   // 刷新状态灯
});

/** 刷新状态灯（密钥永不回显，输入框不回填旧值防误存） */
async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    if (s.configured) {
      statusLamp.textContent = `🟢 侦探社已开业 · ${s.model}`;
      statusLamp.className = 'lamp lamp-ok';
    } else {
      const miss = [];
      if (!s.searchReady) miss.push('元宝搜索');
      if (!s.llmReady) miss.push('侦探大脑');
      statusLamp.textContent = `🟡 待配置：${miss.join('、')}`;
      statusLamp.className = 'lamp lamp-wait';
    }
  } catch {
    statusLamp.textContent = '🔴 服务未连接';
  }
}

/* ---------- 3. 设置面板：打开 / 关闭 / 保存 ---------- */
settingsBtn.addEventListener('click', () => {
  settingsMsg.textContent = '';
  settingsMask.classList.remove('hidden');
});
settingsCancel.addEventListener('click', () => settingsMask.classList.add('hidden'));
settingsMask.addEventListener('click', e => {
  if (e.target === settingsMask) settingsMask.classList.add('hidden');
});

settingsSave.addEventListener('click', async () => {
  // 只提交填写了的字段（留空=保持不变）
  const body = {};
  if (cfgYbKey.value.trim())    body.ybApiKey = cfgYbKey.value.trim();
  if (cfgBaseUrl.value.trim())  body.baseUrl  = cfgBaseUrl.value.trim();
  if (cfgApiKey.value.trim())   body.apiKey   = cfgApiKey.value.trim();
  if (cfgModel.value.trim())    body.model    = cfgModel.value.trim();

  if (!Object.keys(body).length) {
    settingsMsg.className = 'settings-msg';
    settingsMsg.textContent = '没有填写任何内容。至少要填一项再保存。';
    return;
  }

  settingsSave.disabled = true;
  settingsMsg.className = 'settings-msg';
  settingsMsg.textContent = '保存中…';
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.ok) {
      settingsMsg.className = 'settings-msg ok';
      settingsMsg.textContent = '✅ 档案已保存并生效';
      cfgYbKey.value = ''; cfgApiKey.value = '';   // 安全：清空密钥输入框
      refreshStatus();
      setTimeout(() => settingsMask.classList.add('hidden'), 900);
    } else {
      settingsMsg.textContent = j.error || '保存失败';
    }
  } catch (err) {
    settingsMsg.textContent = '连接服务失败：' + err.message;
  }
  settingsSave.disabled = false;
});

/* ---------- 4. 模式页签切换 ---------- */
const MODE_META = {
  normal: {
    desc: '适合日常快查：拆解关键点、多轮搜索、交叉对质后结案。',
    ph:   '把要查的事交给侦探：比如「某发布会门票到底在哪些渠道真卖过？」',
  },
  deep: {
    desc: '适合复杂问题：先出侦查计划，逐方向多轮查证，输出交叉比对表与证据链报告。',
    ph:   '深度调查：问题越复杂越合适，比如「对比 A、B 两款设备的真实口碑差异」',
  },
  watch: {
    desc: '适合长期关注：侦探定期复查同一问题，有变化就梳理成《盯梢记录》。',
    ph:   '盯梢目标：比如「某产品价格」「某政策进展」',
  },
  screenshot: {
    desc: '上传截图（可多张），侦探先看图认出主张并生成搜索词，再溯源查证，属实/存疑/不实/未查到四选一结案。',
    ph:   '有文字线索就写在这里；也可以留空，侦探会直接看图辨认',
  },
};

modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    modeDesc.textContent = MODE_META[currentMode].desc;
    questionInput.placeholder = MODE_META[currentMode].ph;
    // 截图模式：显示上传区 + 左下角上传按钮
    shotBox.classList.toggle('hidden', currentMode !== 'screenshot');
    document.getElementById('uploadBtn').classList.toggle('hidden', currentMode !== 'screenshot');
    watchHint.classList.toggle('hidden', currentMode !== 'watch');
  });
});

/* ---------- 5. 示例问题：点击填入，确认后才提交 ---------- */
document.querySelectorAll('.example-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    questionInput.value = chip.textContent.trim();   // 只填入，不自动提交
    questionInput.focus();
    questionInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});

/* ---------- 6. 截图上传：点击 / 拖拽 / 多图预览 / 移除 ---------- */
dropZone.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  for (const f of imageInput.files) loadImage(f);   // 支持多选
  imageInput.value = '';
});
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  for (const f of e.dataTransfer.files) loadImage(f);
});

/** 读取图片为 base64 并加入列表（≤3张，每张≤5MB） */
function loadImage(file) {
  if (!/^image\//.test(file.type)) { alert('请选择图片文件（PNG/JPG）'); return; }
  if (file.size > 5 * 1024 * 1024) { alert('单张图片请控制在 5MB 以内'); return; }
  if (imageDataUrls.length >= 3) { alert('最多上传 3 张截图'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    imageDataUrls.push({ name: file.name, url: reader.result });
    renderPreviews();
  };
  reader.readAsDataURL(file);
}

/** 渲染多图预览列表 */
function renderPreviews() {
  if (!imageDataUrls.length) {
    previewList.classList.add('hidden');
    dropHint.classList.remove('hidden');
    return;
  }
  dropHint.classList.add('hidden');
  previewList.classList.remove('hidden');
  previewList.innerHTML = imageDataUrls.map((im, i) => `
    <div class="preview-item">
      <img src="${im.url}" alt="截图预览" />
      <div class="preview-meta">
        <span class="preview-name">${escapeHtml(im.name)}</span>
        <button class="mini-btn" data-i="${i}" type="button">移除</button>
      </div>
    </div>`).join('');
}
previewList.addEventListener('click', e => {
  const btn = e.target.closest('button.mini-btn');
  if (!btn) return;
  e.stopPropagation();
  imageDataUrls.splice(+btn.dataset.i, 1);
  renderPreviews();
});

/* ---------- 7. 办案流程条 ---------- */
function setStep(n) {
  steps.forEach(s => {
    const num = +s.dataset.step;
    s.classList.toggle('done',   num < n);
    s.classList.toggle('active', num === n);
  });
}

/** 根据已流出的报告文本推断办案进度 */
function inferStep(text) {
  if (/结案报告|调查报告|盯梢记录|【结论】/.test(text)) return 4;
  if (/对质|交叉比对|证词冲突|来源A|比对表/.test(text))   return 3;
  if (text.length > 30)                                   return 2;
  return 1;
}

/* ---------- 8. 立案：开始调查 ---------- */
fileBtn.addEventListener('click', startCase);
questionInput.addEventListener('keydown', e => {
  // Ctrl/Cmd + Enter 提交；普通回车换行（多行输入）
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') startCase();
});

async function startCase() {
  if (busy) return;

  const question = questionInput.value.trim();     // 主问题
  const claim    = claimInput.value.trim();        // 截图主张（可空，侦探看图辨认）
  const context  = contextInput.value.trim();      // 截图上下文
  const text     = currentMode === 'screenshot' ? claim : question;

  // 输入校验 + 红框反馈
  if (currentMode === 'screenshot' && !text && !imageDataUrls.length) {
    questionInput.classList.add('input-error');
    setTimeout(() => questionInput.classList.remove('input-error'), 1500);
    showError('⚠️ 请先上传截图，或填写截图里在传什么说法。');
    return;
  }
  if (currentMode !== 'screenshot' && !text) {
    questionInput.classList.add('input-error');
    setTimeout(() => questionInput.classList.remove('input-error'), 1500);
    showError('⚠️ 委托内容为空，侦探无从下手。请先填写问题。');
    return;
  }

  // 进入办案状态：收起首页介绍区，报告成为视觉中心
  busy = true; fileBtn.disabled = true; fileBtn.textContent = '调查中…';
  document.body.classList.add('investigating');
  stepsBar.classList.remove('hidden');
  setStep(1);
  reportEl.className = 'report typing';
  reportEl.innerHTML = '<p class="report-placeholder">侦探接案，正在走访全网……</p>';
  reportEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // 盯梢模式：带上本地旧卷宗做对比
  let lastReport = '';
  if (currentMode === 'watch') {
    const old = getCases().find(c => c.q === text);
    if (old && old.report) lastReport = old.report;
  }

  // --- 发起 SSE 流式请求：恢复原先的服务端 API Key 版本 ---
  let full = '';
  try {
    const resp = await fetch('/api/investigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: text, mode: currentMode, lastReport, context,
        images: currentMode === 'screenshot' ? imageDataUrls.map(im => im.url) : [],
      }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.error) {
            showError('🔴 ' + j.error);
          } else if (j.stage) {
            showStage(j.stage);
          } else if (j.delta) {
            full += j.delta;
            setStep(inferStep(full));
            reportEl.innerHTML = renderMarkdown(full, true);
            reportEl.scrollTop = reportEl.scrollHeight;
          }
        } catch { /* 半截 JSON 忽略 */ }
      }
    }
  } catch (err) {
    showError('🔴 连接侦探社失败：' + err.message);
  }

  // --- 结案后处理 ---
  setStep(4); steps.forEach(s => s.classList.add('done'));
  reportEl.className = 'report';
  if (full) {
    reportEl.innerHTML = renderMarkdown(full, false) + buildEvidenceDock(full);
    saveCase(text, full, currentMode);
  }
  busy = false; fileBtn.disabled = false; fileBtn.textContent = '开始调查';
}

/** 统一的错误展示 */
function showError(msg) {
  stepsBar.classList.add('hidden');
  reportEl.className = 'report';
  reportEl.innerHTML = `<p style="color:var(--red)">${escapeHtml(msg)}</p>`;
}

/** 办案进度播报行 */
function showStage(text) {
  let bar = reportEl.querySelector('.stage-line');
  if (!bar) {
    reportEl.innerHTML = `<p class="stage-line"></p>`;
    bar = reportEl.querySelector('.stage-line');
  }
  bar.textContent = text;
}

/* ---------- 9. 判定印章：属实/存疑/不实/未查到 ---------- */
function buildStamp(text) {
  const m = text.match(/结论[：:]\s*(属实|存疑|不实|未查到)/);
  if (!m) return '';
  const cls = { '属实': 'stamp-true', '存疑': 'stamp-doubt', '不实': 'stamp-false', '未查到': 'stamp-none' }[m[1]];
  return `<div class="stamp ${cls}">${m[1]}</div>`;
}

/* ---------- 10. 证物卡：编号 + 域名首字母头像 + 可点开 ---------- */
function buildEvidenceDock(text) {
  const urls = [...new Set((text.match(/https?:\/\/[^\s)\]}"'，。；、]+/g) || []))];
  if (!urls.length) return '';

  const cards = urls.map((u, i) => {
    let host = u, letter = '证';
    try {
      host = new URL(u).hostname;
      letter = host.replace(/^www\./, '')[0].toUpperCase();
    } catch { /* 保底 */ }
    return `<a class="evidence-card" href="${u}" target="_blank" rel="noopener">
              <span class="avatar">${escapeHtml(letter)}</span>
              <span class="tag">来源 ${i + 1}</span>
              <span class="site">${escapeHtml(host)}</span>
            </a>`;
  }).join('');

  return `<div class="evidence-dock">
            <h3>🧾 引用来源 · 点击即可查证（共 ${urls.length} 条）</h3>
            <div class="evidence-cards">${cards}</div>
          </div>`;
}

/* ---------- 11. 轻量 Markdown 渲染器（零依赖，先转义防 XSS） ---------- */
function renderMarkdown(md, streaming) {
  let html = escapeHtml(md);

  const stamp = streaming ? '' : buildStamp(md);   // 流式中不显示判定，避免闪烁

  // --- 表格 ---
  const lines = html.split('\n');
  const out = [];
  let inTable = false;
  for (const line of lines) {
    const isRow = /^\s*\|.+\|\s*$/.test(line);
    if (isRow) {
      if (!inTable) { out.push('<table>'); inTable = true; }
      if (/^[\s|:\-]+$/.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, '').split('|')
        .map(c => `<td>${c.trim()}</td>`).join('');
      out.push(`<tr>${cells}</tr>`);
    } else {
      if (inTable) { out.push('</table>'); inTable = false; }
      out.push(line);
    }
  }
  if (inTable) out.push('</table>');
  html = out.join('\n');

  // --- 标题 / 加粗 / 链接 / 列表 ---
  html = html
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>');

  // --- 段落包装 ---
  html = html.split('\n\n').map(block => {
    const b = block.trim();
    if (!b) return '';
    if (/^<(h1|h2|ul|table)/.test(b)) return b;
    if (b.startsWith('<li>')) return `<ul>${b.replace(/\n/g, '')}</ul>`;
    return `<p>${b.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // --- 诚实徽章（结案后才亮） ---
  let badge = '';
  if (!streaming && /(未查到|查不到|无法核实|没有找到可靠|暂无可靠信息)/.test(md)) {
    badge = `<div class="badge-honest">🎖️ 诚实徽章：本案侦探明确承认了查不到的部分，没有编造——这正是职业操守。</div>`;
  }

  return stamp + html + badge;
}

/* ---------- 12. 历史卷宗（localStorage 持久化） ---------- */
const CASE_KEY = 'detective_cases';

function getCases() {
  try { return JSON.parse(localStorage.getItem(CASE_KEY) || '[]'); } catch { return []; }
}

function saveCase(q, report, mode) {
  if (mode !== 'watch' && mode !== 'normal') return;
  if (!q) return;
  const cases = getCases();
  const idx = cases.findIndex(c => c.q === q);
  const rec = { q, report, mode, time: new Date().toLocaleString('zh-CN') };
  if (idx >= 0) cases[idx] = rec; else cases.unshift(rec);
  if (cases.length > 30) cases.pop();
  localStorage.setItem(CASE_KEY, JSON.stringify(cases));
  renderCases();
}

function renderCases() {
  const cases = getCases();
  if (!cases.length) {
    caseListEl.innerHTML = '<li class="cabinet-empty">卷宗柜空空如也。立案后这里会留下档案。</li>';
    return;
  }
  caseListEl.innerHTML = cases.map((c, i) => `
    <li>
      <span class="q">${c.mode === 'watch' ? '📌 ' : '🔍 '}${escapeHtml(c.q)}</span>
      <span class="time">${c.time}</span>
      <button data-act="rewatch" data-i="${i}">再次盯梢</button>
      <button data-act="open" data-i="${i}">查看</button>
      <button data-act="del" class="del" data-i="${i}">销毁</button>
    </li>`).join('');
}

caseListEl.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const i = +btn.dataset.i;
  const cases = getCases();
  const act = btn.dataset.act;

  if (act === 'rewatch') {
    questionInput.value = cases[i].q;
    document.querySelector('[data-mode="watch"]').click();
    startCase();
  } else if (act === 'open') {
    stepsBar.classList.add('hidden');
    reportEl.className = 'report';
    reportEl.innerHTML = renderMarkdown(cases[i].report, false) + buildEvidenceDock(cases[i].report);
    reportEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (act === 'del') {
    cases.splice(i, 1);
    localStorage.setItem(CASE_KEY, JSON.stringify(cases));
    renderCases();
  }
});

/* ---------- 13. 工具：HTML 转义（防 XSS） ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
