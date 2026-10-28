// @vitest-environment jsdom
/**
 * TrashSection 误删恢复面板测试（I3-S9 任务 3）。
 *
 * 覆盖点：
 * - trash_list 数据源渲染：路径 / 删除时间 / 类型 / 大小 / 校验和；
 * - 空列表空态、加载态；
 * - 恢复按钮 → trash_restore（带 sessionId）+ 成功后刷新；
 * - 清除按钮 → trash_purge + 成功后刷新；
 * - 动作失败 → toast（成功静默）。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { TrashSection } from './TrashSection';
import * as trashApi from '../../api/trashApi';
// 会话域（activeSessionId）真源为 SessionStore；layoutStore 已纯化为壳层
// chrome 域（无 sessions/activeSessionId 字段）。
import { useSessionStore } from '../../store/sessionStore';
import type { TrashEntryDto } from '../../api/trashApi';

vi.mock('../../api/trashApi', () => ({
  listTrashEntries: vi.fn(),
  restoreTrashEntry: vi.fn(),
  purgeTrashEntry: vi.fn(),
  formatTrashedAt: vi.fn(),
}));

// toast 通道：TrashSectionProps 已无 onShowToast，组件内 `const { showToast } =
// useToast()`（TrashSection.tsx:34）。打桩 hook 保持真实链路（含 onUndo/options
// 形参），而非注入已废弃的 prop。
const { toastSpies } = vi.hoisted(() => ({
  toastSpies: { showToast: vi.fn(), show: vi.fn() },
}));
vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: toastSpies.showToast }),
  toast: { show: toastSpies.show },
}));

const mockList = vi.mocked(trashApi.listTrashEntries);
const mockRestore = vi.mocked(trashApi.restoreTrashEntry);
const mockPurge = vi.mocked(trashApi.purgeTrashEntry);

const fileEntry: TrashEntryDto = {
  id: 'e1',
  originalPath: 'C:/repo/src/a.txt',
  trashedAt: 1754200000000,
  kind: 'file',
  size: 2048,
  checksum: 'abc123',
};

const dirEntry: TrashEntryDto = {
  id: 'e2',
  originalPath: 'C:/repo/dist',
  trashedAt: 1754190000000,
  kind: 'dir',
  size: 5 * 1024 * 1024,
};

function renderSection() {
  const utils = render(<TrashSection />);
  return { toast: toastSpies.showToast, ...utils };
}

beforeEach(() => {
  useSessionStore.setState((st) => {
    st.activeSessionId = 'sess-1';
  });
  toastSpies.showToast.mockReset();
  mockList.mockResolvedValue({
    entries: [fileEntry, dirEntry],
    trashRoot: 'C:/trash',
  });
  mockRestore.mockReset();
  mockPurge.mockReset();
  vi.mocked(trashApi.formatTrashedAt).mockImplementation((ms) =>
    ms === fileEntry.trashedAt ? '08-03 12:00' : '08-03 10:00'
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TrashSection 数据源渲染（trash_list 接线）', () => {
  it('挂载即拉取 trash_list；条目渲染路径/时间/类型/大小/校验和', async () => {
    renderSection();

    expect(mockList).toHaveBeenCalledTimes(1);
    const rows = await screen.findAllByTestId('trash-entry');
    expect(rows).toHaveLength(2);

    // 文件条目：路径 + 时间 · 文件 · 大小 · 有校验和
    expect(screen.getByText('C:/repo/src/a.txt')).toBeInTheDocument();
    expect(
      screen.getByText('08-03 12:00 · 文件 · 2.0 KB · 有校验和')
    ).toBeInTheDocument();
    // 目录条目：无 checksum → 不显示校验和
    expect(screen.getByText('C:/repo/dist')).toBeInTheDocument();
    expect(screen.getByText('08-03 10:00 · 目录 · 5.0 MB')).toBeInTheDocument();
    // 区段计数
    expect(screen.getByText('2 项')).toBeInTheDocument();
  });

  it('空列表：空态文案（回收站为空）', async () => {
    mockList.mockResolvedValue({ entries: [], trashRoot: '' });
    renderSection();

    expect(await screen.findByText('回收站为空')).toBeInTheDocument();
    expect(screen.queryByTestId('trash-entry')).not.toBeInTheDocument();
  });

  it('工作区授权失败时显示错误，不显示回收站为空', async () => {
    mockList.mockRejectedValueOnce(new Error('当前工作区授权未完成，请重试。'));
    const { toast } = renderSection();

    expect(
      await screen.findByText('读取回收站失败：当前工作区授权未完成，请重试。')
    ).toBeInTheDocument();
    expect(screen.queryByText('回收站为空')).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith(
      '读取回收站失败：当前工作区授权未完成，请重试。',
      undefined,
      { type: 'error' }
    );
  });

  it('刷新失败时保留已加载条目并通知读取错误', async () => {
    mockList
      .mockResolvedValueOnce({
        entries: [fileEntry],
        trashRoot: 'C:/trash',
      })
      .mockRejectedValueOnce(new Error('磁盘读取失败'));
    mockRestore.mockResolvedValue({
      ok: true,
      data: { ok: true, originalPath: fileEntry.originalPath },
    });
    const { toast } = renderSection();
    const row = await screen.findByTestId('trash-entry');
    fireEvent.click(withinRow(row, '恢复 C:/repo/src/a.txt'));

    expect(
      await screen.findByText('回收站刷新失败：磁盘读取失败')
    ).toBeInTheDocument();
    expect(screen.getByTestId('trash-entry')).toBeInTheDocument();
    expect(screen.queryByText('回收站为空')).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith(
      '读取回收站失败：磁盘读取失败',
      undefined,
      { type: 'error' }
    );
  });
});

describe('TrashSection 恢复 / 清除动作', () => {
  it('恢复按钮：trash_restore（带 sessionId）+ 成功后刷新列表', async () => {
    mockRestore.mockResolvedValue({
      ok: true,
      data: { ok: true, originalPath: 'C:/repo/src/a.txt' },
    });
    renderSection();

    const rows = await screen.findAllByTestId('trash-entry');
    fireEvent.click(withinRow(rows[0]!, '恢复 C:/repo/src/a.txt'));

    await waitFor(() => {
      expect(mockRestore).toHaveBeenCalledWith('e1', 'sess-1');
    });
    // 成功后刷新（重新 list）
    await waitFor(() => {
      expect(mockList).toHaveBeenCalledTimes(2);
    });
  });

  it('恢复失败：结构化错误 toast（成功静默）', async () => {
    mockRestore.mockResolvedValue({
      ok: false,
      message: '恢复失败：目标已存在',
    });
    const { toast } = renderSection();

    const rows = await screen.findAllByTestId('trash-entry');
    fireEvent.click(withinRow(rows[0]!, '恢复 C:/repo/src/a.txt'));

    await waitFor(() => {
      // 组件以 (message, onUndo, options) 三参调用（TrashSection.tsx:67）
      expect(toast).toHaveBeenCalledWith('恢复失败：目标已存在', undefined, {
        type: 'error',
      });
    });
  });

  it('清除按钮：trash_purge + 成功后刷新', async () => {
    mockPurge.mockResolvedValue({
      ok: true,
      data: { ok: true, entryId: 'e1' },
    });
    renderSection();

    const rows = await screen.findAllByTestId('trash-entry');
    fireEvent.click(withinRow(rows[1]!, '清除 C:/repo/dist'));

    await waitFor(() => {
      expect(mockPurge).toHaveBeenCalledWith('e2', 'sess-1');
    });
    await waitFor(() => {
      expect(mockList).toHaveBeenCalledTimes(2);
    });
  });

  it('动作期间防连点（busyId 锁定其它按钮）', async () => {
    let release!: () => void;
    mockRestore.mockImplementationOnce(
      () =>
        new Promise<{ ok: true; data: { ok: true; originalPath: string } }>(
          (res) => {
            release = () =>
              res({ ok: true, data: { ok: true, originalPath: 'p' } });
          }
        )
    );
    renderSection();

    const rows = await screen.findAllByTestId('trash-entry');
    const restoreBtn = withinRow(rows[0]!, '恢复 C:/repo/src/a.txt');
    fireEvent.click(restoreBtn);

    await waitFor(() => {
      expect(mockRestore).toHaveBeenCalledTimes(1);
    });
    // busy 期间再次点击被忽略
    fireEvent.click(restoreBtn);
    expect(mockRestore).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      release();
    });
  });
});

/** 在指定行容器内查找按钮（避免同名按钮歧义） */
function withinRow(row: HTMLElement, ariaLabel: string): HTMLButtonElement {
  const btn = row.querySelector<HTMLButtonElement>(
    `button[aria-label="${ariaLabel}"]`
  );
  if (!btn) throw new Error(`row 中未找到按钮 ${ariaLabel}`);
  return btn;
}
