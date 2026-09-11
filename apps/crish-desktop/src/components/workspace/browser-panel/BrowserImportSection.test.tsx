// @vitest-environment jsdom
/**
 * BrowserImportSection 组件测试（G-4 收尾 U6）：按钮可用性 / 统计渲染 /
 * 错误 toast / 导出授权确认流 / 列表展示。
 * invoke 走 test-setup 全局 mock；路径读取面按 API 函数 mock
 * （根配置 vi.mock 拦截 vs app 配置 alias stub 两环境行为解耦）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { mockTauriCommand, mockTauriError } from '../../../test-setup';
import { BrowserImportSection } from './BrowserImportSection';
import {
  BROWSER_IMPORT_BOOKMARKS_CMD,
  BROWSER_IMPORT_HISTORY_CMD,
  BROWSER_IMPORT_STORAGE_STATE_CMD,
  BROWSER_EXPORT_STORAGE_STATE_CMD,
} from '../../../api/browserImportApi';

// 路径读取面按 API 函数 mock（与插件模块解耦：根配置走 vi.mock 拦截、
// app 配置走 alias stub，两环境行为需一致——直接 mock readTextFileAtPath）。
const pathReadMock = vi.hoisted(() => ({
  readTextFileAtPath: vi.fn(),
}));

vi.mock('../../../api/browserImportApi', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../api/browserImportApi')>();
  return { ...actual, readTextFileAtPath: pathReadMock.readTextFileAtPath };
});

const { mockShowToast } = vi.hoisted(() => ({
  mockShowToast: vi.fn(),
}));
vi.mock('../../../services/toast/ToastContext', () => ({
  useToast: () => ({
    show: mockShowToast,
    showToast: mockShowToast,
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
    dismissToast: vi.fn(),
    toasts: [],
  }),
  toast: {
    show: mockShowToast,
  },
}));

function renderSection(
  props: Partial<Parameters<typeof BrowserImportSection>[0]> = {}
) {
  mockShowToast.mockClear();
  const saveExport = vi.fn();
  const view = render(
    <BrowserImportSection
      browserRunning
      saveExport={saveExport}
      {...props}
    />
  );
  return { onShowToast: mockShowToast, saveExport, ...view };
}

function makeFile(
  name: string,
  content: string,
  type = 'application/json'
): File {
  return new File([content], name, { type });
}

function attachFileInput(testId: string, file: File): void {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [file],
  });
  fireEvent.change(input);
}

const BOOKMARKS_JSON = JSON.stringify({
  roots: { bookmark_bar: { children: [] }, other: { children: [] } },
});
const STORAGE_STATE_JSON = JSON.stringify({
  cookies: [
    { name: 'sid', value: 'v1', domain: '.a.com', path: '/' },
    {
      name: 'p',
      value: 'v2',
      domain: '.b.com',
      path: '/',
      expires: 1750000000,
    },
  ],
  origins: [],
});

const importBookmarksBtn = () =>
  screen.getByRole('button', { name: /导入书签/ });
const importHistoryBtn = () => screen.getByRole('button', { name: /导入历史/ });
const exportBtn = () => screen.getByRole('button', { name: /导出登录态/ });
const importStorageBtn = () =>
  screen.getByRole('button', { name: /导入登录态/ });

beforeEach(() => {
  // 默认：路径读取不可用（null → 降级提示）；用例内可覆盖为成功内容
  pathReadMock.readTextFileAtPath.mockReset();
  pathReadMock.readTextFileAtPath.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('书签导入', () => {
  it('文件选择后可用并导入 → 成功提示 toast（inserted/skippedDupes）', async () => {
    const impl = vi.fn(async () => ({
      inserted: 3,
      skippedDupes: 1,
      parsedItems: 4,
      skippedInvalid: 1,
      depthCutoff: 0,
      droppedDupes: 0,
      truncated: 0,
    }));
    mockTauriCommand(BROWSER_IMPORT_BOOKMARKS_CMD, impl);
    const { onShowToast } = renderSection();

    expect(importBookmarksBtn()).toBeEnabled();
    attachFileInput(
      'bookmarks-file-input',
      makeFile('Bookmarks', BOOKMARKS_JSON)
    );

    await waitFor(() => expect(impl).toHaveBeenCalledTimes(1));
    expect(impl).toHaveBeenCalledWith({ json: BOOKMARKS_JSON });

    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/书签导入成功：新增 3 条，跳过 1 条/)
      )
    );
  });

  it('导入报错（tool.invalid_input）→ 错误 toast', async () => {
    mockTauriError(
      BROWSER_IMPORT_BOOKMARKS_CMD,
      new Error('tool.invalid_input: JSON 解析失败')
    );
    const { onShowToast } = renderSection();
    attachFileInput('bookmarks-file-input', makeFile('b.json', 'not-json'));
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/书签导入失败：.*JSON 解析失败/)
      )
    );
  });

  it('命令未接线（missing）→ toast 提示引擎未接线', async () => {
    const { onShowToast } = renderSection();
    attachFileInput('bookmarks-file-input', makeFile('b.json', '{}'));
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/书签导入失败：引擎未接线/)
      )
    );
  });
});

describe('历史导入', () => {
  it('点击导入历史 → 成功提示 toast（inserted/skippedDupes）', async () => {
    const impl = vi.fn(async () => ({
      inserted: 7,
      skippedDupes: 2,
      readTotal: 10,
      skippedInvalidUrl: 1,
    }));
    mockTauriCommand(BROWSER_IMPORT_HISTORY_CMD, impl);
    const { onShowToast } = renderSection();

    expect(importHistoryBtn()).toBeEnabled();
    fireEvent.click(importHistoryBtn());
    await waitFor(() =>
      expect(impl).toHaveBeenCalledWith({ path: 'default' })
    );
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/历史记录导入成功：新增 7 条，跳过 2 条/)
      )
    );
  });

  it('导入报错（库缺失）→ toast 提示', async () => {
    mockTauriError(
      BROWSER_IMPORT_HISTORY_CMD,
      new Error('tool.invalid_input: 库不存在')
    );
    const { onShowToast } = renderSection();
    fireEvent.click(importHistoryBtn());
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/历史导入失败：.*库不存在/)
      )
    );
  });
});

describe('登录态导出（授权确认流）', () => {
  const authDialog = () =>
    within(screen.getByRole('alertdialog', { name: '授权读取登录态' }));
  const previewDialog = () =>
    within(screen.getByRole('alertdialog', { name: '确认导出登录态' }));

  it('未授权取消 → 不 invoke（零副作用）', async () => {
    const impl = vi.fn(async () => '{}');
    mockTauriCommand(BROWSER_EXPORT_STORAGE_STATE_CMD, impl);
    renderSection();
    fireEvent.click(exportBtn());
    await waitFor(() =>
      expect(screen.getByText('授权读取登录态')).toBeTruthy()
    );
    fireEvent.click(authDialog().getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByText('授权读取登录态')).toBeNull()
    );
    expect(impl).not.toHaveBeenCalled();
  });

  it('确认授权 → 实读（authorized=true）→ 域名清单预览 → 确认导出 → 另存为', async () => {
    const impl = vi.fn(async () => STORAGE_STATE_JSON);
    mockTauriCommand(BROWSER_EXPORT_STORAGE_STATE_CMD, impl);
    const { saveExport } = renderSection();

    fireEvent.click(exportBtn());
    await waitFor(() =>
      expect(screen.getByText('授权读取登录态')).toBeTruthy()
    );
    fireEvent.click(authDialog().getByRole('button', { name: '继续读取' }));
    await waitFor(() =>
      expect(impl).toHaveBeenCalledWith({ authorized: true })
    );

    await waitFor(() =>
      expect(screen.getByText('确认导出登录态')).toBeTruthy()
    );
    expect(screen.getByText(/将导出 2 条 cookie/)).toBeTruthy();
    expect(screen.getByText('.a.com、.b.com')).toBeTruthy();

    fireEvent.click(previewDialog().getByRole('button', { name: '确认导出' }));
    await waitFor(() => expect(saveExport).toHaveBeenCalledTimes(1));
    const [filename, content] = saveExport.mock.calls[0] as [string, string];
    expect(filename).toMatch(/^browser-storage-state-\d{8}-\d{6}\.json$/);
    expect(content).toBe(STORAGE_STATE_JSON);
    await waitFor(() =>
      expect(screen.queryByText('确认导出登录态')).toBeNull()
    );
  });

  it('预览对话框取消 → 不写盘、不触发下载', async () => {
    const impl = vi.fn(async () => STORAGE_STATE_JSON);
    mockTauriCommand(BROWSER_EXPORT_STORAGE_STATE_CMD, impl);
    const { saveExport } = renderSection();

    fireEvent.click(exportBtn());
    await waitFor(() => screen.getByText('授权读取登录态'));
    fireEvent.click(authDialog().getByRole('button', { name: '继续读取' }));
    await waitFor(() => screen.getByText('确认导出登录态'));
    fireEvent.click(previewDialog().getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByText('确认导出登录态')).toBeNull()
    );
    expect(saveExport).not.toHaveBeenCalled();
  });

  it('实读报错（not_ready）→ toast 透传结构化消息', async () => {
    mockTauriError(
      BROWSER_EXPORT_STORAGE_STATE_CMD,
      new Error('tool.browser.not_ready: 浏览器未启动')
    );
    const { onShowToast } = renderSection();
    fireEvent.click(exportBtn());
    await waitFor(() => screen.getByText('授权读取登录态'));
    fireEvent.click(authDialog().getByRole('button', { name: '继续读取' }));
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/登录态导出失败：.*not_ready/)
      )
    );
    expect(screen.queryByText('确认导出登录态')).toBeNull();
  });
});

describe('登录态导入', () => {
  it('文件选择 → 内容装载并自动导入 → 成功提示 toast', async () => {
    const impl = vi.fn(async () => ({
      cookies: 2,
      origins: 0,
      localStorageItems: 0,
      injectedScripts: 0,
      injectedItems: 0,
      droppedDupes: 1,
      skippedEmptyName: 0,
    }));
    mockTauriCommand(BROWSER_IMPORT_STORAGE_STATE_CMD, impl);
    const { onShowToast } = renderSection();
    attachFileInput(
      'storage-file-input',
      makeFile('state.json', STORAGE_STATE_JSON)
    );
    await waitFor(() =>
      expect(impl).toHaveBeenCalledWith({ json: STORAGE_STATE_JSON })
    );
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/登录态导入成功：cookies 2 条/)
      )
    );
  });

  it('导入报错 → toast', async () => {
    mockTauriError(
      BROWSER_IMPORT_STORAGE_STATE_CMD,
      new Error('tool.invalid_input: 大小超限')
    );
    const { onShowToast } = renderSection();
    attachFileInput(
      'storage-file-input',
      makeFile('state.json', '{}')
    );
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/登录态导入失败：.*大小超限/)
      )
    );
  });
});

describe('browserRunning 门禁', () => {
  it('未运行浏览器：登录态导入/导出禁用，书签/历史不受影响', async () => {
    renderSection({ browserRunning: false });
    expect(exportBtn()).toBeDisabled();
    expect(importStorageBtn()).toBeDisabled();
    expect(importBookmarksBtn()).toBeEnabled();
    expect(importHistoryBtn()).toBeEnabled();
  });

  it('运行中：登录态导入/导出可用', async () => {
    renderSection({ browserRunning: true });
    expect(exportBtn()).toBeEnabled();
    expect(importStorageBtn()).toBeEnabled();
  });
});
