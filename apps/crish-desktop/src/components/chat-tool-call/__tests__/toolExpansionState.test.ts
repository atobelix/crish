// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/chat-tool-call/__tests__/toolExpansionState.test.ts
 *
 * 工具卡片原地替换与展开防抖自动化单元测试套件
 * 覆盖：
 * 1. 100ms 原地替换缓冲契约判定（相同命令类型、同类参数、<=100ms 衔接时序）；
 * 2. 原地翻转状态机与时序演进（idle -> flipping -> settled 100ms 动效周期）；
 * 3. 展开/收起 100ms 防抖判定（阻止快速连击与微秒重入）；
 * 4. usePreActionAnchor 相对位移度量与账本记录（ΔH 变化与 ΔY ≡ 0 视口零晃动）；
 * 5. findPreviousToolInItems 拓扑前驱定位；
 * 6. useToolExpansionState Hook 集成与防抖切换；
 * 7. CompactToolRow DOM 属性与原地翻转集成测试。
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, act, fireEvent, cleanup } from '@testing-library/react';
import type { MessageToolCall } from '../../../store/types';
import type { ToolRenderItem } from '../../../api/toolPresentation';
import { VirtualScrollManager } from '../../../api/VirtualScrollManager';
import {
  IN_PLACE_REPLACEMENT_BUFFER_MS,
  EXPANSION_DEBOUNCE_MS,
  IN_PLACE_FLIP_DURATION_MS,
  extractToolParameterKind,
  isSameToolParameterType,
  isWithinInPlaceBuffer,
  evaluateInPlaceReplacement,
  shouldInPlaceReplace,
  isExpansionDebounced,
  calculateRelativeDisplacement,
  recordToolDisplacement,
  getDisplacementHistory,
  clearDisplacementHistory,
  findScrollContainer,
  findPreviousToolInItems,
  useToolExpansionState,
} from '../toolExpansionState';
import { CompactToolRow } from '../CompactToolRow';
import type { ChatToolStackProps } from '../ChatToolCallBlock';

describe('toolExpansionState — 工具卡片原地替换与展开防抖测试套件', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearDisplacementHistory();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    clearDisplacementHistory();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 第一部分：100ms 原地替换缓冲契约判定
  // ──────────────────────────────────────────────────────────────────────────
  describe('一、100ms 原地替换缓冲契约判定', () => {
    it('标准同类文件读取工具在 50ms 内衔接：判定原地替换生效 (eligible)', () => {
      const prevTool: MessageToolCall = {
        id: 'tc-1',
        name: 'read_file',
        status: 'success',
        startedAt: 1000,
        completedAt: 1200,
        arguments: JSON.stringify({ AbsolutePath: 'c:/Software/foo.ts' }),
      };
      const nextTool: MessageToolCall = {
        id: 'tc-2',
        name: 'read_file',
        status: 'running',
        startedAt: 1250, // 间隔 50ms <= 100ms
        arguments: JSON.stringify({ AbsolutePath: 'c:/Software/bar.ts' }),
      };

      const decision = evaluateInPlaceReplacement(prevTool, nextTool);
      expect(decision.shouldReplace).toBe(true);
      expect(decision.reason).toBe('eligible');
      expect(decision.elapsedMs).toBe(50);
      expect(shouldInPlaceReplace(prevTool, nextTool)).toBe(true);
    });

    it('临界 100ms 时序：恰好 100ms 放行，101ms 判定超时失效', () => {
      const prevTool: MessageToolCall = {
        id: 'tc-1',
        name: 'read_file',
        status: 'success',
        startedAt: 1000,
        completedAt: 1200,
        arguments: JSON.stringify({ AbsolutePath: 'c:/foo.ts' }),
      };

      const nextExact100: MessageToolCall = {
        id: 'tc-2',
        name: 'read_file',
        status: 'running',
        startedAt: 1300, // 恰好 100ms
        arguments: JSON.stringify({ AbsolutePath: 'c:/bar.ts' }),
      };
      expect(shouldInPlaceReplace(prevTool, nextExact100)).toBe(true);

      const nextOver100: MessageToolCall = {
        id: 'tc-3',
        name: 'read_file',
        status: 'running',
        startedAt: 1301, // 101ms 超时
        arguments: JSON.stringify({ AbsolutePath: 'c:/bar.ts' }),
      };
      const decisionOver = evaluateInPlaceReplacement(prevTool, nextOver100);
      expect(decisionOver.shouldReplace).toBe(false);
      expect(decisionOver.reason).toBe('buffer_expired');
      expect(decisionOver.elapsedMs).toBe(101);
    });

    it('不同命令类型（read vs shell）：拒绝原地替换 (different_type)', () => {
      const prevTool: MessageToolCall = {
        id: 'tc-read',
        name: 'read_file',
        status: 'success',
        startedAt: 1000,
        completedAt: 1200,
        arguments: JSON.stringify({ AbsolutePath: 'c:/foo.ts' }),
      };
      const nextTool: MessageToolCall = {
        id: 'tc-shell',
        name: 'run_command',
        status: 'running',
        startedAt: 1230,
        arguments: JSON.stringify({ CommandLine: 'npm test' }),
      };

      const decision = evaluateInPlaceReplacement(prevTool, nextTool);
      expect(decision.shouldReplace).toBe(false);
      expect(decision.reason).toBe('different_type');
    });

    it('前驱非终态或后继非运行态：拒绝原地替换 (not_consecutive_states)', () => {
      // 场景 A：前驱仍在 running
      const runningPrev: MessageToolCall = {
        id: 'tc-run',
        name: 'read_file',
        status: 'running',
        startedAt: 1000,
        arguments: JSON.stringify({ AbsolutePath: 'c:/foo.ts' }),
      };
      const runningNext: MessageToolCall = {
        id: 'tc-next',
        name: 'read_file',
        status: 'running',
        startedAt: 1050,
        arguments: JSON.stringify({ AbsolutePath: 'c:/bar.ts' }),
      };
      expect(evaluateInPlaceReplacement(runningPrev, runningNext).reason).toBe(
        'not_consecutive_states'
      );

      // 场景 B：后继已成功结束（success），无需翻转指示
      const successPrev: MessageToolCall = {
        id: 'tc-succ-1',
        name: 'read_file',
        status: 'success',
        completedAt: 1200,
        arguments: JSON.stringify({ AbsolutePath: 'c:/foo.ts' }),
      };
      const successNext: MessageToolCall = {
        id: 'tc-succ-2',
        name: 'read_file',
        status: 'success',
        startedAt: 1240,
        arguments: JSON.stringify({ AbsolutePath: 'c:/bar.ts' }),
      };
      expect(evaluateInPlaceReplacement(successPrev, successNext).reason).toBe(
        'not_consecutive_states'
      );

      // 场景 C：无前驱工具（null / undefined）
      expect(evaluateInPlaceReplacement(null, runningNext).reason).toBe(
        'not_consecutive_states'
      );
    });

    it('缺失时间戳（live 会话实时更新流）：连续状态匹配时仍安全放行', () => {
      const prevTool: MessageToolCall = {
        id: 'tc-live-prev',
        name: 'read_file',
        status: 'success',
        arguments: JSON.stringify({ AbsolutePath: 'c:/foo.ts' }),
      };
      const nextTool: MessageToolCall = {
        id: 'tc-live-next',
        name: 'read_file',
        status: 'running',
        arguments: JSON.stringify({ AbsolutePath: 'c:/bar.ts' }),
      };

      const timing = isWithinInPlaceBuffer(prevTool, nextTool);
      expect(timing.within).toBe(true);
      expect(shouldInPlaceReplace(prevTool, nextTool)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 第二部分：工具参数提取与同类型判定
  // ──────────────────────────────────────────────────────────────────────────
  describe('二、工具参数提取与同类型判定', () => {
    it('正确分类各类工具的核心参数类型', () => {
      expect(
        extractToolParameterKind({
          name: 'read_file',
          arguments: JSON.stringify({ AbsolutePath: 'c:/src/a.ts' }),
        })
      ).toBe('file');

      expect(
        extractToolParameterKind({
          name: 'write_to_file',
          arguments: JSON.stringify({ TargetFile: 'c:/src/b.ts' }),
        })
      ).toBe('file');

      expect(
        extractToolParameterKind({
          name: 'run_command',
          arguments: JSON.stringify({ CommandLine: 'cargo build' }),
        })
      ).toBe('command');

      expect(
        extractToolParameterKind({
          name: 'grep_search',
          arguments: JSON.stringify({ Query: 'hello' }),
        })
      ).toBe('search');

      expect(
        extractToolParameterKind({
          name: 'invoke_subagent',
          arguments: JSON.stringify({ role: 'tester' }),
        })
      ).toBe('subagent');
    });

    it('isSameToolParameterType: 语义类别与参数类型完全一致才判定为 true', () => {
      const cmd1: MessageToolCall = {
        name: 'run_command',
        arguments: JSON.stringify({ CommandLine: 'git status' }),
      };
      const cmd2: MessageToolCall = {
        name: 'run_command',
        arguments: JSON.stringify({ CommandLine: 'git diff' }),
      };
      expect(isSameToolParameterType(cmd1, cmd2)).toBe(true);

      const fileRead: MessageToolCall = {
        name: 'read_file',
        arguments: JSON.stringify({ AbsolutePath: 'a.txt' }),
      };
      const fileWrite: MessageToolCall = {
        name: 'write_to_file',
        arguments: JSON.stringify({ TargetFile: 'b.txt' }),
      };
      // read vs write 虽均为 file 参数，但命令语义轴不一致 (read vs write)
      expect(isSameToolParameterType(fileRead, fileWrite)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 第三部分：展开/收起 100ms 防抖判定
  // ──────────────────────────────────────────────────────────────────────────
  describe('三、展开/收起 100ms 防抖判定', () => {
    it('isExpansionDebounced: 100ms 黄金窗口内连击拦截，冷却后放行', () => {
      const baseTime = 10000;

      // 0ms 紧随前次调用：防抖拦截
      expect(isExpansionDebounced(baseTime, baseTime + 10, EXPANSION_DEBOUNCE_MS)).toBe(
        true
      );
      // 50ms 仍在窗口内：防抖拦截
      expect(isExpansionDebounced(baseTime, baseTime + 50, EXPANSION_DEBOUNCE_MS)).toBe(
        true
      );
      // 99ms 边界防护：防抖拦截
      expect(isExpansionDebounced(baseTime, baseTime + 99, EXPANSION_DEBOUNCE_MS)).toBe(
        true
      );

      // 100ms 恰好冷却：放行
      expect(
        isExpansionDebounced(baseTime, baseTime + 100, EXPANSION_DEBOUNCE_MS)
      ).toBe(false);
      // 200ms 远超冷却：放行
      expect(
        isExpansionDebounced(baseTime, baseTime + 200, EXPANSION_DEBOUNCE_MS)
      ).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 第四部分：联动 usePreActionAnchor 相对位移度量与历史账本
  // ──────────────────────────────────────────────────────────────────────────
  describe('四、联动 usePreActionAnchor 相对位移度量与历史账本', () => {
    it('高度膨胀场景 (卡片展开 ΔH = +1200px)：位移记录计算并保障视口平稳', () => {
      const snapshot = {
        snapshotScrollTop: 500,
        snapshotScrollHeight: 2000,
        anchor: { key: 'tool-anchor-1', top: -30 },
      };
      // 理想视口微调补偿后，页面高度增加了 1200px
      const current = {
        scrollTop: 500,
        scrollHeight: 3200,
      };

      const result = calculateRelativeDisplacement(snapshot, current);
      expect(result.deltaHeight).toBe(1200);
      expect(result.deltaScrollTop).toBe(0);
      expect(result.relativeDisplacement).toBe(0);
    });

    it('recordToolDisplacement: 账本入库、查询与超限平滑淘汰 (最大 50 条)', () => {
      expect(getDisplacementHistory().length).toBe(0);

      const record1 = {
        toolId: 't-1',
        action: 'expand' as const,
        timestamp: 1000,
        snapshotScrollTop: 100,
        snapshotScrollHeight: 800,
        deltaHeight: 300,
        deltaScrollTop: 0,
        relativeDisplacement: 0,
      };
      recordToolDisplacement(record1);
      expect(getDisplacementHistory().length).toBe(1);
      expect(getDisplacementHistory()[0]?.toolId).toBe('t-1');

      // 批量压入 60 条记录，验证最大 50 条限制与 FIFO 淘汰
      for (let i = 2; i <= 60; i++) {
        recordToolDisplacement({
          ...record1,
          toolId: `t-${i}`,
        });
      }

      const history = getDisplacementHistory();
      expect(history.length).toBe(50);
      // 第 1 条已被淘汰，最前一条为 t-11
      expect(history[0]?.toolId).toBe('t-11');
      expect(history[49]?.toolId).toBe('t-60');

      clearDisplacementHistory();
      expect(getDisplacementHistory().length).toBe(0);
    });

    it('findScrollContainer: 正确检索 DOM 树中的滚动宿主容器', () => {
      const container = document.createElement('div');
      container.className = 'chat-scroller';

      const middle = document.createElement('div');
      const inner = document.createElement('div');
      container.appendChild(middle);
      middle.appendChild(inner);

      document.body.appendChild(container);

      expect(findScrollContainer(inner)).toBe(container);
      expect(findScrollContainer(null)).toBeNull();

      document.body.removeChild(container);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 第五部分：findPreviousToolInItems 前驱定位
  // ──────────────────────────────────────────────────────────────────────────
  describe('五、findPreviousToolInItems 前驱定位', () => {
    const t1: MessageToolCall = { id: 't1', name: 'read_file' };
    const t2: MessageToolCall = { id: 't2', name: 'read_file' };
    const t3: MessageToolCall = { id: 't3', name: 'write_file' };

    const items: ToolRenderItem[] = [
      { kind: 'single', tc: t1 },
      { kind: 'group', id: 'grp-1', tools: [t2, t3], label: '组操作' },
    ];

    it('能正确索引定位 single 项与 group 项的前驱', () => {
      expect(findPreviousToolInItems(items, 't2')).toEqual(t1);
      expect(findPreviousToolInItems(items, 't3')).toEqual(t2);
      // 第一项无前驱
      expect(findPreviousToolInItems(items, 't1')).toBeUndefined();
      // 不存在的工具 ID
      expect(findPreviousToolInItems(items, 'non-existent')).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 第六部分：useToolExpansionState Hook 状态机与翻转时序
  // ──────────────────────────────────────────────────────────────────────────
  describe('六、useToolExpansionState Hook 状态机与翻转时序', () => {
    it('符合原地替换条件时：Hook 启动 flipping 并在 100ms 后平滑转入 settled', () => {
      const prevTool: MessageToolCall = {
        id: 'p-1',
        name: 'read_file',
        status: 'success',
        completedAt: 1000,
        arguments: JSON.stringify({ AbsolutePath: 'foo.ts' }),
      };
      const nextTool: MessageToolCall = {
        id: 'n-1',
        name: 'read_file',
        status: 'running',
        startedAt: 1040,
        arguments: JSON.stringify({ AbsolutePath: 'bar.ts' }),
      };

      const onToggle = vi.fn();

      const { result } = renderHook(() =>
        useToolExpansionState({
          tc: nextTool,
          prevTc: prevTool,
          expandedTools: {},
          onToggleTool: onToggle,
        })
      );

      // 初始：shouldReplace 生效，isFlipping 为 true，phase 为 flipping
      expect(result.current.shouldReplace).toBe(true);
      expect(result.current.isFlipping).toBe(true);
      expect(result.current.flipPhase).toBe('flipping');

      // 时钟推进 100ms
      act(() => {
        vi.advanceTimersByTime(IN_PLACE_FLIP_DURATION_MS);
      });

      // 100ms 原地翻转完成，转入 settled，isFlipping 回归 false
      expect(result.current.flipPhase).toBe('settled');
      expect(result.current.isFlipping).toBe(false);
    });

    it('handleToggle 防抖拦截：快速连击只触发一次底层 onToggleTool', () => {
      const tc: MessageToolCall = {
        id: 'tc-click',
        name: 'read_file',
        status: 'success',
        arguments: JSON.stringify({ AbsolutePath: 'test.ts' }),
        output: 'file content',
      };
      const onToggle = vi.fn();

      const { result } = renderHook(() =>
        useToolExpansionState({
          tc,
          expandedTools: {},
          onToggleTool: onToggle,
        })
      );

      // 第 1 次点击：放行
      act(() => {
        result.current.handleToggle('tc-click', false);
      });
      expect(onToggle).toHaveBeenCalledTimes(1);

      // 30ms 内快速重入连击：被防抖拦截，不重复触发
      act(() => {
        vi.advanceTimersByTime(30);
        result.current.handleToggle('tc-click', false);
      });
      expect(onToggle).toHaveBeenCalledTimes(1);

      // 100ms 冷却后再次点击：放行触发第 2 次
      act(() => {
        vi.advanceTimersByTime(EXPANSION_DEBOUNCE_MS);
        result.current.handleToggle('tc-click', false);
      });
      expect(onToggle).toHaveBeenCalledTimes(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 第七部分：CompactToolRow DOM 属性与原地翻转集成测试
  // ──────────────────────────────────────────────────────────────────────────
  describe('七、CompactToolRow DOM 属性与原地翻转集成测试', () => {
    function createMockProps(
      items: ToolRenderItem[] = [],
      onToggleTool = vi.fn()
    ): ChatToolStackProps {
      return {
        items,
        agents: [],
        activeSessionId: 'test-session',
        expandedTools: {},
        onToggleTool,
        approvalBusy: false,
      };
    }

    it('当满足原地替换时，CompactToolRow 根节点被正确标记 data-in-place-replace 与 flipping 属性', () => {
      const prevTc: MessageToolCall = {
        id: 'p-prev',
        name: 'read_file',
        status: 'success',
        completedAt: 1000,
        arguments: JSON.stringify({ AbsolutePath: 'a.txt' }),
      };
      const currTc: MessageToolCall = {
        id: 'p-curr',
        name: 'read_file',
        status: 'running',
        startedAt: 1050,
        arguments: JSON.stringify({ AbsolutePath: 'b.txt' }),
      };

      const props = createMockProps([
        { kind: 'single', tc: prevTc },
        { kind: 'single', tc: currTc },
      ]);

      const { container } = render(
        React.createElement(CompactToolRow, {
          tc: currTc,
          prevTc: prevTc,
          rowKey: 'p-curr',
          props: props,
        })
      );

      const rowEl = container.querySelector('[data-tool-id="p-curr"]');
      expect(rowEl).not.toBeNull();
      expect(rowEl?.getAttribute('data-in-place-replace')).toBe('true');
      expect(rowEl?.getAttribute('data-in-place-flipping')).toBe('true');

      // 推进 100ms 计时器
      act(() => {
        vi.advanceTimersByTime(100);
      });

      // 翻转完成后，flipping 属性被安全清除
      expect(rowEl?.getAttribute('data-in-place-flipping')).toBeNull();
      // 但原地替换契约标记依然保留
      expect(rowEl?.getAttribute('data-in-place-replace')).toBe('true');
    });

    it('点击工具行触发防抖化 handleToggle', () => {
      const toggleFn = vi.fn();
      const tc: MessageToolCall = {
        id: 'tool-toggle',
        name: 'read_file',
        status: 'success',
        arguments: JSON.stringify({ AbsolutePath: 'doc.md' }),
        output: 'line 1\nline 2',
      };

      const props = createMockProps(
        [{ kind: 'single', tc }],
        toggleFn
      );

      const { container } = render(
        React.createElement(CompactToolRow, {
          tc: tc,
          rowKey: 'tool-toggle',
          props: props,
        })
      );

      const headEl = container.querySelector('.tool-row-head');
      expect(headEl).not.toBeNull();

      // 第 1 次点击
      fireEvent.click(headEl!);
      expect(toggleFn).toHaveBeenCalledTimes(1);

      // 40ms 内双击：防抖拦截
      act(() => {
        vi.advanceTimersByTime(40);
      });
      fireEvent.click(headEl!);
      expect(toggleFn).toHaveBeenCalledTimes(1);

      // 100ms 冷却后点击：放行
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.click(headEl!);
      expect(toggleFn).toHaveBeenCalledTimes(2);
    });
  });
});
