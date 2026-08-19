// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeSendShortcut,
  persistSendShortcut,
  readSendShortcut,
  SEND_SHORTCUT_CHANGED_EVENT,
} from './settingsAccess';

describe('sendShortcut 单钥匙', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('读 crish_settings.sendShortcut，不再依赖 crish_send_shortcut 写入面', () => {
    localStorage.setItem(
      'crish_settings',
      JSON.stringify({ sendShortcut: 'ctrlEnter' })
    );
    expect(readSendShortcut()).toBe('ctrlEnter');
  });

  it('settings 缺字段时回落旧钥匙', () => {
    localStorage.setItem('crish_send_shortcut', 'ctrlEnter');
    expect(readSendShortcut()).toBe('ctrlEnter');
  });

  it('非法值回落 enter', () => {
    expect(normalizeSendShortcut('nope')).toBe('enter');
    expect(normalizeSendShortcut('ctrlEnter')).toBe('ctrlEnter');
  });

  it('persistSendShortcut 写入同一把钥匙并通知同窗 composer', () => {
    localStorage.setItem(
      'crish_settings',
      JSON.stringify({ theme: 'dark', sendShortcut: 'enter' })
    );
    const seen: string[] = [];
    const onChange = () => seen.push(readSendShortcut());
    window.addEventListener(SEND_SHORTCUT_CHANGED_EVENT, onChange);
    expect(persistSendShortcut('ctrlEnter')).toBe('ctrlEnter');
    window.removeEventListener(SEND_SHORTCUT_CHANGED_EVENT, onChange);
    expect(readSendShortcut()).toBe('ctrlEnter');
    expect(seen).toEqual(['ctrlEnter']);
    const stored = JSON.parse(localStorage.getItem('crish_settings') || '{}') as {
      theme?: string;
      sendShortcut?: string;
    };
    expect(stored.theme).toBe('dark');
    expect(stored.sendShortcut).toBe('ctrlEnter');
  });
});
