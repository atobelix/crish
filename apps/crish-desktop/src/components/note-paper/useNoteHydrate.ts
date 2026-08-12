/**
 * useNoteHydrate — Strict 轨 hydrate 状态机 hook（SD-04 可验证拆分）
 *
 * 从 `NotePaperStrictPanel` 抽出加载 / 空 / 错误 / 成功三态，
 * 降低面板主文件复杂度；**不**改 transport 契约。
 *
 * ## 诚实边界
 * - 投影 ≠ 文档权威；**禁止** 行级 EditorStore
 * - **≠** 打开完成（G-HYD）；**≠** EL-01 / EL-08
 *
 * 测：StrictPanel hydrate 三态测不回退（`NotePaperStrictPanel.test.tsx`）
 */

import { useCallback, useEffect, useState } from 'react';
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
   */
  refreshToken?: number | string;
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
  const { hydrateTransport, docId, refreshToken = 0 } = options;

  const [status, setStatus] = useState<HydrateUiStatus>('loading');
  const [projection, setProjection] = useState<DocHydrateProjection | null>(
    null
  );
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

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

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

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
