/**
 * setup soft-hint 可见性：与 FirstRun / 空态协调，禁止 toast 引导。
 * 互斥出口 resolveSetupHintKind + chatEmptyState 纯函数契约。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveNeedsKeySoftHintText,
  resolveNeedsModelSoftHintText,
  shouldShowNeedsKeySoftHint,
  shouldShowNeedsModelSoftHint,
} from '../../api/chatEmptyState';
import {
  resolveSetupHintKind,
  type SetupHintKind,
} from './chatStatusRibbonsLib';

describe('ChatStatusRibbons setup soft-hint branches', () => {
  it('hides key hint while FirstRun overlay is open', () => {
    expect(
      shouldShowNeedsKeySoftHint({
        needsKeySetup: true,
        firstRunOpen: true,
        engineOk: true,
      })
    ).toBe(false);
  });

  it('shows key hint after wizard when still needs key (page soft-hint, not toast)', () => {
    expect(
      shouldShowNeedsKeySoftHint({
        needsKeySetup: true,
        firstRunOpen: false,
        engineOk: true,
      })
    ).toBe(true);
  });

  it('hides model hint while FirstRun open or key still needed', () => {
    expect(
      shouldShowNeedsModelSoftHint({
        needsModelSetup: true,
        firstRunOpen: true,
        engineOk: true,
      })
    ).toBe(false);
    expect(
      shouldShowNeedsModelSoftHint({
        needsModelSetup: true,
        needsKeySetup: true,
        firstRunOpen: false,
        engineOk: true,
      })
    ).toBe(false);
  });

  it('shows model hint for hand-fill path when key ready', () => {
    expect(
      shouldShowNeedsModelSoftHint({
        needsModelSetup: true,
        needsKeySetup: false,
        firstRunOpen: false,
        engineOk: true,
      })
    ).toBe(true);
  });

  it('defers setup hints when engine soft-hint owns the bar', () => {
    expect(
      shouldShowNeedsKeySoftHint({
        needsKeySetup: true,
        firstRunOpen: false,
        engineOk: false,
      })
    ).toBe(false);
    expect(
      shouldShowNeedsModelSoftHint({
        needsModelSetup: true,
        firstRunOpen: false,
        engineOk: false,
      })
    ).toBe(false);
  });

  it('uses compact copy on empty surface (avoid double guidance)', () => {
    const keyFull = resolveNeedsKeySoftHintText({ onEmptySurface: false });
    const keyCompact = resolveNeedsKeySoftHintText({ onEmptySurface: true });
    expect(keyCompact.length).toBeLessThan(keyFull.length);
    expect(keyCompact).toMatch(/密钥/);

    const modelFull = resolveNeedsModelSoftHintText({ onEmptySurface: false });
    const modelCompact = resolveNeedsModelSoftHintText({
      onEmptySurface: true,
    });
    expect(modelCompact.length).toBeLessThan(modelFull.length);
    expect(modelCompact).toMatch(/手填|模型/);
  });

  it('never shows key and model setup hints together (key wins)', () => {
    // 密钥未就绪时 model 条必须让位，避免 soft-hint 叠两条
    const key = shouldShowNeedsKeySoftHint({
      needsKeySetup: true,
      firstRunOpen: false,
      engineOk: true,
    });
    const model = shouldShowNeedsModelSoftHint({
      needsModelSetup: true,
      needsKeySetup: true,
      firstRunOpen: false,
      engineOk: true,
    });
    expect(key).toBe(true);
    expect(model).toBe(false);
  });

  it('model hint only after key path clear and wizard closed', () => {
    expect(
      shouldShowNeedsModelSoftHint({
        needsModelSetup: true,
        needsKeySetup: false,
        firstRunOpen: false,
        engineOk: null,
      })
    ).toBe(true);
  });
});

describe('resolveSetupHintKind (mutual exclusion)', () => {
  it('returns null while FirstRun overlay owns the surface', () => {
    expect(
      resolveSetupHintKind({
        needsKeySetup: true,
        needsModelSetup: true,
        engineOk: false,
        localHasKey: true,
        firstRunOpen: true,
      })
    ).toBeNull();
  });

  it('prefers engine-down over key / model / sync', () => {
    expect(
      resolveSetupHintKind({
        needsKeySetup: true,
        needsModelSetup: true,
        engineOk: false,
        engineHasApiKey: false,
        localHasKey: true,
        firstRunOpen: false,
      })
    ).toBe('engine-down');
  });

  it('prefers needs-key over model and sync', () => {
    expect(
      resolveSetupHintKind({
        needsKeySetup: true,
        needsModelSetup: true,
        engineOk: true,
        engineHasApiKey: false,
        localHasKey: true,
        firstRunOpen: false,
      })
    ).toBe('needs-key');
  });

  it('shows needs-model when key ready and hand-fill needed', () => {
    expect(
      resolveSetupHintKind({
        needsKeySetup: false,
        needsModelSetup: true,
        engineOk: true,
        engineHasApiKey: true,
        localHasKey: true,
        firstRunOpen: false,
      })
    ).toBe('needs-model');
  });

  it('shows sync-engine only when engine ok, engine key missing, local has key', () => {
    expect(
      resolveSetupHintKind({
        needsKeySetup: false,
        needsModelSetup: false,
        engineOk: true,
        engineHasApiKey: false,
        localHasKey: true,
        firstRunOpen: false,
      })
    ).toBe('sync-engine');
  });

  it('does not show sync when local has no key', () => {
    expect(
      resolveSetupHintKind({
        needsKeySetup: false,
        needsModelSetup: false,
        engineOk: true,
        engineHasApiKey: false,
        localHasKey: false,
        firstRunOpen: false,
      })
    ).toBeNull();
  });

  it('does not show sync when engine already has key', () => {
    expect(
      resolveSetupHintKind({
        needsKeySetup: false,
        needsModelSetup: false,
        engineOk: true,
        engineHasApiKey: true,
        localHasKey: true,
        firstRunOpen: false,
      })
    ).toBeNull();
  });

  it('engineOk null allows needs-key but not engine-down or sync', () => {
    expect(
      resolveSetupHintKind({
        needsKeySetup: true,
        engineOk: null,
        engineHasApiKey: null,
        localHasKey: true,
        firstRunOpen: false,
      })
    ).toBe('needs-key');
    expect(
      resolveSetupHintKind({
        needsKeySetup: false,
        needsModelSetup: false,
        engineOk: null,
        engineHasApiKey: false,
        localHasKey: true,
        firstRunOpen: false,
      })
    ).toBeNull();
  });

  it('at most one kind for any combined setup flags', () => {
    const combos: Array<Parameters<typeof resolveSetupHintKind>[0]> = [
      {
        needsKeySetup: true,
        needsModelSetup: true,
        engineOk: false,
        localHasKey: true,
        firstRunOpen: false,
      },
      {
        needsKeySetup: true,
        needsModelSetup: true,
        engineOk: true,
        engineHasApiKey: false,
        localHasKey: true,
        firstRunOpen: false,
      },
      {
        needsKeySetup: false,
        needsModelSetup: true,
        engineOk: true,
        engineHasApiKey: false,
        localHasKey: true,
        firstRunOpen: false,
      },
      {
        needsKeySetup: false,
        needsModelSetup: false,
        engineOk: true,
        engineHasApiKey: false,
        localHasKey: true,
        firstRunOpen: false,
      },
    ];
    const kinds = new Set<SetupHintKind>();
    for (const c of combos) {
      const k = resolveSetupHintKind(c);
      if (k) kinds.add(k);
      // 每次调用至多一个 kind（类型上已保证；再断言非数组）
      expect(k === null || typeof k === 'string').toBe(true);
    }
    expect(kinds.has('engine-down')).toBe(true);
    expect(kinds.has('needs-key')).toBe(true);
    expect(kinds.has('needs-model')).toBe(true);
    expect(kinds.has('sync-engine')).toBe(true);
  });

  it('SetupHintBanner CSS 契约：中性边框（无 --brand 绿边）、与输入框同宽居中、图标与文本同水平中线', () => {
    const css = fs.readFileSync(
      path.join(__dirname, 'SetupHintBanner.module.css'),
      'utf8'
    );
    expect(css).not.toMatch(/var\(--brand\)/);
    expect(css).toMatch(/margin:\s*0\s+auto/);
    expect(css).toMatch(/max-width:\s*100%/);
    expect(css).toMatch(/\.chatSoftHintIcon\s*\{[^}]*display:\s*inline-flex/s);
    expect(css).toMatch(/\.chatSoftHintIcon\s*\{[^}]*align-items:\s*center/s);
  });
});
