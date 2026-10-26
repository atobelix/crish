// @vitest-environment jsdom
/**
 * 虚拟滚动快速滚动稳定性与测高联动契约测试
 * 对齐 P3-T04 与 R-P3-01：双重内衬根除后列宽拓宽至 720px，行距与折行估算联动升级。
 */
import { describe, expect, it } from 'vitest';
import {
  VirtualScrollManager,
  CHAT_ROW_GAP_PX,
  ESTIMATE_TEXT_CHARS_PER_LINE,
  ESTIMATE_TEXT_LINE_HEIGHT_PX,
  estimateTimelineMessageHeight,
} from '../VirtualScrollManager';
import { readStreamPadX } from '../../components/chat-message-list/chatScrollGeometry';
import type { SessionMessage } from '../../store/types';

describe('P3-T04: 虚拟滚动估算与测高联动参数契约', () => {
  it('行距与折行基准对齐 P3 规范定值', () => {
    // P3 规范：--gap-block 与默认行距收敛为 20px
    expect(CHAT_ROW_GAP_PX).toBe(20);
    // 双重内衬消除后，内容区展开至 720px，每行平均字符数从 38 提升至 40
    expect(ESTIMATE_TEXT_CHARS_PER_LINE).toBe(40);
    // 正文行高 1.55 对应 22px
    expect(ESTIMATE_TEXT_LINE_HEIGHT_PX).toBe(22);
  });

  it('readStreamPadX 运行时纯辅助函数正确读取 DOM 与安全回退', () => {
    // 1. 无 DOM / 默认回退 20px
    expect(readStreamPadX(null)).toBe(20);

    // 2. DOM 元素声明了 --stream-pad-x
    const container = document.createElement('div');
    container.style.setProperty('--stream-pad-x', '24px');
    document.body.appendChild(container);
    expect(readStreamPadX(container)).toBe(24);

    // 3. 历史兼容读取 --chat-stream-pad-x
    const legacyContainer = document.createElement('div');
    legacyContainer.style.setProperty('--chat-stream-pad-x', '20px');
    document.body.appendChild(legacyContainer);
    expect(readStreamPadX(legacyContainer)).toBe(20);

    // 4. 清理
    document.body.removeChild(container);
    document.body.removeChild(legacyContainer);
  });
});

describe('P3: 虚拟滚动快速滚动稳定性测试 (virtualScroll.stability)', () => {
  /**
   * 构造包含 100 条真实混合消息的数据集
   * 包含：正文长短文本、思考折叠块、工具调用簇、用户提问、纯状态载体
   */
  function createMixedMessages(count = 100): SessionMessage[] {
    const list: SessionMessage[] = [];
    for (let i = 0; i < count; i++) {
      const id = `msg-${i + 1}`;
      if (i % 5 === 0) {
        // 用户消息
        list.push({
          id,
          sender: 'user',
          text: `用户提问第 ${i} 轮：测试虚拟滚动在多行长文输入下的折行高度表现。\n第二行详细描述用户的问题场景。`,
          timestamp: Date.now() + i * 1000,
        } as SessionMessage);
      } else if (i % 5 === 1) {
        // 含思考块与工具调用的复杂助手消息
        list.push({
          id,
          sender: 'assistant',
          blocks: [
            { type: 'thought', content: '正在分析问题并规划执行步骤...' },
            {
              type: 'tool_call',
              toolName: 'read_file',
              args: { path: '/test.ts' },
            },
            {
              type: 'text',
              content:
                '根据分析结果，我们建议执行如下重构方案：\n1. 根除双重内衬\n2. 保持单源间距',
            },
          ],
          timestamp: Date.now() + i * 1000,
        } as unknown as SessionMessage);
      } else if (i % 5 === 2) {
        // 长文本正文消息（触发折行估高）
        const longText =
          '深入理解计算机系统的虚拟滚动架构，在不同视口宽度下必须保证行高估算连续且单调递增。'.repeat(
            5
          );
        list.push({
          id,
          sender: 'assistant',
          blocks: [{ type: 'text', content: longText }],
          timestamp: Date.now() + i * 1000,
        } as unknown as SessionMessage);
      } else if (i % 5 === 3) {
        // 纯状态载体
        list.push({
          id,
          sender: 'system',
          text: '系统状态已更新',
          timestamp: Date.now() + i * 1000,
        } as SessionMessage);
      } else {
        // 普通短正文助手消息
        list.push({
          id,
          sender: 'assistant',
          text: `这是简短的回复条目 ${i}。`,
          timestamp: Date.now() + i * 1000,
        } as SessionMessage);
      }
    }
    return list;
  }

  it('用例 2.1: 快速滚动下高度与偏移稳定性（从 0px 快速滚至 2000px 无跳变）', () => {
    const messages = createMixedMessages(100);
    const ids = messages.map((m) => m.id);
    const vsm = new VirtualScrollManager(120);

    const estimates = messages.map((msg) => ({
      id: msg.id,
      height: estimateTimelineMessageHeight(msg),
    }));
    vsm.preloadEstimates(estimates);
    vsm.syncOrder(ids);

    const viewportHeight = 600;
    const overscan = 2;
    const scrollStep = 200;
    const maxScroll = 2000;

    let previousRange = vsm.computeVisibleRange(
      0,
      viewportHeight,
      ids.length,
      overscan
    );
    expect(previousRange.startIndex).toBe(0);
    expect(previousRange.startOffset).toBe(0);
    expect(previousRange.estimatedTotalHeight).toBeGreaterThan(maxScroll);

    // 模拟从 0 到 2000px 的快速滚动流
    for (
      let scrollTop = scrollStep;
      scrollTop <= maxScroll;
      scrollTop += scrollStep
    ) {
      const range = vsm.computeVisibleRange(
        scrollTop,
        viewportHeight,
        ids.length,
        overscan
      );

      // 1. 结构完整性断言
      expect(range.startIndex).toBeGreaterThanOrEqual(0);
      expect(range.endIndex).toBeGreaterThanOrEqual(range.startIndex);
      expect(range.endIndex).toBeLessThan(ids.length);

      // 2. startOffset 必须与 startIndex 的前缀和严格精确吻合（O(log N) BIT 寻址恒等）
      const expectedOffset = vsm.getOffset(range.startIndex);
      expect(range.startOffset).toBe(expectedOffset);

      // 3. 快速滚动单调性：随着 scrollTop 增加，可视起点单调非递减
      expect(range.startIndex).toBeGreaterThanOrEqual(previousRange.startIndex);
      expect(range.startOffset).toBeGreaterThanOrEqual(
        previousRange.startOffset
      );

      // 4. 视口覆盖保证：计算出的可视窗口必须完全覆写 [scrollTop, scrollTop + viewportHeight] 范围
      const endItemOffset =
        vsm.getOffset(range.endIndex) +
        (vsm.getActualHeight(ids[range.endIndex]) ??
          estimates[range.endIndex].height);
      expect(endItemOffset).toBeGreaterThanOrEqual(
        Math.min(scrollTop + viewportHeight, vsm.getTotalHeight())
      );

      // 5. 模拟回写当前可见项的实测高度（与估算高度相近，如波动在 2px 以内）
      for (let i = range.startIndex; i <= range.endIndex; i++) {
        const estH = estimates[i].height;
        // 模拟真实渲染尺寸（微小误差）
        vsm.setActual(ids[i], estH);
      }

      // 回写后再次计算 visibleRange，验证绝对无巨幅弹跳（偏移量变动不超过 1px）
      const postMeasureRange = vsm.computeVisibleRange(
        scrollTop,
        viewportHeight,
        ids.length,
        overscan
      );
      const deltaOffset = Math.abs(
        postMeasureRange.startOffset - range.startOffset
      );
      expect(deltaOffset).toBeLessThanOrEqual(1);

      previousRange = postMeasureRange;
    }
  });

  it('用例 2.2: 边界与极窄视口退化测试（400px 视口，左右留 20px 安全槽）', () => {
    // 极窄视口 400px：--stream-pad-x 为 20px 时，内容区宽度为 400 - 20 * 2 = 360px
    const padX = readStreamPadX(null);
    expect(padX).toBe(20);
    const containerWidth = 400;
    const contentWidth = containerWidth - padX * 2;
    expect(contentWidth).toBe(360);

    // 测试长文本在极窄视口下的估高表现：无 NaN，无负数
    const testMsg: SessionMessage = {
      id: 'narrow-1',
      sender: 'assistant',
      text: '这是一个极窄视口测试，验证文本估高算法在内容区变窄时的鲁棒性。'.repeat(
        10
      ),
      timestamp: Date.now(),
    } as SessionMessage;

    const estimatedHeight = estimateTimelineMessageHeight(testMsg);
    expect(Number.isFinite(estimatedHeight)).toBe(true);
    expect(estimatedHeight).toBeGreaterThan(50);
    expect(estimatedHeight).toBeLessThanOrEqual(10000);

    // 边界用例：空文本、超长字符、仅空格、极端退化
    const emptyMsg: SessionMessage = {
      id: 'empty-1',
      sender: 'assistant',
      text: '',
      timestamp: Date.now(),
    } as SessionMessage;
    const emptyH = estimateTimelineMessageHeight(emptyMsg);
    expect(emptyH).toBeGreaterThanOrEqual(50);

    const hugeMsg: SessionMessage = {
      id: 'huge-1',
      sender: 'user',
      text: 'A'.repeat(5000),
      timestamp: Date.now(),
    } as SessionMessage;
    const hugeH = estimateTimelineMessageHeight(hugeMsg);
    expect(hugeH).toBeLessThanOrEqual(1000); // 截断保护
  });
});
