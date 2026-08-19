// @vitest-environment jsdom
/**
 * codeIndentProjection：settingsStore.markdown.codeBlockIndent → DOM tab-size。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from './settingsStore';
import { initCodeIndentProjection } from './codeIndentProjection';

let unsub: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty('--md-code-tab-size');
  document.documentElement.removeAttribute('data-code-indent');
  useSettingsStore.setState({
    appSettings: null,
    providers: [],
    scheduledTasks: [],
    mcpServers: [],
    tokenUsage: {
      input: 0,
      inputMax: 0,
      output: 0,
      outputMax: 0,
      cost: 0,
      cacheRead: 0,
      cacheWrite: 0,
      savedCost: 0,
    },
  });
});

afterEach(() => {
  unsub?.();
  unsub = null;
  document.documentElement.style.removeProperty('--md-code-tab-size');
  document.documentElement.removeAttribute('data-code-indent');
});

describe('codeIndentProjection', () => {
  it('setAppSettings(codeBlockIndent) → --md-code-tab-size + data-code-indent', () => {
    unsub = initCodeIndentProjection();
    useSettingsStore.getState().setAppSettings({
      markdown: { codeBlockIndent: '    ' },
    } as never);
    expect(
      document.documentElement.style.getPropertyValue('--md-code-tab-size')
    ).toBe('4');
    expect(document.documentElement.getAttribute('data-code-indent')).toBe(
      '4'
    );
  });

  it('同值重复触发幂等（属性保持）', () => {
    unsub = initCodeIndentProjection();
    useSettingsStore.getState().setAppSettings({
      markdown: { codeBlockIndent: '\t' },
    } as never);
    useSettingsStore.getState().setAppSettings({
      markdown: { codeBlockIndent: '\t' },
    } as never);
    expect(document.documentElement.getAttribute('data-code-indent')).toBe(
      'tab'
    );
  });

  it('退订后不再投影', () => {
    unsub = initCodeIndentProjection();
    unsub();
    unsub = null;
    document.documentElement.removeAttribute('data-code-indent');
    useSettingsStore.getState().setAppSettings({
      markdown: { codeBlockIndent: '    ' },
    } as never);
    expect(document.documentElement.getAttribute('data-code-indent')).toBeNull();
  });

  it('appSettings 为 null 时播种默认 2 空格', () => {
    unsub = initCodeIndentProjection();
    expect(
      document.documentElement.style.getPropertyValue('--md-code-tab-size')
    ).toBe('2');
    expect(document.documentElement.getAttribute('data-code-indent')).toBe(
      '2'
    );
  });
});
