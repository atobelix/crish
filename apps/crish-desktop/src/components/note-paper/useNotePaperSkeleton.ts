/**
 * useNotePaperSkeleton — W5-B-S Skeleton 壳钩子（SD-25）
 *
 * 默认实例：静默 fixture / BlockChromeModel / SlashMenuModel。
 * 仅当调用方传入 `transport` 时 `queryBlocks`；
 * **未传则静默假数据，不隐式拉真后端 / 不宣称打开完成**。
 *
 * **≠ W5-B Strict**（不走 `useNoteHydrate`）
 * **≠ 任何 EL**；禁止 EditorStore。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  BlockChromeModel,
  SlashMenuModel,
  type SilentFixture,
} from '@crish/block-paper';
import type { NoteTransport } from '../../api/noteApi';
import {
  mapSilentBlocksToDisplay,
  mapTransportHitsToDisplay,
  resolveSkeletonFixture,
  type DisplayBlock,
} from './notePaperSilentFixture';

export type UseNotePaperSkeletonOptions = {
  docId: string;
  blockCount: number;
  fixture?: SilentFixture;
  chrome?: BlockChromeModel;
  slashMenu?: SlashMenuModel;
  /** 省略 → 静默假数据；禁止在 hook 内默认造 Tauri/产品 transport */
  transport?: NoteTransport;
  refreshToken?: number | string;
};

export type UseNotePaperSkeletonResult = {
  fixture: SilentFixture;
  chrome: BlockChromeModel;
  slashMenu: SlashMenuModel;
  slashOpen: string;
  useTransport: boolean;
  displayBlocks: DisplayBlock[];
  transportLoading: boolean;
  transportError: string | null;
  loadFromTransport: () => Promise<void>;
  chromeTick: number;
  snapshot: ReturnType<BlockChromeModel['getSnapshot']>;
  handleHover: (blockId: string | null) => void;
  handleFocus: (blockId: string | null) => void;
  resolvedDocId: string;
  resolvedRev: number;
};

/**
 * Skeleton 模型 + 可选半 transport 只读投影 + 静默 chrome hover/focus。
 */
export function useNotePaperSkeleton(
  options: UseNotePaperSkeletonOptions
): UseNotePaperSkeletonResult {
  const {
    docId,
    blockCount,
    fixture: fixtureProp,
    chrome: chromeProp,
    slashMenu: slashMenuProp,
    transport,
    refreshToken = 0,
  } = options;

  const useTransport = transport !== undefined;

  const fixture = useMemo(
    () => resolveSkeletonFixture(fixtureProp, blockCount, docId),
    [fixtureProp, blockCount, docId]
  );

  const chrome = useMemo(
    () => chromeProp ?? new BlockChromeModel(),
    [chromeProp]
  );

  const slashMenu = useMemo(
    () => slashMenuProp ?? new SlashMenuModel(),
    [slashMenuProp]
  );

  const slashOpen = useSyncExternalStore(
    (onStoreChange) => slashMenu.subscribe(onStoreChange),
    () => (slashMenu.isOpen() ? '1' : '0'),
    () => '0'
  );

  const [transportBlocks, setTransportBlocks] = useState<DisplayBlock[]>([]);
  const [transportLoading, setTransportLoading] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [transportRev, setTransportRev] = useState(0);

  const loadFromTransport = useCallback(async () => {
    if (!transport) return;
    setTransportLoading(true);
    setTransportError(null);
    try {
      const res = await transport.queryBlocks({ docId, limit: 200 });
      if (!res.ok) {
        setTransportBlocks([]);
        setTransportError(res.reason);
        return;
      }
      setTransportBlocks(mapTransportHitsToDisplay(res.blocks));
      setTransportRev((n) => n + 1);
    } finally {
      setTransportLoading(false);
    }
  }, [transport, docId]);

  useEffect(() => {
    if (!useTransport) return;
    void loadFromTransport();
  }, [useTransport, loadFromTransport, refreshToken]);

  const displayBlocks: DisplayBlock[] = useMemo(() => {
    if (useTransport) return transportBlocks;
    return mapSilentBlocksToDisplay(fixture);
  }, [useTransport, transportBlocks, fixture]);

  const [chromeTick, setChromeTick] = useState(0);
  const bump = useCallback(() => setChromeTick((n) => n + 1), []);

  const snapshot = useMemo(() => {
    void chromeTick;
    return chrome.getSnapshot();
  }, [chrome, chromeTick]);

  const handleHover = useCallback(
    (blockId: string | null) => {
      chrome.setHovered(blockId);
      bump();
    },
    [chrome, bump]
  );

  const handleFocus = useCallback(
    (blockId: string | null) => {
      chrome.setFocused(blockId);
      bump();
    },
    [chrome, bump]
  );

  const resolvedDocId = useTransport ? docId : fixture.docId;
  const resolvedRev = useTransport ? transportRev : fixture.rev;

  return {
    fixture,
    chrome,
    slashMenu,
    slashOpen,
    useTransport,
    displayBlocks,
    transportLoading,
    transportError,
    loadFromTransport,
    chromeTick,
    snapshot,
    handleHover,
    handleFocus,
    resolvedDocId,
    resolvedRev,
  };
}
