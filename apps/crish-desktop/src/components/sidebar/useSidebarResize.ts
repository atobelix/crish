import React, { useCallback, useEffect, useState } from 'react';
import { useLayoutStore } from '../../store/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import { configService } from '../../services/ConfigService';
import { preferencesClient } from '../../api/preferences';
import {
  SIDEBAR_RESIZE_STEP,
  SIDEBAR_RESIZE_STEP_LARGE,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarExpandedWidth,
  shouldCollapseSidebar,
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
            const prefWidth = await preferencesClient.getPreference('sidebar_width');
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

        if (
          typeof restoredWidth === 'number' &&
          restoredWidth >= SIDEBAR_WIDTH_MIN &&
          restoredWidth <= SIDEBAR_WIDTH_MAX
        ) {
          document.documentElement.style.setProperty(
            '--sidebar-width',
            `${restoredWidth}px`
          );
          document.documentElement.style.setProperty(
            '--sidebar-visible-width',
            `${restoredWidth}px`
          );
          setSidebarWidthPx(restoredWidth);
          return;
        }

        const cssW = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(
            '--sidebar-width'
          ),
          10
        );
        if (!Number.isNaN(cssW) && cssW >= SIDEBAR_WIDTH_MIN) {
          const visibleW = Math.min(cssW, SIDEBAR_WIDTH_MAX);
          document.documentElement.style.setProperty(
            '--sidebar-visible-width',
            `${visibleW}px`
          );
          setSidebarWidthPx(visibleW);
        } else {
          document.documentElement.style.setProperty(
            '--sidebar-visible-width',
            `${SIDEBAR_WIDTH_DEFAULT}px`
          );
          setSidebarWidthPx(SIDEBAR_WIDTH_DEFAULT);
        }
      } catch {
        /* ignore */
      }
    };

    void restoreSidebarWidth();
    return () => {
      unmounted = true;
    };
  }, []);

  useEffect(() => {
    if (document.body.classList.contains('is-resizing')) {
      return;
    }
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

  const persistSidebarWidth = useCallback((px: number) => {
    try {
      void preferencesClient.setPreference('sidebar_width', px).catch(() => {});
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

  const handleSidebarResizeStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handleEl = e.currentTarget as HTMLElement;
    try {
      handleEl.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom / 非 primary 指针 */
    }
    handleEl.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
    document.body.classList.add('sidebar-resizing');
    const startX = e.clientX;
    const cssW = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--sidebar-width'
      ),
      10
    );
    const startWidth =
      Number.isFinite(cssW) && cssW > 0
        ? cssW
        : sidebarWidthPx || SIDEBAR_WIDTH_DEFAULT;
    const layout = getCompositionRoot().layout;
    let isCurrentlyCollapsed = layout.getSidebarCollapsed();
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      let newWidth = startWidth + dx;
      if (shouldCollapseSidebar(newWidth)) {
        if (!isCurrentlyCollapsed) {
          isCurrentlyCollapsed = true;
          layout.setSidebarCollapsed(true);
        }
        document.documentElement.style.setProperty('--sidebar-width', '0px');
      } else {
        newWidth = clampSidebarExpandedWidth(newWidth);
        if (isCurrentlyCollapsed) {
          isCurrentlyCollapsed = false;
          layout.setSidebarCollapsed(false);
        }
        document.documentElement.style.setProperty(
          '--sidebar-width',
          `${newWidth}px`
        );
        document.documentElement.style.setProperty(
          '--sidebar-visible-width',
          `${newWidth}px`
        );
        window.dispatchEvent(new Event('crish-sidebar-resize'));
      }
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      try {
        if (handleEl.hasPointerCapture?.(upEvent.pointerId)) {
          handleEl.releasePointerCapture(upEvent.pointerId);
        }
      } catch {
        /* ignore */
      }
      handleEl.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      document.body.classList.remove('sidebar-resizing');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      const finalWidth = startWidth + (upEvent.clientX - startX);
      if (shouldCollapseSidebar(finalWidth)) {
        applySidebarWidth(0, { collapse: true, persist: false });
      } else {
        applySidebarWidth(finalWidth, { persist: true });
      }
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleSidebarResizeDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  };

  const handleSidebarResizeKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? SIDEBAR_RESIZE_STEP_LARGE : SIDEBAR_RESIZE_STEP;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      applySidebarWidth(sidebarWidthPx - step);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      applySidebarWidth(sidebarWidthPx + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      applySidebarWidth(SIDEBAR_WIDTH_MIN);
    } else if (e.key === 'End') {
      e.preventDefault();
      applySidebarWidth(SIDEBAR_WIDTH_MAX);
    }
  };

  return {
    sidebarWidthPx,
    applySidebarWidth,
    handleSidebarResizeStart,
    handleSidebarResizeDoubleClick,
    handleSidebarResizeKeyDown,
  };
}
