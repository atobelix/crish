// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeSendShortcut,
  readSendShortcut,
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
});
