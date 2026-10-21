import { describe, expect, it } from 'vitest';
import { resolveTiptapKeydown } from './TiptapKeymap';

const enter = {
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
};

const tab = {
  key: 'Tab',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
};

describe('resolveTiptapKeydown', () => {
  it('codeBlock 内 Tab → insertIndent', () => {
    expect(
      resolveTiptapKeydown(tab, {
        sendShortcut: 'enter',
        inCodeBlock: true,
        suggestionActive: false,
      })
    ).toBe('insertIndent');
  });

  it('建议弹层打开时 Tab 放行（斜杠/提及接管）', () => {
    expect(
      resolveTiptapKeydown(tab, {
        sendShortcut: 'enter',
        inCodeBlock: true,
        suggestionActive: true,
      })
    ).toBe('pass');
  });

  it('非 codeBlock Tab 放行', () => {
    expect(
      resolveTiptapKeydown(tab, {
        sendShortcut: 'enter',
        inCodeBlock: false,
        suggestionActive: false,
      })
    ).toBe('pass');
  });

  it('codeBlock 内 Shift+Tab 不插入', () => {
    expect(
      resolveTiptapKeydown(
        { ...tab, shiftKey: true },
        {
          sendShortcut: 'enter',
          inCodeBlock: true,
          suggestionActive: false,
        }
      )
    ).toBe('pass');
  });

  it('codeBlock 内 Enter 仍只换行', () => {
    expect(
      resolveTiptapKeydown(enter, {
        sendShortcut: 'enter',
        inCodeBlock: true,
        suggestionActive: false,
      })
    ).toBe('pass');
  });

  it('建议弹层打开时 Enter 交给建议层，不发送', () => {
    expect(
      resolveTiptapKeydown(enter, {
        sendShortcut: 'enter',
        inCodeBlock: false,
        suggestionActive: true,
      })
    ).toBe('pass');
  });

  it('普通段落 Enter 发送', () => {
    expect(
      resolveTiptapKeydown(enter, {
        sendShortcut: 'enter',
        inCodeBlock: false,
        suggestionActive: false,
      })
    ).toBe('send');
  });
});
