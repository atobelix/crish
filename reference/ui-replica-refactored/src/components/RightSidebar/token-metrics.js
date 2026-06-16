/**
 * TokenMetrics — right sidebar usage statistics panel.
 * Full port of original HTML/CSS functionality, using design system tokens.
 */
import { store } from '../../services/store.js';
import { eventBus } from '../../services/eventBus.js';
import { MockData } from '../../data/mockData.js';

let currentTokensUsed = 4253109;
const TOTAL_LIMIT = 10000000;

export function initTokenMetrics() {
  const panel = document.getElementById('tab-token-metrics');
  if (!panel) return;
  renderMetrics(panel);
  bindMetricButtons(panel);
  eventBus.on('chat:send', () => setTimeout(() => addMockLog('user_message', 240, 0), 100));
}

function renderMetrics(panel) {
  const pct = ((currentTokensUsed / TOTAL_LIMIT) * 100).toFixed(1);
  panel.innerHTML = `
    <div class="token-metrics-container">
      <div class="metric-filter-bar">
        <button class="metric-dropdown-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg><span>当前对话</span><svg class="dd-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg></button>
        <button class="metric-dropdown-btn"><span>近7天</span><svg class="dd-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg></button>
        <button class="metric-dropdown-btn"><span>自适应</span><svg class="dd-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg></button>
        <div class="metric-spacer"></div>
        <button class="metric-icon-btn active" title="折线图"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="22 20 18 14 14 16 10 10 6 12 2 6"></polyline></svg></button>
        <button class="metric-icon-btn" title="柱状图"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg></button>
        <button class="metric-icon-btn" title="热力图"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="4" height="4" rx="1"></rect><rect x="10" y="3" width="4" height="4" rx="1"></rect><rect x="17" y="3" width="4" height="4" rx="1"></rect><rect x="3" y="10" width="4" height="4" rx="1"></rect><rect x="10" y="10" width="4" height="4" rx="1"></rect><rect x="17" y="10" width="4" height="4" rx="1"></rect><rect x="3" y="17" width="4" height="4" rx="1"></rect><rect x="10" y="17" width="4" height="4" rx="1"></rect><rect x="17" y="17" width="4" height="4" rx="1"></rect></svg></button>
      </div>
      <div class="metric-content">
        <div class="token-progress-card">
          <div class="token-card-header">
            <span class="total-used-tokens">已使用: ${currentTokensUsed.toLocaleString()} (${pct}%)</span>
            <span class="token-limit-info-pill">上限: ${(TOTAL_LIMIT / 1000000).toFixed(0)}M</span>
          </div>
          <div class="token-stacked-bar">
            <div class="bar-fill fill-cached-input" style="width:25%" title="缓存输入: 2,500,000"></div>
            <div class="bar-fill fill-input" style="width:12.5%" title="普通输入: 1,250,000"></div>
            <div class="bar-fill fill-cached-output" style="width:3%" title="缓存输出: 300,000"></div>
            <div class="bar-fill fill-output" style="width:2%" title="普通输出: 203,109"></div>
          </div>
          <div class="token-legend">
            <div class="legend-item"><span class="dot dot-cached-input"></span><span>缓存输入 (2.5M)</span></div>
            <div class="legend-item"><span class="dot dot-input"></span><span>普通输入 (1.25M)</span></div>
            <div class="legend-item"><span class="dot dot-cached-output"></span><span>缓存输出 (300K)</span></div>
            <div class="legend-item"><span class="dot dot-output"></span><span>普通输出 (203K)</span></div>
          </div>
        </div>
        <div class="metric-chart-card">
          <div class="metric-chart-header"><span class="chart-title">模型调用频率</span><div class="chart-legend-inline"><span class="legend-line" style="color:#3b82f6">━ GPT-4</span><span class="legend-line" style="color:#19b36b">━ Gemini</span><span class="legend-line" style="color:#8b5cf6">━ Claude</span></div></div>
          <div class="metric-chart-body">${renderModelChart()}</div>
        </div>
        <div class="metric-chart-card">
          <div class="metric-chart-header"><span class="chart-title">逐时 Token 消耗</span><div class="chart-legend-inline"><span class="legend-dot" style="color:#3b82f6">● 输入</span><span class="legend-dot" style="color:#f97316">● 输出</span><span class="legend-dot" style="color:#19b36b">● 缓存</span></div></div>
          <div class="metric-chart-body">${renderHourlyChart()}</div>
        </div>
        <div class="metric-chart-card">
          <div class="metric-chart-header"><span class="chart-title">Token 速率 (tok/sec)</span><span class="chart-subtitle">按小时</span></div>
          <div class="metric-chart-body">${renderRateChart()}</div>
        </div>
        <div class="metric-chart-card">
          <div class="metric-chart-header"><span class="chart-title">预估费用趋势 ($)</span><span class="chart-subtitle">按天</span></div>
          <div class="metric-chart-body">${renderCostChart()}</div>
        </div>
        <div class="token-log-section">
          <h5>AI 行动 Token 消耗记录</h5>
          <ul class="token-log-list" id="token-log-list">
            <li class="token-log-item"><div class="log-meta"><span class="log-action">grep_search</span><span class="log-time">17:42:01</span></div><div class="log-tokens"><span class="input-tokens">+4,212 in</span><span class="output-tokens">+85 out</span></div></li>
            <li class="token-log-item"><div class="log-meta"><span class="log-action">read_file (index.html)</span><span class="log-time">17:42:15</span></div><div class="log-tokens"><span class="input-tokens">+15,800 in</span><span class="output-tokens">--</span></div></li>
            <li class="token-log-item"><div class="log-meta"><span class="log-action">edit_file (style.css)</span><span class="log-time">17:43:08</span></div><div class="log-tokens"><span class="input-tokens">+74,500 in</span><span class="output-tokens">+2,400 out</span></div></li>
          </ul>
        </div>
      </div>
    </div>`;
}

function renderModelChart() {
  return `<svg class="line-chart" viewBox="0 0 280 100" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">
    <defs><linearGradient id="g1"><stop offset="0%" stop-color="#3b82f6" stop-opacity="0.15"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/></linearGradient>
    <linearGradient id="g2"><stop offset="0%" stop-color="#19b36b" stop-opacity="0.15"/><stop offset="100%" stop-color="#19b36b" stop-opacity="0"/></linearGradient>
    <linearGradient id="g3"><stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.15"/><stop offset="100%" stop-color="#8b5cf6" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" y1="25" x2="280" y2="25" stroke="rgba(0,0,0,0.04)" stroke-width="0.5"/>
    <line x1="0" y1="50" x2="280" y2="50" stroke="rgba(0,0,0,0.04)" stroke-width="0.5"/>
    <line x1="0" y1="75" x2="280" y2="75" stroke="rgba(0,0,0,0.04)" stroke-width="0.5"/>
    <path d="M0,85 Q14,80 28,55 Q42,45 56,40 Q70,50 84,35 Q98,25 112,30 Q126,20 140,15 Q154,18 168,25 Q182,30 196,20 Q210,15 224,18 Q238,22 252,12 Q266,8 280,10" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M0,85 Q14,80 28,55 Q42,45 56,40 Q70,50 84,35 Q98,25 112,30 Q126,20 140,15 Q154,18 168,25 Q182,30 196,20 Q210,15 224,18 Q238,22 252,12 Q266,8 280,10 L280,90 L0,90 Z" fill="url(#g1)" opacity="0.6"/>
    <path d="M0,88 Q14,75 28,65 Q42,60 56,55 Q70,45 84,50 Q98,40 112,45 Q126,55 140,50 Q154,40 168,35 Q182,28 196,30 Q210,25 224,20 Q238,15 252,18 Q266,12 280,15" fill="none" stroke="#19b36b" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M0,88 Q14,75 28,65 Q42,60 56,55 Q70,45 84,50 Q98,40 112,45 Q126,55 140,50 Q154,40 168,35 Q182,28 196,30 Q210,25 224,20 Q238,15 252,18 Q266,12 280,15 L280,90 L0,90 Z" fill="url(#g2)" opacity="0.6"/>
    <path d="M0,90 Q14,88 28,85 Q42,75 56,70 Q70,65 84,60 Q98,55 112,50 Q126,45 140,42 Q154,38 168,40 Q182,45 196,55 Q210,50 224,45 Q238,40 252,35 Q266,30 280,28" fill="none" stroke="#8b5cf6" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M0,90 Q14,88 28,85 Q42,75 56,70 Q70,65 84,60 Q98,55 112,50 Q126,45 140,42 Q154,38 168,40 Q182,45 196,55 Q210,50 224,45 Q238,40 252,35 Q266,30 280,28 L280,90 L0,90 Z" fill="url(#g3)" opacity="0.6"/>
  </svg>`;
}

function renderHourlyChart() {
  return `<svg class="bar-chart" viewBox="0 0 280 90" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">
    <line x1="0" y1="30" x2="280" y2="30" stroke="rgba(0,0,0,0.04)" stroke-width="0.5"/>
    <line x1="0" y1="60" x2="280" y2="60" stroke="rgba(0,0,0,0.04)" stroke-width="0.5"/>
    <rect x="4" y="52" width="18" height="28" rx="2" fill="#3b82f6" opacity="0.6"/><rect x="4" y="40" width="18" height="12" rx="2" fill="#8b5cf6" opacity="0.6"/>
    <rect x="26" y="48" width="18" height="32" rx="2" fill="#3b82f6" opacity="0.85"/><rect x="26" y="38" width="18" height="10" rx="2" fill="#f97316" opacity="0.85"/>
    <rect x="48" y="35" width="18" height="45" rx="2" fill="#3b82f6" opacity="0.85"/>
    <rect x="70" y="30" width="18" height="50" rx="2" fill="#3b82f6" opacity="0.85"/><rect x="70" y="22" width="18" height="8" rx="2" fill="#19b36b" opacity="0.85"/>
    <rect x="92" y="38" width="18" height="42" rx="2" fill="#3b82f6" opacity="0.85"/>
    <rect x="114" y="42" width="18" height="38" rx="2" fill="#3b82f6" opacity="0.85"/><rect x="114" y="32" width="18" height="10" rx="2" fill="#f97316" opacity="0.85"/>
    <rect x="136" y="28" width="18" height="52" rx="2" fill="#3b82f6" opacity="0.85"/><rect x="136" y="20" width="18" height="8" rx="2" fill="#19b36b" opacity="0.85"/>
    <rect x="158" y="35" width="18" height="45" rx="2" fill="#3b82f6" opacity="0.85"/><rect x="158" y="25" width="18" height="10" rx="2" fill="#f97316" opacity="0.85"/>
    <rect x="180" y="40" width="18" height="40" rx="2" fill="#3b82f6" opacity="0.85"/>
    <rect x="202" y="45" width="18" height="35" rx="2" fill="#3b82f6" opacity="0.85"/>
    <rect x="224" y="50" width="18" height="30" rx="2" fill="#3b82f6" opacity="0.85"/><rect x="224" y="40" width="18" height="10" rx="2" fill="#f97316" opacity="0.85"/>
    <rect x="246" y="55" width="18" height="25" rx="2" fill="#3b82f6" opacity="0.85"/><rect x="246" y="45" width="18" height="10" rx="2" fill="#19b36b" opacity="0.85"/>
    <rect x="268" y="60" width="18" height="20" rx="2" fill="#3b82f6" opacity="0.85"/>
    <text x="13" y="82" font-size="6" fill="var(--text-muted)" text-anchor="middle">6</text><text x="71" y="82" font-size="6" fill="var(--text-muted)" text-anchor="middle">9</text>
    <text x="137" y="82" font-size="6" fill="var(--text-muted)" text-anchor="middle">12</text><text x="203" y="82" font-size="6" fill="var(--text-muted)" text-anchor="middle">15</text><text x="269" y="82" font-size="6" fill="var(--text-muted)" text-anchor="middle">18</text>
  </svg>`;
}

function renderRateChart() {
  return `<svg class="line-chart" viewBox="0 0 280 70" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">
    <defs><linearGradient id="gr"><stop offset="0%" stop-color="#00b4d8" stop-opacity="0.15"/><stop offset="100%" stop-color="#00b4d8" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" y1="30" x2="280" y2="30" stroke="rgba(0,0,0,0.03)" stroke-width="0.5"/>
    <line x1="0" y1="50" x2="280" y2="50" stroke="rgba(0,0,0,0.03)" stroke-width="0.5"/>
    <path d="M0,55 Q35,42 70,35 Q105,28 140,22 Q175,18 210,25 Q245,15 280,20" fill="none" stroke="#00b4d8" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M0,55 Q35,42 70,35 Q105,28 140,22 Q175,18 210,25 Q245,15 280,20 L280,60 L0,60 Z" fill="url(#gr)" opacity="0.6"/>
    <text x="10" y="62" font-size="6" fill="var(--text-muted)">6:00</text><text x="130" y="62" font-size="6" fill="var(--text-muted)">12:00</text><text x="250" y="62" font-size="6" fill="var(--text-muted)">18:00</text>
  </svg>`;
}

function renderCostChart() {
  return `<svg class="line-chart" viewBox="0 0 280 70" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">
    <defs><linearGradient id="gc"><stop offset="0%" stop-color="#fb923c" stop-opacity="0.15"/><stop offset="100%" stop-color="#fb923c" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" y1="30" x2="280" y2="30" stroke="rgba(0,0,0,0.03)" stroke-width="0.5"/>
    <line x1="0" y1="50" x2="280" y2="50" stroke="rgba(0,0,0,0.03)" stroke-width="0.5"/>
    <path d="M0,52 Q35,50 70,45 Q105,42 140,48 Q175,44 210,38 Q245,40 280,35" fill="none" stroke="#fb923c" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M0,52 Q35,50 70,45 Q105,42 140,48 Q175,44 210,38 Q245,40 280,35 L280,60 L0,60 Z" fill="url(#gc)" opacity="0.6"/>
    <text x="10" y="62" font-size="6" fill="var(--text-muted)">10/06</text><text x="100" y="62" font-size="6" fill="var(--text-muted)">10/09</text><text x="190" y="62" font-size="6" fill="var(--text-muted)">10/12</text><text x="250" y="62" font-size="6" fill="var(--text-muted)">10/15</text>
  </svg>`;
}

/* ── Bind filter bar buttons ── */
function bindMetricButtons(panel) {
  // Chart type toggle
  panel.querySelectorAll('.metric-icon-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.querySelectorAll('.metric-icon-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  // Dropdown buttons (mock: show/hide placeholder)
  panel.querySelectorAll('.metric-dropdown-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Toggle dropdown style feedback
      btn.classList.toggle('active');
    });
  });
}

export function addMockLog(actionName, inputTokens, outputTokens) {
  const logList = document.getElementById('token-log-list');
  if (!logList) return;
  const timeStr = new Date().toTimeString().split(' ')[0];
  const li = document.createElement('li');
  li.className = 'token-log-item';
  li.innerHTML = `<div class="log-meta"><span class="log-action">${actionName}</span><span class="log-time">${timeStr}</span></div><div class="log-tokens"><span class="input-tokens">+${inputTokens.toLocaleString()} in</span><span class="output-tokens">${outputTokens > 0 ? '+' + outputTokens.toLocaleString() + ' out' : '--'}</span></div>`;
  logList.insertAdjacentHTML('afterbegin', li.outerHTML);
  if (logList.children.length > 8) logList.removeChild(logList.lastChild);
  currentTokensUsed += inputTokens + outputTokens;
  if (currentTokensUsed > TOTAL_LIMIT) currentTokensUsed = TOTAL_LIMIT;
  const totalEl = document.querySelector('.total-used-tokens');
  if (totalEl) totalEl.textContent = `已使用: ${currentTokensUsed.toLocaleString()} (${((currentTokensUsed / TOTAL_LIMIT) * 100).toFixed(1)}%)`;
}

window.addMockTokenLog = addMockLog;
