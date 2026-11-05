// 主页 hub 本地数据面（CON-2 立骨架 → CON-4 换多线程数据面 → hub 同列
// 接线批改逐线程形态 → 2026-11-02 状态板批改资格备料）：本地线程在主页
// 会话区的数据面，职责两件——
// (1) 状态板逐线程行输入备料：线程元数据 + 逐线程生成态 + 本进程完成
//     打点（资格选择在 domain/pure/hubRows.selectStatusBoardRows，本 VM
//     只备料）；全部本地线程在抽屉/本地列表页，不在主页全量呈现；
// (2) 主页本地模式 Composer 的事实面：配置态 / 活动模型标签 / 任一线程
//     生成中（忙态）。
// 导航不再经本 VM：逐线程行点按由宿主直达壳内 /thread/<threadId>
// （界面统一 U3）；抽屉无独立本地入口行——本地线程与远端会话同列
// 混排（domain/pure/drawerRows），本 VM 的数据面口径与抽屉 VM 同源。
//
// 分区口径：本地线程是手机自身的分区（行上带「本地」标识），不属于任何
// 远端设备、不受设备切换影响——本 VM 的数据源里没有任何远端设备作用域。
import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { localChatStore } from '@/domain/store/localChatStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { resolveActiveSelection } from '@/domain/pure/localChatProtocol';
import type { HubLocalThreadInput } from '@/domain/pure/hubRows';

export interface LocalHubEntryVm {
  /** hub 逐线程行输入（线程元数据 + 该线程生成态；store 既有 updatedAt 降序） */
  localThreads: HubLocalThreadInput[];
  /** 逐线程行摘要：生成中线程返回 '正在生成…' 标量（避免逐 Token 轰炸主屏）；否则取 meta.preview */
  snippetOf: (threadId: string) => string;
  /** 是否有任一本地线程正在生成（主页本地模式 composer 忙态） */
  streaming: boolean;
  /** 是否已配置且可选定活动模型（false = 未配置态） */
  configured: boolean;
  /** 当前本地供应商 · 模型标签（未配置为 null；主页本地模式模型钮共用） */
  activeLabel: string | null;
}

export function useLocalHubEntryVm(): LocalHubEntryVm {
  const config = useStore(localChatStore, (s) => s.config);
  const threads = useStore(localChatSessionStore, (s) => s.threads);
  const activeThreadId = useStore(
    localChatSessionStore,
    (s) => s.activeThreadId
  );
  const activeStreaming = useStore(localChatSessionStore, (s) => s.streaming);
  const inactive = useStore(localChatSessionStore, (s) => s.inactive);
  const completedAtByThread = useStore(
    localChatSessionStore,
    (s) => s.completedAtByThread
  );

  // 与本地页同款补水合兜底（dbBootstrap 启动期已水合，此处防未及）
  useEffect(() => {
    if (!localChatStore.getState().hydrated) {
      void localChatStore.getState().hydrate();
    }
    if (!localChatSessionStore.getState().hydrated) {
      void localChatSessionStore.getState().hydrate();
    }
  }, []);

  const selection = resolveActiveSelection(config);
  const configured = selection !== null;
  const activeLabel = selection
    ? `${selection.provider.displayName ?? selection.providerId} · ${selection.modelId}`
    : null;

  // 逐线程生成态：活动线程看顶层投影，非活动线程看 inactive 运行时
  // （与旧线程列表 VM 的 streamingIds 同一派生口径）。
  // 备料 memo 化（PERF #3）：localThreads / snippetOf 保持引用稳定——
  // 主页状态板的选择器输入若每次渲染都是新引用，输入框逐键重渲染会
  // 连带整表重算与列表重渲；稳定后键击只动 Composer 本身。
  const localThreads = useMemo<HubLocalThreadInput[]>(
    () =>
      threads.map((meta) => ({
        meta,
        streaming:
          meta.id === activeThreadId
            ? activeStreaming
            : (inactive[meta.id]?.streaming ?? false),
        completedAtMs: completedAtByThread[meta.id] ?? null,
      })),
    [threads, activeThreadId, activeStreaming, inactive, completedAtByThread]
  );
  const streaming = localThreads.some((t) => t.streaming);

  const snippetOf = useCallback(
    (threadId: string): string => {
      const meta = threads.find((t) => t.id === threadId);
      if (!meta) return '';
      const isStreaming =
        threadId === activeThreadId
          ? activeStreaming
          : (inactive[threadId]?.streaming ?? false);
      if (isStreaming) {
        return '正在生成…';
      }
      return meta.preview;
    },
    [threads, activeThreadId, activeStreaming, inactive]
  );

  return {
    localThreads,
    snippetOf,
    streaming,
    configured,
    activeLabel,
  };
}
