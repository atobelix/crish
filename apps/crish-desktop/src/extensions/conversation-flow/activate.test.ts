// @vitest-environment jsdom
/**
 * 对话流扩展激活 / 注销。jsdom 绿 ≠ 叙事 UI 完成 ≠ 默认开。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type React from 'react';
import {
  registerBuiltInViews,
  slotCore,
  viewRegistry,
  type ViewFactoryMap,
} from '../../services/view-registry';
import type { ViewRenderContext } from '../../services/view-registry';
import {
  activateConversationFlow,
  deactivateConversationFlow,
  setOfficialConversationFlowActivateForTesting,
  shouldActivateOfficialConversationFlow,
} from './activate';
import {
  DESKTOP_SRC_DIR,
  readEntryChainSource,
} from '../../test-utils/entryChainSources';

const stubComponent: React.FC<ViewRenderContext> = () => null;
const stubFactory = () => stubComponent;
const testFactories: ViewFactoryMap = {
  chat: stubFactory,
  terminal: stubFactory,
  preview: stubFactory,
  overview: stubFactory,
  files: stubFactory,
  diff: stubFactory,
  runtime: stubFactory,
  agent: stubFactory,
  browser: stubFactory,
  'flow-dag': stubFactory,
  'file-viewer': stubFactory,
};

/**
 * 内置视图 id 清单（真源：services/view-registry/registerBuiltInViews.tsx）。
 *
 * `browser` 已于「决策 1 视图路由收敛」并入 `preview`，不再注册独立视图
 * （registerBuiltInViews.tsx:44-45）⇒ 名单为 10 项，且必须反向断言 browser 缺席，
 * 防其被重新注册回来。
 */
const BUILTIN_IDS = [
  'chat',
  'terminal',
  'preview',
  'overview',
  'files',
  'diff',
  'runtime',
  'agent',
  'flow-dag',
  'file-viewer',
] as const;

function ensureBuiltins(): void {
  if (!viewRegistry.getView('chat')) {
    registerBuiltInViews(testFactories);
  }
}

describe('conversation-flow activate / deactivate（S1 槽可卸）', () => {
  beforeEach(() => {
    deactivateConversationFlow();
    setOfficialConversationFlowActivateForTesting(null);
    ensureBuiltins();
  });

  afterEach(() => {
    deactivateConversationFlow();
    setOfficialConversationFlowActivateForTesting(null);
  });

  it('默认 shouldActivate 为 false', () => {
    expect(shouldActivateOfficialConversationFlow()).toBe(false);
    setOfficialConversationFlowActivateForTesting(true);
    expect(shouldActivateOfficialConversationFlow()).toBe(true);
    setOfficialConversationFlowActivateForTesting(null);
    expect(shouldActivateOfficialConversationFlow()).toBe(false);
  });

  it('activate 后 stream 槽 id 为 conversation-flow，且不是 view', () => {
    activateConversationFlow();
    const entry = slotCore.getSingle('workspace.chat.stream');
    expect(entry?.id).toBe('conversation-flow');
    expect(entry?.component).toBeTypeOf('function');
    expect(viewRegistry.getView('conversation-flow')).toBeUndefined();
    const ids = viewRegistry.getAllViews().map((v) => v.id);
    for (const id of BUILTIN_IDS) {
      expect(ids).toContain(id);
    }
    // 决策 1 视图路由收敛：browser 已并入 preview，不得回归为独立视图
    expect(ids).not.toContain('browser');
    expect(ids).not.toContain('conversation-flow');
  });

  it('activate 后 composerAbove 槽 id 为 conversation-flow；默认不 activate', () => {
    expect(slotCore.getSingle('workspace.chat.composerAbove')).toBeUndefined();
    activateConversationFlow();
    const entry = slotCore.getSingle('workspace.chat.composerAbove');
    expect(entry?.id).toBe('conversation-flow');
    expect(entry?.component).toBeTypeOf('function');
    expect(viewRegistry.getView('conversation-flow')).toBeUndefined();
  });

  it('deactivate 后 getSingle 空；二次 deactivate 不抛', () => {
    activateConversationFlow();
    deactivateConversationFlow();
    expect(slotCore.getSingle('workspace.chat.stream')).toBeUndefined();
    expect(slotCore.getSingle('workspace.chat.composerAbove')).toBeUndefined();
    expect(() => deactivateConversationFlow()).not.toThrow();
  });

  it('二次 activate 先卸再挂，不泄漏', () => {
    activateConversationFlow();
    activateConversationFlow();
    expect(slotCore.getSingle('workspace.chat.stream')?.id).toBe(
      'conversation-flow'
    );
    expect(slotCore.getSingle('workspace.chat.composerAbove')?.id).toBe(
      'conversation-flow'
    );
    deactivateConversationFlow();
    expect(slotCore.getSingle('workspace.chat.stream')).toBeUndefined();
    expect(slotCore.getSingle('workspace.chat.composerAbove')).toBeUndefined();
  });

  it('入口链在 builtins 之后条件调用 activateConversationFlow', () => {
    // 装配点在 entry-core.tsx（ACT-301 单拍装配后 main.tsx 仅转发）
    const entrySrc = readEntryChainSource();
    const builtinIdx = entrySrc.indexOf(
      'registerBuiltInViews(builtinViewFactories)'
    );
    const activateIdx = entrySrc.indexOf('activateConversationFlow()');
    expect(builtinIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(builtinIdx);
    expect(entrySrc).toMatch(/shouldActivateOfficialConversationFlow\s*\(/);
  });

  it('conversation-flow 不是内置视图：工厂表 10 槽不含它', () => {
    // 精确扫工厂表定义模块（而非整条入口链）：整链正则会把 import 语句也纳入，
    // 断言失真（entry-core 同时 import 了 builtinViewFactories 与扩展激活）。
    const factoriesSrc = readFileSync(
      join(DESKTOP_SRC_DIR, 'builtinViewFactories.tsx'),
      'utf8'
    );
    expect(factoriesSrc).not.toContain('conversation-flow');
    expect(factoriesSrc).not.toContain('conversation_flow');
    // 10 槽全量（迁移清单铁律：严禁缩减）
    const slotKeys = [...factoriesSrc.matchAll(/^ {2}'?([a-z][a-z-]*)'?:/gm)].map(
      (m) => m[1]
    );
    expect(slotKeys).toHaveLength(10);
    expect(slotKeys).not.toContain('browser');
  });
});
