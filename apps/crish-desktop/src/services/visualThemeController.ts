import { useSettingsStore } from '../store/settingsStore';
import { useLayoutStore } from '../store/layoutStore';
import type {
  UiSize,
  ShellChromeMode,
} from '../store/layout-helpers/store-types';

export const UI_SCALE_MAP: Record<UiSize, string> = {
  small: '0.9',
  medium: '1.0',
  large: '1.1',
};

export const UI_DENSITY_MAP: Record<UiSize, string> = {
  small: 'compact',
  medium: 'default',
  large: 'comfortable',
};

/**
 * 视觉配置直写 DOM 控制器 (React 0 重绘机制)
 * 监听 settingsStore 与 layoutStore 变更，直接操作 document.documentElement
 */
export function initVisualPresentationController(): () => void {
  if (typeof document === 'undefined') {
    return () => {};
  }

  const applyUiSize = (size: UiSize) => {
    const root = document.documentElement;
    root.setAttribute('data-ui-size', size);
    root.setAttribute('data-density', UI_DENSITY_MAP[size] || 'default');
    root.style.setProperty('--ui-scale', UI_SCALE_MAP[size] || '1.0');
  };

  const applyShellChrome = (mode: ShellChromeMode) => {
    document.documentElement.setAttribute(
      'data-shell-chrome',
      mode || 'classic'
    );
  };

  // 1. 初始化时同步应用首屏配置
  const initialLayout = useLayoutStore.getState();
  const initialUiSize = (initialLayout?.uiSize as UiSize) || 'medium';
  const initialChrome = initialLayout?.shellChromeMode || 'classic';
  applyUiSize(initialUiSize);
  applyShellChrome(initialChrome);

  // 2. 细粒度订阅设置变更 (使用 subscribe 监听特定字段变化，不触发 React 渲染)
  const unsubSettings = useSettingsStore.subscribe((state, prev) => {
    const nextSettings = state.appSettings as Record<string, unknown> | null;
    const prevSettings = prev?.appSettings as Record<string, unknown> | null;
    const nextSize = nextSettings?.uiSize as UiSize | undefined;
    const prevSize = prevSettings?.uiSize as UiSize | undefined;
    if (nextSize && nextSize !== prevSize) {
      applyUiSize(nextSize);
    }
  });

  const unsubLayout = useLayoutStore.subscribe((state, prev) => {
    if (state.uiSize && state.uiSize !== prev?.uiSize) {
      applyUiSize(state.uiSize);
    }
    if (
      state.shellChromeMode &&
      state.shellChromeMode !== prev?.shellChromeMode
    ) {
      applyShellChrome(state.shellChromeMode);
    }
  });

  return () => {
    unsubSettings();
    unsubLayout();
  };
}
