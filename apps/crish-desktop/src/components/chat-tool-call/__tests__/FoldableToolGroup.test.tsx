// @vitest-environment jsdom
/**
 * FoldableToolGroup.test.tsx
 *
 * 意图组容器组件测试（P4 方案 & M-01 静态身份确定律 & J9 无统计裁决）。
 * 验证：
 * 1. 组头自然语言标题 groupTitle（彻底去除「已运行 N 条命令」/「共 N 项工具」等计数与耗时文案）；
 * 2. 6px 聚合状态点仲裁（P0 running > P1 error > P2 pending > P3 success）；
 * 3. M-01 静态身份确定律：从第 1 项起恒定渲染组头 + 组体，杜绝 DOM 裂变跳动；
 * 4. isSealed 封口自动收敛折叠；
 * 5. 键盘 Enter/Space 与 focusCapture 无障碍切换；
 * 6. 视口平滑回退保护。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { FoldableToolGroup } from '../FoldableToolGroup';
import { clearGroupStateLedger } from '../../chat-message-list/useChatMessageState';
import type { ToolRenderItem } from '../../../api/toolPresentation';
import type { MessageToolCall } from '../../../store/types';

function tc(
  id: string,
  name: string,
  status: MessageToolCall['status'],
  extra?: Partial<MessageToolCall>
): MessageToolCall {
  return { id, name, status, arguments: '', ...extra };
}

function baseHostProps() {
  return {
    agents: [],
    activeSessionId: 's1',
    expandedTools: {},
    onToggleTool: vi.fn(),
    approvalBusy: false,
    items: [],
  };
}

describe('FoldableToolGroup 意图组容器测试', () => {
  beforeEach(() => {
    clearGroupStateLedger();
  });
  it('默认折叠：首屏展示自然语言 groupTitle 并保持折叠态（无任何计数与耗时）', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'success', {
          intent: '安装项目依赖',
          arguments: '{"CommandLine":"npm install"}',
        }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'success', {
          intent: '执行类型检查',
          arguments: '{"CommandLine":"npm run typecheck"}',
        }),
      },
    ];

    const { getByTestId, queryByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        groupTitle="环境准备与门禁检查"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    expect(root.getAttribute('data-expanded')).toBe('false');

    // 验证自然语言标题（S1b：标题文本现居 ticker 单元格内文本段）
    const label = root.querySelector('[class*="tickerCellText"]');
    expect(label?.textContent).toBe('环境准备与门禁检查');
    // 零计数统计防回归：不得包含步数或命令计数
    expect(root.textContent).not.toContain('已运行');
    expect(root.textContent).not.toContain('条命令');
    expect(root.textContent).not.toContain('共 2 项');

    // 默认折叠时具有 hidden="until-found" 属性以支持页面查找穿透
    const body = root.querySelector('[class*="groupBody"]');
    expect(body?.getAttribute('hidden')).toBe('until-found');
    expect(body?.getAttribute('data-expanded')).toBe('false');

    // 不再渲染旧版的 errorBadge
    expect(queryByTestId('tool-group-error-badge')).toBeNull();
  });

  it('未显式传入 groupTitle 时，自动从首项工具的 group 或 intent 剥离引用提取', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'read_file', 'success', {
          intent: '正在查看 [App.tsx](src/App.tsx) 核心渲染逻辑',
        }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'read_file', 'success', {
          intent: '检查辅助工具',
        }),
      },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    const label = root.querySelector('[class*="tickerCellText"]');
    // 自动剥离 Markdown 引用链接语法，纯净提取主文本
    expect(label?.textContent).toBe('正在查看 App.tsx 核心渲染逻辑');
  });

  it('点击标题行可切换展开与收起，并通知 onInvalidate', () => {
    const onInvalidate = vi.fn();
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'find_by_name', 'success', { intent: '查找源文件' }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'grep_search', 'success', { intent: '检索调用点' }),
      },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        groupTitle="代码探索"
        hostProps={{ ...baseHostProps(), items }}
        onInvalidate={onInvalidate}
      />
    );

    const root = getByTestId('foldable-tool-group');
    const header = root.querySelector('[class*="groupHeader"]') as HTMLElement;
    expect(header).toBeTruthy();

    // 点击展开
    fireEvent.click(header);
    expect(root.getAttribute('data-expanded')).toBe('true');
    expect(onInvalidate).toHaveBeenCalledTimes(1);

    const body = root.querySelector('[class*="groupBody"]');
    expect(body?.hasAttribute('hidden')).toBe(false);
    expect(body?.getAttribute('data-expanded')).toBe('true');

    // 再次点击收起
    fireEvent.click(header);
    expect(root.getAttribute('data-expanded')).toBe('false');
    expect(onInvalidate).toHaveBeenCalledTimes(2);

    // 折叠过渡结束后 (transitionend) 打上 hidden="until-found"
    fireEvent.transitionEnd(body!, { propertyName: 'grid-template-rows' });
    expect(body?.getAttribute('hidden')).toBe('until-found');
    expect(body?.getAttribute('data-expanded')).toBe('false');
  });

  it('键盘 Enter / Space 可触发展开折叠切换', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'view_file', 'success', { intent: '浏览文件' }),
      },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        groupTitle="阅读源码"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    const header = root.querySelector('[class*="groupHeader"]') as HTMLElement;

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(root.getAttribute('data-expanded')).toBe('true');

    fireEvent.keyDown(header, { key: ' ' });
    expect(root.getAttribute('data-expanded')).toBe('false');
  });

  it('M-01 静态身份确定律：单项工具也恒定渲染组头与组体，杜绝 DOM 裂变跳动', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'read_file', 'running', {
          intent: '读取配置文件',
        }),
      },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        groupTitle="读取配置"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    // 恒定存在组头，不出现单工具直出时的裂变属性
    expect(root.querySelector('[class*="groupHeader"]')).not.toBeNull();
    expect(root.getAttribute('data-single-tool')).toBeNull();
    expect(root.querySelector('[class*="tickerCellText"]')?.textContent).toBe('读取配置');
  });

  it('封口信号 isSealed 到达且工具非 running 时自动收敛折叠 (工具数 > 3)', () => {
    const runningItems: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'running', { intent: '运行单元测试 1' }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'running', { intent: '运行单元测试 2' }),
      },
      {
        kind: 'single',
        tc: tc('t3', 'run_command', 'running', { intent: '运行单元测试 3' }),
      },
      {
        kind: 'single',
        tc: tc('t4', 'run_command', 'running', { intent: '运行单元测试 4' }),
      },
    ];
    const completedItems: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'success', { intent: '单元测试通过 1' }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'success', { intent: '单元测试通过 2' }),
      },
      {
        kind: 'single',
        tc: tc('t3', 'run_command', 'success', { intent: '单元测试通过 3' }),
      },
      {
        kind: 'single',
        tc: tc('t4', 'run_command', 'success', { intent: '单元测试通过 4' }),
      },
    ];

    const { getByTestId, rerender } = render(
      <FoldableToolGroup
        items={runningItems}
        msgId="m1"
        groupTitle="测试套件"
        hostProps={{ ...baseHostProps(), items: runningItems }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    // 运行态默认折叠（2026-11-06 裁决第 8 条）：运行中不直出展开
    expect(root.getAttribute('data-expanded')).toBe('false');

    // 收到 isSealed=true 且全部完成且 >3 工具 → 保持折叠（全程未被顶开）
    rerender(
      <FoldableToolGroup
        items={completedItems}
        msgId="m1"
        groupTitle="测试套件"
        isSealed={true}
        hostProps={{ ...baseHostProps(), items: completedItems }}
      />
    );
    expect(root.getAttribute('data-expanded')).toBe('false');
  });

  it('运行态默认折叠（2026-11-06 裁决第 8 条）：未封口全程折叠、items 增减不改变展开状态、用户手动展开后不被收敛', () => {
    const runningItems: ToolRenderItem[] = [
      { kind: 'single', tc: tc('t1', 'run_command', 'running', { intent: '测试 1' }) },
      { kind: 'single', tc: tc('t2', 'run_command', 'running', { intent: '测试 2' }) },
      { kind: 'single', tc: tc('t3', 'run_command', 'running', { intent: '测试 3' }) },
      { kind: 'single', tc: tc('t4', 'run_command', 'running', { intent: '测试 4' }) },
    ];
    const completedItems: ToolRenderItem[] = [
      { kind: 'single', tc: tc('t1', 'run_command', 'success', { intent: '测试 1' }) },
      { kind: 'single', tc: tc('t2', 'run_command', 'success', { intent: '测试 2' }) },
      { kind: 'single', tc: tc('t3', 'run_command', 'success', { intent: '测试 3' }) },
      { kind: 'single', tc: tc('t4', 'run_command', 'success', { intent: '测试 4' }) },
    ];
    const grownItems: ToolRenderItem[] = [
      ...completedItems,
      { kind: 'single', tc: tc('t5', 'run_command', 'running', { intent: '测试 5' }) },
    ];

    const { getByTestId, rerender } = render(
      <FoldableToolGroup
        items={runningItems}
        msgId="m_live"
        groupTitle="运行态折叠测试"
        isSealed={false}
        hostProps={{ ...baseHostProps(), items: runningItems }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    // 运行中：默认折叠（旧「视线保护」运行顶开已退役）
    expect(root.getAttribute('data-expanded')).toBe('false');

    // 工具陆续完成、仍未封口 → 展开状态不变（恒折叠）
    rerender(
      <FoldableToolGroup
        items={completedItems}
        msgId="m_live"
        groupTitle="运行态折叠测试"
        isSealed={false}
        hostProps={{ ...baseHostProps(), items: completedItems }}
      />
    );
    expect(root.getAttribute('data-expanded')).toBe('false');

    // 新工具到达（items 增加）→ 展开状态不变（恒折叠）
    rerender(
      <FoldableToolGroup
        items={grownItems}
        msgId="m_live"
        groupTitle="运行态折叠测试"
        isSealed={false}
        hostProps={{ ...baseHostProps(), items: grownItems }}
      />
    );
    expect(root.getAttribute('data-expanded')).toBe('false');

    // 用户运行中手动展开 → 后续 items 增减与封口都不收敛用户的展开
    const header = root.querySelector('[class*="groupHeader"]') as HTMLElement;
    fireEvent.click(header);
    expect(root.getAttribute('data-expanded')).toBe('true');
    rerender(
      <FoldableToolGroup
        items={completedItems}
        msgId="m_live"
        groupTitle="运行态折叠测试"
        isSealed={true}
        hostProps={{ ...baseHostProps(), items: completedItems }}
      />
    );
    expect(root.getAttribute('data-expanded')).toBe('true');
  });

  it('封口信号 isSealed 到达且工具数 <= 3 时保持折叠（2026-11-06 裁决：UX-04 封口顶开特例退役）', () => {
    const runningItems: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'running', { intent: '运行单元测试 1' }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'running', { intent: '运行单元测试 2' }),
      },
    ];
    const completedItems: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'success', { intent: '单元测试通过 1' }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'success', { intent: '单元测试通过 2' }),
      },
    ];

    const { getByTestId, rerender } = render(
      <FoldableToolGroup
        items={runningItems}
        msgId="m2"
        groupId="group-short-ux04"
        groupTitle="测试套件"
        hostProps={{ ...baseHostProps(), items: runningItems }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    // 运行态默认折叠：少量工具组运行中亦不展开
    expect(root.getAttribute('data-expanded')).toBe('false');

    // 收到 isSealed=true 且全部完成、工具数 <= 3 → 保持折叠，不再被顶开
    rerender(
      <FoldableToolGroup
        items={completedItems}
        msgId="m2"
        groupId="group-short-ux04"
        groupTitle="测试套件"
        isSealed={true}
        hostProps={{ ...baseHostProps(), items: completedItems }}
      />
    );
    expect(root.getAttribute('data-expanded')).toBe('false');
  });

  it('S1b 折叠态：chevron 进每个 ticker 单元格、紧跟文本；行尾无 chevron', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'success', {
          intent: '安装项目依赖',
          arguments: '{"CommandLine":"npm install"}',
        }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'success', {
          intent: '执行类型检查',
          arguments: '{"CommandLine":"npm run typecheck"}',
        }),
      },
    ];

    const { getByTestId, getAllByTestId, queryByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        groupTitle="环境准备与门禁检查"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    expect(root.getAttribute('data-expanded')).toBe('false');

    // 每个 ticker 单元格各一枚 chevron（标题 + 2 工具意图 = 3 格）
    const tickerChevrons = getAllByTestId('tool-group-ticker-chevron');
    expect(tickerChevrons).toHaveLength(3);
    for (const chevron of tickerChevrons) {
      expect(chevron.textContent?.trim()).toBe('›');
    }
    // 行尾 chevron 折叠态不渲染，避免双 chevron
    expect(queryByTestId('tool-group-chevron')).toBeNull();

    // 单元格文本段只含文本、不含 chevron 字形
    const cellText = root.querySelector('[class*="tickerCellText"]');
    expect(cellText?.textContent).toBe('环境准备与门禁检查');
    // chevron 紧跟文本段之后（同一单元格内的下一个兄弟）
    expect(cellText?.nextElementSibling?.getAttribute('data-testid')).toBe(
      'tool-group-ticker-chevron'
    );
  });

  it('S1b 展开态：行尾 chevron 单枚出现且旋转，ticker chevron 全部卸载', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'find_by_name', 'success', { intent: '查找源文件' }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'grep_search', 'success', { intent: '检索调用点' }),
      },
    ];

    const { getByTestId, getAllByTestId, queryAllByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        groupTitle="代码探索"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    const header = root.querySelector('[class*="groupHeader"]') as HTMLElement;

    fireEvent.click(header);
    expect(root.getAttribute('data-expanded')).toBe('true');

    const headerChevron = getByTestId('tool-group-chevron');
    expect(headerChevron.textContent?.trim()).toBe('›');
    expect(headerChevron.className).toContain('rot');
    expect(queryAllByTestId('tool-group-ticker-chevron')).toHaveLength(0);

    // 再收起：行尾 chevron 卸载，ticker chevron 回来
    fireEvent.click(header);
    expect(root.getAttribute('data-expanded')).toBe('false');
    expect(getAllByTestId('tool-group-ticker-chevron').length).toBeGreaterThan(0);
  });

  it('S1b CSS 契约：文本 flex 收缩、ticker 单元格按内容定宽', () => {
    const cssPath = path.resolve(
      __dirname,
      '../FoldableToolGroup.module.css'
    );
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    // 组头摘要不再吃满剩余宽
    const summaryLabel =
      cssContent.match(/^\.summaryLabel\s*\{[^}]*\}/m)?.[0] ?? '';
    expect(summaryLabel).toContain('flex: 0 1 auto');
    // ticker 视口同理
    const viewport =
      cssContent.match(/^\.tickerViewport\s*\{[^}]*\}/m)?.[0] ?? '';
    expect(viewport).toContain('flex: 0 1 auto');
    // 单元格按内容定宽、上限 100%（长文本时文本段收缩、chevron 落行尾）
    const cell = cssContent.match(/^\.tickerCell\s*\{[^}]*\}/m)?.[0] ?? '';
    expect(cell).toContain('width: max-content');
    expect(cell).toContain('max-width: 100%');
    // 单元格内文本段带省略号
    const cellText =
      cssContent.match(/^\.tickerCellText\s*\{[^}]*\}/m)?.[0] ?? '';
    expect(cellText).toContain('text-overflow: ellipsis');
    expect(cellText).toContain('flex: 0 1 auto');
  });

  describe('组级状态点聚合仲裁规则（P4 §8.2 权威仲裁：P0 running > P1 error > P2 pending > P3 success）', () => {
    it('包含 running 工具时，聚合状态为 running 蓝脉冲点', () => {
      const items: ToolRenderItem[] = [
        { kind: 'single', tc: tc('t1', 'run_command', 'success', { intent: '步骤一' }) },
        { kind: 'single', tc: tc('t2', 'run_command', 'running', { intent: '步骤二' }) },
        { kind: 'single', tc: tc('t3', 'run_command', 'error', { intent: '步骤三' }) },
      ];

      const { container } = render(
        <FoldableToolGroup
          items={items}
          msgId="m1"
          groupTitle="并行构建"
          hostProps={{ ...baseHostProps(), items }}
        />
      );

      const pulseDot = container.querySelector('[class*="toolPulseDot"]');
      expect(pulseDot).not.toBeNull();
      const header = container.querySelector('[class*="groupHeader"]');
      expect(header?.getAttribute('aria-label')).toContain('运行中：并行构建');
    });

    it('无 running 但包含 error 工具时，聚合状态为 error 失败红点', () => {
      const items: ToolRenderItem[] = [
        { kind: 'single', tc: tc('t1', 'run_command', 'success', { intent: '步骤一' }) },
        { kind: 'single', tc: tc('t2', 'run_command', 'error', { intent: '步骤二' }) },
      ];

      const { container } = render(
        <FoldableToolGroup
          items={items}
          msgId="m1"
          groupTitle="构建流水线"
          hostProps={{ ...baseHostProps(), items }}
        />
      );

      const errorDot = container.querySelector('[class*="toolErrorDot"]');
      expect(errorDot).not.toBeNull();
      const header = container.querySelector('[class*="groupHeader"]');
      expect(header?.getAttribute('aria-label')).toContain('失败：构建流水线');
    });

    it('无 running/error 但包含 pending_approval 工具时，聚合状态为 pending 待确认橙点', () => {
      const items: ToolRenderItem[] = [
        { kind: 'single', tc: tc('t1', 'run_command', 'success', { intent: '步骤一' }) },
        { kind: 'single', tc: tc('t2', 'run_command', 'pending_approval', { intent: '待确认步骤' }) },
      ];

      const { container } = render(
        <FoldableToolGroup
          items={items}
          msgId="m1"
          groupTitle="安全执行"
          hostProps={{ ...baseHostProps(), items }}
        />
      );

      const pendingDot = container.querySelector('[class*="toolPendingDot"]');
      expect(pendingDot).not.toBeNull();
      const header = container.querySelector('[class*="groupHeader"]');
      expect(header?.getAttribute('aria-label')).toContain('待确认：安全执行');
    });

    it('全部成功时，聚合状态为 success 成功绿点', () => {
      const items: ToolRenderItem[] = [
        { kind: 'single', tc: tc('t1', 'run_command', 'success', { intent: '步骤一' }) },
        { kind: 'single', tc: tc('t2', 'run_command', 'success', { intent: '步骤二' }) },
      ];

      const { container } = render(
        <FoldableToolGroup
          items={items}
          msgId="m1"
          groupTitle="全部成功"
          hostProps={{ ...baseHostProps(), items }}
        />
      );

      const successDot = container.querySelector('[class*="toolSuccessDot"]');
      expect(successDot).not.toBeNull();
      const header = container.querySelector('[class*="groupHeader"]');
      expect(header?.getAttribute('aria-label')).toContain('已完成：全部成功');
    });
  });

  it('收起长内容时若滚出屏幕顶部，触发视口平滑回退保护', () => {
    const items: ToolRenderItem[] = [
      { kind: 'single', tc: tc('t1', 'run_command', 'success', { intent: '任务一' }) },
      { kind: 'single', tc: tc('t2', 'run_command', 'success', { intent: '任务二' }) },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        groupTitle="长任务组"
        hostProps={{ ...baseHostProps(), items }}
        defaultExpanded={true}
      />
    );

    const root = getByTestId('foldable-tool-group');
    const scrollIntoViewMock = vi.fn();
    root.scrollIntoView = scrollIntoViewMock;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      top: -200,
      bottom: 600,
      left: 0,
      right: 500,
      width: 500,
      height: 800,
      x: 0,
      y: -200,
      toJSON: () => {},
    });

    const header = root.querySelector('[class*="groupHeader"]') as HTMLElement;
    fireEvent.click(header);

    expect(root.getAttribute('data-expanded')).toBe('false');
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'start',
      behavior: 'smooth',
    });
  });

  it('聚焦槽位内部子项时通过 onFocusCapture 主动唤醒展开', () => {
    const items: ToolRenderItem[] = [
      { kind: 'single', tc: tc('t1', 'run_command', 'success', { intent: '任务一' }) },
      { kind: 'single', tc: tc('t2', 'run_command', 'success', { intent: '任务二' }) },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        groupTitle="键盘无障碍"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    expect(root.getAttribute('data-expanded')).toBe('false');

    const innerChild = root.querySelector(
      '[class*="groupBodyInner"]'
    ) as HTMLElement;
    fireEvent.focus(innerChild);

    expect(root.getAttribute('data-expanded')).toBe('true');
  });
});
