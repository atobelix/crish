// @vitest-environment jsdom
/**
 * FilesCard 分栏拖拽 R5 迁移契约测试（分割线统一波次 R5）
 *
 * 覆盖：
 * - 纯函数：filesListRatioFromDelta / clampFilesListRatio 的换算与钳制；
 * - 行为：拖中实时直写 --files-list-ratio 变量（不落盘）、松手提交并落盘、
 *   按下未移动松手经兜底落盘一次、Esc 取消恢复起始比例且不落盘、
 *   键盘比例域步进（±2% / Shift ±10% / Home / End）；
 * - a11y 基线：separator 的 tabIndex 与比例域 aria-value*；
 * - 源码契约：CSS 中性灰钉版（8px 热区、无 --accent-color、无辉光、
 *   focus-visible 激活在位）、TSX 单绑指针（双绑 handler 已消除）。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { setPreferenceMock } = vi.hoisted(() => ({
  setPreferenceMock: vi.fn(async (_key: string, _value: unknown) => {}),
}));

// jsdom 无 rAF 的环境兜底（原生存在时不介入）：hook 的节流回调依赖它
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(
      () => cb(performance.now()),
      16
    )) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as typeof cancelAnimationFrame;
}

vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../api/preferences', () => ({
  preferencesClient: {
    getPreference: vi.fn(async () => undefined),
    setPreference: setPreferenceMock,
  },
}));

vi.mock('../../api/workspaceFsApi', () => ({
  countPendingFileAnnotations: () => 0,
  openPathDefault: vi.fn(async () => {}),
  resolveReadableFilePath: (p: string) => p,
  resolveWorkspacePath: () => null,
  takePendingOpenPath: () => null,
}));

vi.mock('./hooks/useFileNavigation', () => ({
  useFileNavigation: () => ({
    root: 'C:/workspace',
    flatTree: [],
    expanded: {},
    loading: false,
    error: '',
    filter: '',
    filterMode: false,
    gitStatusMap: {},
    confirmGateView: null,
    confirmNavigation: vi.fn(async () => true),
    revealPath: vi.fn(async () => {}),
    toggleExpand: vi.fn(),
    refresh: vi.fn(async () => {}),
    setFilter: vi.fn(),
    setFilterMode: vi.fn(),
    setError: vi.fn(),
  }),
}));

vi.mock('./hooks/useFilePreview', () => ({
  useFilePreview: () => ({
    dirty: false,
    view: 'browse',
    selected: null,
    kind: null,
    isMd: false,
    canEdit: false,
    content: '',
    editBuf: '',
    editing: false,
    detailLoading: false,
    truncated: false,
    lineBudget: 0,
    loadingMore: false,
    mdMode: 'preview',
    assetUrl: null,
    canLoadMore: false,
    wordWrap: false,
    formattedContent: '',
    isFormatted: false,
    isJson: false,
    fileOpeners: [],
    pendingCount: 0,
    actionHint: null,
    actionHintTimerRef: { current: null },
    openDefaultLabel: '',
    confirmGateView: null,
    openFile: vi.fn(async () => {}),
    resetPreview: vi.fn(),
    setView: vi.fn(),
    setSelected: vi.fn(),
    clearActionHint: vi.fn(),
    setPendingCount: vi.fn(),
    setEditing: vi.fn(),
    setEditBuf: vi.fn(),
    setDirty: vi.fn(),
    setMdMode: vi.fn(),
    toggleFormatJson: vi.fn(async () => {}),
    toggleWordWrap: vi.fn(),
    saveFile: vi.fn(async () => {}),
    loadMoreLines: vi.fn(async () => {}),
    copyPath: vi.fn(),
  }),
}));

vi.mock('./FileTreeView', () => ({ FileTreeView: () => null }));
vi.mock('./FilePreview', () => ({ FilePreview: () => null }));
vi.mock('./FileBreadcrumb', () => ({ FileBreadcrumb: () => null }));
vi.mock('./FileActions', () => ({ FileActions: () => null }));

import {
  FilesCard,
  clampFilesListRatio,
  filesListRatioFromDelta,
  FILES_LIST_RATIO_MIN,
  FILES_LIST_RATIO_MAX,
} from './FilesCard';

const CONTAINER_WIDTH = 800;

function rectOf(width: number): DOMRect {
  return {
    width,
    height: 600,
    left: 0,
    top: 0,
    right: width,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function renderCard() {
  const utils = render(<FilesCard />);
  const resizer = utils.container.querySelector(
    '[role="separator"]'
  ) as HTMLElement;
  const splitBody = utils.container.querySelector(
    '[data-mode="browse"]'
  ) as HTMLElement;
  expect(resizer).toBeTruthy();
  expect(splitBody).toBeTruthy();
  vi.spyOn(splitBody, 'getBoundingClientRect').mockReturnValue(
    rectOf(CONTAINER_WIDTH)
  );
  return { ...utils, resizer, splitBody };
}

function liveRatioOf(splitBody: HTMLElement): string {
  return splitBody.style.getPropertyValue('--files-list-ratio');
}

/** 等一帧 rAF，让 hook 的节流回调落定 */
async function flushFrame() {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
  });
}

beforeEach(() => {
  setPreferenceMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('filesListRatioFromDelta / clampFilesListRatio（纯函数）', () => {
  it('增量按容器宽度换算为比例', () => {
    expect(filesListRatioFromDelta(35, 80, 800)).toBe(45);
    expect(filesListRatioFromDelta(35, -80, 800)).toBe(25);
    expect(filesListRatioFromDelta(35, 0, 800)).toBe(35);
  });

  it('两端钳制在 [15, 75]', () => {
    expect(filesListRatioFromDelta(35, 100_000, 800)).toBe(
      FILES_LIST_RATIO_MAX
    );
    expect(filesListRatioFromDelta(35, -100_000, 800)).toBe(
      FILES_LIST_RATIO_MIN
    );
    expect(clampFilesListRatio(5)).toBe(FILES_LIST_RATIO_MIN);
    expect(clampFilesListRatio(90)).toBe(FILES_LIST_RATIO_MAX);
    expect(clampFilesListRatio(50)).toBe(50);
  });

  it('容器不可测（宽为 0）时保持起始比例', () => {
    expect(filesListRatioFromDelta(35, 80, 0)).toBe(35);
    expect(filesListRatioFromDelta(35, 80, Number.NaN)).toBe(35);
  });
});

describe('FilesCard 分栏拖拽（R5 钩子级迁移行为）', () => {
  it('a11y 基线：tabIndex=0 与比例域 aria-value*', () => {
    const { resizer } = renderCard();
    expect(resizer.getAttribute('tabindex')).toBe('0');
    expect(resizer.getAttribute('aria-orientation')).toBe('vertical');
    expect(resizer.getAttribute('aria-label')).toBe('调整目录树与预览宽度');
    expect(resizer.getAttribute('aria-valuemin')).toBe('15');
    expect(resizer.getAttribute('aria-valuemax')).toBe('75');
    expect(resizer.getAttribute('aria-valuenow')).toBe('35');
  });

  it('拖中直写变量不落盘，松手提交状态并落盘一次', async () => {
    const { resizer, splitBody } = renderCard();
    fireEvent.pointerDown(resizer, {
      button: 0,
      pointerId: 7,
      clientX: 400,
    });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 480 });
    await flushFrame();
    // +80px / 800px = +10% → 45%
    expect(liveRatioOf(splitBody)).toBe('45%');
    expect(setPreferenceMock).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { pointerId: 7, clientX: 480 });
    expect(liveRatioOf(splitBody)).toBe('45%');
    expect(resizer.getAttribute('aria-valuenow')).toBe('45');
    expect(setPreferenceMock).toHaveBeenCalledTimes(1);
    expect(setPreferenceMock).toHaveBeenCalledWith('files_list_ratio', 45);
  });

  it('按下未移动松手：经兜底以当前比例落盘一次（迁移前恒落盘契约）', () => {
    const { resizer } = renderCard();
    fireEvent.pointerDown(resizer, {
      button: 0,
      pointerId: 8,
      clientX: 400,
    });
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 400 });
    expect(setPreferenceMock).toHaveBeenCalledTimes(1);
    expect(setPreferenceMock).toHaveBeenCalledWith('files_list_ratio', 35);
  });

  it('Esc 取消：变量恢复起始比例且不落盘', async () => {
    const { resizer, splitBody } = renderCard();
    fireEvent.pointerDown(resizer, {
      button: 0,
      pointerId: 9,
      clientX: 400,
    });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 480 });
    await flushFrame();
    expect(liveRatioOf(splitBody)).toBe('45%');

    fireEvent.keyDown(resizer, { key: 'Escape' });
    expect(liveRatioOf(splitBody)).toBe('35%');
    expect(setPreferenceMock).not.toHaveBeenCalled();
  });

  it('键盘：±2% 步进、Shift ±10%、Home/End 到界，均立即落盘', () => {
    const { resizer, splitBody } = renderCard();
    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    expect(liveRatioOf(splitBody)).toBe('37%');
    expect(setPreferenceMock).toHaveBeenCalledWith('files_list_ratio', 37);

    fireEvent.keyDown(resizer, { key: 'ArrowRight', shiftKey: true });
    expect(liveRatioOf(splitBody)).toBe('47%');

    fireEvent.keyDown(resizer, { key: 'Home' });
    expect(liveRatioOf(splitBody)).toBe('15%');

    fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
    expect(liveRatioOf(splitBody)).toBe('15%');

    fireEvent.keyDown(resizer, { key: 'End' });
    expect(liveRatioOf(splitBody)).toBe('75%');
    expect(resizer.getAttribute('aria-valuenow')).toBe('75');
  });
});

describe('FilesCard 分栏条源码契约（中性灰钉版）', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, 'FilesCard.module.css'), 'utf8');
  const tsx = readFileSync(join(here, 'FilesCard.tsx'), 'utf8');

  function resizerCssBlock(): string {
    const start = css.indexOf('.filesSplitResizer {');
    const end = css.indexOf('@container filesCard');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return css.slice(css.lastIndexOf('/*', start), end);
  }

  it('CSS：8px 热区 + z-index 令牌化', () => {
    const block = resizerCssBlock();
    expect(block).toContain('flex: 0 0 8px');
    expect(block).toContain('z-index: var(--z-resizer)');
  });

  it('CSS：激活走中性灰 --border-color，无 accent、无辉光', () => {
    const block = resizerCssBlock();
    expect(block).toContain('background: var(--border-color)');
    expect(block).toContain(':focus-visible');
    expect(block).not.toContain('--accent-color');
    expect(block).not.toContain('box-shadow');
  });

  it('TSX：手势收编至 useSplitResize，双绑 handler 已消除', () => {
    expect(tsx).toContain('useSplitResize');
    expect(tsx).toContain('splitSeparatorProps');
    expect(tsx).not.toContain('handleSplitResizeStart');
  });
});
