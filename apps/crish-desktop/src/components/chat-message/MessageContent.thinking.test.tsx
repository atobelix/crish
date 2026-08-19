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
}: {
  hideThinkingBlock: boolean;
  onRenderThought: (args: ChatNarrativeRenderThoughtArgs) => void;
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
            />
          );
        },
      }}
    >
      <MessageContent msg={thoughtMsg} hideThinkingBlock={hideThinkingBlock} />
    </NarrativeRenderSlotsContext.Provider>
  );
}

describe('MessageContent hideThinkingBlock', () => {
  it('为真时思考段默认折叠，为假时默认展开', () => {
    const folded = render(
      <MessageContent msg={thoughtMsg} hideThinkingBlock />
    );
    const foldedThought = folded.container.querySelector('[data-kind="thought"]');
    expect(foldedThought).not.toBeNull();
    expect(
      foldedThought?.querySelector('[aria-expanded="false"]')
    ).not.toBeNull();
    expect(
      foldedThought?.querySelector('[data-expanded="false"]')
    ).not.toBeNull();
    folded.unmount();

    const expanded = render(
      <MessageContent msg={thoughtMsg} hideThinkingBlock={false} />
    );
    const expandedThought = expanded.container.querySelector(
      '[data-kind="thought"]'
    );
    expect(expandedThought).not.toBeNull();
    expect(
      expandedThought?.querySelector('[aria-expanded="true"]')
    ).not.toBeNull();
    expect(
      expandedThought?.querySelector('[data-expanded="true"]')
    ).not.toBeNull();
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
