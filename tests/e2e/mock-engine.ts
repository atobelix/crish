/**
 * L2 mock 引擎 —— e2e/visual 共用的前端 Tauri IPC 替身（T11.1）。
 *
 * ## 设计（对齐 PE-11 T11.1 方案评估 3：E2E-L2 mock 引擎）
 * - 注入方式：`page.addInitScript` 两层脚本（先 config 后引擎），浏览器环境
 *   直接替换 `window.__TAURI_INTERNALS__`（invoke / transformCallback）与
 *   `window.__TAURI_EVENT_PLUGIN_INTERNALS__`（unregisterListener），
 *   对齐 Tauri v2 `@tauri-apps/api/core` / `event` 的真实调用面
 *   （core.js:201-203、event.js:71-83，node_modules 内核对）。
 * - 事件通道：`plugin:event|listen` 注册监听 → `window.__CRISH_E2E__.emit(payload)`
 *   以 `{ event, id, payload }` 形态投递（TauriTransport 懒订阅
 *   `workbench-run-event` 后即收到），模拟 Rust `workbench-run-event` 事件流。
 * - 命令面：内置快照镜像 `BUILTIN_COMMAND_MANIFEST`（registered 子集）；
 *   已知命令走处理器，registered 命令默认返回 null（ok 语义），
 *   未知命令抛「command not found」（missing 语义，与 Tauri 行为一致）。
 * - 有状态命令（config_get/update、save_session_body）持久化到 localStorage
 *   `__crish_mock_store_v1`，`page.reload()` 后状态保留（settings-persist 场景）。
 * - 引擎脚本为自包含字符串（无外部引用），可整体经 addInitScript 注入。
 *
 * ## 场景编排
 * - `core_run_task` 命中后按 `config.runStream` 编排自动推送事件序列
 *   （逐条 setTimeout，`delayMs` 可调；runId/sessionId/sequence 自动补齐），
 *   保证流式中间态可被断言（streaming-render / full-journey）。
 * - `config.runStream.error` 抛 `{ kind, message }`（CoreError 形状）驱动错误路径。
 * - `config.sessions[].events` 作为 `core_read_session_events` 回放源
 *   （session-restore 场景：会话恢复 hydrate）。
 */

import type { Page } from '@playwright/test';
import { BUILTIN_COMMAND_MANIFEST } from '../../apps/crish-desktop/src/api/transport/commandManifest';

/** 事件通道名（与 TauriTransport.RUN_EVENT_CHANNEL 一致） */
export const MOCK_EVENT_CHANNEL = 'workbench-run-event';

/** 引擎持久化 key（localStorage；config 写入、reload 保留） */
export const MOCK_STORE_LS_KEY = '__crish_mock_store_v1';

/** 单页会话内「已种子化」标记（sessionStorage；reload 不重复种子） */
export const MOCK_SEED_FLAG = '__crish_mock_seeded_v1';

/** 引擎暴露给测试的 window 句柄名 */
export const MOCK_HANDLE = '__CRISH_E2E__';

/** mock 引擎注入配置的 window 全局名（先于引擎脚本执行） */
export const MOCK_CONFIG_GLOBAL = '__CRISH_MOCK_CONFIG__';

/** 引擎事件载荷（IPC 顶层平铺 { type, runId, sessionId, sequence, ... }） */
export type MockEvent = Record<string, unknown> & { type: string };

/** 单会话回放源（core_read_session_events） */
export interface MockSessionSource {
  id: string;
  title: string;
  cwd?: string;
  updatedAt?: number | string;
  /** 会话事件回放（restore/hydrate 场景） */
  events?: MockEvent[];
}

/** run 编排（core_run_task 命中后自动推送） */
export interface MockRunStreamConfig {
  events?: MockEvent[];
  /** 逐条间隔（ms），默认 80；流式中间态断言建议 ≥120 */
  delayMs?: number;
  /** core_run_task 直接抛错（CoreError 形状 { kind, message }） */
  error?: { kind: string; message: string };
}

/** mock 引擎配置（JSON 可序列化，经 addInitScript 注入） */
export interface MockEngineConfig {
  /** 会话列表 + 事件回放源 */
  sessions?: MockSessionSource[];
  /** core_run_task 编排 */
  runStream?: MockRunStreamConfig;
  /** get_app_settings 返回（默认含 defaultModel/thinkingLevel） */
  getSettings?: Record<string, unknown>;
  /** list_models 返回 */
  listModels?: unknown[];
  /** get_command_permissions 返回 */
  commandPermissions?: unknown[];
  /** get_providers 返回 */
  providers?: unknown[];
  /** 初始 config_get 值 */
  config?: Record<string, unknown>;
  /** core_get_status 覆盖（默认 engineReady/dbReady=true） */
  status?: Record<string, unknown>;
  /** 首次加载时种子化的 localStorage（sessionStorage 门控，仅一次） */
  localStorage?: Record<string, string>;
  /** 禁用动画/过渡（visual 基线稳定化用） */
  disableAnimations?: boolean;
}

/**
 * 构建引擎注入脚本（自包含 IIFE 字符串）。
 * 运行时读取 `window.__CRISH_MOCK_CONFIG__`（须先注册 config 脚本）。
 */
export function buildMockEngineInitScript(): string {
  const manifestJson = JSON.stringify(BUILTIN_COMMAND_MANIFEST);
  return `(function () {
    'use strict';
    var MANIFEST = ${manifestJson};
    var REGISTERED = {};
    MANIFEST.commands.forEach(function (c) { if (c.registered) REGISTERED[c.name] = true; });

    var cfg = (window['${MOCK_CONFIG_GLOBAL}'] || {});
    var LS_KEY = '${MOCK_STORE_LS_KEY}';
    var store = {};
    try { store = JSON.parse(window.localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { store = {}; }
    function persist() { try { window.localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) {} }

    var callbacks = {};
    var cbSeq = 0;
    var listeners = {};
    var emitSeq = 0;

    function transformCallback(fn, once) {
      cbSeq += 1;
      callbacks[cbSeq] = { fn: fn, once: !!once };
      return cbSeq;
    }
    function unregisterCallback(id) { delete callbacks[id]; }

    function emitEvent(name, payload) {
      emitSeq += 1;
      window['${MOCK_HANDLE}'].state.emitted += 1;
      var ids = (listeners[name] || []).slice();
      for (var i = 0; i < ids.length; i++) {
        var entry = callbacks[ids[i]];
        if (!entry) continue;
        if (entry.once) delete callbacks[ids[i]];
        try { entry.fn({ event: name, id: emitSeq, payload: payload }); } catch (e) {}
      }
    }

    // ── 最小 markdown → HTML（Rust md_render 的浏览器替身；确定性优先）──
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function inlineMd(s) {
      return s
        .replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
        .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
    }
    function renderMarkdownToHtml(text) {
      var src = String(text == null ? '' : text).replace(/\\r\\n/g, '\\n');
      var out = [];
      var lines = src.split('\\n');
      var i = 0;
      var inFence = false;
      var fenceBuf = [];
      var fenceLang = '';
      while (i < lines.length) {
        var line = lines[i];
        var fence = /^\\s*\\\`\\\`\\\`(\\w*)/.exec(line);
        if (fence) {
          if (inFence) {
            out.push('<pre><code' + (fenceLang ? ' class="language-' + esc(fenceLang) + '"' : '') + '>' + esc(fenceBuf.join('\\n')) + '</code></pre>');
            fenceBuf = []; inFence = false; fenceLang = '';
          } else {
            inFence = true; fenceLang = fence[1] || '';
          }
          i += 1;
          continue;
        }
        if (inFence) { fenceBuf.push(line); i += 1; continue; }
        var head = /^(#{1,6})\\s+(.*)$/.exec(line);
        if (head) {
          out.push('<h' + head[1].length + '>' + inlineMd(head[2]) + '</h' + head[1].length + '>');
          i += 1;
          continue;
        }
        if (/^\\s*\\|/.test(line) && i + 1 < lines.length && /^\\s*\\|?[\\s:|-]+\\|/.test(lines[i + 1])) {
          var headerRow = line.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(function (c) { return c.trim(); });
          var body = [];
          i += 2;
          while (i < lines.length && /^\\s*\\|/.test(lines[i])) {
            body.push(lines[i].trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(function (c) { return c.trim(); }));
            i += 1;
          }
          var rows = [headerRow].concat(body);
          out.push('<table><thead><tr>' + headerRow.map(function (c) { return '<th>' + inlineMd(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
            body.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inlineMd(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>');
          continue;
        }
        if (/^\\s*-\\s+/.test(line)) {
          var list = [];
          while (i < lines.length && /^\\s*-\\s+/.test(lines[i])) {
            list.push('<li>' + inlineMd(lines[i].replace(/^\\s*-\\s+/, '')) + '</li>');
            i += 1;
          }
          out.push('<ul>' + list.join('') + '</ul>');
          continue;
        }
        if (/^\\s*\\d+\\.\\s+/.test(line)) {
          var ol = [];
          while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])) {
            ol.push('<li>' + inlineMd(lines[i].replace(/^\\s*\\d+\\.\\s+/, '')) + '</li>');
            i += 1;
          }
          out.push('<ol>' + ol.join('') + '</ol>');
          continue;
        }
        if (line.trim() === '') { i += 1; continue; }
        var para = [];
        while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6})\\s+/.test(lines[i]) && !/^\\s*\\\`\\\`\\\`/.test(lines[i])) {
          para.push(lines[i]);
          i += 1;
        }
        out.push('<p>' + inlineMd(para.join(' ')) + '</p>');
      }
      if (inFence) {
        out.push('<pre><code' + (fenceLang ? ' class="language-' + esc(fenceLang) + '"' : '') + '>' + esc(fenceBuf.join('\\n')) + '</code></pre>');
      }
      return out.join('\\n');
    }

    // ── 命令处理器 ──
    function getConfigAll() {
      var base = (cfg.config || {});
      var merged = {};
      for (var k in base) merged[k] = base[k];
      var saved = (store.config || {});
      for (var j in saved) merged[j] = saved[j];
      return merged;
    }
    function applyConfigUpdate(args) {
      var patch = (args && typeof args === 'object') ? args : {};
      var cur = (store.config || {});
      for (var k in patch) {
        if (k === 'type' || k === 'apiKey') continue;
        cur[k] = patch[k];
      }
      store.config = cur;
      persist();
      return cur;
    }
    function runTask(args) {
      var state = window['${MOCK_HANDLE}'].state;
      state.lastRun = {
        runId: args && args.runId, sessionId: args && args.sessionId,
        prompt: args && args.prompt, permissionMode: args && args.permissionMode,
        args: args || {}
      };
      state.runCount += 1;
      var run = (cfg.runStream || {});
      if (run.error) throw run.error;
      var events = run.events || [];
      var delay = (typeof run.delayMs === 'number' && run.delayMs >= 0) ? run.delayMs : 80;
      var seq = 0;
      events.forEach(function (ev, i) {
        setTimeout(function () {
          var e = {};
          for (var k in ev) e[k] = ev[k];
          if (e.runId === undefined) e.runId = args && args.runId;
          if (e.sessionId === undefined) e.sessionId = args && args.sessionId;
          if (e.sequence === undefined) e.sequence = ++seq;
          emitEvent('${MOCK_EVENT_CHANNEL}', e);
        }, delay * (i + 1));
      });
      return { runId: args && args.runId, sessionId: args && args.sessionId };
    }
    function readSessionEvents(args) {
      var sid = args && args.sessionId;
      var sessions = cfg.sessions || [];
      var src = null;
      for (var i = 0; i < sessions.length; i++) {
        if (sessions[i].id === sid) { src = sessions[i]; break; }
      }
      var events = (src && src.events) || [];
      return { events: events, nextAfterSequence: events.length, hasMore: false };
    }
    function listSessions() {
      var sessions = cfg.sessions || [];
      var now = Date.now();
      return sessions.map(function (s) {
        var out = { id: s.id, sessionId: s.id, title: s.title };
        if (s.cwd) out.cwd = s.cwd;
        out.updatedAt = s.updatedAt !== undefined ? s.updatedAt : now;
        return out;
      });
    }

    var handlers = {
      'core_list_commands': function () { return MANIFEST; },
      'core_get_status': function () {
        if (cfg.status) return cfg.status;
        // 默认引擎持钥态（E1.1 终态语义：Rust 真源持有 provider/model/hasApiKey，
        // 前端无本地密钥也可发送；hasApiKey=true 消除「待同步」提示）
        return {
          engineReady: true,
          dbReady: true,
          initialized: true,
          providerId: 'mock-openai',
          model: 'gpt-4o',
          hasApiKey: true,
        };
      },
      'core_run_task': runTask,
      'core_run_control': function () { return null; },
      'core_cancel_run': function () { return null; },
      'core_approve_tool': function () { return null; },
      'core_deny_tool': function () { return null; },
      'config_get': function (args) {
        var all = getConfigAll();
        var key = args && args.key;
        return key ? (all[key] !== undefined ? all[key] : null) : all;
      },
      'config_update': applyConfigUpdate,
      'config_set': applyConfigUpdate,
      'config_secret_set': function () { return null; },
      'config_secret_get': function () { return null; },
      'config_secret_has': function () { return false; },
      'config_secret_clear': function () { return null; },
      'config_profile_apply': function () { return null; },
      'config_secret_reveal': function () { return null; },
      'list_sessions': listSessions,
      'core_read_session_events': readSessionEvents,
      'core_read_run_events': function (args) {
        var sid = args && args.sessionId;
        return readSessionEvents({ sessionId: sid });
      },
      'load_session_body': function (args) {
        var sid = args && args.sessionId;
        var bodies = (store.sessionBody || {});
        return bodies[sid] || [];
      },
      'save_session_body': function (args) {
        var sid = args && args.sessionId;
        var msgs = args && args.messages;
        if (sid && Array.isArray(msgs)) {
          if (!store.sessionBody) store.sessionBody = {};
          store.sessionBody[sid] = msgs;
          persist();
        }
        return null;
      },
      'delete_session': function (args) {
        var sid = args && args.sessionId;
        if (sid && store.sessionBody) { delete store.sessionBody[sid]; persist(); }
        return null;
      },
      'core_get_run_snapshot': function () { return { snapshot: null }; },
      'md_render': function (args) { return renderMarkdownToHtml(args && args.text); },
      'md_render_batch': function (args) {
        var texts = (args && args.texts) || [];
        return texts.map(function (t) { return renderMarkdownToHtml(t); });
      },
      'core_md_render': function (args) { return renderMarkdownToHtml(args && args.text); },
      'core_md_render_batch': function (args) {
        var texts = (args && args.texts) || [];
        return texts.map(function (t) { return renderMarkdownToHtml(t); });
      },
      'core_md_render_stream': function (args) { return renderMarkdownToHtml(args && args.text); },
      'core_highlight_code': function (args) { return { html: esc(args && args.code || '') }; },
      'core_md_clear_cache': function () { return null; },
      'get_app_settings': function () {
        return cfg.getSettings || { defaultModel: 'gpt-4o', defaultThinkingLevel: 'medium' };
      },
      'list_models': function () {
        return cfg.listModels || [{ id: 'gpt-4o', name: 'GPT-4o' }];
      },
      'get_command_permissions': function () { return cfg.commandPermissions || []; },
      'get_providers': function () { return cfg.providers || []; },
    };

    function handleCommand(cmd, args) {
      if (cmd === 'plugin:event|listen') {
        var event = args && args.event;
        var handlerId = args && args.handler;
        if (event && handlerId) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(handlerId);
        }
        cbSeq += 1;
        return cbSeq;
      }
      if (cmd === 'plugin:event|unlisten') { return null; }
      if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') { return null; }
      var h = handlers[cmd];
      if (h) return h(args);
      if (REGISTERED[cmd] === true) return null;
      throw new Error('command ' + cmd + ' not found');
    }

    // ── 环境安装 ──
    window.__TAURI_INTERNALS__ = {
      invoke: function (cmd, args, options) {
        return Promise.resolve().then(function () { return handleCommand(cmd, args); });
      },
      transformCallback: transformCallback,
      unregisterCallback: unregisterCallback,
      convertFileSrc: function (p) { return p; },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: function () {},
    };
    window['${MOCK_HANDLE}'] = {
      config: cfg,
      state: { lastRun: null, runCount: 0, emitted: 0 },
      emit: function (payload) { emitEvent('${MOCK_EVENT_CHANNEL}', payload); },
      setConfig: function (next) { cfg = next || {}; },
      getState: function () { return window['${MOCK_HANDLE}'].state; },
      registeredCommands: Object.keys(REGISTERED),
    };

    // ── 种子化（sessionStorage 门控：同一标签页仅种子一次，reload 保留用户写入）──
    var seeded = false;
    try { seeded = window.sessionStorage.getItem('${MOCK_SEED_FLAG}') === '1'; } catch (e) {}
    if (!seeded && cfg.localStorage) {
      for (var key in cfg.localStorage) {
        try { window.localStorage.setItem(key, cfg.localStorage[key]); } catch (e) {}
      }
      try { window.sessionStorage.setItem('${MOCK_SEED_FLAG}', '1'); } catch (e) {}
    }
    try {
      if (!window.localStorage.getItem('crish_first_run_done_v1')) {
        window.localStorage.setItem('crish_first_run_done_v1', '1');
      }
    } catch (e) {}
    if (cfg.disableAnimations) {
      var style = document.createElement('style');
      style.textContent = '*{animation:none!important;transition:none!important}';
      document.head.appendChild(style);
    }
  })();`;
}

/**
 * 安装 mock 引擎到页面（两层 addInitScript：config → 引擎）。
 * 必须在 `page.goto()` 之前调用；`page.reload()` 自动重装（引擎幂等重建）。
 */
export async function installMockEngine(
  page: Page,
  config: MockEngineConfig = {}
): Promise<void> {
  // 注意：addInitScript 序列化函数时**不携带外层作用域**，
  // 闭包引用（MOCK_CONFIG_GLOBAL 等）必须内联为字面量。
  await page.addInitScript((cfg) => {
    (window as any)['__CRISH_MOCK_CONFIG__'] = cfg;
  }, config);
  await page.addInitScript(buildMockEngineInitScript());
}

/** 测试句柄：手动推送一条引擎事件（流式编排补充用） */
export async function emitEngineEvent(
  page: Page,
  payload: MockEvent
): Promise<void> {
  await page.evaluate(
    ([handle, ev]) => {
      (window as any)[handle].emit(ev);
    },
    [MOCK_HANDLE, payload]
  );
}

/** 读取引擎内部状态（lastRun / runCount 等） */
export async function engineState(
  page: Page
): Promise<Record<string, unknown>> {
  return page.evaluate(
    (handle) => (window as any)[handle].getState(),
    MOCK_HANDLE
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 场景编排 fixture（事件序列真源：chat-bridge/EventRouter 协议）
// ────────────────────────────────────────────────────────────────────────────

/** 完整旅程：启动→新建会话→发送→流式→工具调用→收口 */
export function fullJourneyRunEvents(): MockEvent[] {
  return [
    { type: 'message-start' },
    {
      type: 'message-delta',
      block: { type: 'text', text: '我来帮你查看当前目录。' },
    },
    {
      type: 'message-delta',
      block: { type: 'text', text: '先执行 pwd 确认位置。' },
    },
    {
      type: 'tool-start',
      id: 'tool-1',
      name: 'bash',
      args: 'pwd',
      explanation: '查看当前目录',
    },
    {
      type: 'tool-end',
      result: { id: 'tool-1', output: '/workspace/crish', isError: false },
    },
    {
      type: 'message-delta',
      block: { type: 'text', text: '目录确认完毕，共 3 个文件。' },
    },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content:
          '我来帮你查看当前目录。先执行 pwd 确认位置。目录确认完毕，共 3 个文件。',
        blocks: [
          {
            type: 'text',
            text: '我来帮你查看当前目录。先执行 pwd 确认位置。目录确认完毕，共 3 个文件。',
          },
        ],
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

/** 流式渲染专项：未闭合 fence（软渲染态）+ 完成态收敛 */
export function fenceRunEvents(): MockEvent[] {
  return [
    { type: 'message-start' },
    { type: 'message-delta', block: { type: 'text', text: '示例代码：\n' } },
    {
      type: 'message-delta',
      block: { type: 'text', text: '```ts\nconst x = 1;\n' },
    },
    {
      type: 'message-delta',
      block: { type: 'text', text: 'const y = x + 1;\n' },
    },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: '示例代码：\n```ts\nconst x = 1;\nconst y = x + 1;\n```',
        blocks: [
          {
            type: 'text',
            text: '示例代码：\n```ts\nconst x = 1;\nconst y = x + 1;\n```',
          },
        ],
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

/** 表格渲染 fixture（visual + streaming-render 复用） */
export function tableRunEvents(): MockEvent[] {
  return [
    { type: 'message-start' },
    {
      type: 'message-delta',
      block: {
        type: 'text',
        text: '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
      },
    },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
        blocks: [
          {
            type: 'text',
            text: '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
          },
        ],
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

/** 错误路径：core_run_task 拒绝 → 前端提示 */
export function errorRunConfig(): { error: { kind: string; message: string } } {
  return {
    error: {
      kind: 'ProviderUnavailable',
      message: '模型服务不可用（mock 注入错误）',
    },
  };
}

/** 会话恢复 fixture：3 会话（含 1 个 in-flight 中断会话，对齐 PE-08 T08.6） */
export function restoreSessions(): MockSessionSource[] {
  return [
    {
      id: 'sess-restore-1',
      title: '规划 Rust 迁移',
      updatedAt: Date.now() - 3_600_000,
      events: [
        { type: 'message-start' },
        {
          type: 'message-delta',
          block: { type: 'text', text: '迁移方案已整理完毕。' },
        },
        {
          type: 'message-end',
          message: {
            role: 'assistant',
            content: '迁移方案已整理完毕。',
            blocks: [{ type: 'text', text: '迁移方案已整理完毕。' }],
          },
        },
        { type: 'run-terminal', terminal: 'completed' },
      ],
    },
    {
      id: 'sess-restore-2',
      title: '修复 CI 报错',
      updatedAt: Date.now() - 7_200_000,
      events: [
        { type: 'message-start' },
        {
          type: 'message-delta',
          block: { type: 'text', text: 'CI 失败原因已定位。' },
        },
        {
          type: 'tool-start',
          id: 'tool-r2-1',
          name: 'bash',
          args: 'cargo test',
          explanation: '复现 CI 失败',
        },
        {
          type: 'tool-end',
          result: {
            id: 'tool-r2-1',
            output: '2 failed; 1 passed',
            isError: false,
          },
        },
        {
          type: 'message-end',
          message: {
            role: 'assistant',
            content: 'CI 失败原因已定位。',
            blocks: [{ type: 'text', text: 'CI 失败原因已定位。' }],
          },
        },
        { type: 'run-terminal', terminal: 'completed' },
      ],
    },
    {
      // in-flight：事件流无 run-terminal → 恢复为 interrupted（PE-08 T08.6 语义）
      id: 'sess-restore-3',
      title: '长会话（中断未收口）',
      updatedAt: Date.now() - 86_400_000,
      events: [
        { type: 'message-start' },
        {
          type: 'message-delta',
          block: { type: 'text', text: '开始处理第 1 步…' },
        },
        {
          type: 'tool-start',
          id: 'tool-r3-1',
          name: 'bash',
          args: 'npm run build',
          explanation: '构建验证',
        },
        { type: 'message-delta', block: { type: 'text', text: '构建进行中…' } },
      ],
    },
  ];
}

/** 会话恢复所需的 localStorage 索引种子（crish_session_index_v1 真源 key） */
export function restoreSessionIndexSeed(): Record<string, string> {
  const sessions = restoreSessions();
  return {
    crish_session_index_v1: JSON.stringify(
      sessions.map((s, i) => ({
        id: s.id,
        title: s.title,
        folder: '常规会话',
        isPinned: false,
        isArchived: false,
        timestamp: '',
        updatedAt:
          typeof s.updatedAt === 'number' ? s.updatedAt : Date.now() - i,
        messageCount: 0,
      }))
    ),
    crish_folder_order_v1: JSON.stringify(['常规会话']),
  };
}
