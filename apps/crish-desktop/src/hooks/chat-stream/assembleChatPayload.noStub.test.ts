/**
 * assembleChatPayload：斜杠目标/对齐模式只走 wire 文本，禁止空壳 dispatch 回潮。
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const patchSessionMock = vi.hoisted(() => vi.fn());
const setPermissionModeMock = vi.hoisted(() => vi.fn());
const toastShowMock = vi.hoisted(() => vi.fn());

vi.mock('../../api/storeAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/storeAccess')>();
  return {
    ...actual,
    patchSession: (...args: unknown[]) => patchSessionMock(...args),
    setPermissionMode: (...args: unknown[]) => setPermissionModeMock(...args),
  };
});

vi.mock('../../services/toast/ToastContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/toast/ToastContext')>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      show: (...args: unknown[]) => toastShowMock(...args),
    },
  };
});

vi.mock('../../api/modelVisionSupport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/modelVisionSupport')>();
  return {
    ...actual,
    isModelVisionSupported: () => false,
  };
});

vi.mock('../../api/providerProfiles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/providerProfiles')>();
  return {
    ...actual,
    getActiveModelId: () => 'test-model',
    getActiveProfileId: () => 'test-profile',
  };
});

vi.mock('../../api/workspaceFsApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/workspaceFsApi')>();
  return {
    ...actual,
    formatAnnotationsForModel: () => '',
    takePendingFileAnnotations: () => [],
  };
});

vi.mock('../../store/sessionStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../store/sessionStore')>();
  return {
    ...actual,
    getSessionById: () => ({ goalMode: null }),
  };
});

import { assembleChatPayload } from './slashSendPreflight';

describe('assembleChatPayload §2.1 无伪连通', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('slashContextCards.ts 已删除（空 stub 文件不得回潮）', () => {
    const p = resolve(__dirname, 'slashContextCards.ts');
    expect(existsSync(p)).toBe(false);
  });

  it('/goal 写入 goalMode 并产出 wire 前缀，不依赖空壳派发', () => {
    const slash = {
      kind: 'goal' as const,
      goal: '完成审计',
      raw: '/goal 完成审计',
    };
    const out = assembleChatPayload({
      sessionId: 'sess-1',
      rawInput: '/goal 完成审计',
      slash: slash as never,
      modelText: '/goal 完成审计',
      displayText: '/goal 完成审计',
      attachments: [],
    });
    expect(patchSessionMock).toHaveBeenCalledTimes(1);
    expect(out.displayText).toBe('/goal 完成审计');
    expect(out.input).toContain('完成审计');
    expect(out.input.length).toBeGreaterThan('完成审计'.length);
  });

  it('带图且无视觉时 assembleChatPayload 硬抛（第二道闸）', () => {
    expect(() =>
      assembleChatPayload({
        sessionId: 'sess-1',
        rawInput: '看图',
        slash: { kind: 'none', raw: '看图' },
        modelText: '看图',
        displayText: '看图',
        attachments: [
          {
            name: 'shot.png',
            mime: 'image/png',
            dataUrl: 'data:image/png;base64,xx',
          },
        ],
      })
    ).toThrow(/不支持图片输入/);
    expect(toastShowMock).toHaveBeenCalled();
  });

  it('/grill-me 产出渲染 wire 文本（plan 伪模式已物理移除）', () => {
    const slash = {
      kind: 'grill-me' as const,
      topic: '权限模型',
      raw: '/grill-me 权限模型',
    };
    const out = assembleChatPayload({
      sessionId: 'sess-1',
      rawInput: '/grill-me 权限模型',
      slash: slash as never,
      modelText: '/grill-me 权限模型',
      displayText: '/grill-me 权限模型',
      attachments: [],
    });
    expect(setPermissionModeMock).not.toHaveBeenCalled();
    expect(out.displayText).toBe('/grill-me 权限模型');
    expect(out.input).toContain('权限模型');
    expect(out.input).not.toBe('/grill-me 权限模型');
  });
});
