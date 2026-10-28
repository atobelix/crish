// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  CHAT_SCROLL_PAD_BOTTOM,
  CHAT_SCROLL_PAD_TOP,
  chatSpacerHeight,
  contentOffsetToDocOffset,
  readStreamPadX,
  readStreamPadding,
} from './chatScrollGeometry';

describe('chatScrollGeometry', () => {
  it('spacer = padTop + content + padBottom', () => {
    expect(chatSpacerHeight(1000)).toBe(
      CHAT_SCROLL_PAD_TOP + 1000 + CHAT_SCROLL_PAD_BOTTOM
    );
  });

  it('空内容仍有顶/底衬（避免 sticky 遮挡与贴边）', () => {
    expect(chatSpacerHeight(0)).toBe(
      CHAT_SCROLL_PAD_TOP + CHAT_SCROLL_PAD_BOTTOM
    );
    expect(chatSpacerHeight(-10)).toBe(
      CHAT_SCROLL_PAD_TOP + CHAT_SCROLL_PAD_BOTTOM
    );
  });

  it('内容偏移映射到文档坐标', () => {
    expect(contentOffsetToDocOffset(0)).toBe(CHAT_SCROLL_PAD_TOP);
    expect(contentOffsetToDocOffset(120)).toBe(CHAT_SCROLL_PAD_TOP + 120);
  });

  it('readStreamPadX 遵循 CSS 变量 SSOT 与 20px 安全回退', () => {
    expect(readStreamPadX(null)).toBe(20);

    const el = document.createElement('div');
    el.style.setProperty('--stream-pad-x', '24px');
    document.body.appendChild(el);
    expect(readStreamPadX(el)).toBe(24);

    const legacyEl = document.createElement('div');
    legacyEl.style.setProperty('--chat-stream-pad-x', '18px');
    document.body.appendChild(legacyEl);
    expect(readStreamPadX(legacyEl)).toBe(18);

    document.body.removeChild(el);
    document.body.removeChild(legacyEl);
  });

  it('readStreamPadding 彻底清除未定义变量引用与虚假 fallback，保持单源几何真理', () => {
    // null 目标回退至 readStreamPadX SSOT
    expect(readStreamPadding(null)).toEqual({ padStart: 20, padEnd: 20 });

    // 未设置 padding 的元素同样回退至 readStreamPadX
    const emptyEl = document.createElement('div');
    document.body.appendChild(emptyEl);
    expect(readStreamPadding(emptyEl)).toEqual({ padStart: 20, padEnd: 20 });

    // 真实盒模型 computed padding 正确度量
    const customEl = document.createElement('div');
    customEl.style.paddingLeft = '20px';
    customEl.style.paddingRight = '48px';
    document.body.appendChild(customEl);
    expect(readStreamPadding(customEl)).toEqual({ padStart: 20, padEnd: 48 });

    document.body.removeChild(emptyEl);
    document.body.removeChild(customEl);
  });
});
