/**
 * apps/crish-desktop/src/components/sidebar/useSidebarResize.ts
 *
 * 侧栏宽度状态域（分割线统一波次 R1 迁移后形态）：
 * - 手势 / 键盘 / 呈现全部由统一组件 `ui/SplitResizer` 托管（指针捕获、
 *   弹性手柄引擎、Esc 取消、折叠阈值判定、双击复位）；本 hook 不再自滚
 *   pointer 监听，旧 handleSidebarResizeStart 的手势实现已物理删除。
 * - 本 hook 只保留侧栏域状态：宽度 state（单一真源）、挂载恢复
 *   （config → preferences）、提交落盘（applySidebarWidth：store 折叠态 +
 *   根变量 + 事件 + 持久化），以及与手势绑定的全局副作用装配——拖拽期
 *   body 类（is-resizing / sidebar-resizing：shell-reset 的 iframe 封锁与
 *   .sidebar 过渡关停）在手势开始时挂上、在呈现静止（组件 onRest）时才
 *   移除，覆盖回弹收尾全程，杜绝弹簧与 CSS 过渡双轨（与迁移前「松手后
 *   延帧移除防回弹」同一意图，窗口由一帧扩到弹簧收敛点）。
 * - 呈现变量分工：拖拽期组件把弹簧值写在 .sidebar 元素自身内联的
 *   --sidebar-width 上；根（documentElement）变量由本 hook 按已提交状态
 *   同步，静止撤下内联变量后无缝回落。--sidebar-visible-width 在拖拽期
 *   由 onLiveChange 逐帧镜像钳制值（SettingsQuickMenu 锚定消费）。
 */

import { useCallback, useEffect, useState } from 'react';
import { useLayoutStore } from '../../store/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import { configService } from '../../services/ConfigService';
import { preferencesClient } from '../../api/preferences';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarExpandedWidth,
} from './sidebarHelpers';

export function useSidebarResize() {
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const [sidebarWidthPx, setSidebarWidthPx] = useState(SIDEBAR_WIDTH_DEFAULT);

  useEffect(() => {
    let unmounted = false;

    const restoreSidebarWidth = async () => {
      try {
        const layout = configService.get('workspace.layout') as
          { sidebarWidth?: number } | undefined;
        let restoredWidth = layout?.sidebarWidth;
        if (
          typeof restoredWidth !== 'number' ||
          restoredWidth < SIDEBAR_WIDTH_MIN ||
          restoredWidth > SIDEBAR_WIDTH_MAX
        ) {
          try {
            const prefWidth =
              await preferencesClient.getPreference('sidebar_width');
            if (
              typeof prefWidth === 'number' &&
              prefWidth >= SIDEBAR_WIDTH_MIN &&
              prefWidth <= SIDEBAR_WIDTH_MAX
            ) {
              restoredWidth = prefWidth;
            }
          } catch {
            /* ignore preferencesClient read failure */
          }
        }

        if (unmounted) return;

        // DESIGN Token 常量直读：挂载热路径禁止 getComputedStyle（REDLINE-404 / ACT-404）
        let targetWidth = SIDEBAR_WIDTH_DEFAULT;
        if (
          typeof restoredWidth === 'number' &&
          restoredWidth >= SIDEBAR_WIDTH_MIN &&
          restoredWidth <= SIDEBAR_WIDTH_MAX
        ) {
          targetWidth = restoredWidth;
        }

        document.documentElement.style.setProperty(
          '--sidebar-width',
          `${targetWidth}px`
        );
        document.documentElement.style.setProperty(
          '--sidebar-visible-width',
          `${targetWidth}px`
        );
        setSidebarWidthPx(targetWidth);
      } catch {
        /* ignore */
      }
    };

    void restoreSidebarWidth();
    return () => {
      unmounted = true;
      document.body.classList.remove('is-resizing');
      document.body.classList.remove('sidebar-resizing');
    };
  }, []);

  useEffect(() => {
    // 状态 → 根变量同步。迁移后拖拽不再直写根变量（组件把弹簧值写在
    // .sidebar 元素自身的 --sidebar-width 内联变量上，静止撤下后才回落
    // 到根变量），故状态变化必须即时同步：提交瞬间写入的已提交值会被
    // 元素内联变量屏蔽至回弹结束，不与拖拽帧打架。旧实现的 is-resizing
    // 跳过守卫针对的是「拖拽直写根变量、状态滞后一拍」模型，随迁移退役。
    if (sidebarCollapsed) {
      document.documentElement.style.setProperty('--sidebar-width', '0px');
      document.documentElement.style.setProperty(
        '--sidebar-visible-width',
        `${sidebarWidthPx}px`
      );
    } else {
      document.documentElement.style.setProperty(
        '--sidebar-width',
        `${sidebarWidthPx}px`
      );
      document.documentElement.style.setProperty(
        '--sidebar-visible-width',
        `${sidebarWidthPx}px`
      );
      window.dispatchEvent(new Event('crish-sidebar-resize'));
    }
  }, [sidebarCollapsed, sidebarWidthPx]);

  // 折叠即手势生命周期的终点：折叠提交后 SplitResizer 随折叠卸载，
  // onRest 不会再来——拖拽类在此收束，避免常驻关停 .sidebar 过渡与
  // iframe 封锁（折叠后展开侧栏的切换动画需要过渡处于恢复状态）。
  useEffect(() => {
    if (sidebarCollapsed) {
      document.body.classList.remove('is-resizing');
      document.body.classList.remove('sidebar-resizing');
    }
  }, [sidebarCollapsed]);

  const persistSidebarWidth = useCallback((px: number) => {
    try {
      void preferencesClient.setPreference('sidebar_width', px).catch(() => {
        /* swallow-ok: configService 已同步写入；偏好落盘失败不打断拖拽 */
      });
      const layout = configService.get('workspace.layout') as {
        sidebarWidth?: number;
      };
      configService.set('workspace.layout', { ...layout, sidebarWidth: px });
    } catch {
      /* ignore */
    }
  }, []);

  const applySidebarWidth = useCallback(
    (px: number, opts?: { persist?: boolean; collapse?: boolean }) => {
      const layout = getCompositionRoot().layout;
      if (opts?.collapse) {
        layout.setSidebarCollapsed(true);
        document.documentElement.style.setProperty('--sidebar-width', '0px');
        document.documentElement.style.setProperty(
          '--sidebar-visible-width',
          `${sidebarWidthPx}px`
        );
        return;
      }
      const capped = clampSidebarExpandedWidth(px);
      layout.setSidebarCollapsed(false);
      document.documentElement.style.setProperty(
        '--sidebar-width',
        `${capped}px`
      );
      document.documentElement.style.setProperty(
        '--sidebar-visible-width',
        `${capped}px`
      );
      setSidebarWidthPx(capped);
      window.dispatchEvent(new Event('crish-sidebar-resize'));
      if (opts?.persist !== false) persistSidebarWidth(capped);
    },
    [persistSidebarWidth, sidebarWidthPx]
  );

  /**
   * SplitResizer 手势起止透传（组件 onDragStateChange）：
   * 开始时挂上拖拽期 body 协议类；结束时**不**立即移除——回弹收尾期间
   * .sidebar 的 width 过渡必须保持关停、iframe 封锁必须保持生效，待组件
   * 通知呈现静止（handleResizerRest）才统一收束。
   */
  const handleResizerDragStateChange = useCallback((dragging: boolean) => {
    if (dragging) {
      document.body.classList.add('is-resizing');
      document.body.classList.add('sidebar-resizing');
    }
  }, []);

  /** SplitResizer 呈现静止通知（组件 onRest）：收束拖拽期 body 协议类 */
  const handleResizerRest = useCallback(() => {
    document.body.classList.remove('is-resizing');
    document.body.classList.remove('sidebar-resizing');
  }, []);

  /**
   * 拖拽期实时值（组件 onLiveChange，rAF 节流后的钳制值）：
   * --sidebar-visible-width 逐帧镜像（折叠态临时展开与 SettingsQuickMenu
   * 锚定消费的是它而非呈现变量），并广播 crish-sidebar-resize 供锚定方
   * 实时跟随。根 --sidebar-width 不在此写入——呈现值归组件的元素内联
   * 变量，已提交值归状态同步 effect，两者互不踩踏。
   */
  const handleResizerLiveChange = useCallback((px: number) => {
    document.documentElement.style.setProperty(
      '--sidebar-visible-width',
      `${px}px`
    );
    window.dispatchEvent(new Event('crish-sidebar-resize'));
  }, []);

  return {
    sidebarWidthPx,
    applySidebarWidth,
    handleResizerDragStateChange,
    handleResizerRest,
    handleResizerLiveChange,
  };
}
