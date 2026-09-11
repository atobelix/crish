// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MessageContent } from './MessageContent';
import {
  NarrativeRenderSlotsContext,
  type ChatNarrativeRenderThoughtArgs,
} from './narrativeRenderSlots';
import type { SessionMessage } from '../../store/types';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: (markdown: string) => ({
    html: markdown ? `<p>${markdown}</p>` : '',
    loading: false,
  }),
  parseMarkdownToHtmlAsync: vi.fn(async (m: string) => `<p>${m}</p>`),
}));

const thoughtMsg: SessionMessage = {
  id: 'msg-thought-1',
  sender: 'assistant',
  text: '结论',
  thinking: '这是一段深度推理',
  status: 'completed',
};

function ThoughtSlotProbe({
  hideThinkingBlock,
  onRenderThought,
  msg = thoughtMsg,
  isThinkingMsg = false,
}: {
  hideThinkingBlock: boolean;
  onRenderThought: (args: ChatNarrativeRenderThoughtArgs) => void;
  msg?: SessionMessage;
  isThinkingMsg?: boolean;
}): React.ReactElement {
  return (
    <NarrativeRenderSlotsContext.Provider
      value={{
        renderThought: (args) => {
          onRenderThought(args);
          return (
            <div
              data-testid="thought-slot"
              data-open={String(args.defaultOpen)}
              data-live={String(args.isLive)}
            />
          );
        },
      }}
    >
      <MessageContent
        msg={msg}
        hideThinkingBlock={hideThinkingBlock}
        isThinkingMsg={isThinkingMsg}
      />
    </NarrativeRenderSlotsContext.Provider>
  );
}

describe('MessageContent hideThinkingBlock', () => {
  it('思考段折叠由四铁律裁决：hideThinkingBlock 仅影响段内思考行默认开合，不覆盖铁律一', () => {
    // 该样本 `thinking` 后跟随正文 `text='结论'`，命中【铁律一】：
    // 过程段后继存在 AI 正文 ⟹ foldable=true ∧ defaultExpanded=false。
    // 铁律一是物理界标裁决，优先级高于 hideThinkingBlock 的视觉偏好，
    // 因此无论 hideThinkingBlock 取何值，过程段一律收敛折叠。
    const folded = render(
      <MessageContent msg={thoughtMsg} hideThinkingBlock />
    );
    const foldedSection = folded.container.querySelector('[data-process-segment]');
    expect(foldedSection).not.toBeNull();
    expect(foldedSection?.getAttribute('data-foldable')).toBe('true');
    expect(foldedSection?.getAttribute('data-expanded')).toBe('false');
    const foldedSlot = foldedSection?.querySelector('[data-testid^="process-slot-"]');
    expect(foldedSlot?.getAttribute('hidden')).toBe('until-found');
    folded.unmount();

    const expanded = render(
      <MessageContent msg={thoughtMsg} hideThinkingBlock={false} />
    );
    const expandedSection = expanded.container.querySelector('[data-process-segment]');
    expect(expandedSection).not.toBeNull();
    // 铁律一同样生效：段仍默认折叠
    expect(expandedSection?.getAttribute('data-expanded')).toBe('false');
    const expandedSlot = expandedSection?.querySelector('[data-testid^="process-slot-"]');
    expect(expandedSlot?.getAttribute('hidden')).toBe('until-found');
  });

  it('叙事槽 renderThought 收到 defaultOpen = !hideThinkingBlock', () => {
    const seen: Array<boolean | undefined> = [];
    const folded = render(
      <ThoughtSlotProbe
        hideThinkingBlock
        onRenderThought={(args) => seen.push(args.defaultOpen)}
      />
    );
    expect(seen.at(-1)).toBe(false);
    expect(folded.getByTestId('thought-slot').getAttribute('data-open')).toBe(
      'false'
    );
    folded.unmount();

    const expanded = render(
      <ThoughtSlotProbe
        hideThinkingBlock={false}
        onRenderThought={(args) => seen.push(args.defaultOpen)}
      />
    );
    expect(seen.at(-1)).toBe(true);
    expect(expanded.getByTestId('thought-slot').getAttribute('data-open')).toBe(
      'true'
    );
  });
});

describe('DIM-05 双阶段生命周期调度与思考折叠规范契约', () => {
  it('Phase 1（流式生成期）：isThinkingMsg=true 时，思考槽 isLive=true 且保持流式直出', () => {
    const liveThoughtMsg: SessionMessage = {
      id: 'msg-live-1',
      sender: 'assistant',
      text: '',
      thinking: '正在实时进行逻辑推演...',
      status: 'processing',
    };

    let receivedArgs: ChatNarrativeRenderThoughtArgs | undefined;
    render(
      <ThoughtSlotProbe
        msg={liveThoughtMsg}
        isThinkingMsg={true}
        hideThinkingBlock={true}
        onRenderThought={(args) => {
          receivedArgs = args;
        }}
      />
    );

    expect(receivedArgs).toBeDefined();
    expect(receivedArgs?.isLive).toBe(true);
    expect(receivedArgs?.content).toBe('正在实时进行逻辑推演...');
  });

  it('Phase 2（轮次闭合期）：status="completed", isThinkingMsg=false 时，进入终态结算，isLive=false', () => {
    const closedThoughtMsg: SessionMessage = {
      id: 'msg-closed-1',
      sender: 'assistant',
      text: '最终回答结论',
      thinking: '已完成的前置思考推演',
      status: 'completed',
    };

    let receivedArgs: ChatNarrativeRenderThoughtArgs | undefined;
    render(
      <ThoughtSlotProbe
        msg={closedThoughtMsg}
        isThinkingMsg={false}
        hideThinkingBlock={false}
        onRenderThought={(args) => {
          receivedArgs = args;
        }}
      />
    );

    expect(receivedArgs).toBeDefined();
    expect(receivedArgs?.isLive).toBe(false);
    expect(receivedArgs?.defaultOpen).toBe(true);
  });

  it('透传指标统计字段 durationMs 与 turnIndex，为 33px 控制栏摘要汇总提供度量基准', () => {
    const timedThoughtMsg: SessionMessage = {
      id: 'msg-timed-1',
      sender: 'assistant',
      text: '回答',
      status: 'completed',
      blocks: [
        {
          type: 'thought',
          content: '耗时分析与执行步骤规划',
          durationMs: 3500,
        },
        {
          type: 'text',
          content: '回答',
        },
      ],
    };

    let receivedArgs: ChatNarrativeRenderThoughtArgs | undefined;
    render(
      <ThoughtSlotProbe
        msg={timedThoughtMsg}
        isThinkingMsg={false}
        hideThinkingBlock={false}
        onRenderThought={(args) => {
          receivedArgs = args;
        }}
      />
    );

    expect(receivedArgs).toBeDefined();
    expect(receivedArgs?.durationMs).toBe(3500);
    expect(receivedArgs?.content).toBe('耗时分析与执行步骤规划');
  });

  it('默认无叙事插槽时，过程段折叠容器具备正确 data 属性与折叠 aria 契约', () => {
    const { container } = render(
      <MessageContent msg={thoughtMsg} hideThinkingBlock={true} />
    );
    const section = container.querySelector('[data-process-segment]');
    expect(section).not.toBeNull();
    expect(section?.getAttribute('data-foldable')).toBe('true');
    expect(section?.getAttribute('data-expanded')).toBe('false');
    expect(section?.querySelector('[aria-expanded="false"]')).not.toBeNull();
    // 负向断言：历史遗留的 `data-kind="thought"` 契约已随旧思考行组件物理切除
    expect(container.querySelector('[data-kind="thought"]')).toBeNull();
  });
});

