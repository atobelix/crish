// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeSendShortcut,
  persistSendShortcut,
  readSendShortcut,
  SEND_SHORTCUT_CHANGED_EVENT,
} from './settingsAccess';
import { useSettingsStore } from '../../store/settingsStore';

describe('sendShortcut 单钥匙', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ appSettings: null });
  });

  it('读 settingsStore.sendShortcut', () => {
    useSettingsStore.setState({
      appSettings: { sendShortcut: 'ctrlEnter' } as never,
    });
    expect(readSendShortcut()).toBe('ctrlEnter');
  });

  it('非法值回落 enter', () => {
    expect(normalizeSendShortcut('nope')).toBe('enter');
    expect(normalizeSendShortcut('ctrlEnter')).toBe('ctrlEnter');
  });

  it('persistSendShortcut 写入 store 并通知同窗 composer', () => {
    useSettingsStore.setState({
      appSettings: { theme: 'dark', sendShortcut: 'enter' } as never,
    });
    const seen: string[] = [];
    const onChange = () => seen.push(readSendShortcut());
    window.addEventListener(SEND_SHORTCUT_CHANGED_EVENT, onChange);
    expect(persistSendShortcut('ctrlEnter')).toBe('ctrlEnter');
    window.removeEventListener(SEND_SHORTCUT_CHANGED_EVENT, onChange);
    expect(readSendShortcut()).toBe('ctrlEnter');
    expect(seen).toEqual(['ctrlEnter']);
    expect(useSettingsStore.getState().appSettings?.sendShortcut).toBe('ctrlEnter');
  });
});
