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
import type { ModelsCatalogSnapshot } from '../../apps/crish-desktop/src/api/modelsCatalogTypes';

/** 事件通道名（与 TauriTransport.RUN_EVENT_CHANNEL 一致） */
const MOCK_EVENT_CHANNEL = 'workbench-run-event';

/** 引擎持久化 key（localStorage；config 写入、reload 保留） */
const MOCK_STORE_LS_KEY = '__crish_mock_store_v1';

/** 单页会话内「已种子化」标记（sessionStorage；reload 不重复种子） */
const MOCK_SEED_FLAG = '__crish_mock_seeded_v1';

/** 引擎暴露给测试的 window 句柄名 */
export const MOCK_HANDLE = '__CRISH_E2E__';

/** mock 引擎注入配置的 window 全局名（先于引擎脚本执行） */
const MOCK_CONFIG_GLOBAL = '__CRISH_MOCK_CONFIG__';

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
  /** 覆盖单个事件的相邻间隔（ms），用于精确构造可观测的流式边界。 */
  eventDelaysMs?: number[];
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
  /** get_providers 返回 */
  providers?: unknown[];
  /** 模型配置读取回执；默认提供已配置的 mock 模型 */
  modelsCatalog?: ModelsCatalogSnapshot;
  /** 初始 config_get 值 */
  config?: Record<string, unknown>;
  /** core_get_status 覆盖（默认 engineReady/dbReady=true） */
  status?: Record<string, unknown>;
  /** 首次加载时种子化的 localStorage（sessionStorage 门控，仅一次） */
  localStorage?: Record<string, string>;
  /** 禁用动画/过渡（visual 基线稳定化用） */
  disableAnimations?: boolean;
}

const DEFAULT_MODELS_CATALOG: ModelsCatalogSnapshot = {
  path: 'C:/e2e/models.yaml',
  content: '',
  revision: 'e2e-model-catalog-v1',
  template: '',
  credentialStates: {
    'mock-openai': { hasKey: true, apiKeyLast4: 'mock' },
  },
  tree: {
    version: 2,
    activeModel: { providerId: 'mock-openai', modelId: 'gpt-4o' },
    providers: {
      'mock-openai': {
        displayName: 'Mock OpenAI',
        protocol: 'openai/chat',
        enabled: true,
        stream: true,
        models: [
          {
            id: 'gpt-4o',
            displayName: 'GPT-4o',
            enabled: true,
            supportsTools: true,
            modalities: { input: ['text'], output: ['text'] },
          },
        ],
      },
    },
  },
};

const DEFAULT_CAPABILITY_DICTIONARY = {
  version: 1,
  entries: [{ provider: 'mock-openai', model: 'gpt-4o' }],
};

/**
 * 构建引擎注入脚本（自包含 IIFE 字符串）。
 * 运行时读取 `window.__CRISH_MOCK_CONFIG__`（须先注册 config 脚本）。
 */
function buildMockEngineInitScript(): string {
  const manifestJson = JSON.stringify(BUILTIN_COMMAND_MANIFEST);
  const defaultModelsCatalogJson = JSON.stringify(DEFAULT_MODELS_CATALOG);
  return `(function () {
    'use strict';
    var MANIFEST = ${manifestJson};
    var DEFAULT_MODELS_CATALOG = ${defaultModelsCatalogJson};
    var DEFAULT_CAPABILITY_DICTIONARY = ${JSON.stringify(DEFAULT_CAPABILITY_DICTIONARY)};
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
      var state = window['${MOCK_HANDLE}'].state;
      state.emitted += 1;
      state.lastEvent = payload;
      state.eventHistory.push(payload);
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
          var separatorCells = lines[i + 1].trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(function (c) { return c.trim(); });
          var alignments = separatorCells.map(function (c) {
            if (c.charAt(0) === ':' && c.charAt(c.length - 1) === ':') return 'center';
            if (c.charAt(c.length - 1) === ':') return 'right';
            return 'left';
          });
          var alignAttr = function (index) {
            var align = alignments[index] || 'left';
            return align === 'left' ? '' : ' style="text-align:' + align + '"';
          };
          var body = [];
          i += 2;
          while (i < lines.length && /^\\s*\\|/.test(lines[i])) {
            body.push(lines[i].trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(function (c) { return c.trim(); }));
            i += 1;
          }
          var rows = [headerRow].concat(body);
          out.push('<table><thead><tr>' + headerRow.map(function (c, index) { return '<th' + alignAttr(index) + '>' + inlineMd(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
            body.map(function (r) { return '<tr>' + r.map(function (c, index) { return '<td' + alignAttr(index) + '>' + inlineMd(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>');
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
    function runTask(request) {
      var args = request && request.options && typeof request.options === 'object'
        ? request.options
        : {};
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
      var elapsed = 0;
      events.forEach(function (ev, i) {
        var eventDelay = Array.isArray(run.eventDelaysMs) && typeof run.eventDelaysMs[i] === 'number'
          ? Math.max(0, run.eventDelaysMs[i])
          : delay;
        elapsed += eventDelay;
        setTimeout(function () {
          var e = {};
          for (var k in ev) e[k] = ev[k];
          if (e.runId === undefined) e.runId = args && args.runId;
          if (e.sessionId === undefined) e.sessionId = args && args.sessionId;
          if (e.sequence === undefined) e.sequence = ++seq;
          emitEvent('${MOCK_EVENT_CHANNEL}', e);
        }, elapsed);
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
      'workbench_activate_default_workspace': function () {
        // 启动工作区门闩：Rust 真实命令返回已登记默认根；mock 提供稳定根，
        // 避免 workspaceAccessGate 以 null 启动而阻断 core_run_task。
        return { path: 'C:/e2e/workspace' };
      },
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
      'get_providers': function () { return cfg.providers || []; },
      'workbench_read_models_yaml': function () {
        return cfg.modelsCatalog || DEFAULT_MODELS_CATALOG;
      },
      'workbench_read_capability_dictionary': function () {
        return cfg.capabilityDictionary || DEFAULT_CAPABILITY_DICTIONARY;
      },
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
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
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
      state: { lastRun: null, runCount: 0, emitted: 0, lastEvent: null, eventHistory: [] },
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
async function emitEngineEvent(page: Page, payload: MockEvent): Promise<void> {
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
    {
      type: 'message-delta',
      block: {
        type: 'text',
        text: '# 流式 Markdown\n\n- **列表项**\n\n示例代码：\n',
      },
    },
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
        content:
          '# 流式 Markdown\n\n- **列表项**\n\n示例代码：\n```ts\nconst x = 1;\nconst y = x + 1;\n```',
        blocks: [
          {
            type: 'text',
            text: '# 流式 Markdown\n\n- **列表项**\n\n示例代码：\n```ts\nconst x = 1;\nconst y = x + 1;\n```',
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

/** 表格逐行流式 fixture：表头和数据行分 delta 到达。 */
export function streamingTableRunEvents(): MockEvent[] {
  const content =
    '| 任务编号 | 任务名称 |\n| --- | :---: |\n| TASK-001 | **需求调研** |\n| TASK-002 | 原型设计 |\n表格后说明：**实时生成文字**';
  return [
    { type: 'message-start' },
    {
      type: 'message-delta',
      block: { type: 'text', text: '| 任务编号 | 任务名称 |\n' },
    },
    {
      type: 'message-delta',
      block: { type: 'text', text: '| --- | :---: |\n' },
    },
    {
      type: 'message-delta',
      block: { type: 'text', text: '| TASK-001 | **需求调研** |\n' },
    },
    {
      type: 'message-delta',
      block: { type: 'text', text: '| TASK-002 | 原型设计 |' },
    },
    {
      type: 'message-delta',
      block: { type: 'text', text: '\n表格后说明：**实时生成文字**' },
    },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content,
        blocks: [{ type: 'text', text: content }],
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

function appendPerfToolEvents(events: MockEvent[], index: number): void {
  const toolId = `perf-tool-${index}`;
  const call = {
    id: toolId,
    toolName: index % 2 === 0 ? 'shell_command' : 'read_file',
    summary: `性能压测工具 ${index}`,
    input: { command: `echo step-${index}` },
    category: 'terminal' as const,
    concurrency: 'sequential' as const,
  };
  events.push(
    {
      type: 'tool-batch-start',
      sessionId: 's',
      batchId: `batch-${index}`,
      timestamp: `t${index}`,
      summary: `执行第 ${index} 步`,
      calls: [call],
    },
    {
      type: 'tool-start',
      sessionId: 's',
      batchId: `batch-${index}`,
      timestamp: `t${index}`,
      call,
    },
    toolUpdateEvent(
      { text: `第 ${index} 步执行中…`, metadata: { kind: 'tool-progress' } },
      { timestamp: `t${index}.1` }
    ),
    {
      type: 'tool-end',
      sessionId: 's',
      batchId: `batch-${index}`,
      timestamp: `t${index}.2`,
      result: {
        id: toolId,
        toolName: call.toolName,
        output: { text: `第 ${index} 步完成` },
        isError: false,
        durationMs: 100,
      },
    },
    {
      type: 'tool-batch-end',
      sessionId: 's',
      batchId: `batch-${index}`,
      timestamp: `t${index}.3`,
      calls: [
        {
          id: toolId,
          toolName: call.toolName,
          output: { text: `第 ${index} 步完成` },
          isError: false,
          durationMs: 100,
        },
      ],
    }
  );
}

/**
 * 性能压测 fixture（08-detail 6.3，T5.2）：100KB 文本 + 40 条文本增量 + 20 工具事件。
 * - 全文等分为 40 条 message-delta，不重叠、不拼入额外文本；
 * - 20 个工具 start/update/end 分散穿插，压工具区 timeline 重建；
 * - delayMs=0~1 压榨渲染管线（mock 引擎逐条 setTimeout 投递）。
 */
export function bigRunEvents(): MockEvent[] {
  const text =
    '## 性能压测流式输出\n' +
    '- 目标：100KB 级文本流式渲染 + 20 工具事件交错\n' +
    '- 锚点词：吞吐基线 / 延迟基线 / 帧预算 / 完成收敛\n\n' +
    '正文内容用于撑满文本体积：' +
    Array.from(
      { length: 120 },
      (_, i) =>
        `段落 ${i}：流式渲染管线在 rAF 帧预算内增量写出，` +
        `占位行与总结标题在完成态统一剥离。标记词 marker-${i}。\n`
    ).join('') +
    '\n## 本轮总结\n' +
    '流式增量渲染完成，等待收口。';
  // 撑到 100KB
  let body = text;
  while (body.length < 100 * 1024) {
    body += `\n补充段落（${body.length}）：性能压测文本填充，用于验证增量渲染的线性成本边界。`;
  }

  const events: MockEvent[] = [{ type: 'message-start' }];
  const chunkCount = 40;
  let nextToolIndex = 0;
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = Math.floor((chunkIndex * body.length) / chunkCount);
    const end = Math.floor(((chunkIndex + 1) * body.length) / chunkCount);
    events.push({
      type: 'message-delta',
      block: { type: 'text', text: body.slice(start, end) },
    });

    const toolsAfterThisChunk = Math.floor(
      ((chunkIndex + 1) * 20) / chunkCount
    );
    while (nextToolIndex < toolsAfterThisChunk) {
      appendPerfToolEvents(events, nextToolIndex);
      nextToolIndex += 1;
    }
  }
  events.push(
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: body,
        blocks: [{ type: 'text', text: body }],
      },
    },
    { type: 'run-terminal', terminal: 'completed' }
  );
  return events;
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
        {
          type: 'message-end',
          message: { role: 'user', content: '规划 Rust 迁移' },
        },
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
        {
          type: 'message-end',
          message: { role: 'user', content: '修复 CI 报错' },
        },
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
        {
          type: 'message-end',
          message: { role: 'user', content: '长会话（中断未收口）' },
        },
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

// ────────────────────────────────────────────────────────────────────────────
// 缓存 fixture（P6 §3.5.1，T-45；事件形状供 T-48 cache-telemetry.spec.ts 消费）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 带缓存 usage 的完整旅程 fixture（P6 §3.5.1，T-45）。
 *
 * 事件编排：message-start → message-delta → message-end（携带
 * `message.metadata.usage`，ProviderUsage camelCase 挂载点，Included 形态：
 * promptTokens 已含缓存读）→ cache-stats-updated（会话级统计快照）→
 * run-terminal（结束事件后不再发送数据事件）。
 *
 * 命中率断言口径（P6 §3.5.1 / C9）：hitRate = cacheReadTokens / inputTotal，
 * inputTotal = miss + read + write；本 fixture 为 Included 形态，
 * inputTotal = promptTokens = 12000 → 75%（9000/12000）。
 *
 * 事件形状清单（T-48 消费面，camelCase）：
 * - `message-end.message.metadata.usage`：
 *   `{ promptTokens: 12000, completionTokens: 400, cacheReadTokens: 9000,
 *     cacheWriteTokens: 500, reasoningTokens: 60 }`
 * - `cache-stats-updated`（runId/sessionId/sequence 由引擎自动补齐）：
 *   `{ type: 'cache-stats-updated', timestamp, stats: { promptTokens,
 *     completionTokens, totalTokens, cacheReadTokens, cacheWriteTokens,
 *     cacheMissTokens, sampleCount, hitRatio, writeRatio } }`
 */
export function cacheUsageRunEvents(): MockEvent[] {
  return [
    { type: 'message-start' },
    {
      type: 'message-delta',
      block: { type: 'text', text: '本次运行命中缓存：读取 9000 缓存 token。' },
    },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: '本次运行命中缓存：读取 9000 缓存 token。',
        blocks: [
          {
            type: 'text',
            text: '本次运行命中缓存：读取 9000 缓存 token。',
          },
        ],
        metadata: {
          usage: {
            promptTokens: 12000,
            completionTokens: 400,
            cacheReadTokens: 9000,
            cacheWriteTokens: 500,
            reasoningTokens: 60,
          },
        },
      },
    },
    {
      type: 'cache-stats-updated',
      timestamp: '2026-08-03T00:00:00.000Z',
      stats: {
        promptTokens: 12000,
        completionTokens: 400,
        totalTokens: 12400,
        cacheReadTokens: 9000,
        cacheWriteTokens: 500,
        cacheMissTokens: 2500,
        sampleCount: 1,
        hitRatio: 0.75,
        writeRatio: 500 / 12000,
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

/**
 * 无 cache 字段的老形态 run fixture（P6 §3.5.1，T-45）：
 * message-end 不携带 metadata.usage、无 cache-stats-updated 事件。
 * 兼容性断言：渲染层不得出现徽标、不得显示 0% 误导（C15 null 语义）。
 */
export function legacyNoUsageRunEvents(): MockEvent[] {
  return [
    { type: 'message-start' },
    {
      type: 'message-delta',
      block: { type: 'text', text: '老形态消息：不携带缓存计量字段。' },
    },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: '老形态消息：不携带缓存计量字段。',
        blocks: [
          {
            type: 'text',
            text: '老形态消息：不携带缓存计量字段。',
          },
        ],
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

/**
 * 命中率边界 fixture（e2e 用例④，P6 §3.5.1）：
 * usage 存在但 cacheReadTokens 确为 0（厂商已上报、确为未命中）——
 * 与「未上报 → null → 隐藏」必须可区分（C15），渲染层应显示
 * 「未命中」态而非 0% 误导（文案细节归 P5，P6 只钉徽标行为）。
 */
export function zeroCacheReadRunEvents(): MockEvent[] {
  return [
    { type: 'message-start' },
    {
      type: 'message-delta',
      block: { type: 'text', text: '本次运行未命中缓存。' },
    },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: '本次运行未命中缓存。',
        blocks: [{ type: 'text', text: '本次运行未命中缓存。' }],
        metadata: {
          usage: {
            promptTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

/**
 * 构造 cache-stats-updated 事件（RunCacheStats camelCase，
 * shared-types/events.ts:214 契约；timestamp 缺省注入当前时间，
 * runId/sessionId/sequence 由引擎自动补齐）。
 * 供 T-48 cache-telemetry.spec.ts 组合多 run 命中率上升等场景复用。
 */
function cacheStatsUpdatedEvent(stats: Record<string, unknown>): MockEvent {
  return {
    type: 'cache-stats-updated',
    timestamp: new Date().toISOString(),
    stats,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 工具流式 fixture（TOOLS-01 S1 §3.1.5；tool-streaming.spec.ts 消费）
// 时序契约：tool-batch-start → (tool-start → tool-update* → tool-end)* →
// tool-batch-end；ToolUpdate 载荷形状 { sessionId, batchId, toolCallId,
// update: { text?, json?, metadata? }, timestamp }，metadata.kind 字面量
// tool-progress / tool-args-delta / content-blocks（content-blocks 预留）。
// runId/sessionId/sequence 由引擎自动补齐。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 构造 tool-update 事件（契约形状；缺 timestamp/sessionId 即宽容形态，
 * 走 eventParser 宽容归一器兜底）。供工具流式 spec 组合逐块进度序列复用。
 */
function toolUpdateEvent(
  update: Record<string, unknown>,
  opts: { batchId?: string; toolCallId?: string; timestamp?: string } = {}
): MockEvent {
  return {
    type: 'tool-update',
    batchId: opts.batchId ?? 'batch-s1',
    toolCallId: opts.toolCallId ?? 'tool-s1',
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    update,
  };
}

/**
 * 工具流式完整旅程（严格契约形状：sessionId/batchId/timestamp 齐全、
 * call/result 嵌套 → 走生成解析器直出路径）。
 *
 * 事件编排：tool-batch-start → tool-start → tool-update×3（text 形态，
 * metadata.kind="tool-progress"）→ tool-update（json 形态，
 * metadata.kind="tool-args-delta"）→ tool-end → tool-batch-end →
 * message-start/delta/end → run-terminal。
 *
 * 断言口径（§3.1.5）：ToolUpdate 为展示面事件不进消息历史——update.text
 * （构建进度…）不得混入 assistant 消息；终值仅由 ToolEnd 承载（build ok）。
 */
export function toolStreamingRunEvents(): MockEvent[] {
  const batchId = 'batch-s1';
  const toolCallId = 'tool-s1';
  const call = {
    id: toolCallId,
    toolName: 'shell_command',
    summary: 'npm run build',
    input: { command: 'npm run build' },
    category: 'terminal',
    concurrency: 'sequential',
  };
  return [
    {
      type: 'tool-batch-start',
      sessionId: 's',
      batchId,
      timestamp: 't0',
      summary: '执行构建',
      calls: [call],
    },
    { type: 'tool-start', sessionId: 's', batchId, timestamp: 't1', call },
    toolUpdateEvent(
      { text: '构建进度 1/3…', metadata: { kind: 'tool-progress' } },
      { timestamp: 't2' }
    ),
    toolUpdateEvent(
      { text: '构建进度 2/3…', metadata: { kind: 'tool-progress' } },
      { timestamp: 't3' }
    ),
    toolUpdateEvent(
      { text: '构建进度 3/3…', metadata: { kind: 'tool-progress' } },
      { timestamp: 't4' }
    ),
    toolUpdateEvent(
      {
        json: { args: { watch: true } },
        metadata: { kind: 'tool-args-delta' },
      },
      { timestamp: 't5' }
    ),
    {
      type: 'tool-end',
      sessionId: 's',
      batchId,
      timestamp: 't6',
      result: {
        id: toolCallId,
        toolName: 'shell_command',
        output: { text: 'build ok' },
        isError: false,
        durationMs: 1200,
      },
    },
    {
      type: 'tool-batch-end',
      sessionId: 's',
      batchId,
      timestamp: 't7',
      calls: [
        {
          id: toolCallId,
          toolName: 'shell_command',
          output: { text: 'build ok' },
          isError: false,
          durationMs: 1200,
        },
      ],
    },
    { type: 'message-start' },
    { type: 'message-delta', block: { type: 'text', text: '构建完成。' } },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: '构建完成。',
        blocks: [{ type: 'text', text: '构建完成。' }],
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}

/**
 * 工具流式宽容形态（缺 sessionId/timestamp/batchId 信封字段、平铺
 * id/name/args 形状，对齐既有 full-journey fixture 风格 → 走宽容归一器）。
 * tool-update 三形态齐发：text 缺 metadata、json 形态、update 非对象
 * （畸形）兜底为空对象——全部必须被宽容消费且不登记 unknown。
 */
export function toolStreamingLenientRunEvents(): MockEvent[] {
  return [
    {
      type: 'tool-start',
      id: 'tool-l1',
      name: 'shell_command',
      args: 'git status',
      explanation: '检查工作区',
    },
    toolUpdateEvent(
      { text: '检查中…' },
      { batchId: '', toolCallId: 'tool-l1' }
    ),
    toolUpdateEvent(
      { json: { pending: 2 } },
      { batchId: '', toolCallId: 'tool-l1' }
    ),
    {
      type: 'tool-update',
      batchId: 'batch-l1',
      toolCallId: 'tool-l1',
      update: 'not-an-object',
    },
    {
      type: 'tool-end',
      result: {
        toolCallId: 'tool-l1',
        toolName: 'shell_command',
        output: 'clean',
        isError: false,
        durationMs: 5,
      },
    },
    { type: 'message-start' },
    { type: 'message-delta', block: { type: 'text', text: '工作区干净。' } },
    {
      type: 'message-end',
      message: {
        role: 'assistant',
        content: '工作区干净。',
        blocks: [{ type: 'text', text: '工作区干净。' }],
      },
    },
    { type: 'run-terminal', terminal: 'completed' },
  ];
}
