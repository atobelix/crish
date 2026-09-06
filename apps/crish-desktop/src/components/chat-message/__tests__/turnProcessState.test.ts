/**
 * apps/crish-desktop/src/components/chat-message/__tests__/turnProcessState.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  deriveTurnProcessState,
  countProcessMetrics,
} from '../turnProcessState';
import type { AssistantTimelineItem } from '../../../api/toolPresentation';

describe('DIM-05 7 布尔量折叠状态机纯逻辑数学矩阵断言', () => {
  it('分支 1：流式生成中 (isTurnLive=true)，无论内容如何，foldable 必须为 false，processHidden 必须为 false', () => {
    const state = deriveTurnProcessState({
      isTurnLive: true,
      msgStatus: 'processing',
      itemKind: 'tools',
      isFinalAnswer: false,
      hasToolsOrThinking: true,
      toolCount: 5,
      userExpanded: false,
    });

    expect(state.processWindowReady).toBe(false);
    expect(state.foldable).toBe(false);
    expect(state.processHidden).toBe(false);
  });

  it('分支 2：生成完成且具备正文，未手动展开时，自动判定 foldable=true, processHidden=true, compactAnswer=true', () => {
    const state = deriveTurnProcessState({
      isTurnLive: false,
      msgStatus: 'completed',
      itemKind: 'tools',
      isFinalAnswer: false,
      hasToolsOrThinking: true,
      toolCount: 3,
      userExpanded: false,
    });

    expect(state.processWindowReady).toBe(true);
    expect(state.processMember).toBe(true);
    expect(state.foldable).toBe(true);
    expect(state.processHidden).toBe(true);
  });

  it('分支 3：用户手动点击展开后，processHidden 立即翻转为 false', () => {
    const state = deriveTurnProcessState({
      isTurnLive: false,
      msgStatus: 'completed',
      itemKind: 'tools',
      isFinalAnswer: false,
      hasToolsOrThinking: true,
      toolCount: 3,
      userExpanded: true,
    });

    expect(state.foldable).toBe(true);
    expect(state.processHidden).toBe(false);
    expect(state.compactAnswer).toBe(false);
  });

  it('分支 4：Tool-Only 纯工具终态轮次（无正文但工具>=2），自动收敛为 foldable=true, processHidden=true', () => {
    const state = deriveTurnProcessState({
      isTurnLive: false,
      msgStatus: 'completed',
      itemKind: 'tools',
      isFinalAnswer: false,
      hasToolsOrThinking: true,
      toolCount: 4,
      userExpanded: false,
    });

    expect(state.foldable).toBe(true);
    expect(state.processHidden).toBe(true);
  });

  it('分支 5：简单文本问答（无工具、无思考），foldable 必须为 false，折叠栏不激活', () => {
    const state = deriveTurnProcessState({
      isTurnLive: false,
      msgStatus: 'completed',
      itemKind: 'text',
      isFinalAnswer: true,
      hasToolsOrThinking: false,
      toolCount: 0,
      userExpanded: false,
    });

    expect(state.foldable).toBe(false);
    expect(state.processHidden).toBe(false);
  });
});

describe('DIM-05 指标统计纯函数测试', () => {
  it('精准累加单工具、工具组与思考耗时', () => {
    const mockItems: AssistantTimelineItem[] = [
      {
        kind: 'thought',
        key: 'th-1',
        content: '思考内容',
        durationMs: 2500,
      },
      {
        kind: 'tools',
        key: 'tc-1',
        items: [
          { kind: 'single', tc: { id: '1', name: 'read_file', status: 'success' } as any },
          {
            kind: 'group',
            id: 'g1',
            label: '搜索组',
            tools: [
              { id: '2', name: 'grep', status: 'success' } as any,
              { id: '3', name: 'grep', status: 'success' } as any,
            ],
          },
        ],
      },
    ];

    const metrics = countProcessMetrics(mockItems);
    expect(metrics.toolCount).toBe(3); // 1 single + 2 in group
    expect(metrics.thoughtCount).toBe(1);
    expect(metrics.durationMs).toBe(2500);
  });
});
