import { useLayoutStore } from '../store/layoutStore';
import type {
  UiSize,
  ShellChromeMode,
} from '../store/layout-helpers/store-types';
import { tokenRuntimeController } from './TokenRuntimeController';

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
 * 监听 layoutStore 变更，直接操作 document.documentElement
 */
export function initVisualPresentationController(): () => void {
  if (typeof document === 'undefined') {
    return () => {};
  }

  const applyUiSize = (size: UiSize) => {
    const root = document.documentElement;
    root.setAttribute('data-ui-size', size);
    root.setAttribute('data-density', UI_DENSITY_MAP[size] || 'default');
    tokenRuntimeController.setUiScale(size);
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

  // 2. 细粒度订阅布局变更 (使用 subscribe 监听特定字段变化，不触发 React 渲染)
  // uiSize / shellChromeMode 唯一 DOM 应用路径——layoutStore 是单一真源
  // （维度 2 收敛：已删除 settingsStore.appSettings.uiSize 的重复订阅）
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
    unsubLayout();
  };
}
