/**
 * useNotePaperStrictShell — Strict 装配壳交互 / 模型钩子（SD-15）
 *
 * 从 `NotePaperStrictPanel` 外置：
 * - chrome / blockSelection / slashMenu 默认实例
 * - slash · mdPrefix 写锥绑定
 * - hydrate 块序 → selection
 * - hover/focus · openSlash · 面板内 `/` 键
 *
 * hydrate 通路仍走 `useNoteHydrate`；**≠ EL-01**；不改 presentation 默认互斥。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import {
  BlockChromeModel,
  SlashMenuModel,
  type SlashOpenResult,
} from '@crish/block-paper';
import { createProductBlockSelection } from './blockSelectionProduct';
import type { HydratedBlockProjection } from './hydrateProjection';
import { resolveStrictMdPrefixBinding } from './noteMdPrefixBridge';
import type { NotePaperStrictPanelProps } from './notePaperStrictProps';
import {
  openProductSlash,
  resolveProductSlashAnchor,
  tryOpenProductSlashFromKey,
} from './productSlashOpen';
import { resolveStrictSlashBinding } from './strictSlashBinding';

export type UseNotePaperStrictShellOptions = Pick<
  NotePaperStrictPanelProps,
  | 'chrome'
  | 'blockSelection'
  | 'slashMenu'
  | 'slashIntentSink'
  | 'slashWriteMode'
  | 'slashSinkSource'
  | 'turnIntoSink'
  | 'mdPrefixWriteMode'
  | 'mdPrefixSinkSource'
  | 'mdPrefixBinding'
  | 'onSlashOpenResult'
> & {
  docId: string;
  blocks: readonly HydratedBlockProjection[];
};

/**
 * Strict 面板模型 + 交互（不含 JSX / 不含 presentation 解析）。
 */
export function useNotePaperStrictShell(
  options: UseNotePaperStrictShellOptions
) {
  const {
    docId,
    blocks,
    chrome: chromeProp,
    blockSelection: blockSelectionProp,
    slashMenu: slashMenuProp,
    slashIntentSink,
    slashWriteMode: slashWriteModeProp,
    slashSinkSource: slashSinkSourceProp,
    turnIntoSink,
    mdPrefixWriteMode: mdPrefixWriteModeProp,
    mdPrefixSinkSource: mdPrefixSinkSourceProp,
    mdPrefixBinding,
    onSlashOpenResult,
  } = options;

  const chrome = useMemo(
    () => chromeProp ?? new BlockChromeModel(),
    [chromeProp]
  );
  /**
   * W3-E-desk：默认 / 注入 BlockSelectionBridge（统一 multi + focus 写入口）。
   * focus 经 bridge → chrome.focusedBlockId，CONN-C pin 不回退。
   */
  const blockSelection = useMemo(
    () => blockSelectionProp ?? createProductBlockSelection(chrome),
    [blockSelectionProp, chrome]
  );
  const slashMenu = useMemo(
    () => slashMenuProp ?? new SlashMenuModel(),
    [slashMenuProp]
  );

  /** CONN-B：无 sink 默认只读；有 sink 默认可写 */
  const { writeMode: slashWriteMode, sinkSource: slashSinkSource } =
    resolveStrictSlashBinding({
      slashIntentSink,
      slashWriteMode: slashWriteModeProp,
      slashSinkSource: slashSinkSourceProp,
    });
  /** CONN-D2/D3：无 turnIntoSink/binding 默认 disabled；有则 writable */
  const effectiveTurnIntoSink = mdPrefixBinding?.sink ?? turnIntoSink;
  const { writeMode: mdPrefixWriteMode, sinkSource: mdPrefixSinkSource } =
    resolveStrictMdPrefixBinding({
      turnIntoSink: effectiveTurnIntoSink,
      mdPrefixWriteMode: mdPrefixWriteModeProp ?? mdPrefixBinding?.mode,
      mdPrefixSinkSource: mdPrefixSinkSourceProp ?? mdPrefixBinding?.source,
    });

  const slashOpen = useSyncExternalStore(
    (onStoreChange) => slashMenu.subscribe(onStoreChange),
    () => (slashMenu.isOpen() ? '1' : '0'),
    () => '0'
  );

  const snapshot = chrome.getSnapshot();
  const selSnapshot = blockSelection.getSnapshot();

  // hydrate 块序 → bridge range 展开
  useEffect(() => {
    blockSelection.setBlockOrder(blocks.map((b) => b.id));
  }, [blockSelection, blocks]);

  const handleHover = useCallback(
    (blockId: string | null) => {
      chrome.setHovered(blockId);
    },
    [chrome]
  );
  /** 焦点经 bridge：multi 外默认清 multi；仍投影 chrome.focusedBlockId（CONN-C） */
  const handleFocus = useCallback(
    (blockId: string | null) => {
      blockSelection.setFocused(blockId);
    },
    [blockSelection]
  );

  const panelRef = useRef<HTMLElement | null>(null);

  /** CONN-B2：产品 openSlash；composing 拒开；≠ EL-01 */
  const openSlash = useCallback(
    (blockId?: string, offset = 0): SlashOpenResult => {
      const anchorId =
        blockId ??
        resolveProductSlashAnchor({
          focusedBlockId: chrome.getSnapshot().focusedBlockId,
          blocks,
          docId,
        });
      const opened = openProductSlash({
        menu: slashMenu,
        blockId: anchorId,
        offset,
      });
      onSlashOpenResult?.(opened);
      return opened;
    },
    [blocks, docId, slashMenu, chrome, onSlashOpenResult]
  );

  const openSlashMenu = useCallback(() => {
    void openSlash();
  }, [openSlash]);

  /** CONN-B2：面板内裸 `/` → 同 open 路径 */
  useEffect(() => {
    const root = panelRef.current;
    if (!root) return;

    const onKeyDown = (ev: KeyboardEvent) => {
      const r = tryOpenProductSlashFromKey(ev, {
        menu: slashMenu,
        anchor: {
          focusedBlockId: chrome.getSnapshot().focusedBlockId,
          blocks,
          docId,
        },
        surfaceRoot: root,
      });
      if (r.ok) {
        onSlashOpenResult?.(r);
      } else if (r.code === 'composing') {
        onSlashOpenResult?.(r);
      }
    };

    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [slashMenu, chrome, blocks, docId, onSlashOpenResult]);

  return {
    chrome,
    blockSelection,
    slashMenu,
    slashWriteMode,
    slashSinkSource,
    effectiveTurnIntoSink,
    mdPrefixWriteMode,
    mdPrefixSinkSource,
    slashOpen,
    chromeTick: 0,
    snapshot,
    selSnapshot,
    handleHover,
    handleFocus,
    openSlashMenu,
    panelRef,
  };
}
