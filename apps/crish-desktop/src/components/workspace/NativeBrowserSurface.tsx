/**
 * apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx
 *
 * 原生子 Webview 挖洞占位组件 (Native Browser Surface Placeholder)
 *
 * 核心规范：
 * 1. 绝对纯净的镂空 DOM 占位容器，零 <iframe>，零重绘负载；
 * 2. 原生生命周期与状态机严格收敛：
 *    - 首次挂载并测量 DOMRect 后，调用 browserWebviewCreate；
 *    - 创建成功后标记 isReady = true，激活 useNativeBrowserGeometry 双相几何引擎进行边界与显隐同步；
 *    - 当 tabId 发生切换时，平滑复位状态机，安全隐藏旧 Webview 并挂接新 Webview；
 *    - 组件卸载只隐藏 Webview；物理销毁由 closeTab 生命周期负责。
 * 3. 联动 LayerStackManager：通过 useLayerStackModalActive() 响应全局模态框展开/收起，
 *    自动触发底层 set_visible(false) 并展示半透明磨砂毛玻璃底板，彻底消除 Airspace 穿透遮挡；
 * 4. 接入 useNativeBrowserGeometry 双相几何同步引擎（rAF 单槽节流 + 50ms 静态收敛 + 0.5px 差分去重）；
 * 5. 接入 useHitTestGuard 鼠标穿透看门狗，防范手势中断导致原生视口永久穿透死锁。
 */

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import styles from './NativeBrowserSurface.module.css';
import {
  browserWebviewCreate,
  browserWebviewNavigate,
  browserWebviewSetBounds,
  browserWebviewSetVisible,
} from '../../api/nativeBrowserApi';
import { resolveBrowserTabId } from './nativeBrowserTabId';
import {
  isLifecycleAbortReason,
  formatFriendlyBrowserError,
} from './nativeBrowserError';
import {
  getBrowserDefaultMuted,
  getBrowserStorageMode,
} from '../settings/settingsBrowserLib';
import { toast } from '../../services/toast/toast';
import { useI18n } from '../../i18n';
import {
  isRectInViewport,
  useNativeBrowserGeometry,
  useHitTestGuard,
  useLayerStackModalActive,
  useFloatingActive,
  type NativeBrowserHitTestResult,
  type PhysicalBounds,
} from './nativeBrowserGeometry';

export interface NativeBrowserSurfaceProps {
  /** 浏览器实体唯一标识（对齐 tabId，单一真理来源） */
  tabId?: string;
  /** 兼容别名标识（若传入 browserId 则用作 tabId 兜底） */
  browserId?: string;
  /** 所属窗格叶子节点标识（仅在缺省 tabId 时用于向下兼容兜底） */
  leafId?: string;
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
  /** 原生子 WebView 创建完成或当前创建失败时通知宿主 */
  onReadyChange?: (ready: boolean) => void;
  /** 子元素（通常为空，可用于承载 React 顶层绝对定位覆盖物） */
  children?: React.ReactNode;
}

export interface NativeBrowserSurfaceHandle {
  /** 获取占位 DOM 节点引用 */
  surfaceElement: HTMLDivElement | null;
  /** 触发几何同步 */
  syncGeometry: (immediate?: boolean) => void;
  /** 手动切换鼠标穿透 */
  setHitTest: (
    enabled: boolean
  ) => NativeBrowserHitTestResult | Promise<NativeBrowserHitTestResult>;
}

export const NativeBrowserSurface = forwardRef<
  NativeBrowserSurfaceHandle,
  NativeBrowserSurfaceProps
>(function NativeBrowserSurface(
  {
    tabId,
    browserId,
    leafId,
    initialUrl,
    isActive = true,
    className,
    style,
    onBoundsChange,
    onReadyChange,
    children,
  },
  ref
) {
  const { t } = useI18n();
  const effectiveId = resolveBrowserTabId(tabId ?? browserId, leafId);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [readyTabId, setReadyTabId] = useState<string | null>(null);
  const isReady = readyTabId === effectiveId;
  const lastNavigatedUrlRef = useRef<string | null>(null);
  const onReadyChangeRef = useRef(onReadyChange);
  onReadyChangeRef.current = onReadyChange;
  const lastReportedReadyRef = useRef<boolean | null>(null);
  const notifyReadyChange = useCallback((ready: boolean) => {
    if (lastReportedReadyRef.current === ready) return;
    lastReportedReadyRef.current = ready;
    onReadyChangeRef.current?.(ready);
  }, []);

  // 1. 订阅全仓浮层调度中枢状态 (Airspace Guard: 模态框与浮层菜单/气泡均触发避让)
  const isModalActive = useLayerStackModalActive();
  const isFloatingActive = useFloatingActive();
  const isOccluded = isModalActive || isFloatingActive;

  // 保持对最新属性的引用，避免异步创建闭包读取过期值
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const isOccludedRef = useRef(isOccluded);
  isOccludedRef.current = isOccluded;
  const initialUrlRef = useRef(initialUrl);
  initialUrlRef.current = initialUrl;
  const effectiveIdRef = useRef(effectiveId);
  effectiveIdRef.current = effectiveId;

  // 2. 原生子 Webview 创建、平滑 Tab 切换与卸载收敛生命周期状态机
  useEffect(() => {
    let cancelled = false;
    let createSucceeded = false;
    const currentTabId = effectiveId;
    if (!currentTabId) return;

    notifyReadyChange(false);
    lastNavigatedUrlRef.current = null;

    const el = surfaceRef.current;
    if (!el) return;

    const createArgs = () => {
      const rect = el.getBoundingClientRect();
      return {
        tabId: currentTabId,
        initialUrl: initialUrlRef.current || 'about:blank',
        bounds: {
          x: rect.left,
          y: rect.top,
          width: Math.max(rect.width, 1),
          height: Math.max(rect.height, 1),
        },
        visible:
          Boolean(isActiveRef.current) &&
          !isOccludedRef.current &&
          isRectInViewport(rect),
        storageMode: getBrowserStorageMode(),
        muted: getBrowserDefaultMuted(),
      };
    };

    const reportInitializationError = (
      error: unknown,
      retry: () => Promise<void>
    ) => {
      const reason = error instanceof Error ? error.message : String(error);
      if (isLifecycleAbortReason(reason)) {
        return;
      }
      console.warn(
        `[NativeBrowserSurface] browser initialization/reconciliation failed for ${currentTabId}:`,
        error
      );
      const friendlyReason = formatFriendlyBrowserError(reason, t);
      toast.error(
        t('workspace.browser.syncFailed', '原生浏览器同步失败：{reason}', {
          reason: friendlyReason,
        }),
        {
          action: {
            label: t('common.retry', '重试'),
            onClick: retry,
          },
        }
      );
    };

    const reconcileLatest = async () => {
      if (cancelled || effectiveIdRef.current !== currentTabId) return;
      const latestArgs = createArgs();
      await browserWebviewSetBounds(currentTabId, latestArgs.bounds);
      if (await hideIfCancelled()) return;
      await browserWebviewSetVisible(currentTabId, latestArgs.visible);
      await hideIfCancelled();
    };

    const initWebview = async (): Promise<void> => {
      if (cancelled || effectiveIdRef.current !== currentTabId) return;
      try {
        const initialArgs = createArgs();
        await browserWebviewCreate(initialArgs);
        createSucceeded = true;
        lastNavigatedUrlRef.current = initialArgs.initialUrl;

        if (await hideIfCancelled()) return;

        // The child exists now. Release geometry and hit-test gates before
        // reconciling newer props, so a transient sync error cannot strand it.
        setReadyTabId(currentTabId);
        notifyReadyChange(true);
        await reconcileLatest();
      } catch (err) {
        if (cancelled || effectiveIdRef.current !== currentTabId) return;
        if (createSucceeded) setReadyTabId(currentTabId);
        else notifyReadyChange(false);
        reportInitializationError(err, initWebview);
      }
    };

    const hideIfCancelled = async () => {
      if (!cancelled && effectiveIdRef.current === currentTabId) {
        return false;
      }
      await browserWebviewSetVisible(currentTabId, false);
      return true;
    };

    void initWebview();

    return () => {
      cancelled = true;
      if (createSucceeded) {
        void browserWebviewSetVisible(currentTabId, false).catch((err) => {
          console.warn(
            `[NativeBrowserSurface] hide failed for ${currentTabId}:`,
            err
          );
        });
      }
    };
  }, [effectiveId]);

  // 3. 双相几何同步引擎 (rAF 动态相 + 50ms 静态收敛相 + 0.5px 差分脏矩形拦截)
  const { scheduleSync, syncImmediate } = useNativeBrowserGeometry({
    tabId: effectiveId,
    surfaceRef,
    isReady,
    isActive,
    isOccluded,
    onBoundsChange,
  });
  const { setHitTest } = useHitTestGuard(effectiveId, isReady);

  // 4. 监听 initialUrl 变更并触发原生子视口导航
  useEffect(() => {
    if (
      isReady &&
      initialUrl &&
      initialUrl !== lastNavigatedUrlRef.current &&
      initialUrl !== 'about:blank'
    ) {
      let cancelled = false;
      const navigateLatestUrl = async (): Promise<void> => {
        if (
          cancelled ||
          effectiveIdRef.current !== effectiveId ||
          initialUrlRef.current !== initialUrl
        ) {
          return;
        }
        try {
          await browserWebviewNavigate(effectiveId, initialUrl);
          if (
            !cancelled &&
            effectiveIdRef.current === effectiveId &&
            initialUrlRef.current === initialUrl
          ) {
            lastNavigatedUrlRef.current = initialUrl;
          }
        } catch (err) {
          if (
            cancelled ||
            effectiveIdRef.current !== effectiveId ||
            initialUrlRef.current !== initialUrl
          ) {
            return;
          }
          const reason = err instanceof Error ? err.message : String(err);
          if (isLifecycleAbortReason(reason)) {
            return;
          }
          console.warn(
            `[NativeBrowserSurface] navigate failed for ${effectiveId}:`,
            err
          );
          const friendlyReason = formatFriendlyBrowserError(reason, t);
          toast.error(
            t(
              'workspace.browser.navigationFailed',
              '原生浏览器导航失败：{reason}',
              { reason: friendlyReason }
            ),
            {
              action: {
                label: t('common.retry', '重试'),
                onClick: navigateLatestUrl,
              },
            }
          );
        }
      };
      void navigateLatestUrl();
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [effectiveId, initialUrl, isReady]);

  // 5. 暴露命令式句柄
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
      data-is-floating-active={isFloatingActive ? 'true' : 'false'}
      data-is-occluded={isOccluded ? 'true' : 'false'}
      aria-hidden="true"
    >
      {/* 模态框与浮层打开时的平滑毛玻璃占位底板 (Airspace 避让展示) */}
      {isOccluded && (
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
