import { describe, expect, it } from 'vitest';
import {
  CHAT_SCROLL_PAD_BOTTOM,
  CHAT_SCROLL_PAD_TOP,
  chatSpacerHeight,
  contentOffsetToDocOffset,
} from './chatScrollGeometry';

describe('chatScrollGeometry', () => {
  it('spacer = padTop + content + padBottom', () => {
    expect(chatSpacerHeight(1000)).toBe(CHAT_SCROLL_PAD_TOP + 1000 + CHAT_SCROLL_PAD_BOTTOM);
  });

  it('空内容仍有顶/底衬（避免 sticky 遮挡与贴边）', () => {
    expect(chatSpacerHeight(0)).toBe(CHAT_SCROLL_PAD_TOP + CHAT_SCROLL_PAD_BOTTOM);
    expect(chatSpacerHeight(-10)).toBe(CHAT_SCROLL_PAD_TOP + CHAT_SCROLL_PAD_BOTTOM);
  });

  it('内容偏移映射到文档坐标', () => {
    expect(contentOffsetToDocOffset(0)).toBe(CHAT_SCROLL_PAD_TOP);
    expect(contentOffsetToDocOffset(120)).toBe(CHAT_SCROLL_PAD_TOP + 120);
  });
});
