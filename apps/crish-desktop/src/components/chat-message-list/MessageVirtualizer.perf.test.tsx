// @vitest-environment jsdom
/**
 * 性能与长会话虚拟列表测试 suite (MessageVirtualizer)
 * 1. 1000+ 条消息超长会话虚拟渲染与 DOM 节点数约束
 * 2. 动态高度测量、Pretext 估算与 getOffset 偏移量计算
 * 3. 100 次高频虚拟滚动：单帧工作量不随消息总数增长（自校准相对门禁）
 */
import React from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { MessageVirtualizer } from './MessageVirtualizer';

// 行内 useToast 在无 Provider 时会刷屏 fallback 警告，污染帧计时；与虚拟滚动性能无关
vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), toast: { show: vi.fn() } }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
import type { SessionMessage } from '../../store/types';
import {
  MESSAGE_ESTIMATED_ROW_HEIGHT,
  VirtualScrollManager,
} from '../../api/VirtualScrollManager';

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Suppress act warnings in test logs
let origError: typeof console.error;
beforeAll(() => {
  origError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act'))
      return;
    origError.call(console, ...args);
  };
});
afterAll(() => {
  console.error = origError;
});

function createMockMessages(count: number): SessionMessage[] {
  const msgs: SessionMessage[] = [];
  for (let i = 0; i < count; i++) {
    const isUser = i % 2 === 0;
    msgs.push({
      id: `msg-${i}`,
      sender: isUser ? 'user' : 'assistant',
      timestamp: Date.now() - (count - i) * 1000,
      text: isUser
        ? `用户问题 ${i}: 请分析性能与内存泄露策略，包含 1000+ 条消息虚拟滚动测试。`
        : `助手回答 ${i}:\n\`\`\`ts\nconst total = ${i};\nconsole.log("Processing message", total);\n\`\`\`\n详细解释内容，确保文本行数足够产生不同测量高度。`,
      toolCalls:
        i % 5 === 0
          ? [
              {
                id: `tc-${i}`,
                name: 'read_file',
                arguments: '{}',
                status: 'success',
              },
            ]
          : undefined,
    });
  }
  return msgs;
}

function createDefaultProps(
  messages: SessionMessage[]
): MessageVirtualizerProps {
  return {
    messages,
    activeSessionId: 'sess-1',
    navigation: {
      onOpenDiff: vi.fn(),
      onOpenPath: vi.fn(),
      onOpenTerminal: vi.fn(),
    },
    approval: {
      approvalBusy: false,
      pendingApprovalMsgId: '',
      onApprovalAllow: vi.fn(),
      onApprovalDeny: vi.fn(),
    },
    composer: {
      onSetChatInput: vi.fn(),
      onSendFollowUp: vi.fn(),
    },
    generation: {
      onRegenerate: vi.fn(),
      onBranch: vi.fn(),
      onRetract: vi.fn(),
    },
    pins: {
      pinnedItems: [],
      pinsOpen: false,
      setPinsOpen: vi.fn(),
      jumpToPinned: vi.fn(),
      togglePin: vi.fn(),
    },
    flowControl: {
      hideThinkingBlock: false,
      lastAssistantId: messages[messages.length - 1]?.id ?? null,
      showAllMessages: true,
    },
    interaction: {
      expandedUserMsgs: {},
      onToggleExpandUser: vi.fn(),
      dismissedFollowUps: {},
      handleDismissFollowUp: vi.fn(),
      handleMarkdownClick: vi.fn(),
      toolStackProps: {
        activeSessionId: 'sess-1',
        onShowToast: vi.fn(),
        onOpenDiff: vi.fn(),
        onOpenDiffPanel: vi.fn(),
      },
    },
    searchHighlightQuery: '',
  };
}

describe('MessageVirtualizer — 长会话 (1000+ 消息) 性能与高度断言', () => {
  it('1000+ 条消息虚拟渲染：仅渲染可视区域 DOM 节点，DOM 节点数硬性上限限制', () => {
    const messages = createMockMessages(1200);
    const props = createDefaultProps(messages);

    const { container } = render(<MessageVirtualizer {...props} />);

    const listElement = container.querySelector('[data-virtual-scroll="true"]');
    expect(listElement).not.toBeNull();
    expect(listElement?.getAttribute('data-total-count')).toBe('1200');

    // 测量 DOM 节点数：即使包含 1200 条消息，DOM 中 [data-vindex] 节点的数量必须受限于窗口视口+overscan（如 <= 25）
    const renderedRowElements = container.querySelectorAll('[data-vindex]');
    expect(renderedRowElements.length).toBeGreaterThan(0);
    expect(renderedRowElements.length).toBeLessThanOrEqual(30);
    // 严禁将 1200 个节点全量挂载在 DOM 树中
    expect(renderedRowElements.length).not.toBe(1200);
  });

  it('高度测量与 Manager 缓存一致性：setActual 之后 offset 正确累加且未变动高度保留', () => {
    const manager = new VirtualScrollManager({
      fallbackHeight: MESSAGE_ESTIMATED_ROW_HEIGHT,
    });
    const ids = Array.from({ length: 1500 }, (_, i) => `msg-${i}`);
    manager.syncOrder(ids);

    expect(manager.getHeight('msg-0')).toBe(MESSAGE_ESTIMATED_ROW_HEIGHT);
    expect(manager.getOffset(10)).toBe(10 * MESSAGE_ESTIMATED_ROW_HEIGHT);
    expect(manager.getTotalHeight(1500)).toBe(
      1500 * MESSAGE_ESTIMATED_ROW_HEIGHT
    );

    // 动态模拟元素测量反馈 setActual
    manager.setActual('msg-0', 350);
    manager.setActual('msg-1', 500);

    expect(manager.getHeight('msg-0')).toBe(350);
    expect(manager.getHeight('msg-1')).toBe(500);
    // 确认未测量的 msg-2 保持 fallback
    expect(manager.getHeight('msg-2')).toBe(MESSAGE_ESTIMATED_ROW_HEIGHT);

    // 验证 getOffset: msg-2 的 offset 应为 350 + 500 = 850
    expect(manager.getOffset(2)).toBe(850);
    // 验证 totalHeight 动态变化: (1500 - 2) * 180 + 350 + 500
    const expectedTotal = 1498 * MESSAGE_ESTIMATED_ROW_HEIGHT + 350 + 500;
    expect(manager.getTotalHeight(1500)).toBe(expectedTotal);
  });

  it(
    '100 次高频虚拟滚动：单帧工作量不随消息总数增长（自校准相对门禁）',
    { timeout: 60000 },
    () => {
      // ── 门禁可信化改造（2026-09-15）────────────────────────────────────
      // 原实现断言绝对墙钟：avgFrameTime < 80ms / maxFrameTime < 350ms。
      // 实测（8 次隔离复跑，含全量套件并发轮次）：
      //   · 帧耗时分布右偏，中位数在 61-99ms 区间随机漂移（±20%），
      //     阈值 80ms 正落在噪声带中央 ⇒ 实测误红率 3/8；
      //   · 全量 847 文件并发时单帧曾达 703ms（> 350ms 阈值）。
      // 结论：本机对该负载的吞吐本身有 ±20% 漂移，**任何贴着实测值标定的
      // 绝对墙钟阈值都必然误红**。绝对阈值在此不可作为稳定判据，而误红会
      // 训练出「忽略红」的习惯，反而使门禁失效。
      //
      // 改造为「同一进程内自校准」：以 300 条消息为基线、1500 条为对照
      // （5 倍消息量），两者使用**相同的每帧推进量（5 行）与相同的帧数**，
      // 比较各自的帧耗时低分位。虚拟滚动若正确，每帧只渲染视口窗口 +
      // overscan，与消息总数无关 ⇒ 比值接近 1；若退化为 O(N)（全量挂载 /
      // 每帧全量遍历 / offset 前缀和未缓存）⇒ 5 倍消息量将放大比值到 3 倍以上。
      //
      // 估计量与采样协议（全量并发下实测校准）：
      //   ① 用 **P10 低分位**而非中位数/均值——争抢使所有帧一致变慢，而
      //      「最不受争抢的那批帧」最接近真实单帧成本，故低分位对 CPU
      //      争抢的敏感度远低于中心统计量；
      //   ② **交错重复两轮（A,B,A,B）并对每个负载取两轮的较小值**——
      //      大负载若恒在第二个测，会系统性继承更多已累积垃圾（GC 压力）
      //      与更晚出现的争抢突发，形成顺序偏差；交错 + 取最小可抵消它。
      // 机器速度在比值中完全抵消 ⇒ 零误红，且对「随 N 增长」这一真回归类的
      // 探测力**强于**原绝对阈值（原阈值在快机器上即使存在 O(N) 退化也可能
      // 因绝对值低而放行）。
      //
      // 本门禁上线即捕获到一处真缺陷（2026-09-15，已修）：
      // FlowScrubber 的轨道按**每条用户消息**产出一枚刻度 DOM，而轨道是固定
      // 高度条带 ⇒ 每次滚动提交都要协调 O(N) 个元素。实测修复前
      // t(300)=18ms / t(1500)=40ms / t(6000)=128ms（线性，N=6000 时是 16.7ms
      // 帧预算的 7.7 倍）；短路轨道渲染后每帧与 N 无关（25ms 持平）。
      // 修复：轨道刻度按像素容量有界渲染（flowScrubberModel.capScrubberSegments），
      // 修复后 t(300)=15ms / t(1500)=14ms / t(6000)=13ms（持平，N=6000 时约 9.5 倍改善）。
      const FRAMES = 20; // 每轮 20 帧；共 4 轮 = 80 帧采样
      const STEP = 5 * MESSAGE_ESTIMATED_ROW_HEIGHT; // 每帧推进 5 行，两侧一致

      /** 低分位估计量：最不受争抢的帧最接近真实单帧成本 */
      const lowPercentile = (durations: number[], q: number): number => {
        const asc = [...durations].sort((a, b) => a - b);
        return asc[Math.min(asc.length - 1, Math.floor(asc.length * q))]!;
      };

      const measure = (count: number): number[] => {
        const props = createDefaultProps(createMockMessages(count));
        const { container, unmount } = render(
          <MessageVirtualizer {...props} />
        );
        const listEl = container.querySelector(
          '[data-virtual-scroll="true"]'
        ) as HTMLElement;
        expect(listEl).not.toBeNull();

        const durations: number[] = [];
        for (let i = 0; i < FRAMES; i++) {
          Object.defineProperty(listEl, 'scrollTop', {
            value: i * STEP,
            configurable: true,
          });
          const startTime = performance.now();
          act(() => {
            fireEvent.scroll(listEl);
          });
          durations.push(performance.now() - startTime);
        }
        unmount();
        return durations;
      };

      // 交错采样：A,B,A,B（抵消顺序偏差）
      const a1 = measure(300);
      const b1 = measure(1500);
      const a2 = measure(300);
      const b2 = measure(1500);

      const baseline = Math.min(lowPercentile(a1, 0.1), lowPercentile(a2, 0.1));
      const large = Math.min(lowPercentile(b1, 0.1), lowPercentile(b2, 0.1));

      // ① 主判据：5 倍消息量下典型帧成本不得放大（自校准，机器速度抵消）
      const growthRatio = large / Math.max(baseline, 0.001);
      expect(growthRatio).toBeLessThan(2.5);
      // ② 绝对冒烟界：仅拦「挂死」级异常，故意取得极宽以免与机器负载耦合
      //    （并发争抢下曾观测单帧 703ms）
      expect(Math.max(...b1, ...b2)).toBeLessThan(5000.0);
      // ③ 基线自身必须有可测耗时（防止 measure 静默返回 0 使比值失去意义）
      expect(baseline).toBeGreaterThan(0);
    }
  );
});
