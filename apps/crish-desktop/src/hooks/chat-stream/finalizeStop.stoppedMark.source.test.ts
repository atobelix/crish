/**
 * 批 B ㉖ 源码契约：停止收口的标记与反馈单轨——
 * 非 silent（用户主动）停止才落 stoppedByUser 标记，silent 内部停止不冒充
 * 用户可见语义；无正文分支不再弹「已停止本轮生成」toast（呈现单轨到流内行）。
 * 无句柄兜底路径的队列收口 toast 不在本形态范围内，保持不动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fs.readFileSync(
  path.resolve(__dirname, './useStreamCallbacks.ts'),
  'utf8'
);

describe('finalizeStopGeneration 已停止标记（批 B ㉖）', () => {
  it('非 silent 时调用 markMessageStoppedByUser 标记助手消息', () => {
    expect(SRC).toMatch(
      /if \(!silent\) \{\s*st\.markMessageStoppedByUser\(sid, cur\.assistantMsgId\);/
    );
  });

  it('无正文分支不再弹停止 toast（行内行单轨呈现）', () => {
    expect(SRC).not.toMatch(/已停止本轮生成。/);
    expect(SRC).not.toMatch(/已强制停止本轮生成。/);
  });

  it('无句柄兜底路径的队列收口 toast 保持不动', () => {
    expect(SRC).toMatch(/已停止任务并清空排队。/);
  });
});
