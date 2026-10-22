// @vitest-environment jsdom
/**
 * McpServerList 用户视角测试：实时模式（状态徽标 / 工具数 / 错误标记 / 展开工具面板 /
 * 启停按钮与不可用态 / 复制）、空态与筛选空态、加载态，以及演示模式（启用开关 / 删除 /
 * 添加入口 / 刷新）。真实渲染 McpServerToolbar / McpServerTools / McpServerFilterEmpty，
 * 回调用 vi.fn 断言。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { McpServerList, type McpServerListProps } from './McpServerList';
import type { McpServerInfo } from '../../api/mcpApi';
import type { McpServer } from '../../api/clientApi';

const RUNNING: McpServerInfo = {
  id: 'fs.local',
  name: 'Filesystem',
  state: 'running',
  tools: ['read_file', 'write_file'],
  transport: 'stdio',
};
const STOPPED: McpServerInfo = {
  id: 'git@x',
  name: 'Git',
  state: 'stopped',
  tools: [],
  toolCount: 3,
  transport: 'sse',
  lastError: 'spawn ENOENT',
};
const FAILED: McpServerInfo = {
  id: 'web',
  name: 'Web',
  state: 'failed',
  tools: [],
};

function makeProps(
  over: {
    servers?: Partial<McpServerListProps['servers']>;
    ui?: Partial<McpServerListProps['ui']>;
  } = {}
) {
  const actions = {
    onRefresh: vi.fn(),
    onSetSort: vi.fn(),
    onSetFilter: vi.fn(),
    onClearFilter: vi.fn(),
    onSetShowAdd: vi.fn(),
    onToggleServer: vi.fn(),
    onCopy: vi.fn(),
    onToggleExpanded: vi.fn(),
    onToggleDemoEnabled: vi.fn(),
    onDeleteDemo: vi.fn(),
    refreshDemo: vi.fn(),
    refreshLive: vi.fn(),
  };
  const servers = [RUNNING, STOPPED, FAILED];
  const props: McpServerListProps = {
    servers: {
      demo: false,
      loading: false,
      servers,
      status: { configured: true },
      demoServers: [],
      demoEnabled: {},
      filtered: servers,
      filteredDemo: [],
      expanded: {},
      busyId: null,
      canStartStop: true,
      ...over.servers,
    },
    ui: {
      filter: '',
      sortMode: 'name',
      showAdd: false,
      listLabelId: 'mcp-list-label',
      toolsPanelPrefix: 'mcp-tools',
      ...over.ui,
    },
    actions,
  };
  return { props, actions };
}

/** 列表区（与工具条区分：工具条也有刷新 / 添加按钮） */
function listRegion(): HTMLElement {
  return screen.getByRole('list', { name: '服务列表' });
}

function rowOf(name: string): HTMLElement {
  const btn = screen.getByRole('button', { name: `复制标识 ${name}` });
  const row = btn.closest('[role="listitem"]');
  if (!row) throw new Error(`row for ${name} not found`);
  return row as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe('McpServerList 实时模式', () => {
  it('每个服务一行：状态文案、传输方式、工具数与错误标记', () => {
    const { props } = makeProps();
    render(<McpServerList {...props} />);

    const list = screen.getByRole('list', { name: '服务列表' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list).toHaveAttribute('aria-labelledby', 'mcp-list-label');

    const fs = rowOf('Filesystem');
    expect(fs).toHaveTextContent('运行中');
    expect(fs).toHaveTextContent('stdio · 工具 2');
    expect(fs).not.toHaveTextContent('错误');

    const git = rowOf('Git');
    expect(git).toHaveTextContent('已停止');
    // toolCount 优先于 tools.length
    expect(git).toHaveTextContent('sse · 工具 3');
    expect(git).toHaveTextContent('· 错误');

    expect(rowOf('Web')).toHaveTextContent('错误');
    expect(rowOf('Web')).toHaveTextContent('工具 0');
  });

  it('运行中的服务显示停止按钮，其余显示启动按钮，点击回调带上动作', () => {
    const { props, actions } = makeProps();
    render(<McpServerList {...props} />);

    fireEvent.click(screen.getByRole('button', { name: '停止 Filesystem' }));
    expect(actions.onToggleServer).toHaveBeenLastCalledWith('fs.local', 'stop');

    fireEvent.click(screen.getByRole('button', { name: '启动 Git' }));
    expect(actions.onToggleServer).toHaveBeenLastCalledWith('git@x', 'start');

    expect(screen.queryByRole('button', { name: '停止 Git' })).toBeNull();
    expect(screen.getByRole('button', { name: '启动 Web' })).toBeEnabled();
  });

  it('启动中（starting）也视为运行中，可停止', () => {
    const starting: McpServerInfo = { ...FAILED, state: 'starting' };
    const { props } = makeProps({
      servers: { servers: [starting], filtered: [starting] },
    });
    render(<McpServerList {...props} />);
    expect(rowOf('Web')).toHaveTextContent('启动中');
    expect(
      screen.getByRole('button', { name: '停止 Web' })
    ).toBeInTheDocument();
  });

  it('busyId 对应的服务按钮禁用并标记 aria-busy', () => {
    const { props } = makeProps({ servers: { busyId: 'fs.local' } });
    render(<McpServerList {...props} />);
    const stop = screen.getByRole('button', { name: '停止 Filesystem' });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '启动 Git' })).toBeEnabled();
  });

  it('引擎不支持启停时显示禁用的「不可用」按钮', () => {
    const { props, actions } = makeProps({ servers: { canStartStop: false } });
    render(<McpServerList {...props} />);
    expect(screen.queryByRole('button', { name: /^停止 / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^启动 / })).toBeNull();
    expect(screen.getByRole('button', { name: '停止不可用' })).toBeDisabled();
    const startUnavailable = screen.getAllByRole('button', {
      name: '启动不可用',
    });
    expect(startUnavailable).toHaveLength(2);
    startUnavailable.forEach((b) => expect(b).toBeDisabled());
    expect(actions.onToggleServer).not.toHaveBeenCalled();
  });

  it('展开按钮切换工具面板：列出工具名并可复制工具名与标识', () => {
    const { props, actions } = makeProps({
      servers: { expanded: { 'fs.local': true } },
    });
    render(<McpServerList {...props} />);

    const collapse = screen.getByRole('button', {
      name: '收起 Filesystem 的工具',
    });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: 'Filesystem 的工具' });
    expect(collapse).toHaveAttribute('aria-controls', panel.id);
    expect(panel.id).toBe('mcp-tools-fs_local');

    fireEvent.click(
      within(panel).getByRole('button', { name: '复制工具名 write_file' })
    );
    expect(actions.onCopy).toHaveBeenLastCalledWith('write_file');
    fireEvent.click(
      within(panel).getByRole('button', { name: '复制标识 fs.local' })
    );
    expect(actions.onCopy).toHaveBeenLastCalledWith('fs.local');

    fireEvent.click(collapse);
    expect(actions.onToggleExpanded).toHaveBeenCalledWith('fs.local');

    // 未展开的行：按钮文案含工具数，aria-expanded=false，无面板
    const expandGit = screen.getByRole('button', { name: '展开 Git 的工具 3' });
    expect(expandGit).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Git 的工具' })).toBeNull();
  });

  it('工具未返回名称时面板说明数量；无工具时显示暂无工具', () => {
    const { props } = makeProps({
      servers: { expanded: { 'git@x': true, web: true } },
    });
    render(<McpServerList {...props} />);
    expect(
      screen.getByRole('region', { name: 'Git 的工具' })
    ).toHaveTextContent('工具 3（未返回名称）');
    expect(
      screen.getByRole('region', { name: 'Web 的工具' })
    ).toHaveTextContent('暂无工具');
  });

  it('点击服务名复制其标识', () => {
    const { props, actions } = makeProps();
    render(<McpServerList {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '复制标识 Git' }));
    expect(actions.onCopy).toHaveBeenCalledWith('git@x');
  });
});

describe('McpServerList 空态 / 筛选 / 加载', () => {
  it('已配置但无实例：显示「暂无服务实例」，刷新调用 refreshLive', () => {
    const { props, actions } = makeProps({
      servers: { servers: [], filtered: [] },
    });
    render(<McpServerList {...props} />);
    expect(screen.getByText('暂无服务实例')).toBeInTheDocument();
    fireEvent.click(
      within(listRegion()).getByRole('button', { name: '刷新列表' })
    );
    expect(actions.refreshLive).toHaveBeenCalledTimes(1);
  });

  it('引擎未配置：显示「暂无扩展服务」', () => {
    const { props } = makeProps({
      servers: { servers: [], filtered: [], status: { configured: false } },
    });
    render(<McpServerList {...props} />);
    expect(screen.getByText('暂无扩展服务')).toBeInTheDocument();
    expect(screen.queryByText('暂无服务实例')).toBeNull();
  });

  it('有服务但筛选无匹配：显示无匹配与清除筛选', () => {
    const { props, actions } = makeProps({
      servers: { filtered: [] },
      ui: { filter: 'zzz' },
    });
    render(<McpServerList {...props} />);
    expect(screen.getByText('无匹配')).toBeInTheDocument();
    expect(screen.queryByText('暂无服务实例')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(actions.onClearFilter).toHaveBeenCalled();
  });

  it('筛选词只有空白时不算筛选，不显示无匹配', () => {
    const { props } = makeProps({
      servers: { filtered: [] },
      ui: { filter: '   ' },
    });
    render(<McpServerList {...props} />);
    expect(screen.queryByText('无匹配')).toBeNull();
  });

  it('首次加载中：列表标记 aria-busy 并显示加载中，不显示空态', () => {
    const { props } = makeProps({
      servers: { loading: true, servers: [], filtered: [] },
    });
    render(<McpServerList {...props} />);
    expect(screen.getByRole('list', { name: '服务列表' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
    expect(screen.getByText('加载中…')).toBeInTheDocument();
    expect(screen.queryByText('暂无服务实例')).toBeNull();
  });
});

describe('McpServerList 演示模式', () => {
  const DEMO: McpServer[] = [
    {
      id: 'demo-a',
      name: 'Demo A',
      type: 'stdio',
      command: 'npx demo-a',
    } as McpServer,
    {
      id: 'demo-b',
      name: 'Demo B',
      type: 'sse',
      url: 'http://127.0.0.1:9000/sse',
    } as McpServer,
  ];

  it('渲染演示服务：启用态、传输与命令 / URL，开关与删除回调', () => {
    const { props, actions } = makeProps({
      servers: {
        demo: true,
        demoServers: DEMO,
        filteredDemo: DEMO,
        demoEnabled: { 'demo-b': false },
      },
    });
    render(<McpServerList {...props} />);

    const a = rowOf('Demo A');
    expect(a).toHaveTextContent('启用');
    expect(a).toHaveTextContent('stdio · npx demo-a');
    const b = rowOf('Demo B');
    expect(b).toHaveTextContent('禁用');
    expect(b).toHaveTextContent('sse · http://127.0.0.1:9000/sse');

    const swA = screen.getByRole('switch', { name: '禁用 Demo A' });
    expect(swA).toBeChecked();
    expect(
      screen.getByRole('switch', { name: '启用 Demo B' })
    ).not.toBeChecked();
    fireEvent.click(swA);
    expect(actions.onToggleDemoEnabled).toHaveBeenCalledWith('demo-a');

    fireEvent.click(screen.getByRole('button', { name: '删除 Demo B' }));
    expect(actions.onDeleteDemo).toHaveBeenCalledWith('demo-b');

    // 演示模式没有启停按钮
    expect(screen.queryByRole('button', { name: /^启动 / })).toBeNull();
  });

  it('演示空态：可打开添加表单与刷新；加载中时显示加载态', () => {
    const { props, actions } = makeProps({ servers: { demo: true } });
    const { rerender } = render(<McpServerList {...props} />);
    fireEvent.click(
      within(listRegion()).getByRole('button', { name: '添加演示服务' })
    );
    expect(actions.onSetShowAdd).toHaveBeenCalledWith(true);
    fireEvent.click(
      within(listRegion()).getByRole('button', { name: '刷新列表' })
    );
    expect(actions.refreshDemo).toHaveBeenCalledTimes(1);

    rerender(
      <McpServerList {...props} servers={{ ...props.servers, loading: true }} />
    );
    expect(
      within(listRegion()).queryByRole('button', { name: '添加演示服务' })
    ).toBeNull();
    expect(within(listRegion()).getByText('加载中…')).toBeInTheDocument();
  });
});
