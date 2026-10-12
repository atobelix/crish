// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsArchiveTab } from './SettingsArchiveTab';

const mockShowToast = vi.fn();
vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const mockUnarchiveSession = vi.fn();
const mockOpenSession = vi.fn();
const mockCloseSettings = vi.fn();
const mockDeleteSessionCascade = vi.fn();

vi.mock('../sidebar/session-list/sessionListUtils', () => ({
  sessionListProjectLabel: (folder?: string) =>
    folder === 'proj-1' ? 'Work Project' : '常规会话',
}));

vi.mock('../../store/storeAccess', () => ({
  closeSettings: () => mockCloseSettings(),
  deleteSessionCascade: (id: string) => mockDeleteSessionCascade(id),
  listProjects: () => [{ id: 'proj-1', name: 'Work Project' }],
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector(mockSessionStoreState),
}));

vi.mock('../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    session: {
      unarchiveSession: mockUnarchiveSession,
    },
    shell: {
      openSession: mockOpenSession,
    },
  }),
}));

let mockSessionStoreState = {
  sessions: [] as Array<{
    id: string;
    title: string;
    isArchived?: boolean;
    folder?: string;
    updatedAt?: number;
    messages?: Array<{ text: string }>;
  }>,
};

describe('SettingsArchiveTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStoreState = {
      sessions: [],
    };
  });

  it('空状态：无已归档对话时展示空态提示', () => {
    render(<SettingsArchiveTab />);
    expect(screen.getByText('暂无已归档对话')).toBeInTheDocument();
    expect(screen.queryByTestId('archive-restore-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('archive-clear-all')).not.toBeInTheDocument();
  });

  it('展示归档列表并支持关键字搜索过滤', () => {
    mockSessionStoreState.sessions = [
      {
        id: 'sess-1',
        title: '架构重构规划',
        isArchived: true,
        folder: 'proj-1',
        updatedAt: 1000,
        messages: [{ text: 'hello' }],
      },
      {
        id: 'sess-2',
        title: '日常琐事记录',
        isArchived: true,
        updatedAt: 2000,
        messages: [],
      },
      {
        id: 'sess-3',
        title: '活跃会话',
        isArchived: false,
        updatedAt: 3000,
      },
    ];

    render(<SettingsArchiveTab />);
    expect(screen.getByText('架构重构规划')).toBeInTheDocument();
    expect(screen.getByText('日常琐事记录')).toBeInTheDocument();
    expect(screen.queryByText('活跃会话')).not.toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText('搜索…');
    fireEvent.change(searchInput, { target: { value: '重构' } });

    expect(screen.getByText('架构重构规划')).toBeInTheDocument();
    expect(screen.queryByText('日常琐事记录')).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: '不存在的会话' } });
    expect(screen.getByText(/无匹配「不存在的会话」/)).toBeInTheDocument();
  });

  it('点击“打开”：解归档并打开会话且关闭设置', () => {
    mockSessionStoreState.sessions = [
      {
        id: 'sess-1',
        title: '测试归档',
        isArchived: true,
        folder: 'proj-1',
      },
    ];

    render(<SettingsArchiveTab />);
    const openBtn = screen.getByTestId('archive-open-sess-1');
    fireEvent.click(openBtn);

    expect(mockUnarchiveSession).toHaveBeenCalledWith('sess-1');
    expect(mockOpenSession).toHaveBeenCalledWith('sess-1', {
      title: '测试归档',
      workspaceKey: 'proj-1',
    });
    expect(mockCloseSettings).toHaveBeenCalled();
  });

  it('点击“还原”：还原单条会话至侧栏', () => {
    mockSessionStoreState.sessions = [
      {
        id: 'sess-1',
        title: '测试还原',
        isArchived: true,
      },
    ];

    render(<SettingsArchiveTab />);
    const restoreBtn = screen.getByTestId('archive-restore-sess-1');
    fireEvent.click(restoreBtn);

    expect(mockUnarchiveSession).toHaveBeenCalledWith('sess-1');
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('已还原对话: 测试还原')
    );
  });

  it('点击“全部还原”：批量还原全部归档会话', () => {
    mockSessionStoreState.sessions = [
      { id: 'sess-1', title: '会话 1', isArchived: true },
      { id: 'sess-2', title: '会话 2', isArchived: true },
    ];

    render(<SettingsArchiveTab />);
    const restoreAllBtn = screen.getByTestId('archive-restore-all');
    fireEvent.click(restoreAllBtn);

    expect(mockUnarchiveSession).toHaveBeenCalledWith('sess-1');
    expect(mockUnarchiveSession).toHaveBeenCalledWith('sess-2');
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('已还原 2 个对话')
    );
  });

  it('点击删除并确认：触发级联删除与 Toast', () => {
    mockSessionStoreState.sessions = [
      { id: 'sess-1', title: '待删除会话', isArchived: true },
    ];

    render(<SettingsArchiveTab />);
    const deleteBtn = screen.getByTestId('archive-delete-sess-1');
    fireEvent.click(deleteBtn);

    expect(screen.getByText('删除对话')).toBeInTheDocument();
    expect(
      screen.getByText(/确定要永久删除对话“待删除会话”吗/)
    ).toBeInTheDocument();

    const confirmBtn = screen.getByText('确认删除');
    fireEvent.click(confirmBtn);

    expect(mockDeleteSessionCascade).toHaveBeenCalledWith('sess-1');
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('已删除对话: 待删除会话')
    );
  });

  it('清空全部并确认：触发批量级联删除', () => {
    mockSessionStoreState.sessions = [
      { id: 'sess-1', title: '会话 1', isArchived: true },
      { id: 'sess-2', title: '会话 2', isArchived: true },
    ];

    render(<SettingsArchiveTab />);
    const clearAllBtn = screen.getByTestId('archive-clear-all');
    fireEvent.click(clearAllBtn);

    expect(screen.getByText('清空已归档对话')).toBeInTheDocument();
    expect(
      screen.getByText(/确定要永久删除全部 2 个已归档对话吗/)
    ).toBeInTheDocument();

    const confirmBtn = screen.getByText('全部删除');
    fireEvent.click(confirmBtn);

    expect(mockDeleteSessionCascade).toHaveBeenCalledWith('sess-1');
    expect(mockDeleteSessionCascade).toHaveBeenCalledWith('sess-2');
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('已清空 2 个归档对话')
    );
  });
});
