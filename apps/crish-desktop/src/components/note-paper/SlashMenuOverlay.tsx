/**
 * SlashMenuOverlay — 真 React slash 浮层装配壳（SD-13）
 *
 * ## 角色
 * - 呈现 `SlashMenuModel` 过滤后的 catalog（heading / list / code / paragraph 等）
 * - 皮：直接吃 `.bp-slash-host` / `.bp-slash-item` 族（`@crish/block-paper/chrome.css`）
 * - 可点：选项 → `selectItem` → `slash_insert` → `submitIntent` / sink
 *
 * ## 分模（体积 / 职责）
 * - `SlashMenuOverlay.types` — Props / WriteMode
 * - `slashMenuOverlayWriteMode` — CONN-B 写模式解析
 * - `useSlashMenuModelSync` — model → React 指纹
 * - `useSlashMenuSelect` — 选中 / submit
 * - `useSlashMenuKeymap` — ↑↓ Enter Escape
 * - `SlashMenuOverlayCatalog` — banner / empty / items
 *
 * ## 轨
 * - 呈现方向（W3-F 桌面 React）；**≠ EL-01**；**≠ A-BLK-02 产品 e2e 满关**
 * - 写路径不回退 collab Strict：可注入 `createCollabApplySink`；测可用 mock
 * - DomHost catalog 默认关闭（`projectSlashCatalog` 默认 false，SD-03）防双浮层
 * - **CONN-B**：`writeMode="readonly"` 时 catalog **禁提交**（data-slash-write-mode），
 *   禁止产品空态「可点无写」静默
 *
 * ## 诚实边界
 * - 本组件 **不** 宣称 `/` 键触发全路径 / IME WebView e2e 关闭
 * - 默认 L0：`open=false` 时不渲染可见菜单
 * - `writeMode` 未传时：有 sink 走 submit；无 sink 仍可 intent-only（库测兼容）
 * - 目标：装配壳显著 &lt;400（结构债 SD-13 黄边）；切开 ≠ 关 EL
 */

import React, { useMemo, useRef } from 'react';
import {
  BP_SLASH_HOST,
  BP_SLASH_OPEN,
  groupSlashCatalogItems,
} from '@crish/block-paper';
import '@crish/block-paper/chrome.css';

import type { SlashMenuOverlayProps } from './SlashMenuOverlay.types';
import { SlashMenuOverlayCatalog } from './SlashMenuOverlayCatalog';
import {
  isSlashReadOnly,
  resolveSlashWriteMode,
  toSlashDataWriteMode,
} from './slashMenuOverlayWriteMode';
import { useSlashMenuKeymap } from './useSlashMenuKeymap';
import { useSlashMenuModelSync } from './useSlashMenuModelSync';
import { useSlashMenuSelect } from './useSlashMenuSelect';
import { useClosingValue } from '../motion/useExitReveal';
import { DURATION_POPOVER_EXIT_MS } from '../../utils/motionTokens';

// 公共类型再导出：调用方仍从本文件 import（strictSlashBinding / index 等）
export type {
  SlashMenuOverlayProps,
  SlashOverlayWriteMode,
} from './SlashMenuOverlay.types';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * React slash 浮层：catalog 可点 → Intent → sink。
 * 关闭态返回 null（零噪声）。
 * CONN-B：`writeMode=readonly` 时禁提交，不假装已 apply。
 */
export const SlashMenuOverlay: React.FC<SlashMenuOverlayProps> = ({
  menu,
  sink,
  writeMode,
  submitOptions,
  syncToken = 0,
  style,
  className,
  testId = 'note-paper-slash-overlay',
  onSelectIntent,
  onSubmitResult,
  onClose,
  emptyMessage = '无匹配项',
  readOnlyMessage = '只读 catalog（未接 apply；禁止假写）',
}) => {
  const version = useSlashMenuModelSync(menu, syncToken);
  void version;

  const snap = menu.getSnapshot();

  // S4 退场宿主：model 关闭时菜单不立即卸载——宿主保持最后一次打开
  // 的 snap 播 120ms 退场（全局 .crish-exit-popover，design-system.css
  // 内定义即安全）。菜单不走入场通道（无入场动画），entered 取「曾经
  // 打开过」。关闭由 model 驱动，closing 不干扰 finishClose 回调时序；
  // 键盘映射仍取实况 snap.open，退场期不响应 ↑↓/Enter。
  const shownRef = useRef(false);
  if (snap.open) shownRef.current = true;
  const closingSnap = useClosingValue(snap.open ? snap : null, {
    key: 'slash-menu',
    durationMs: DURATION_POPOVER_EXIT_MS,
    entered: shownRef.current,
  });
  const renderSnap = closingSnap.value;

  const resolvedWriteMode = resolveSlashWriteMode(writeMode);
  const isReadOnly = isSlashReadOnly(resolvedWriteMode);
  const dataWriteMode = toSlashDataWriteMode(resolvedWriteMode, sink);

  const { pending, runSelectItem, runSelectActive, finishClose } =
    useSlashMenuSelect({
      menu,
      sink,
      isReadOnly,
      submitOptions,
      onSelectIntent,
      onSubmitResult,
      onClose,
    });

  const segments = useMemo(
    () => groupSlashCatalogItems(renderSnap?.items ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version 指纹驱动
    [version]
  );

  useSlashMenuKeymap({
    open: snap.open,
    menu,
    runSelectActive,
    finishClose,
  });

  if (!renderSnap) {
    return null;
  }

  const rootClass = [
    'bp-slash-host',
    'np-slash-overlay',
    className,
    closingSnap.closing ? 'crish-exit-popover' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const activeOptionId =
    renderSnap.items[renderSnap.activeIndex] != null
      ? `np-slash-opt-${renderSnap.items[renderSnap.activeIndex]!.id}`
      : undefined;

  return (
    <div
      className={rootClass}
      style={style}
      data-testid={testId}
      {...{ [BP_SLASH_HOST]: '1' }}
      {...{ [BP_SLASH_OPEN]: '1' }}
      data-slash-ui="react"
      data-slash-write-mode={dataWriteMode}
      data-block-id={renderSnap.blockId ?? undefined}
      data-slash-query={renderSnap.query}
      data-exiting={closingSnap.closing ? 'true' : undefined}
      aria-hidden={closingSnap.closing ? true : undefined}
      role="listbox"
      aria-label={isReadOnly ? '斜杠命令（只读）' : '斜杠命令'}
      aria-disabled={isReadOnly ? true : undefined}
      aria-activedescendant={activeOptionId}
      aria-busy={pending ? true : undefined}
    >
      <SlashMenuOverlayCatalog
        testId={testId}
        isReadOnly={isReadOnly}
        pending={pending}
        emptyMessage={emptyMessage}
        readOnlyMessage={readOnlyMessage}
        items={renderSnap.items}
        activeIndex={renderSnap.activeIndex}
        segments={segments}
        menu={menu}
        onSelectItem={(id) => {
          void runSelectItem(id);
        }}
      />
    </div>
  );
};

export default SlashMenuOverlay;
