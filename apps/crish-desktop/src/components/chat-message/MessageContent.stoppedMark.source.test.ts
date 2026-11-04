/**
 * 批 B ㉖ 源码契约：「已停止」安静行的呈现条件——
 * 仅 stoppedByUser 标记驱动、仅分支 α（零可渲染内容）呈现；
 * 有部分正文的 β/γ 分支不追加本行（按既有形态收口）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fs.readFileSync(
  path.resolve(__dirname, './MessageContent.tsx'),
  'utf8'
);
const MARK = fs.readFileSync(
  path.resolve(__dirname, './TurnStoppedMark.tsx'),
  'utf8'
);

describe('MessageContent 已停止行（批 B ㉖）', () => {
  it('stoppedMark 由 msg.stoppedByUser 驱动并委托 TurnStoppedMark 呈现', () => {
    expect(SRC).toMatch(/msg\.stoppedByUser === true/);
    expect(SRC).toMatch(/<TurnStoppedMark \/>/);
  });

  it('TurnStoppedMark：专属 testid + 文案走 i18n 键', () => {
    expect(MARK).toMatch(/data-testid="turn-stopped-mark"/);
    expect(MARK).toMatch(/t\('chat\.message\.turnStopped'\)/);
  });

  it('仅分支 α 返回 stoppedMark（β/γ 不引用，避免有正文时加行）', () => {
    expect(SRC).toMatch(/return stoppedMark;/);
    const occurrences = SRC.match(/stoppedMark/g) ?? [];
    // const stoppedMark 定义 + 分支 α return，共 2 处
    expect(occurrences.length).toBe(2);
  });

  it('与失败标记 interruptedMark 相互独立（停止非失败）', () => {
    expect(SRC).toMatch(/data-testid="turn-interrupted-mark"/);
    expect(SRC).not.toMatch(/stoppedByUser[\s\S]{0,80}turn-interrupted-mark/);
  });
});
