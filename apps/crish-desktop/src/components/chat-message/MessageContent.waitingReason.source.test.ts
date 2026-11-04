/**
 * 批 B ⑲ 源码契约（钉住）：等待占位的原因文案接线——
 * 分支 α 的等待呈现与 retry 原因行（InFlowStatusLine）同屏；
 * WorkingStatusIndicator 在 MessageContent 内从不被喂字面 statusText，
 * 即无前置工作时不编造原因文案。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fs.readFileSync(
  path.resolve(__dirname, './MessageContent.tsx'),
  'utf8'
);

describe('MessageContent 等待原因接线（批 B ⑲）', () => {
  it('等待分支与 InFlowStatusLine 原因行同屏（由 inFlowRetry 驱动）', () => {
    expect(SRC).toMatch(
      /\{inFlowRetry && <InFlowStatusLine retry=\{inFlowRetry\} \/>\}/
    );
  });

  it('WorkingStatusIndicator 从不被喂字面 statusText', () => {
    expect(SRC).not.toMatch(/<WorkingStatusIndicator[^>]*statusText=/);
  });

  it('inFlowRetry 只在 retrying 相位且本轮活跃时成立（无前置信号不出行）', () => {
    expect(SRC).toMatch(/runtimeStatus\?\.phase === 'retrying'/);
  });
});
