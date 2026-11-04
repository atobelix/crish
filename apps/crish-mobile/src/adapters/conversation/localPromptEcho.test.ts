// 本地回显块身份缓存测试（U5 rider）：同一 prompt（id + text +
// atMs 未变）多次投影必须返回同一块对象（toBe 身份断言），任一
// 字段变化才重铸——流式期间回显行引用稳定，行级 memo 不被击穿。
import { createLocalPromptEchoCache } from './localPromptEcho';

describe('createLocalPromptEchoCache', () => {
  it('未变的回显 prompt 保持块引用稳定', () => {
    const echoOf = createLocalPromptEchoCache();
    const prompt = { id: 'local-r1', text: '你好', atMs: 1000 };
    const first = echoOf(prompt);
    expect(first).toMatchObject({
      kind: 'message',
      id: 'local-r1',
      role: 'user',
      text: '你好',
      streaming: false,
      atMs: 1000,
    });
    // 等值的新对象（state 数组重建后的等值条目）仍命中同一块
    expect(echoOf({ ...prompt })).toBe(first);
    expect(echoOf(prompt)).toBe(first);
  });

  it('text 或 atMs 变化 → 重铸新块；不同 id 互不串扰', () => {
    const echoOf = createLocalPromptEchoCache();
    const a = echoOf({ id: 'local-r1', text: '一', atMs: 1 });
    const changedText = echoOf({ id: 'local-r1', text: '一改', atMs: 1 });
    expect(changedText).not.toBe(a);
    expect(changedText).toMatchObject({ text: '一改' });
    const changedAt = echoOf({ id: 'local-r1', text: '一改', atMs: 2 });
    expect(changedAt).not.toBe(changedText);
    const b = echoOf({ id: 'local-r2', text: '一改', atMs: 2 });
    expect(b).not.toBe(changedAt);
    expect(b).toMatchObject({ id: 'local-r2' });
    // 变化后的新值成为新的稳定引用
    expect(echoOf({ id: 'local-r1', text: '一改', atMs: 2 })).toBe(changedAt);
  });
});
