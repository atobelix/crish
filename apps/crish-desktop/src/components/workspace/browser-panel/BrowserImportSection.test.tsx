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
  BROWSER_LIST_BOOKMARKS_CMD,
  BROWSER_LIST_HISTORY_CMD,
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

function renderSection(
  props: Partial<Parameters<typeof BrowserImportSection>[0]> = {}
) {
  const onShowToast = vi.fn();
  const saveExport = vi.fn();
  const view = render(
    <BrowserImportSection
      onShowToast={onShowToast}
      browserRunning
      saveExport={saveExport}
      {...props}
    />
  );
  return { onShowToast, saveExport, ...view };
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
const bookmarksListBtn = () => screen.getByRole('button', { name: /书签列表/ });
const historyListBtn = () => screen.getByRole('button', { name: /历史列表/ });

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
  it('初始禁用 → 文件选择后可用 → 导入成功展示统计（inserted/skippedDupes）', async () => {
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

    expect(importBookmarksBtn()).toBeDisabled();
    attachFileInput(
      'bookmarks-file-input',
      makeFile('Bookmarks', BOOKMARKS_JSON)
    );
    await waitFor(() => expect(importBookmarksBtn()).toBeEnabled());
    // 已装载文案为「前缀 + <code>文件名</code>」分节点，分别断言
    expect(screen.getByText('已装载：')).toBeTruthy();
    expect(screen.getByText('Bookmarks')).toBeTruthy();

    fireEvent.click(importBookmarksBtn());
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(1));
    expect(impl).toHaveBeenCalledWith({ json: BOOKMARKS_JSON });

    await waitFor(() =>
      expect(
        screen.getByText(
          /新增 3 条，跳过 1 条（此前已导入）；解析 4 条，无效跳过 1/
        )
      ).toBeTruthy()
    );
    // 成功统计行内展示，不打扰 toast（产品禁令）
    expect(onShowToast).not.toHaveBeenCalled();
  });

  it('拖入文件 → 可用并导入（内容取自 dataTransfer.files）', async () => {
    const impl = vi.fn(async () => ({
      inserted: 1,
      skippedDupes: 0,
      parsedItems: 1,
      skippedInvalid: 0,
      depthCutoff: 0,
      droppedDupes: 0,
      truncated: 0,
    }));
    mockTauriCommand(BROWSER_IMPORT_BOOKMARKS_CMD, impl);
    renderSection();

    const zone = screen.getByRole('button', {
      name: '拖入 Chrome Bookmarks JSON',
    });
    fireEvent.drop(zone, {
      dataTransfer: { files: [makeFile('Bookmarks.json', BOOKMARKS_JSON)] },
    });
    await waitFor(() => expect(importBookmarksBtn()).toBeEnabled());
    fireEvent.click(importBookmarksBtn());
    await waitFor(() =>
      expect(impl).toHaveBeenCalledWith({ json: BOOKMARKS_JSON })
    );
  });

  it('导入报错（tool.invalid_input）→ 错误 toast + 行内 alert', async () => {
    mockTauriError(
      BROWSER_IMPORT_BOOKMARKS_CMD,
      new Error('tool.invalid_input: JSON 解析失败')
    );
    const { onShowToast } = renderSection();
    attachFileInput('bookmarks-file-input', makeFile('b.json', 'not-json'));
    await waitFor(() => expect(importBookmarksBtn()).toBeEnabled());
    fireEvent.click(importBookmarksBtn());
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/书签导入失败：.*JSON 解析失败/)
      )
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('命令未接线（missing）→ toast 提示引擎未接线', async () => {
    const { onShowToast } = renderSection();
    attachFileInput('bookmarks-file-input', makeFile('b.json', '{}'));
    await waitFor(() => expect(importBookmarksBtn()).toBeEnabled());
    fireEvent.click(importBookmarksBtn());
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/书签导入失败：引擎未接线/)
      )
    );
  });

  it('路径读取：plugin-fs 可用时装载内容', async () => {
    pathReadMock.readTextFileAtPath.mockResolvedValue(BOOKMARKS_JSON);
    renderSection();
    fireEvent.change(screen.getByLabelText(/输入文件路径/), {
      target: { value: 'C:\\Bookmarks' },
    });
    fireEvent.click(screen.getByRole('button', { name: '读取路径' }));
    await waitFor(() => expect(screen.getByText('C:\\Bookmarks')).toBeTruthy());
    expect(importBookmarksBtn()).toBeEnabled();
  });

  it('路径读取失败/不可用 → toast 提示改用文件选择', async () => {
    // 默认语义：路径读取不可用（mock 默认 null）→ 降级提示
    const { onShowToast } = renderSection();
    fireEvent.change(screen.getByLabelText(/输入文件路径/), {
      target: { value: 'C:\\Bookmarks' },
    });
    fireEvent.click(screen.getByRole('button', { name: '读取路径' }));
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/路径读取不可用：.*请用文件选择或拖入/)
      )
    );
    expect(importBookmarksBtn()).toBeDisabled();
  });
});

describe('历史导入', () => {
  it('空路径禁用 → 输入路径 → 导入成功展示统计（readTotal/skippedDupes）', async () => {
    const impl = vi.fn(async () => ({
      inserted: 7,
      skippedDupes: 2,
      readTotal: 10,
      skippedInvalidUrl: 1,
    }));
    mockTauriCommand(BROWSER_IMPORT_HISTORY_CMD, impl);
    renderSection();

    expect(importHistoryBtn()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('History 库路径'), {
      target: { value: 'C:\\History' },
    });
    expect(importHistoryBtn()).toBeEnabled();
    fireEvent.click(importHistoryBtn());
    await waitFor(() =>
      expect(impl).toHaveBeenCalledWith({ path: 'C:\\History' })
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          /新增 7 条，跳过 2 条（此前已导入）；读取 10 条，无效 URL 跳过 1/
        )
      ).toBeTruthy()
    );
  });

  it('导入报错（库缺失）→ toast + 行内 alert', async () => {
    mockTauriError(
      BROWSER_IMPORT_HISTORY_CMD,
      new Error('tool.invalid_input: 库不存在')
    );
    const { onShowToast } = renderSection();
    fireEvent.change(screen.getByLabelText('History 库路径'), {
      target: { value: 'missing' },
    });
    fireEvent.click(importHistoryBtn());
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/历史导入失败：.*库不存在/)
      )
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('登录态导出（授权确认流）', () => {
  // 两个 ConfirmDialog 常驻挂载（关闭仅隐藏），按钮按对话框名域内查找
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

    // 预览对话框：域名清单 + 条数
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
  it('空内容禁用 → 粘贴 JSON → 导入成功展示脱敏统计', async () => {
    const impl = vi.fn(async () => ({
      cookies: 2,
      origins: 0,
      localStorageItems: 0,
      injectedScripts: 0,
      injectedItems: 0,
      droppedDupes: 0,
      skippedEmptyName: 0,
    }));
    mockTauriCommand(BROWSER_IMPORT_STORAGE_STATE_CMD, impl);
    renderSection();

    expect(importStorageBtn()).toBeDisabled();
    fireEvent.change(
      screen.getByPlaceholderText(/粘贴标准 storage_state JSON/),
      { target: { value: STORAGE_STATE_JSON } }
    );
    expect(importStorageBtn()).toBeEnabled();
    fireEvent.click(importStorageBtn());
    await waitFor(() =>
      expect(impl).toHaveBeenCalledWith({ json: STORAGE_STATE_JSON })
    );
    await waitFor(() =>
      expect(screen.getByText(/cookies 2 · origins 0/)).toBeTruthy()
    );
  });

  it('文件选择 → 内容装载 → 导入', async () => {
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
    renderSection();
    attachFileInput(
      'storage-file-input',
      makeFile('state.json', STORAGE_STATE_JSON)
    );
    await waitFor(() => expect(screen.getByText('state.json')).toBeTruthy());
    fireEvent.click(importStorageBtn());
    await waitFor(() => expect(screen.getByText(/去重丢弃 1/)).toBeTruthy());
  });

  it('导入报错 → toast', async () => {
    mockTauriError(
      BROWSER_IMPORT_STORAGE_STATE_CMD,
      new Error('tool.invalid_input: 大小超限')
    );
    const { onShowToast } = renderSection();
    fireEvent.change(
      screen.getByPlaceholderText(/粘贴标准 storage_state JSON/),
      { target: { value: '{}' } }
    );
    fireEvent.click(importStorageBtn());
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/登录态导入失败：.*大小超限/)
      )
    );
  });
});

describe('列表展示', () => {
  it('书签列表展开：行渲染（name/folder_path/url），再次点击收起', async () => {
    mockTauriCommand(BROWSER_LIST_BOOKMARKS_CMD, async () => [
      {
        url: 'https://a.example',
        name: 'A 站',
        folder_path: ['书签栏', '工作'],
        guid: null,
        source: 'manual/bookmarks',
        imported_at: 1750000000,
      },
      {
        url: 'https://b.example',
        name: 'B 站',
        folder_path: [],
        guid: null,
        source: 'manual/bookmarks',
        imported_at: 1750000100,
      },
    ]);
    renderSection();
    fireEvent.click(bookmarksListBtn());
    await waitFor(() =>
      expect(screen.getByText('共 2 条（导入时间倒序）')).toBeTruthy()
    );
    expect(screen.getByText('A 站')).toBeTruthy();
    expect(screen.getByText('书签栏 / 工作')).toBeTruthy();
    expect(screen.getByText('（顶层）')).toBeTruthy();
    expect(screen.getByText('https://a.example')).toBeTruthy();
    fireEvent.click(bookmarksListBtn());
    await waitFor(() => expect(screen.queryByText('共 2 条')).toBeNull());
  });

  it('历史列表：limit 输入生效（透传 limit），行渲染 visited_at 格式化', async () => {
    const impl = vi.fn(async () => [
      {
        url: 'https://h.example',
        visited_at: 1750000000,
        title: 'H 页',
        source: 'manual/history',
        imported_at: 1750000200,
      },
    ]);
    mockTauriCommand(BROWSER_LIST_HISTORY_CMD, impl);
    renderSection();
    fireEvent.click(historyListBtn());
    // 展开即按默认 limit=50 加载
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(1));
    expect(impl).toHaveBeenCalledWith({ limit: 50 });
    await waitFor(() =>
      expect(screen.getByText(/共 1 条（visited_at 倒序/)).toBeTruthy()
    );
    expect(screen.getByText('H 页')).toBeTruthy();
    expect(screen.getByText('https://h.example')).toBeTruthy();
    // visited_at 本地时间渲染（时区无关：仅断言形状）
    expect(screen.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeTruthy();

    // 修改 limit 后点「刷新」→ 新 limit 透传
    fireEvent.change(screen.getByRole('spinbutton', { name: 'limit' }), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(2));
    expect(impl).toHaveBeenLastCalledWith({ limit: 30 });
  });

  it('历史列表 limit 非法 → 回落默认 50', async () => {
    const impl = vi.fn(async () => []);
    mockTauriCommand(BROWSER_LIST_HISTORY_CMD, impl);
    renderSection();
    fireEvent.click(historyListBtn());
    await waitFor(() => expect(impl).toHaveBeenCalledWith({ limit: 50 }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'limit' }), {
      target: { value: 'abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(2));
    expect(impl).toHaveBeenLastCalledWith({ limit: 50 });
  });

  it('列表加载报错 → toast', async () => {
    mockTauriError(
      BROWSER_LIST_BOOKMARKS_CMD,
      new Error('书签列表失败: internal')
    );
    const { onShowToast } = renderSection();
    fireEvent.click(bookmarksListBtn());
    await waitFor(() =>
      expect(onShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/书签列表加载失败：/)
      )
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('browserRunning 门禁', () => {
  it('未运行浏览器：登录态导入/导出禁用，书签/历史不受影响', async () => {
    renderSection({ browserRunning: false });
    expect(exportBtn()).toBeDisabled();
    expect(importStorageBtn()).toBeDisabled();

    attachFileInput('bookmarks-file-input', makeFile('b.json', '{}'));
    await waitFor(() => expect(importBookmarksBtn()).toBeEnabled());
    fireEvent.change(screen.getByLabelText('History 库路径'), {
      target: { value: 'C:\\History' },
    });
    expect(importHistoryBtn()).toBeEnabled();
  });

  it('运行中：登录态导入/导出可用', async () => {
    renderSection({ browserRunning: true });
    expect(exportBtn()).toBeEnabled();
    expect(importStorageBtn()).toBeDisabled(); // 仍需 JSON 内容
  });
});
