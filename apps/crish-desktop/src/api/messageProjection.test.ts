import { describe, expect, it } from 'vitest';
import type {
  AgentMessage,
  AgentMessageBlock,
} from '../../../../packages/shared-types/src/generated/engine';
import {
  agentBlockToTimelineBlock,
  projectAgentMessageContent,
  projectAgentMessageToSessionMessage,
} from './messageProjection';

describe('agentBlockToTimelineBlock', () => {
  it('text 块投影为 text 时间线块', () => {
    expect(agentBlockToTimelineBlock({ type: 'text', text: '你好' })).toEqual({
      type: 'text',
      content: '你好',
    });
  });

  it('thought 块投影为 thought 时间线块（redacted 透传）', () => {
    expect(
      agentBlockToTimelineBlock({ type: 'thought', text: '思路' })
    ).toEqual({
      type: 'thought',
      content: '思路',
    });
    expect(
      agentBlockToTimelineBlock({
        type: 'thought',
        text: '思路',
        redacted: true,
      })
    ).toEqual({ type: 'thought', content: '思路', redacted: true });
  });

  it('tool-call 块投影为 tool_call 锚点', () => {
    expect(
      agentBlockToTimelineBlock({
        type: 'tool-call',
        id: 'call-1',
        toolName: 'read',
        input: {},
      })
    ).toEqual({ type: 'tool_call', id: 'call-1' });
  });

  it('tool-result 块投影为 tool_call 锚点（无独立展示块）', () => {
    expect(
      agentBlockToTimelineBlock({
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'read',
        output: { text: 'ok' },
        isError: false,
      })
    ).toEqual({ type: 'tool_call', id: 'call-1' });
  });

  it('image 块不合成时间线块（返回 null；图片走消息级 images 通道）', () => {
    const urlImage: AgentMessageBlock = {
      type: 'image',
      url: 'https://example.com/a.png',
      mimeType: 'image/png',
      alt: '示意图',
    };
    expect(agentBlockToTimelineBlock(urlImage)).toBeNull();
    // data 形态同样不合成为时间线块
    expect(
      agentBlockToTimelineBlock({
        type: 'image',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
      })
    ).toBeNull();
  });
});

describe('projectAgentMessageToSessionMessage · image 块处置', () => {
  const base: AgentMessage = {
    id: 'm1',
    role: 'assistant',
    createdAt: '2026-11-01T00:00:00.000Z',
    blocks: [],
  };

  it('混合块中 image 被过滤，其余块按发生序投影', () => {
    const msg = projectAgentMessageToSessionMessage({
      ...base,
      blocks: [
        { type: 'text', text: '前' },
        { type: 'image', mimeType: 'image/png', url: 'https://x/y.png' },
        { type: 'tool-call', id: 'c1', toolName: 'read', input: {} },
        { type: 'text', text: '后' },
      ],
    });
    expect(msg.blocks).toEqual([
      { type: 'text', content: '前' },
      { type: 'tool_call', id: 'c1' },
      { type: 'text', content: '后' },
    ]);
    expect(msg.text).toBe('前后');
    expect(msg.timestamp).toBe(Date.parse('2026-11-01T00:00:00.000Z'));
  });

  it('仅 image 块时不挂 blocks（无任何合成块）', () => {
    const msg = projectAgentMessageToSessionMessage({
      ...base,
      blocks: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    });
    expect(msg.blocks).toBeUndefined();
  });
});

describe('projectAgentMessageContent · image 块不贡献文本', () => {
  it('image 块对 text / thought 均无贡献', () => {
    expect(
      projectAgentMessageContent({
        blocks: [
          { type: 'text', text: '正文' },
          { type: 'image', mimeType: 'image/png', url: 'https://x/y.png' },
          { type: 'thought', text: '思路' },
        ],
      })
    ).toEqual({ text: '正文', thought: '思路' });
  });
});

describe('projectAgentMessageContent · thought 段间分隔（HC1 · D-5）', () => {
  it('多段 thought 以换行分隔，段标题不粘连成无界长句', () => {
    expect(
      projectAgentMessageContent({
        blocks: [
          { type: 'thought', text: '第一段标题' },
          { type: 'thought', text: '第二段标题' },
        ],
      })
    ).toEqual({ text: '', thought: '第一段标题\n第二段标题' });
  });

  it('空 thought 段不产生多余分隔符', () => {
    expect(
      projectAgentMessageContent({
        blocks: [
          { type: 'thought', text: '' },
          { type: 'thought', text: '唯一一段' },
        ],
      })
    ).toEqual({ text: '', thought: '唯一一段' });
  });
});
