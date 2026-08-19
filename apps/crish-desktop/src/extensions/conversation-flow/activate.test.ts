// @vitest-environment jsdom
/**
 * 对话流扩展激活 / 注销。jsdom 绿 ≠ 叙事 UI 完成 ≠ 默认开。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

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

const BUILTIN_IDS = [
  'chat',
  'terminal',
  'preview',
  'overview',
  'files',
  'diff',
  'runtime',
  'agent',
  'browser',
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
    expect(ids).not.toContain('conversation-flow');
  });

  it('deactivate 后 getSingle 空；二次 deactivate 不抛', () => {
    activateConversationFlow();
    deactivateConversationFlow();
    expect(slotCore.getSingle('workspace.chat.stream')).toBeUndefined();
    expect(() => deactivateConversationFlow()).not.toThrow();
  });

  it('二次 activate 先卸再挂，不泄漏', () => {
    activateConversationFlow();
    activateConversationFlow();
    expect(slotCore.getSingle('workspace.chat.stream')?.id).toBe(
      'conversation-flow'
    );
    deactivateConversationFlow();
    expect(slotCore.getSingle('workspace.chat.stream')).toBeUndefined();
  });

  it('main.tsx 在 builtins 之后条件调用 activateConversationFlow', () => {
    const mainSrc = readFileSync(join(DIR, '../../main.tsx'), 'utf8');
    const builtinIdx = mainSrc.indexOf(
      'registerBuiltInViews(builtinViewFactories)'
    );
    const activateIdx = mainSrc.indexOf('activateConversationFlow()');
    expect(builtinIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(builtinIdx);
    expect(mainSrc).toMatch(/shouldActivateOfficialConversationFlow\s*\(/);
    expect(mainSrc).not.toMatch(
      /builtinViewFactories[\s\S]*conversation-flow/
    );
  });
});
