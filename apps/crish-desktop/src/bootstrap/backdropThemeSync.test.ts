// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDarkTheme,
  startBackdropThemeSync,
  isWindows11Device,
  syncMicaBackdrop,
} from './backdropThemeSync';

describe('backdropThemeSync：材质跟随应用主题', () => {
  const el = document.documentElement;
  afterEach(() => {
    el.removeAttribute('data-theme');
    el.className = '';
  });

  it('启动即发一次，之后只在明暗真正变化时发送', async () => {
    el.setAttribute('data-theme', 'light');
    const send = vi.fn();
    const stop = startBackdropThemeSync(el, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(false);
    el.setAttribute('data-theme', 'dark');
    await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith(true);
    el.classList.add('theme-dark'); // 仍是深色：不重复发送
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    stop();
  });

  it('识别 data-theme=dark 与 .theme-dark 两种标记', () => {
    el.setAttribute('data-theme', 'dark');
    expect(isDarkTheme(el)).toBe(true);
    el.setAttribute('data-theme', 'default');
    expect(isDarkTheme(el)).toBe(false);
    el.classList.add('theme-dark');
    expect(isDarkTheme(el)).toBe(true);
  });

  it('isWindows11Device 能够正确根据能力标记或系统环境判断', () => {
    (window as any).__CRISH_MICA_SUPPORTED__ = true;
    expect(isWindows11Device()).toBe(true);
    (window as any).__CRISH_MICA_SUPPORTED__ = false;
    expect(isWindows11Device()).toBe(false);
    delete (window as any).__CRISH_MICA_SUPPORTED__;
  });

  it('syncMicaBackdrop 非 Tauri 容器安全无崩溃执行', async () => {
    await expect(syncMicaBackdrop(true, false)).resolves.not.toThrow();
  });
});
