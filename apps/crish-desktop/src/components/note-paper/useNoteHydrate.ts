/**
 * useNoteHydrate — Strict 轨 hydrate 状态机 hook（SD-04 可验证拆分）
 *
 * 从 `NotePaperStrictPanel` 抽出加载 / 空 / 错误 / 成功三态，
 * 降低面板主文件复杂度；**不**改 transport 契约。
 *
 * ## CONN-G1 / G2 · 写后 Strict 读回
 * 订阅 `bridges/note-doc-written`：同 docId 写成功（applied）后自动 reload。
 * 来源含 `send_to_note`（G1）与 `product_apply`（G2 产品 note_apply_ops）。
 * 与外部 `refreshToken` 并存；**不**依赖 StrictPanel 大改 JSX；不按 source 过滤。
 *
 * ## 诚实边界
 * - 投影 ≠ 文档权威；**禁止** 行级 EditorStore
 * - **≠** 打开完成（G-HYD）；**≠** EL-01 / EL-08
 * - 投影可带 `hydratePath`（`doc-session` | `query-blocks`）；**path ≠ 关 EL / 打开完成**
 * - Skeleton 双轨保留；本 hook 仅 Strict 轨使用
 *
 * 测：StrictPanel hydrate 三态测不回退（`NotePaperStrictPanel.test.tsx`）；
 *     CONN-G1 写后读回见 `conn-g1.send-to-note-strict-refresh.test.tsx`；
 *     CONN-G2 产品 apply 见 `conn-g2.product-apply-note-doc-written.test.ts`
 */

import { useCallback, useEffect, useState } from 'react';
import { subscribeNoteDocWritten } from '../../bridges/note-doc-written';
import type {
  DocHydrateProjection,
  HydratedBlockProjection,
  NoteHydrateTransport,
} from './hydrateProjection';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** hydrate UI 四态（loading / ready / empty / error） */
export type HydrateUiStatus = 'loading' | 'ready' | 'empty' | 'error';

export type UseNoteHydrateOptions = {
  /** 必填：hydrate 通路 */
  hydrateTransport: NoteHydrateTransport;
  /** 文档 id */
  docId: string;
  /**
   * 变更时重新 hydrate（演示写后刷新 / 外部触发）。
   * 默认 0。
   * 与 CONN-G1 自动读回并存：任一侧变更均触发 reload。
   */
  refreshToken?: number | string;
  /**
   * 是否订阅 send_to_note 写后同 doc 读回（CONN-G1）。
   * 默认 true；单测可关以避免跨测总线干扰。
   */
  autoRefreshOnWrite?: boolean;
};

export type UseNoteHydrateResult = {
  status: HydrateUiStatus;
  projection: DocHydrateProjection | null;
  errorReason: string | null;
  errorCode: string | null;
  /** 当前投影块（无投影时 []） */
  blocks: HydratedBlockProjection[];
  resolvedRev: number;
  /** 投影 source；无投影时 `'none'` */
  hydrateSource: string;
  /** 手动触发重新 hydrate */
  reload: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Strict 轨 hydrate：loading → ready | empty | error。
 * transport 契约应返回 ok:false；若仍抛，收成错误态（零半写 UI）。
 */
export function useNoteHydrate(
  options: UseNoteHydrateOptions
): UseNoteHydrateResult {
  const {
    hydrateTransport,
    docId,
    refreshToken = 0,
    autoRefreshOnWrite = true,
  } = options;

  const [status, setStatus] = useState<HydrateUiStatus>('loading');
  const [projection, setProjection] = useState<DocHydrateProjection | null>(
    null
  );
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  /**
   * CONN-G1：写后自动读回代次（内部 refreshToken 语义）。
   * 外部 props.refreshToken 与写事件任一变化都会触发 reload。
   */
  const [writeRefreshSeq, setWriteRefreshSeq] = useState(0);

  const reload = useCallback(async () => {
    setStatus('loading');
    setErrorReason(null);
    setErrorCode(null);
    try {
      const outcome = await hydrateTransport.hydrate(docId);
      if (!outcome.ok) {
        setProjection(null);
        setErrorReason(outcome.reason);
        setErrorCode(outcome.code);
        setStatus('error');
        return;
      }
      setProjection(outcome.projection);
      setStatus(outcome.projection.blocks.length === 0 ? 'empty' : 'ready');
    } catch (e) {
      // transport 契约应返回 ok:false；若仍抛，收成错误态（零半写 UI）
      setProjection(null);
      setErrorReason(e instanceof Error ? e.message : String(e));
      setErrorCode('note.hydrate_throw');
      setStatus('error');
    }
  }, [hydrateTransport, docId]);

  // CONN-G1：同 docId 的 send_to_note applied → 内部 seq++ → reload
  useEffect(() => {
    if (!autoRefreshOnWrite) {
      return undefined;
    }
    return subscribeNoteDocWritten((ev) => {
      if (ev.docId === docId) {
        setWriteRefreshSeq((n) => n + 1);
      }
    });
  }, [docId, autoRefreshOnWrite]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken, writeRefreshSeq]);

  const blocks: HydratedBlockProjection[] = projection?.blocks ?? [];
  const resolvedRev = projection?.rev ?? 0;
  const hydrateSource = projection?.source ?? 'none';

  return {
    status,
    projection,
    errorReason,
    errorCode,
    blocks,
    resolvedRev,
    hydrateSource,
    reload,
  };
}
