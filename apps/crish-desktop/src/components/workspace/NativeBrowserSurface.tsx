/**
 * apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx
 *
 * 原生子 Webview 挖洞占位组件 (Native Browser Surface Placeholder)
 *
 * 核心规范：
 * 1. 绝对纯净的镂空 DOM 占位容器，零 <iframe>，零重绘负载；
 * 2. 联动 LayerStackManager：通过 useLayerStackModalActive() 响应全局模态框展开/收起，
 *    自动触发底层 set_visible(false) 并展示半透明磨砂毛玻璃底板，彻底消除 Airspace 穿透遮挡；
 * 3. 接入 useNativeBrowserGeometry 双相几何同步引擎（rAF 单槽节流 + 50ms 静态收敛 + 0.5px 差分去重）；
 * 4. 接入 useHitTestGuard 鼠标穿透看门狗，防范手势中断导致原生视口永久穿透死锁。
 */

import React, {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from 'react';
import styles from './NativeBrowserSurface.module.css';
import {
  useNativeBrowserGeometry,
  useHitTestGuard,
  useLayerStackModalActive,
  sendNativeBrowserVisible,
  sendNativeBrowserNavigate,
  type PhysicalBounds,
} from './nativeBrowserGeometry';

export interface NativeBrowserSurfaceProps {
  /** 浏览器实体唯一标识（对齐 tabId，单一真理来源） */
  tabId?: string;
  /** 兼容别名标识（若传入 browserId 则用作 tabId 兜底） */
  browserId?: string;
  /** 初始加载或当前目标 URL */
  initialUrl?: string;
  /** 视口是否处于活跃展示态（Tab 切换与抽屉显隐控制） */
  isActive?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  /** 几何物理矩形发生有效变化时的回调 */
  onBoundsChange?: (bounds: PhysicalBounds) => void;
  /** 子元素（通常为空，可用于承载 React 顶层绝对定位覆盖物） */
  children?: React.ReactNode;
}

export interface NativeBrowserSurfaceHandle {
  /** 获取占位 DOM 节点引用 */
  surfaceElement: HTMLDivElement | null;
  /** 触发几何同步 */
  syncGeometry: (immediate?: boolean) => void;
  /** 手动切换鼠标穿透 */
  setHitTest: (enabled: boolean) => void;
}

export const NativeBrowserSurface = forwardRef<
  NativeBrowserSurfaceHandle,
  NativeBrowserSurfaceProps
>(function NativeBrowserSurface(
  {
    tabId,
    browserId,
    initialUrl,
    isActive = true,
    className,
    style,
    onBoundsChange,
    children,
  },
  ref
) {
  const effectiveId = tabId ?? browserId ?? 'default-native-browser';
  const surfaceRef = useRef<HTMLDivElement>(null);

  // 1. 订阅全仓浮层调度中枢模态状态 (Airspace Guard)
  const isModalActive = useLayerStackModalActive();

  // 2. 双相几何同步引擎 (rAF 动态相 + 50ms 静态收敛相 + 0.5px 差分脏矩形拦截)
  const { scheduleSync, syncImmediate } = useNativeBrowserGeometry({
    tabId: effectiveId,
    surfaceRef,
    isActive,
    isOccluded: isModalActive,
    onBoundsChange,
  });

  // 3. 鼠标穿透 Hit-Test 状态机与自愈看门狗 (手势中断/失焦自愈)
  const { setHitTest } = useHitTestGuard(effectiveId);

  // 4. 监听 initialUrl 变更并触发原生子视口导航
  const lastNavigatedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      initialUrl &&
      initialUrl !== lastNavigatedUrlRef.current &&
      initialUrl !== 'about:blank'
    ) {
      lastNavigatedUrlRef.current = initialUrl;
      void sendNativeBrowserNavigate(effectiveId, initialUrl);
    }
  }, [effectiveId, initialUrl]);

  // 5. 组件卸载时安全将底层视口隐身
  useEffect(() => {
    return () => {
      void sendNativeBrowserVisible(effectiveId, false);
    };
  }, [effectiveId]);

  // 6. 暴露命令式句柄
  useImperativeHandle(
    ref,
    () => ({
      surfaceElement: surfaceRef.current,
      syncGeometry: (immediate = false) => {
        if (immediate) {
          syncImmediate();
        } else {
          scheduleSync(false);
        }
      },
      setHitTest,
    }),
    [scheduleSync, syncImmediate, setHitTest]
  );

  return (
    <div
      ref={surfaceRef}
      className={[styles.nativeHole, className].filter(Boolean).join(' ')}
      style={style}
      data-native-surface="true"
      data-testid="native-browser-surface"
      data-tab-id={effectiveId}
      data-browser-id={effectiveId}
      data-initial-url={initialUrl}
      data-is-active={isActive ? 'true' : 'false'}
      data-is-modal-active={isModalActive ? 'true' : 'false'}
      aria-hidden="true"
    >
      {/* 模态框打开时的平滑毛玻璃占位底板 (Airspace 避让展示) */}
      {isModalActive && (
        <div
          className={styles.scrimPlaceholder}
          data-testid="native-surface-scrim"
          aria-hidden="true"
        />
      )}
      {children}
    </div>
  );
});

NativeBrowserSurface.displayName = 'NativeBrowserSurface';
