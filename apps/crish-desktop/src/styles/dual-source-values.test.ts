// @vitest-environment node
/**
 * 双层同源协议 · 固定值双源同值契约
 * （范式来源：style-contract.test.ts 批次 2 之 ⑦「固定值双源同值」）
 *
 * 覆盖两组「TS 常量 ↔ CSS token」双源：
 *
 * 1. chat-stream-pad-x
 *    TS  ：chatScrollGeometry.ts 的 CHAT_SCROLL_PAD_X（滚动几何数学的真源）
 *    CSS ：tokens.css 的 --chat-stream-pad-x（布局消费）
 *    裁决背景：2026-09-11 用户裁决「固定 20px，不随密度缩放」——密度可变的值
 *    会使几何测量变成时序依赖，且 gutter 是布局骨架（--chat-col-max 亦固定）。
 *    若两侧漂移：滚动地板槽与消息流错位（该 token 生来就是为了消灭 2px 错位）。
 *
 * 2. pin 产品色板
 *    TS  ：colorPickerUtils.ts 的 PRESET_PIN_COLORS（选中态逻辑真源）
 *    CSS ：tokens.css 的 --pin-palette-*（色轮渲染）
 *    若两侧漂移：用户选中的颜色与色轮上高亮扇区不一致。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function readFile(relPath: string): string {
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

/** 从 tokens.css 顶层提取某 token 的声明值（先剥注释，取最后一次声明） */
function readToken(css: string, token: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(`(?<![\\w-])${token.replace(/[-]/g, '\\$&')}\\s*:\\s*([^;]+);`, 'g');
  let value: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) value = m[1].trim();
  expect(value, `tokens.css 缺少 ${token} 声明`).not.toBeNull();
  return value as string;
}

describe('双层同源协议 · chat-stream-pad-x（滚动几何）', () => {
  const geometryTs = readFile('src/components/chat-message-list/chatScrollGeometry.ts');
  const tokensCss = readFile('src/styles/tokens.css');

  it('TS 真源存在：CHAT_SCROLL_PAD_X 为数值常量', () => {
    const m = geometryTs.match(/export\s+const\s+CHAT_SCROLL_PAD_X\s*=\s*(\d+(?:\.\d+)?)/);
    expect(m, 'chatScrollGeometry.ts 缺少 CHAT_SCROLL_PAD_X 常量').not.toBeNull();
  });

  it('CSS token 存在且为固定值（不得引用 --space-*，防止密度缩放分叉）', () => {
    const value = readToken(tokensCss, '--chat-stream-pad-x');
    expect(value).toBe('20px');
    // 负向：禁止改回 var(--space-…) —— 那会重演「TS 固定 20 / CSS large 24」的分叉
    expect(value.startsWith('var('), 'pad-x 不得引用空间刻度（2026-09-11 裁决：固定 20px）').toBe(false);
  });

  it('双源同值：TS CHAT_SCROLL_PAD_X === CSS --chat-stream-pad-x 数值', () => {
    const tsValue = Number(geometryTs.match(/export\s+const\s+CHAT_SCROLL_PAD_X\s*=\s*(\d+(?:\.\d+)?)/)![1]);
    const cssValue = parseFloat(readToken(tokensCss, '--chat-stream-pad-x'));
    expect(cssValue, `CSS --chat-stream-pad-x(${cssValue}px) 应等于 TS CHAT_SCROLL_PAD_X(${tsValue})`).toBe(tsValue);
  });

  it('负向断言：兜底仅允许「占用中且同值」，空闲文件禁止兜底', () => {
    // 占用豁免：ChatScrollFloorSlot.module.css 正被并行会话迁移阴影 token（2026-09-11），
    // 其兜底 20px 与静态默认同值、行为等价；待其提交后应移出豁免名单，升级为严格断言。
    const OCCUPIED_SAME_VALUE_OK = new Set([
      'src/components/chat-message-list/ChatScrollFloorSlot.module.css',
    ]);
    for (const rel of [
      'src/components/chat-message-list/ChatMessageList.module.css',
      'src/components/chat-message-list/ChatScrollFloorSlot.module.css',
    ]) {
      const css = readFile(rel);
      if (!css.includes('--chat-stream-pad-x')) continue;
      const fallbacks = [...css.matchAll(/var\(--chat-stream-pad-x\s*,\s*([^)]*)\)/g)].map((m) => m[1].trim());
      if (fallbacks.length === 0) continue;
      expect(
        OCCUPIED_SAME_VALUE_OK.has(rel),
        `${rel} 存在兜底 ${fallbacks.join(' ')}——默认值由 tokens.css 静态声明提供；若该文件占用已释放，请移出豁免名单`
      ).toBe(true);
      for (const v of fallbacks) {
        expect(v, `${rel} 兜底值必须与静态默认同值（20px），否则构成第二真源`).toBe('20px');
      }
    }
  });
});

describe('双层同源协议 · pin 产品色板（钉选取色器）', () => {
  const pickerTs = readFile('src/components/chat-message-row/colorPickerUtils.ts');
  const tokensCss = readFile('src/styles/tokens.css');

  /** TS 侧真源：PRESET_PIN_COLORS 的 {label, value} 数组 */
  function readPresetPinColors(): Array<{ label: string; value: string }> {
    const block = pickerTs.match(/export\s+const\s+PRESET_PIN_COLORS[^=]*=\s*\[([\s\S]*?)\n\]/);
    expect(block, 'colorPickerUtils.ts 缺少 PRESET_PIN_COLORS').not.toBeNull();
    const out: Array<{ label: string; value: string }> = [];
    const re = /label:\s*'([^']+)'\s*,\s*value:\s*'(#[0-9a-fA-F]{6})'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block![1]))) out.push({ label: m[1], value: m[2] });
    return out;
  }

  it('TS 真源存在：PRESET_PIN_COLORS 恰为 5 色（与色轮 5 扇区一致）', () => {
    expect(readPresetPinColors().length).toBe(5);
  });

  it('双源同值：TS PRESET_PIN_COLORS 每一项都有同值的 CSS --pin-palette-*', () => {
    const cssByValue = new Map<string, string>();
    for (const name of ['rose', 'amber', 'sky', 'violet', 'pink']) {
      cssByValue.set(readToken(tokensCss, `--pin-palette-${name}`).toLowerCase(), `--pin-palette-${name}`);
    }
    for (const { label, value } of readPresetPinColors()) {
      expect(
        cssByValue.has(value.toLowerCase()),
        `PRESET_PIN_COLORS「${label}」${value} 在 tokens.css 的 --pin-palette-* 中无同值项（双源漂移）`
      ).toBe(true);
    }
  });

  it('CSS 色相条谱色齐全：--pin-hue-* 6 谱色与回环红一致', () => {
    const red = readToken(tokensCss, '--pin-hue-red');
    expect(readToken(tokensCss, '--pin-hue-yellow')).toBe('#ffff00');
    expect(readToken(tokensCss, '--pin-hue-green')).toBe('#00ff00');
    expect(readToken(tokensCss, '--pin-hue-cyan')).toBe('#00ffff');
    expect(readToken(tokensCss, '--pin-hue-blue')).toBe('#0000ff');
    expect(readToken(tokensCss, '--pin-hue-magenta')).toBe('#ff00ff');
    expect(red).toBe('#ff0000');
  });
});
