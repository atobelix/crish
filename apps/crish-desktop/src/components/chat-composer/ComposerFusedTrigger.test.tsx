/**
 * 融合触发：左真模型槽 + 右思考档（yaml key）；无思考则物理卸载。
 */
// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComposerFusedTrigger } from './ComposerFusedTrigger';
import { useSettingsStore } from '../../store/settingsStore';
import {
  getSessionThinkingTitle,
  sessionRuntimeRegistry,
  setSessionThinkingTitle,
} from '../../api/SessionRuntimeRegistry';

const h = vi.hoisted(() => {
  const sessionId = 'sess-fused-1';
  const thinking: Record<string, string> = {
    Low: 'low',
    Medium: 'medium',
    High: 'high',
  };
  let options: Array<{ title: string; wire: string }> = [
    { title: 'Low', wire: 'low' },
    { title: 'Medium', wire: 'medium' },
    { title: 'High', wire: 'high' },
  ];
  return {
    thinking,
    sessionId,
    setOptions(next: Array<{ title: string; wire: string }>) {
      options = next;
    },
    getLiveModel: vi.fn(() =>
      options.length === 0
        ? { id: 'plain-text' }
        : { id: 'acme-think', thinking }
    ),
    listThinkingOptions: vi.fn(() => options),
    resolveThinkingHandoff: vi.fn(
      (providerId: string, modelId: string, selectedTitle: string | null) => {
        if (options.length === 0) {
          return {
            supported: false as const,
            providerId,
            modelId,
            thinking: undefined,
            selectedTitle: null,
            selectedWire: null,
          };
        }
        const hit =
          selectedTitle != null && options.some((o) => o.title === selectedTitle)
            ? options.find((o) => o.title === selectedTitle)!
            : options[0];
        return {
          supported: true as const,
          providerId,
          modelId,
          thinking,
          selectedTitle: hit.title,
          selectedWire: hit.wire,
        };
      }
    ),
  };
});

vi.mock('../../api/modelsCatalogLive', () => ({
  getLiveModel: h.getLiveModel,
  listThinkingOptions: h.listThinkingOptions,
  resolveThinkingHandoff: h.resolveThinkingHandoff,
}));

vi.mock('../../store/sessionStore', () => ({
  useSessionStore: (selector: (s: { activeSessionId: string }) => unknown) =>
    selector({ activeSessionId: h.sessionId }),
}));

vi.mock('../../hooks/useModelsCatalogVersion', () => ({
  useModelsCatalogVersion: () => 1,
}));

describe('ComposerFusedTrigger（S3 融合触发 · live 档位）', () => {
  beforeEach(() => {
    h.setOptions([
      { title: 'Low', wire: 'low' },
      { title: 'Medium', wire: 'medium' },
      { title: 'High', wire: 'high' },
    ]);
    h.getLiveModel.mockClear();
    h.listThinkingOptions.mockClear();
    h.resolveThinkingHandoff.mockClear();
    sessionRuntimeRegistry.clearAll();
    localStorage.setItem('crish_active_profile_id', 'acme');
    localStorage.setItem('crish_active_model_id', 'acme-think');
    // 清除按模型存档的思考档位与全局偏好，避免测试间污染
    localStorage.removeItem('conex:model-thinking-pref:acme:acme-think');
    localStorage.removeItem('conex:global-thinking-pref');
    useSettingsStore.setState({
      appSettings: { defaultThinkingLevel: 'default' },
    });
  });

  afterEach(() => {
    sessionRuntimeRegistry.clearAll();
    // 清除按模型存档的思考档位与全局偏好
    localStorage.removeItem('conex:model-thinking-pref:acme:acme-think');
    localStorage.removeItem('conex:global-thinking-pref');
  });

  it('左槽渲染真模型、右为 yaml key 档位，无 Claude 3.7、无 title、无中文标签', async () => {
    const { container } = render(
      <ComposerFusedTrigger>
        <span>qwen3-coder</span>
      </ComposerFusedTrigger>
    );
    expect(screen.getByTestId('composer-fused-trigger')).toBeTruthy();
    expect(screen.getByText('qwen3-coder')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /思考档位：Low/ })
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(/Claude 3\.7/);
    expect(container.textContent).not.toMatch(/默认|深入|关闭/);
    expect(container.querySelectorAll('[title]').length).toBe(0);
    await waitFor(() => {
      expect(getSessionThinkingTitle(h.sessionId)).toBe('Low');
    });
  });

  it('点思考档打开菜单并写入 sessionRuntimeRegistry.thinkingTitle，不写 settings', async () => {
    render(
      <ComposerFusedTrigger>
        <span>model-a</span>
      </ComposerFusedTrigger>
    );
    fireEvent.click(screen.getByTestId('composer-thinking-trigger'));
    const item = await screen.findByRole('menuitem', { name: /^High$/ });
    fireEvent.click(item);
    await waitFor(() => {
      expect(getSessionThinkingTitle(h.sessionId)).toBe('High');
    });
    expect(
      useSettingsStore.getState().appSettings?.defaultThinkingLevel
    ).toBe('default');
    expect(
      screen.getByRole('button', { name: /思考档位：High/ })
    ).toBeTruthy();
  });

  it('Picker 等外部写 thinkingTitle 后胶囊经事件同步刷新（γ-9 补洞）', async () => {
    render(
      <ComposerFusedTrigger>
        <span>model-a</span>
      </ComposerFusedTrigger>
    );
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /思考档位：Low/ })
      ).toBeTruthy();
    });
    // 模拟 Picker 的写路径：不经 Composer 自身交互，直接写 runtime registry
    setSessionThinkingTitle(h.sessionId, 'High');
    expect(
      await screen.findByRole('button', { name: /思考档位：High/ })
    ).toBeTruthy();
  });

  it('再点思考档关闭菜单且不重开', async () => {
    render(
      <ComposerFusedTrigger>
        <span>model-a</span>
      </ComposerFusedTrigger>
    );
    const trigger = screen.getByTestId('composer-thinking-trigger');
    fireEvent.click(trigger);
    expect(await screen.findByRole('menuitem', { name: /^High$/ })).toBeTruthy();
    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: /^High$/ })).toBeNull()
    );
  });

  it('listThinkingOptions 为空时物理卸载思考槽，不是 display:none', () => {
    h.setOptions([]);
    const { container } = render(
      <ComposerFusedTrigger>
        <span>plain-text</span>
      </ComposerFusedTrigger>
    );
    expect(screen.getByText('plain-text')).toBeTruthy();
    expect(screen.queryByTestId('composer-thinking-trigger')).toBeNull();
    expect(screen.queryByTestId('composer-thinking-slot')).toBeNull();
    expect(container.querySelector('[class*="divider"]')).toBeNull();
    expect(container.querySelector('[class*="right"]')).toBeNull();
    expect(container.querySelector('[style*="display: none"]')).toBeNull();
    expect(container.querySelector('[style*="display:none"]')).toBeNull();
  });

  it('切到非思考模型时思考槽物理卸载，thinkingTitle 保持不变（不再自动清零）', async () => {
    setSessionThinkingTitle(h.sessionId, 'High');
    h.setOptions([]);
    render(
      <ComposerFusedTrigger>
        <span>plain-text</span>
      </ComposerFusedTrigger>
    );
    // 思考槽物理卸载（UI 合约不变）
    await waitFor(() => {
      expect(screen.queryByTestId('composer-thinking-trigger')).toBeNull();
    });
    // 新行为：showThinking=false 时不再自动清零 title（避免异步目录重刷时误清）
    // thinkingTitle 保持为 'High'，供切回思考模型时恢复
    expect(getSessionThinkingTitle(h.sessionId)).toBe('High');
  });

  it('字典里没有的 runtime title 回落到第一 key 并回写', async () => {
    setSessionThinkingTitle(h.sessionId, 'XHigh');
    render(
      <ComposerFusedTrigger>
        <span>acme-think</span>
      </ComposerFusedTrigger>
    );
    await waitFor(() => {
      expect(getSessionThinkingTitle(h.sessionId)).toBe('Low');
    });
    expect(
      screen.getByRole('button', { name: /思考档位：Low/ })
    ).toBeTruthy();
  });

  it('生产源不引用 thinkingGear / getModelMeta / defaultThinkingLevel', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'ComposerFusedTrigger.tsx'),
      'utf8'
    );
    expect(src).not.toMatch(/thinkingGear/);
    expect(src).not.toMatch(/THINKING_LEVEL_LABELS/);
    expect(src).not.toMatch(/resolveCatalogEfforts/);
    expect(src).not.toMatch(/fetchDescribeEffortsSnapshot/);
    expect(src).not.toMatch(/getModelMeta/);
    expect(src).not.toMatch(/setModelThinkingLevel/);
    expect(src).not.toMatch(/defaultThinkingLevel/);
    expect(src).not.toMatch(/setAppSettings/);
    expect(src).not.toMatch(/display:\s*none/);
    expect(src).toMatch(/getLiveModel/);
    expect(src).toMatch(/listThinkingOptions/);
    expect(src).toMatch(/resolveThinkingHandoff/);
    expect(src).toMatch(/useModelsCatalogVersion/);
    expect(src).toMatch(/thinkingTitle/);
  });

  it('data-has-thinking 契约：有思考档位输出 true，无思考档位输出 false', () => {
    const { container: c1, unmount: u1 } = render(
      <ComposerFusedTrigger>
        <span>model-a</span>
      </ComposerFusedTrigger>
    );
    const trigger1 = c1.querySelector('[data-testid="composer-fused-trigger"]');
    expect(trigger1?.getAttribute('data-has-thinking')).toBe('true');
    u1();

    h.setOptions([]);
    const { container: c2 } = render(
      <ComposerFusedTrigger>
        <span>model-plain</span>
      </ComposerFusedTrigger>
    );
    const trigger2 = c2.querySelector('[data-testid="composer-fused-trigger"]');
    expect(trigger2?.getAttribute('data-has-thinking')).toBe('false');
  });

  it('CSS 契约：左右独立 Hover、不对称半胶囊几何端头且容器级 Hover 彻底拔除', () => {
    const css = fs.readFileSync(
      path.join(__dirname, 'ComposerFusedTrigger.module.css'),
      'utf8'
    );
    // 容器级 hover 必须拔除，禁止整体一起变灰
    expect(css).not.toMatch(/\.capsule:hover/);
    expect(css).not.toMatch(/\.capsule:active/);
    // 左半胶囊几何（左圆右平贴合）
    expect(css).toMatch(/14px\s+0\s+0\s+14px/);
    // 右半胶囊几何（左平贴合右圆）
    expect(css).toMatch(/0\s+14px\s+14px\s+0/);
    // 中间弱发丝竖线不占据水平排版空间（margin-left: -1px）
    expect(css).toMatch(/margin-left:\s*-1px/);
    // 左右各自独立 hover
    expect(css).toMatch(/\.thinkBtn:hover/);
    expect(css).toMatch(/button.*:hover/);
  });

  it('prefix 插槽契约：支持前置插槽与 data-has-prefix="true"，分割线正确隔离', () => {
    const { container } = render(
      <ComposerFusedTrigger
        prefix={<button data-testid="prefix-btn">权限</button>}
      >
        <span>model-a</span>
      </ComposerFusedTrigger>
    );
    const trigger = container.querySelector('[data-testid="composer-fused-trigger"]');
    expect(trigger?.getAttribute('data-has-prefix')).toBe('true');
    expect(screen.getByTestId('prefix-btn')).toBeInTheDocument();
    // 存在 prefix 与 model 之间的 divider，以及 model 与 thinking 之间的 divider
    const dividers = container.querySelectorAll('span[class*="divider"]');
    expect(dividers.length).toBe(2);
  });
});
