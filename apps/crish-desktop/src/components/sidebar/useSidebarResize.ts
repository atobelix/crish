import React, { useCallback, useEffect, useState } from 'react';
import { useLayoutStore } from '../../store/layoutStore';
import { configService } from '../../services/ConfigService';
import {
  SIDEBAR_RESIZE_STEP,
  SIDEBAR_RESIZE_STEP_LARGE,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './sidebarHelpers';

export function useSidebarResize() {
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const [sidebarWidthPx, setSidebarWidthPx] = useState(SIDEBAR_WIDTH_DEFAULT);

  useEffect(() => {
    try {
      const layout = configService.get('workspace.layout') as
        | { sidebarWidth?: number }
        | undefined;
      const restoredWidth = layout?.sidebarWidth;
      if (
        typeof restoredWidth === 'number' &&
        restoredWidth >= SIDEBAR_WIDTH_MIN &&
        restoredWidth <= SIDEBAR_WIDTH_MAX
      ) {
        document.documentElement.style.setProperty(
          '--sidebar-width',
          `${restoredWidth}px`
        );
        setSidebarWidthPx(restoredWidth);
        return;
      }
      const raw = localStorage.getItem('crish_sidebar_width');
      const n = raw ? parseInt(raw, 10) : NaN;
      if (
        !Number.isNaN(n) &&
        n >= SIDEBAR_WIDTH_MIN &&
        n <= SIDEBAR_WIDTH_MAX
      ) {
        document.documentElement.style.setProperty(
          '--sidebar-width',
          `${n}px`
        );
        setSidebarWidthPx(n);
      } else {
        const cssW = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(
            '--sidebar-width'
          ),
          10
        );
        if (!Number.isNaN(cssW) && cssW >= SIDEBAR_WIDTH_MIN) {
          setSidebarWidthPx(Math.min(cssW, SIDEBAR_WIDTH_MAX));
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (document.body.classList.contains('is-resizing')) {
      return;
    }
    if (sidebarCollapsed) {
      document.documentElement.style.setProperty('--sidebar-width', '0px');
    } else {
      document.documentElement.style.setProperty(
        '--sidebar-width',
        `${sidebarWidthPx}px`
      );
      window.dispatchEvent(new Event('crish-sidebar-resize'));
    }
  }, [sidebarCollapsed, sidebarWidthPx]);

  const persistSidebarWidth = useCallback((px: number) => {
    try {
      localStorage.setItem('crish_sidebar_width', String(px));
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
      if (opts?.collapse) {
        useLayoutStore.setState({ sidebarCollapsed: true });
        document.documentElement.style.setProperty('--sidebar-width', '0px');
        return;
      }
      const capped = Math.min(
        Math.max(px, SIDEBAR_WIDTH_MIN),
        SIDEBAR_WIDTH_MAX
      );
      useLayoutStore.setState({ sidebarCollapsed: false });
      document.documentElement.style.setProperty(
        '--sidebar-width',
        `${capped}px`
      );
      setSidebarWidthPx(capped);
      window.dispatchEvent(new Event('crish-sidebar-resize'));
      if (opts?.persist !== false) persistSidebarWidth(capped);
    },
    [persistSidebarWidth]
  );

  const handleSidebarResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.classList.add('is-resizing');
    const startX = e.clientX;
    const startWidth =
      parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--sidebar-width'
        ),
        10
      ) || SIDEBAR_WIDTH_DEFAULT;
    let isCurrentlyCollapsed = useLayoutStore.getState().sidebarCollapsed;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      let newWidth = startWidth + dx;
      if (newWidth < 80) {
        if (!isCurrentlyCollapsed) {
          isCurrentlyCollapsed = true;
          useLayoutStore.setState({ sidebarCollapsed: true });
        }
        document.documentElement.style.setProperty('--sidebar-width', '0px');
      } else {
        if (newWidth > SIDEBAR_WIDTH_MAX) newWidth = SIDEBAR_WIDTH_MAX;
        if (isCurrentlyCollapsed) {
          isCurrentlyCollapsed = false;
          useLayoutStore.setState({ sidebarCollapsed: false });
        }
        document.documentElement.style.setProperty(
          '--sidebar-width',
          `${newWidth}px`
        );
        window.dispatchEvent(new Event('crish-sidebar-resize'));
      }
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      document.body.classList.remove('is-resizing');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      const finalWidth = startWidth + (upEvent.clientX - startX);
      if (finalWidth < 80) {
        applySidebarWidth(0, { collapse: true, persist: false });
      } else {
        applySidebarWidth(finalWidth, { persist: true });
      }
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
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
    handleSidebarResizeKeyDown,
  };
}
