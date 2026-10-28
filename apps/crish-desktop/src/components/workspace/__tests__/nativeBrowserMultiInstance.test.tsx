/**
 * @vitest-environment jsdom
 * apps/crish-desktop/src/components/workspace/__tests__/nativeBrowserMultiInstance.test.tsx
 *
 * Phase 4: 原生预览多实例与 HWND 视口隔离专项测试套件
 *
 * 验证目标：
 * 1. 消除 `browser-${leafId}` 单实例碰撞：同一叶片下多个 PreviewCard 分别持有唯一 tabId，HWND 不抢占；
 * 2. 零字符串解析与参数直通：params.url 直接透传，无 preview: 弱类型拼装；
 * 3. 容器几何与显隐同步：非激活标签自动隐藏 HWND，激活标签同步边界与可见性。
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('../../../services/toast/ToastContext', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  useToast: () => ({ showToast: vi.fn() }),
  toast: { show: vi.fn(), error: vi.fn() },
}));

import { PreviewCard } from '../PreviewCard';
import * as nativeApi from '../../../api/nativeBrowserApi';
import { LeafScopeProvider } from '../../../contexts/LeafScopeContext';

describe('Phase 4: 原生预览多实例与 HWND 视口隔离', () => {
  let rootRefA: React.RefObject<HTMLDivElement | null>;
  let rootRefB: React.RefObject<HTMLDivElement | null>;

  beforeEach(() => {
    rootRefA = { current: document.createElement('div') };
    rootRefB = { current: document.createElement('div') };
    vi.spyOn(nativeApi, 'browserWebviewCreate').mockResolvedValue();
    vi.spyOn(nativeApi, 'browserWebviewSetBounds').mockResolvedValue();
    vi.spyOn(nativeApi, 'browserWebviewSetVisible').mockResolvedValue();
    vi.spyOn(nativeApi, 'browserWebviewSetHitTest').mockResolvedValue({
      status: 'applied',
      tabId: 'test',
      enabled: true,
      applied: true,
    });
    vi.spyOn(nativeApi, 'browserWebviewClose').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. 同一叶片内多开预览时，每个 PreviewCard 基于唯一 tabId 独占原生 HWND，杜绝 browser-${leafId} 单实例碰撞', async () => {
    const { getByTestId } = render(
      <LeafScopeProvider
        leafId="shared-leaf-1"
        sessionId="sess-1"
        isActive={true}
        leafRootRef={rootRefA}
      >
        <div data-testid="tab-1-wrap">
          <PreviewCard
            tabId="dtab_prev_alpha"
            panelId="dtab_prev_alpha"
            leafId="shared-leaf-1"
            sessionId="sess-1"
            isActive={true}
            initialUrl="https://alpha.example.com"
          />
        </div>
        <div data-testid="tab-2-wrap">
          <PreviewCard
            tabId="dtab_prev_beta"
            panelId="dtab_prev_beta"
            leafId="shared-leaf-1"
            sessionId="sess-1"
            isActive={false}
            initialUrl="https://beta.example.com"
          />
        </div>
      </LeafScopeProvider>
    );

    const surface1 = getByTestId('tab-1-wrap').querySelector(
      '[data-native-surface="true"]'
    );
    const surface2 = getByTestId('tab-2-wrap').querySelector(
      '[data-native-surface="true"]'
    );

    expect(surface1).toBeTruthy();
    expect(surface2).toBeTruthy();

    // 严格绑定对应 tabId，杜绝 browser-shared-leaf-1 碰撞
    expect(surface1?.getAttribute('data-tab-id')).toBe('dtab_prev_alpha');
    expect(surface2?.getAttribute('data-tab-id')).toBe('dtab_prev_beta');

    // 显隐隔离：激活的 tab-1 为 active，非激活的 tab-2 为 inactive
    expect(surface1?.getAttribute('data-is-active')).toBe('true');
    expect(surface2?.getAttribute('data-is-active')).toBe('false');

    await waitFor(() => {
      expect(nativeApi.browserWebviewCreate).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 'dtab_prev_alpha' })
      );
      expect(nativeApi.browserWebviewCreate).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 'dtab_prev_beta' })
      );
    });
  });

  it('2. 零字符串解析与参数直通：initialUrl / initialTarget 完整直通传入', async () => {
    const { getByTestId } = render(
      <LeafScopeProvider
        leafId="leaf-direct"
        sessionId="sess-direct"
        isActive={true}
        leafRootRef={rootRefB}
      >
        <div data-testid="direct-url-wrap">
          <PreviewCard
            tabId="dtab_direct_url"
            initialUrl="https://direct.params.test/path?foo=bar"
            leafId="leaf-direct"
            sessionId="sess-direct"
            isActive={true}
          />
        </div>
      </LeafScopeProvider>
    );

    const surface = getByTestId('direct-url-wrap').querySelector(
      '[data-native-surface="true"]'
    );
    expect(surface?.getAttribute('data-tab-id')).toBe('dtab_direct_url');

    const input = getByTestId('direct-url-wrap').querySelector('input');
    expect(input?.value).toBe('https://direct.params.test/path?foo=bar');
  });

  it('3. 非激活预览标签切换时，对应 HWND 视口被安全隐藏', async () => {
    const { rerender, getByTestId } = render(
      <LeafScopeProvider
        leafId="leaf-toggle"
        sessionId="sess-toggle"
        isActive={true}
        leafRootRef={rootRefA}
      >
        <div data-testid="toggle-wrap">
          <PreviewCard
            tabId="dtab_toggle_active"
            leafId="leaf-toggle"
            sessionId="sess-toggle"
            isActive={true}
            initialUrl="https://toggle.example.com"
          />
        </div>
      </LeafScopeProvider>
    );

    const surface = getByTestId('toggle-wrap').querySelector(
      '[data-native-surface="true"]'
    );
    expect(surface?.getAttribute('data-is-active')).toBe('true');

    // 模拟用户在叶片内切换到其他 Tab，当前 PreviewCard 变为非激活
    rerender(
      <LeafScopeProvider
        leafId="leaf-toggle"
        sessionId="sess-toggle"
        isActive={true}
        leafRootRef={rootRefA}
      >
        <div data-testid="toggle-wrap">
          <PreviewCard
            tabId="dtab_toggle_active"
            leafId="leaf-toggle"
            sessionId="sess-toggle"
            isActive={false}
            initialUrl="https://toggle.example.com"
          />
        </div>
      </LeafScopeProvider>
    );

    expect(surface?.getAttribute('data-is-active')).toBe('false');

    await waitFor(() => {
      // 必须调用 browserWebviewSetVisible(tabId, false)
      expect(nativeApi.browserWebviewSetVisible).toHaveBeenCalledWith(
        'dtab_toggle_active',
        false
      );
    });
  });
});
