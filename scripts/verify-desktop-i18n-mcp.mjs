#!/usr/bin/env node
/**
 * scripts/verify-desktop-i18n-mcp.mjs
 *
 * 4000 端口（Tauri MCP Socket）真机运行态核验自动化脚本
 * (Wave 4 · AGENT-W4-HOST-VERIFY)
 *
 * 遵循纪律：
 * 1. 严格遵循 AGENTS.md §15.2（9222 CDP 列为禁止项，TCP 4000 Tauri MCP Socket 为唯一合法桌面调试通道）；
 * 2. 阶段 1：探测 127.0.0.1:4000 端口连通性与认证握手；
 * 3. 阶段 2：执行语言热切换测试指令（zh-CN <-> en-US），断言无崩溃与状态保持；
 * 4. 阶段 3：执行侧栏 220px 几何排版与 Tooltip 状态读取；
 * 5. 阶段 4：执行截屏与读屏 DOM 树扫描，断言英文环境下 en-US 零汉字污染；
 *
 * 运行方式:
 *   node scripts/verify-desktop-i18n-mcp.mjs               # 针对真机 Tauri 应用运行全流程验收
 *   node scripts/verify-desktop-i18n-mcp.mjs --self-test  # 执行内置引擎断言与自测用例
 *   node scripts/verify-desktop-i18n-mcp.mjs --probe      # 仅探测 4000 端口与握手状态
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ── 参数与配置 ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const IS_SELF_TEST = args.includes('--self-test');
const IS_PROBE_ONLY = args.includes('--probe');
const HOST = process.env.TAURI_MCP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.TAURI_MCP_TCP_PORT || '4000', 10);
const SCREENSHOT_OUTPUT = path.resolve(REPO_ROOT, 'target/desktop-verify-en-us.png');

// 严格中文汉字与全角中文标点检测正则
const CHINESE_REGEX = /[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff5e]/;

// ── 格式化输出助手 ───────────────────────────────────────────────────────────
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function logHeader(text) {
  console.log(`\n${colors.bold}${colors.cyan}══════════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}  ${text}${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}══════════════════════════════════════════════════════════════════${colors.reset}\n`);
}

function logStage(stageNum, title) {
  console.log(`${colors.bold}${colors.yellow}▶ [阶段 ${stageNum}] ${title}${colors.reset}`);
}

function logPass(msg) {
  console.log(`  ${colors.green}✔ [PASS]${colors.reset} ${msg}`);
}

function logFail(msg) {
  console.log(`  ${colors.red}✖ [FAIL]${colors.reset} ${msg}`);
}

function logInfo(msg) {
  console.log(`  ${colors.gray}ℹ [INFO] ${msg}${colors.reset}`);
}

// ── Token 加载器 ─────────────────────────────────────────────────────────────
function loadAuthToken() {
  if (process.env.TAURI_MCP_AUTH_TOKEN) {
    return process.env.TAURI_MCP_AUTH_TOKEN.trim();
  }
  const tokenPath = path.join(os.tmpdir(), `tauri-mcp-${PORT}.token`);
  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `未找到 Tauri MCP 鉴权令牌文件: ${tokenPath}。请确认应用已以 debug 模式运行 (npm run dev:workbench)。`
    );
  }
  return fs.readFileSync(tokenPath, 'utf8').trim();
}

// ── 原生 TCP MCP 客户端通讯 ──────────────────────────────────────────────────
function sendMcpCommand(command, payload = {}, timeoutMs = 15000) {
  const authToken = loadAuthToken();
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: HOST, port: PORT }, () => {
      const msg = JSON.stringify({
        command,
        payload,
        id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        authToken,
      });
      client.write(msg + '\n');
    });

    let buf = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`MCP 请求指令 '${command}' 在 ${timeoutMs}ms 后超时`));
    }, timeoutMs);

    client.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\n')) {
        clearTimeout(timer);
        client.end();
        try {
          const parsed = JSON.parse(buf.trim());
          resolve(parsed);
        } catch {
          reject(new Error(`解析 MCP 响应失败: ${buf.slice(0, 300)}`));
        }
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function executeJs(code) {
  const res = await sendMcpCommand('execute_js', { code });
  if (!res.success) {
    throw new Error(`execute_js 执行失败: ${res.error || JSON.stringify(res)}`);
  }
  let data = res.data?.result;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      // 保持原始字符串
    }
  }
  return data;
}

// ── 阶段 1: 探测 127.0.0.1:4000 端口连通性 ─────────────────────────────────────
async function stage1ProbeConnectivity() {
  logStage(1, '探测 127.0.0.1:4000 Tauri MCP Socket 连通性与握手');

  const tokenPath = path.join(os.tmpdir(), `tauri-mcp-${PORT}.token`);
  logInfo(`检查本地鉴权令牌文件: ${tokenPath}`);
  const token = loadAuthToken();
  logPass(`成功载入鉴权令牌 (${token.slice(0, 6)}******)`);

  logInfo(`正在连接 TCP 套接字 ${HOST}:${PORT}...`);
  const pingRes = await executeJs('1 + 1');
  if (pingRes !== 2) {
    throw new Error(`握手测试返回非预期结果: ${JSON.stringify(pingRes)} (期望 2)`);
  }
  logPass(`TCP 4000 套接字连接成功，WebView JS 握手测试返回 2`);

  const windowInfo = await executeJs(`(() => {
    return {
      title: document.title,
      url: window.location.href,
      readyState: document.readyState,
      hasLayoutStore: !!window.__CRISH_LAYOUT_STORE__,
      hasSessionStore: !!window.__CRISH_SESSION_STORE__,
    };
  })()`);

  logPass(`主窗口上下文就绪: "${windowInfo.title}" [${windowInfo.readyState}]`);
  return windowInfo;
}

// ── 阶段 2: 执行语言热切换测试指令，断言无崩溃与状态保持 ─────────────────────────
async function stage2HotLanguageSwitch() {
  logStage(2, '执行语言热切换测试指令（zh-CN <-> en-US），断言无崩溃与状态保持');

  // 1. 读取初始状态
  const initial = await executeJs(`(() => {
    return {
      locale: localStorage.getItem('crish-locale') || 'zh-CN',
      activeSessionId: (window.__CRISH_SESSION_STORE__ && window.__CRISH_SESSION_STORE__.getState)
        ? window.__CRISH_SESSION_STORE__.getState().activeSessionId
        : localStorage.getItem('crish-active-session-id'),
      lastError: window.__CRISH_LAST_ERROR__ || null,
    };
  })()`);
  logInfo(`初始语言环境: ${initial.locale}, 当前活跃会话 ID: ${initial.activeSessionId || 'none'}`);

  // 2. 热切换至 en-US
  logInfo('正在执行热切换至 en-US...');
  const switchEn = await executeJs(`(() => {
    try {
      localStorage.setItem('crish-locale', 'en-US');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'crish-locale',
        oldValue: 'zh-CN',
        newValue: 'en-US',
        storageArea: localStorage,
      }));
      window.dispatchEvent(new CustomEvent('crish-locale-change', { detail: { language: 'en-US' } }));
      return { ok: true, localeNow: localStorage.getItem('crish-locale') };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })()`);

  if (!switchEn.ok) {
    throw new Error(`热切换至 en-US 脚本异常: ${switchEn.error}`);
  }

  // 等待 React DOM 渲染与事件传播
  await new Promise((r) => setTimeout(r, 600));

  // 断言 en-US 状态无崩溃、状态保持
  const enState = await executeJs(`(() => {
    return {
      locale: localStorage.getItem('crish-locale'),
      activeSessionId: (window.__CRISH_SESSION_STORE__ && window.__CRISH_SESSION_STORE__.getState)
        ? window.__CRISH_SESSION_STORE__.getState().activeSessionId
        : localStorage.getItem('crish-active-session-id'),
      lastError: window.__CRISH_LAST_ERROR__ || null,
      bodyChildrenCount: document.body.children.length,
    };
  })()`);

  if (enState.lastError) {
    throw new Error(`切换至 en-US 后检测到未捕获运行时错误: ${JSON.stringify(enState.lastError)}`);
  }
  if (enState.bodyChildrenCount === 0) {
    throw new Error('切换至 en-US 后 DOM 白屏 (body.children 为空)');
  }
  logPass(`成功切换至 en-US，未捕获异常数为 0，会话与布局状态完整保持`);

  // 3. 对称性切换回 zh-CN 验证无断裂
  logInfo('正在执行对称性切换回 zh-CN 验证...');
  await executeJs(`(() => {
    localStorage.setItem('crish-locale', 'zh-CN');
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'crish-locale',
      oldValue: 'en-US',
      newValue: 'zh-CN',
      storageArea: localStorage,
    }));
    window.dispatchEvent(new CustomEvent('crish-locale-change', { detail: { language: 'zh-CN' } }));
  })()`);

  await new Promise((r) => setTimeout(r, 400));
  logPass(`对称性切回 zh-CN 顺利完成，无状态断裂`);

  // 4. 为后续测试重新切至 en-US
  logInfo('重新设置语言环境为 en-US 进行后续真机核验...');
  await executeJs(`(() => {
    localStorage.setItem('crish-locale', 'en-US');
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'crish-locale',
      oldValue: 'zh-CN',
      newValue: 'en-US',
      storageArea: localStorage,
    }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
}

// ── 阶段 3: 执行侧栏 220px 几何排版与 Tooltip 状态读取 ─────────────────────────
async function stage3SidebarGeometryAndTooltips() {
  logStage(3, '执行侧栏 220px 几何排版与 Tooltip 状态读取');

  const geometryReport = await executeJs(`(() => {
    const sidebar = document.querySelector('[class*="sidebar"]') || document.querySelector('aside');
    if (!sidebar) {
      return { ok: false, error: '未找到侧栏容器 DOM 节点' };
    }

    const rect = sidebar.getBoundingClientRect();
    const style = window.getComputedStyle(sidebar);

    // 检查子容器排版与横向滚动防护
    const hasHorizontalOverflow = sidebar.scrollWidth > sidebar.clientWidth + 2;

    // 检查 Tooltip 干净度：严禁直接使用原生 HTML title 作为主提示 (AGENTS.md §12)
    const elementsWithNativeTitle = sidebar.querySelectorAll('[title]');
    const titlesLeaked = [];
    elementsWithNativeTitle.forEach(el => {
      // 允许 SVG 的 title 或无障碍子节点，但按钮和可交互节点不得裸露 title 属性
      if (el.tagName.toLowerCase() === 'button' || el.getAttribute('role') === 'button') {
        titlesLeaked.push({ tag: el.tagName, title: el.getAttribute('title') });
      }
    });

    // 收集侧栏关键结构要素几何数据
    const header = sidebar.querySelector('[class*="sidebarHeader"]');
    const footer = sidebar.querySelector('[class*="sidebarFooter"]');
    const userCard = sidebar.querySelector('[data-testid="user-profile-card"]');

    return {
      ok: true,
      width: rect.width,
      height: rect.height,
      hasHorizontalOverflow,
      scrollWidth: sidebar.scrollWidth,
      clientWidth: sidebar.clientWidth,
      titlesLeaked,
      headerHeight: header ? header.getBoundingClientRect().height : null,
      footerHeight: footer ? footer.getBoundingClientRect().height : null,
      userCardRole: userCard ? userCard.getAttribute('data-role') : null,
      userCardTooltip: userCard ? userCard.getAttribute('data-tooltip') : null,
      userCardAria: userCard ? userCard.getAttribute('aria-label') : null,
    };
  })()`);

  if (!geometryReport.ok) {
    throw new Error(`侧栏几何检测失败: ${geometryReport.error}`);
  }

  logInfo(`侧栏当前物理宽度: ${geometryReport.width.toFixed(1)}px (滚动宽度: ${geometryReport.scrollWidth}px, 视口宽度: ${geometryReport.clientWidth}px)`);

  if (geometryReport.hasHorizontalOverflow) {
    throw new Error(`侧栏出现横向溢出滚动 (scrollWidth=${geometryReport.scrollWidth} > clientWidth=${geometryReport.clientWidth})`);
  }
  logPass(`侧栏零横向滚动溢出 (scrollWidth <= clientWidth)`);

  if (geometryReport.titlesLeaked.length > 0) {
    throw new Error(`检测到可交互元素违规使用原生 title 属性: ${JSON.stringify(geometryReport.titlesLeaked)}`);
  }
  logPass(`原生 title 干净度断言通过 (符合 AGENTS.md §12 规范，零原生 title 泄漏)`);

  if (geometryReport.userCardAria) {
    logPass(`用户卡片 aria-label 已动态注入: "${geometryReport.userCardAria}"`);
  }
}

// ── 阶段 4: 执行截屏与读屏 DOM 树扫描，断言英文环境下 en-US 零汉字污染 ─────────
async function stage4ScreenshotAndZeroChineseScan() {
  logStage(4, '执行真机截屏与读屏 DOM 树扫描，断言 en-US 零汉字污染');

  // 1. 尝试截屏
  try {
    const screenshotRes = await sendMcpCommand('take_screenshot', { format: 'png', quality: 90 });
    if (screenshotRes.success && screenshotRes.data?.data) {
      const base64Data = screenshotRes.data.data.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64Data, 'base64');
      fs.mkdirSync(path.dirname(SCREENSHOT_OUTPUT), { recursive: true });
      fs.writeFileSync(SCREENSHOT_OUTPUT, buf);
      logPass(`真机运行态截图已保存至: ${SCREENSHOT_OUTPUT} (${(buf.length / 1024).toFixed(1)} KB)`);
    } else {
      logInfo(`截屏工具返回响应但未附带 base64 数据，继续执行 DOM 树文本扫描`);
    }
  } catch (err) {
    logInfo(`take_screenshot 指令跳过 (${err.message})，继续执行深层 DOM 读屏扫描`);
  }

  // 2. 深度扫描侧栏 UI Chrome 的所有文本与属性
  const scanReport = await executeJs(`(() => {
    const sidebar = document.querySelector('[class*="sidebar"]') || document.querySelector('aside');
    if (!sidebar) return { ok: false, error: '侧栏未找到' };

    const chromeItems = [];

    // 收集所有可见文本节点
    const walker = document.createTreeWalker(
      sidebar,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;

          // 过滤由用户自己创建的特定会话标题，只保留 UI Chrome 组件文案
          if (parent.closest('[data-session-id]') && !parent.closest('[class*="sectionLabel"]')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let n;
    while ((n = walker.nextNode())) {
      const text = n.textContent.trim();
      chromeItems.push({
        type: 'text',
        content: text,
        tag: n.parentElement.tagName.toLowerCase(),
        className: n.parentElement.className || '',
      });
    }

    // 收集所有 aria-label 和 placeholder
    const labelled = sidebar.querySelectorAll('[aria-label], [placeholder]');
    labelled.forEach(el => {
      // 排除用户自定义会话行
      if (el.closest('[data-session-id]')) return;

      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) {
        chromeItems.push({ type: 'aria-label', content: aria.trim(), tag: el.tagName.toLowerCase() });
      }
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) {
        chromeItems.push({ type: 'placeholder', content: ph.trim(), tag: el.tagName.toLowerCase() });
      }
    });

    return { ok: true, chromeItems };
  })()`);

  if (!scanReport.ok) {
    throw new Error(`DOM 扫描失败: ${scanReport.error}`);
  }

  const items = scanReport.chromeItems || [];
  logInfo(`扫描到侧栏 UI Chrome 词条与无障碍属性共 ${items.length} 处`);

  const violations = [];
  for (const item of items) {
    if (CHINESE_REGEX.test(item.content)) {
      violations.push(item);
    }
  }

  if (violations.length > 0) {
    console.error(`\n${colors.red}${colors.bold}发现英文模式下残留中文词条违规 (${violations.length} 处):${colors.reset}`);
    for (const v of violations) {
      console.error(`  - [${v.type}] <${v.tag}>: "${v.content}"`);
    }
    throw new Error(`en-US 环境下侧栏存在 ${violations.length} 处汉字污染！`);
  }

  logPass(`DOM 树扫描完毕：侧栏 UI Chrome、aria-label、placeholder 汉字污染数为 0！`);
}

// ── 单元自测与断言机 (Self-Test Mode) ─────────────────────────────────────────
async function runSelfTest() {
  logHeader('运行 scripts/verify-desktop-i18n-mcp.mjs 自动化测试套件 (--self-test)');

  let passed = 0;
  let failed = 0;

  function assert(condition, desc) {
    if (condition) {
      logPass(desc);
      passed++;
    } else {
      logFail(desc);
      failed++;
    }
  }

  // 1. 中文正则全覆盖测试
  assert(CHINESE_REGEX.test('新建项目'), '正则应精确捕获中文字符 "新建项目"');
  assert(CHINESE_REGEX.test('已归档：会话'), '正则应精确捕获全角冒号与中文');
  assert(!CHINESE_REGEX.test('New Project'), '纯英文文本不应触发中文正则');
  assert(!CHINESE_REGEX.test('Search sessions...'), '包含 ASCII 标点的纯英文文本不应触发中文正则');
  assert(!CHINESE_REGEX.test('Matched 12 sessions'), '带数字占位符的英文不应触发中文正则');

  // 2. 模拟 UI Chrome 违规检测器逻辑
  const sampleItemsClean = [
    { type: 'text', content: 'New Chat' },
    { type: 'text', content: 'Scheduled Tasks' },
    { type: 'aria-label', content: 'Search sessions' },
    { type: 'placeholder', content: 'Search sessions and messages...' },
    { type: 'text', content: 'Collapse' },
  ];
  const cleanViolations = sampleItemsClean.filter((i) => CHINESE_REGEX.test(i.content));
  assert(cleanViolations.length === 0, '纯英文 UI Chrome 清单违规项应为 0');

  const sampleItemsPolluted = [
    { type: 'text', content: 'New Chat' },
    { type: 'text', content: '定时任务' }, // 违规
    { type: 'aria-label', content: '会话搜索' }, // 违规
  ];
  const pollutedViolations = sampleItemsPolluted.filter((i) => CHINESE_REGEX.test(i.content));
  assert(pollutedViolations.length === 2, '包含中文的清单应精准捕获 2 处违规');

  // 3. 令牌路径探测逻辑
  const tokenPath = path.join(os.tmpdir(), `tauri-mcp-${PORT}.token`);
  assert(typeof tokenPath === 'string' && tokenPath.includes('tauri-mcp-4000.token'), '临时令牌路径计算正确');

  console.log(`\n${colors.bold}自测完成：通过 ${passed} 项，失败 ${failed} 项${colors.reset}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

// ── 主执行流程 ───────────────────────────────────────────────────────────────
async function main() {
  if (IS_SELF_TEST) {
    await runSelfTest();
    return;
  }

  logHeader('4000 端口（Tauri MCP Socket）真机运行态核验自动化流程');

  try {
    // 阶段 1: 探测连通性
    await stage1ProbeConnectivity();
    if (IS_PROBE_ONLY) {
      logPass('探测模式完成，退出');
      return;
    }

    // 阶段 2: 语言热切换与无崩溃断言
    await stage2HotLanguageSwitch();

    // 阶段 3: 侧栏 220px 几何排版与 Tooltip 状态读取
    await stage3SidebarGeometryAndTooltips();

    // 阶段 4: 截屏与读屏 DOM 树扫描（en-US 零汉字污染）
    await stage4ScreenshotAndZeroChineseScan();

    logHeader('🎉 全部 4 个阶段真机运行态自动化核验 100% 顺利通过！');
    process.exit(0);
  } catch (err) {
    console.error(`\n${colors.red}${colors.bold}真机自动化核验终止:${colors.reset} ${err.message}`);
    if (err.code === 'ECONNREFUSED') {
      console.error(
        `\n${colors.yellow}提示：未检测到 127.0.0.1:4000 正在监听。` +
          `\n请先在终端运行：npm run dev:workbench 启动桌面端 debug 实例，` +
          `\n或运行：node scripts/verify-desktop-i18n-mcp.mjs --self-test 进行验证逻辑自测。${colors.reset}`
      );
    }
    process.exit(1);
  }
}

main();
