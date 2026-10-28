// @vitest-environment jsdom
/**
 * P6 输入坞一体化契约测试（T6-1 / T6-2 / T6-4 / T6-6 / T6-7）
 *
 * 覆盖：
 * 1. 单卡围合与内嵌通知顶槽（[data-composer-card] [data-embedded-top-slot]）零独立外框、零 360px 脱节；
 * 2. 7 类通知源归属矩阵（COMPOSER_NOTICE_SOURCE_MATRIX）100% 路由至内嵌顶槽；
 * 3. 28x28 正圆发送钮全场景常驻（空输入 disabled 态 opacity: 0.38，零 width: 0 坍缩）；
 * 4. PermissionModeMenu 单/多行全场景常驻左槽（[data-composer-grid="left"]）且稳态去橙色；
 * 5. 柔焦护栏（常规 6%，session-empty 3% ≤ 5%）与 20 个死类清零。
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '../ChatComposer';
import {
  COMPOSER_NOTICE_SOURCE_MATRIX,
  resolveComposerNoticePlacement,
  resolveLegacyNoticeType,
  resolveNoticeSeverity,
  shouldRenderInEmbeddedTopSlot,
  type ComposerNoticeSourceKind,
} from '../composerNoticeTypes';
import type { ChatComposerProps } from '../composerTypes';

vi.mock('../../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    session: {
      getActiveSessionId: () => null,
      getState: () => ({
        activeSessionId: null,
        setComposerDraft: () => undefined,
      }),
    },
  }),
}));

vi.mock('../../../api/storeAccess', () => ({
  openSettings: vi.fn(),
}));

const COMPOSER_DIR = path.resolve(__dirname, '..');

function readComposerFile(fileName: string): string {
  return fs.readFileSync(path.join(COMPOSER_DIR, fileName), 'utf8');
}

function makeBaseProps(
  overrides: Partial<ChatComposerProps> = {}
): ChatComposerProps {
  return {
    chatInput: '',
    setChatInput: vi.fn(),
    isComposing: false,
    setIsComposing: vi.fn(),
    filteredCommands: [],
    loadSkillSlash: vi.fn().mockResolvedValue(undefined),
    onPasteImage: vi.fn(),
    onSend: vi.fn(),
    canSend: false,
    attachments: [],
    setAttachments: vi.fn(),
    onFilesSelected: vi.fn(),
    permissionMode: 'ask',
    onPermissionChange: vi.fn(),
    showPlusMenu: false,
    setShowPlusMenu: vi.fn(),
    ...overrides,
  };
}

describe('P6 输入坞一体化契约 (composerNotice.contract)', () => {
  afterEach(() => {
    cleanup();
  });

  it('T6-2: 7 类通知源 100% 归属内嵌顶槽且 severity/type 双向映射对称', () => {
    const allSources: ComposerNoticeSourceKind[] = [
      'upload-warn',
      'provider-error',
      'stream-error',
      'rate-limit',
      'budget-exhausted',
      'context-limit',
      'permission-denied',
    ];
    expect(Object.keys(COMPOSER_NOTICE_SOURCE_MATRIX).sort()).toEqual(
      [...allSources].sort()
    );

    for (const source of allSources) {
      expect(shouldRenderInEmbeddedTopSlot(source)).toBe(true);
      expect(resolveComposerNoticePlacement(source)).toBe('embedded-top-slot');
      const spec = COMPOSER_NOTICE_SOURCE_MATRIX[source];
      expect(spec.placement).toBe('embedded-top-slot');
      expect(
        resolveNoticeSeverity({
          text: 'test',
          source,
        })
      ).toBe(spec.defaultSeverity);
    }

    expect(resolveLegacyNoticeType('error')).toBe('error');
    expect(resolveLegacyNoticeType('warning')).toBe('warn');
    expect(resolveLegacyNoticeType('rate-limit')).toBe('warn');
    expect(resolveLegacyNoticeType('info')).toBe('info');
  });

  it('T6-2: 通知顶槽内嵌于 [data-composer-card] 内部，零外部脱节容器与零 360px 限宽', () => {
    const { container } = render(
      React.createElement(
        ChatComposer,
        makeBaseProps({
          notice: {
            text: '模型请求触发速率限制，将在 5 秒后重试',
            severity: 'rate-limit',
            source: 'rate-limit',
          },
        })
      )
    );

    const card = container.querySelector('[data-composer-card]');
    expect(card).toBeTruthy();

    const embeddedSlot = card?.querySelector('[data-embedded-top-slot]');
    expect(embeddedSlot).toBeTruthy();
    expect(embeddedSlot?.getAttribute('data-notice-severity')).toBe(
      'rate-limit'
    );
    expect(embeddedSlot?.getAttribute('data-notice-type')).toBe('warn');

    // 严禁在 .composerCard 外部遗留旧版浮动区或独立通知胶囊区
    expect(container.querySelector('[data-composer-notice-zone]')).toBeNull();
    expect(container.querySelector('[data-composer-float-zone]')).toBeNull();

    // CSS 契约：内嵌通知无 360px 限宽、无独立四周实线框（border: none + border-bottom: 1px solid）
    const embeddedCss = readComposerFile('ComposerEmbeddedNotice.module.css');
    expect(embeddedCss).not.toMatch(/360px/);
    expect(embeddedCss).toMatch(/border:\s*none/);
    expect(embeddedCss).toMatch(/border-bottom:\s*1px\s+solid/);
  });

  it('T6-4: 28x28 正圆发送钮全场景常驻（空输入 disabled 态不坍缩为 width: 0）', () => {
    const { container, rerender } = render(
      React.createElement(
        ChatComposer,
        makeBaseProps({ chatInput: '', canSend: false })
      )
    );

    const sendBtn = container.querySelector(
      '[data-composer-send="circle"] button'
    ) as HTMLButtonElement | null;
    expect(sendBtn).toBeTruthy();
    expect(sendBtn?.disabled).toBe(true);
    expect(sendBtn?.getAttribute('data-send-active')).toBe('0');

    rerender(
      React.createElement(
        ChatComposer,
        makeBaseProps({ chatInput: 'Hello', canSend: true })
      )
    );
    expect(sendBtn?.disabled).toBe(false);
    expect(sendBtn?.getAttribute('data-send-active')).toBe('1');

    const sendCss = readComposerFile('ComposerSendControls.module.css');
    expect(sendCss).not.toMatch(/width:\s*0\s*;/);
    expect(sendCss).not.toMatch(/opacity:\s*0\s*;/);
    expect(sendCss).toMatch(/width:\s*28px/);
    expect(sendCss).toMatch(/height:\s*28px/);
    expect(sendCss).toMatch(/opacity:\s*0\.38/);
  });

  it('T6-6: PermissionModeMenu 在单行与多行模式下恒定驻留左槽（[data-composer-grid="left"]）且稳态去橙色', () => {
    const { container, rerender } = render(
      React.createElement(
        ChatComposer,
        makeBaseProps({
          layoutVariant: 'single',
          chatInput: '单行输入',
        })
      )
    );

    const leftSlotSingle = container.querySelector(
      '[data-composer-grid="left"]'
    );
    const rightSlotSingle = container.querySelector(
      '[data-composer-grid="right"]'
    );
    expect(
      leftSlotSingle?.querySelector('button[aria-label*="当前权限模式"]')
    ).toBeTruthy();
    expect(
      rightSlotSingle?.querySelector('button[aria-label*="当前权限模式"]')
    ).toBeNull();
    expect(container.querySelector('[data-composer-grid="perm"]')).toBeNull();

    rerender(
      React.createElement(
        ChatComposer,
        makeBaseProps({
          layoutVariant: 'multiline',
          chatInput: '第一行\n第二行',
        })
      )
    );

    const leftSlotMulti = container.querySelector(
      '[data-composer-grid="left"]'
    );
    const rightSlotMulti = container.querySelector(
      '[data-composer-grid="right"]'
    );
    expect(
      leftSlotMulti?.querySelector('button[aria-label*="当前权限模式"]')
    ).toBeTruthy();
    expect(
      rightSlotMulti?.querySelector('button[aria-label*="当前权限模式"]')
    ).toBeNull();
    expect(container.querySelector('[data-composer-grid="perm"]')).toBeNull();

    const permCss = readComposerFile('PermissionModeMenu.module.css');
    expect(permCss).not.toMatch(/--accent-orange|--color-warning/);
    expect(permCss).toMatch(/color:\s*var\(--text-secondary\)/);
  });

  it('T6-1 & T6-7: 柔焦护栏符合 AGENTS.md §13（常规 6%，空态 3% ≤ 5%）且 20 个死类彻底清零', () => {
    const mainCss = readComposerFile('ChatComposer.module.css');

    // 常规焦点混入 6%（≤ 10%），session-empty 混入 3%（≤ 5%）
    expect(mainCss).toMatch(
      /--edge-focus,\s*color-mix\(in srgb,\s*var\(--border-color\)\s*94%,\s*var\(--text-primary\)\s*6%\)/
    );
    expect(mainCss).toMatch(
      /--edge-focus-empty,\s*color-mix\(in srgb,\s*var\(--border-color\)\s*97%,\s*var\(--text-primary\)\s*3%\)/
    );

    // 20 个死类在所有 CSS 模块中 0 残留
    const deadClasses = [
      'flowPermissionHost',
      'flowPermissionBarSummary',
      'planStepCounter',
      'annotationTag',
      'attachChipImage',
      'attachProgressBadge',
      'attachProgressBadgeImage',
      'attachProgressBorder',
      'attachThumb',
      'attachWarnBadge',
      'fileCardHorizontal',
      'fileIconBox',
      'fileInfo',
      'fileInfoCol',
      'fileMeta',
      'fileThumbnail',
      'dotSep',
      'annSectionBlock',
      'annSectionLabel',
      'containerDense',
    ];

    const cssFiles = fs
      .readdirSync(COMPOSER_DIR)
      .filter((f) => f.endsWith('.module.css'));
    expect(cssFiles.length).toBeGreaterThanOrEqual(6);

    for (const file of cssFiles) {
      const content = readComposerFile(file);
      for (const dead of deadClasses) {
        expect(content).not.toMatch(new RegExp(`\\.${dead}\\b`));
      }
    }

    expect(screen).toBeTruthy();
  });
});
