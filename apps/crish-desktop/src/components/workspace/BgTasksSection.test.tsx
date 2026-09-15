// @vitest-environment jsdom
/**
 * BgTasksSection 后台常驻区段测试（重建版，34 文档 DD5-T2a 前端装配测试）。
 *
 * 重建缘由：本文件是 F12 编码事故误伤对象（A6 F-10/B-24 已登记）——原内容
 * 为 UTF-8 被按 GBK 误解码后写盘，中文全部损坏（实测含替换字符）且无法恢复
 * 原文，故按既有用例语义整体重建（UTF-8 无 BOM），并新增 suspicious 装配用例。
 *
 * 覆盖点（4 类既有语义 + suspicious 2 态真实装配路径）：
 * - 空态：在线 / 离线空列表提示，空列表不渲染计数标签；
 * - 渲染与状态展示：区段标题 / 任务行（标题 + 状态与命令 meta）/ 计数标签；
 * - 操作交互：点击任务行 → 读取输出 → 打开终端（打开期间 busy、防连点互斥）；
 * - 读取失败：仍打开终端（回退 command 摘要）+ 错误 toast；
 * - suspicious 装配：wire 原始对象经 parseBackgroundTask 真实解析 → 区段行
 *   渲染「疑似卡死」标记（true 有 / false 或缺省无），走 task.suspicious
 *   字段路径，非 props 注入。
 *
 * mock 面：仅替换出站边界 getBackgroundTaskOutput / openBackgroundTaskInTerminal
 * （34 §0 可信标准：真实渲染 + 不 mock 被测逻辑，解析链保持真实实现）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BgTasksSection } from './BgTasksSection';
import { errorStore } from '../../services/ErrorStore';
import {
  parseBackgroundTask,
  type BackgroundTaskInfo,
} from '../../api/backgroundTasksApi';

vi.mock('../../api/backgroundTasksApi', async () => {
  const actual = await vi.importActual('../../api/backgroundTasksApi');
  return {
    ...actual,
    getBackgroundTaskOutput: vi.fn(),
    openBackgroundTaskInTerminal: vi.fn(),
  };
});

// toast 通道：BgTasksSectionProps 已无 onShowToast，组件内 `const { showToast } =
// useToast()`（BgTasksSection.tsx:36,57）。打桩 hook 保持真实链路，而非注入
// 已废弃的 prop（后者会被忽略，toast 落到 fallback 单例上、断言恒 0 次）。
const { toastSpies } = vi.hoisted(() => ({
  toastSpies: { showToast: vi.fn(), show: vi.fn() },
}));
vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: toastSpies.showToast }),
  toast: { show: toastSpies.show },
}));

import {
  getBackgroundTaskOutput,
  openBackgroundTaskInTerminal,
} from '../../api/backgroundTasksApi';

const mockedGetOutput = vi.mocked(getBackgroundTaskOutput);
const mockedOpenTerminal = vi.mocked(openBackgroundTaskInTerminal);

function task(
  partial: Partial<BackgroundTaskInfo> & Pick<BackgroundTaskInfo, 'id'>,
): BackgroundTaskInfo {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    state: partial.state ?? 'running',
    ...(partial.command !== undefined && { command: partial.command }),
    ...(partial.suspicious !== undefined && { suspicious: partial.suspicious }),
  };
}

function renderSection(opts: {
  bgTasks: BackgroundTaskInfo[];
  countLabel?: string | null;
}) {
  return render(
    <BgTasksSection
      bgTasks={opts.bgTasks}
      countLabel={opts.countLabel ?? null}
    />,
  );
}

/** D2（C-10）：连接态投影（errorStore 真源）——组件不再接收 engineOnline prop */
function setEngineConnection(status: 'connected' | 'disconnected'): void {
  errorStore.setConnectionStatus(status);
}

beforeEach(() => {
  mockedGetOutput.mockReset();
  mockedOpenTerminal.mockReset();
  toastSpies.showToast.mockReset();
  // 默认在线；离线用例显式设置
  setEngineConnection('connected');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BgTasksSection 空态', () => {
  it('空列表（引擎在线）→ 空态提示「暂无后台任务」，且不渲染计数标签', () => {
    renderSection({ bgTasks: [] });
    expect(screen.getByRole('status')).toHaveTextContent('暂无后台任务');
    expect(screen.queryByLabelText(/个后台任务/)).not.toBeInTheDocument();
  });

  it('空列表（引擎离线）→ 空态提示「未连接」', () => {
    setEngineConnection('disconnected');
    renderSection({ bgTasks: [] });
    expect(screen.getByRole('status')).toHaveTextContent('未连接');
  });
});

describe('BgTasksSection 渲染与状态展示', () => {
  it('渲染区段标题 / 任务行（标题 + 状态与命令 meta）/ 计数标签', () => {
    renderSection({
      bgTasks: [
        task({ id: 'a', label: 'Vite', state: 'running', command: 'npm run dev' }),
        task({ id: 'b', label: 'Build', state: 'failed', command: 'npm run build' }),
      ],
      countLabel: '2',
    });
    expect(screen.getByRole('heading', { name: '后台常驻' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText('Vite')).toBeInTheDocument();
    expect(screen.getByText('运行中 · npm run dev')).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('失败 · npm run build')).toBeInTheDocument();
    const count = screen.getByLabelText('2 个后台任务');
    expect(count).toHaveTextContent('2');
  });
});

describe('BgTasksSection 操作交互', () => {
  it('点击任务行 → 读取输出并打开终端（打开期间 busy，完成后清除）', async () => {
    let resolveOut!: (v: string) => void;
    mockedGetOutput.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveOut = resolve; }),
    );
    renderSection({ bgTasks: [task({ id: 'a', label: 'Vite', state: 'running' })] });

    const row = screen.getByRole('button', { name: 'Vite，运行中，在终端中查看输出' });
    fireEvent.click(row);
    expect(mockedGetOutput).toHaveBeenCalledWith('a');
    // 打开期间任务行进 busy 态（防连点互斥生效中）
    expect(row).toHaveAttribute('aria-busy', 'true');

    resolveOut('tail line');
    await waitFor(() => {
      expect(row).not.toHaveAttribute('aria-busy');
    });
    expect(mockedOpenTerminal).toHaveBeenCalledWith('Vite', 'tail line');
  });

  it('防连点：打开期间再次点击不发起第二次读取', async () => {
    let resolveOut!: (v: string) => void;
    mockedGetOutput.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveOut = resolve; }),
    );
    renderSection({ bgTasks: [task({ id: 'a', label: 'Vite', state: 'running' })] });

    const row = screen.getByRole('button', { name: 'Vite，运行中，在终端中查看输出' });
    fireEvent.click(row);
    fireEvent.click(row);
    expect(mockedGetOutput).toHaveBeenCalledTimes(1);
    expect(row).toHaveAttribute('aria-busy', 'true');

    resolveOut('tail line');
    await waitFor(() => {
      expect(row).not.toHaveAttribute('aria-busy');
    });
    expect(mockedOpenTerminal).toHaveBeenCalledTimes(1);
    expect(mockedOpenTerminal).toHaveBeenCalledWith('Vite', 'tail line');
  });
});

describe('BgTasksSection 读取失败回退', () => {
  it('读取失败 → 仍打开终端（回退 command 摘要）+ 错误 toast', async () => {
    mockedGetOutput.mockRejectedValueOnce(new Error('boom'));
    renderSection({
      bgTasks: [
        task({ id: 'a', label: 'Vite', state: 'running', command: 'npm run dev' }),
      ],
    });

    const row = screen.getByRole('button', { name: 'Vite，运行中，在终端中查看输出' });
    fireEvent.click(row);
    await waitFor(() => {
      expect(row).not.toHaveAttribute('aria-busy');
    });
    expect(mockedOpenTerminal).toHaveBeenCalledWith('Vite', 'npm run dev');
    expect(toastSpies.showToast).toHaveBeenCalledWith('读取后台任务输出失败');
  });
});

describe('BgTasksSection suspicious 装配（wire → parse → 卡片）', () => {
  it('suspicious:true 经真实解析路径 → 任务行渲染「疑似卡死」标记', () => {
    // wire 原始形状（轮询快照），走真实 parseBackgroundTask，非 props 注入
    const parsed = parseBackgroundTask({
      taskId: 't1',
      status: 'running',
      label: 'Serve',
      command: 'node serve.js',
      suspicious: true,
    });
    expect(parsed?.label).toBe('Serve');
    expect(parsed?.suspicious).toBe(true);
    renderSection({ bgTasks: parsed ? [parsed] : [] });

    const marker = screen.getByText('疑似卡死');
    expect(marker).toBeInTheDocument();
    // 标记落在对应任务行内（角色按钮行，aria 同步声明）
    const row = screen.getByRole('button', {
      name: 'Serve，运行中，疑似卡死，在终端中查看输出',
    });
    expect(row).toContainElement(marker);
  });

  it('suspicious:false 与缺省 → 均无「疑似卡死」标记（对照态）', () => {
    const parsed = [
      parseBackgroundTask({
        taskId: 't2',
        status: 'running',
        label: 'Watch',
        suspicious: false,
      }),
      parseBackgroundTask({
        taskId: 't3',
        status: 'running',
        label: 'Build',
        command: 'npm run build',
      }),
    ].filter((t): t is BackgroundTaskInfo => t !== null);
    renderSection({ bgTasks: parsed, countLabel: '2' });

    expect(screen.queryByText('疑似卡死')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Watch，运行中，在终端中查看输出' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Build，运行中，在终端中查看输出' }),
    ).toBeInTheDocument();
  });

  it('混合列表：仅 suspicious:true 的任务行带标记（一对一断言）', () => {
    const parsed = [
      parseBackgroundTask({
        taskId: 't1',
        status: 'running',
        label: 'Serve',
        suspicious: true,
      }),
      parseBackgroundTask({
        taskId: 't2',
        status: 'running',
        label: 'Watch',
      }),
    ].filter((t): t is BackgroundTaskInfo => t !== null);
    renderSection({ bgTasks: parsed });

    expect(screen.getAllByText('疑似卡死')).toHaveLength(1);
    const suspiciousRow = screen.getByRole('button', {
      name: 'Serve，运行中，疑似卡死，在终端中查看输出',
    });
    expect(suspiciousRow).toContainElement(screen.getByText('疑似卡死'));
    expect(
      screen.getByRole('button', { name: 'Watch，运行中，在终端中查看输出' }),
    ).toBeInTheDocument();
  });
});
