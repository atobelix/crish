// G3 导出 Markdown 拼装测试：时序渲染 / 角色段 / 工具摘要 / 宽容跳过。
import type { JsonValue } from '@crish/shared-types';
import { buildSessionMarkdown } from './sessionMarkdown';

function ev(value: Record<string, unknown>): JsonValue {
  return value as JsonValue;
}

describe('buildSessionMarkdown', () => {
  it('标题 = 会话名，消息按时序渲染为用户/助手段', () => {
    const md = buildSessionMarkdown('登录页修复', [
      ev({
        type: 'message-end',
        message: {
          role: 'user',
          blocks: [{ type: 'text', text: '帮我修登录页' }],
        },
      }),
      ev({
        type: 'message-end',
        message: {
          role: 'assistant',
          blocks: [
            { type: 'text', text: '好的。' },
            { type: 'tool-call', id: 't1' },
            { type: 'text', text: '已定位到验证码组件。' },
          ],
        },
      }),
    ]);
    expect(md).toContain('# 登录页修复');
    expect(md).toContain('## 用户\n\n帮我修登录页');
    expect(md).toContain('## 助手\n\n好的。\n\n已定位到验证码组件。');
    expect(md.indexOf('## 用户')).toBeLessThan(md.indexOf('## 助手'));
  });

  it('工具摘要：tool-start 行 + tool-end 结果首行（截断）', () => {
    const md = buildSessionMarkdown('t', [
      ev({ type: 'tool-start', toolName: 'grep_search' }),
      ev({
        type: 'tool-end',
        result: { output: '\n  找到 3 处匹配\n第二行不进摘要' },
      }),
    ]);
    expect(md).toContain('- 工具：grep_search');
    expect(md).toContain('  - 结果：找到 3 处匹配');
    expect(md).not.toContain('第二行不进摘要');
  });

  it('流式增量与生命周期事件不进导出；未知角色消息跳过', () => {
    const md = buildSessionMarkdown('t', [
      ev({ type: 'message-delta', block: { type: 'text', text: '增量' } }),
      ev({ type: 'agent-start' }),
      ev({
        type: 'message-end',
        message: { role: 'system', blocks: [{ type: 'text', text: '系统' }] },
      }),
      ev({ type: 'run-terminal' }),
    ]);
    expect(md).toBe('# t\n');
    expect(md).not.toContain('增量');
  });

  it('空标题回退未命名会话；content 兜底', () => {
    const md = buildSessionMarkdown('  ', [
      ev({
        type: 'message-end',
        message: { role: 'user', content: '纯文本消息' },
      }),
    ]);
    expect(md).toContain('# 未命名会话');
    expect(md).toContain('## 用户\n\n纯文本消息');
  });

  it('空事件序列只导出标题壳（与桌面空壳导出口径一致）', () => {
    expect(buildSessionMarkdown('空会话', [])).toBe('# 空会话\n');
  });
});
