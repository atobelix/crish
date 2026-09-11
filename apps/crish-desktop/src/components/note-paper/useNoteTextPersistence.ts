/**
 * useNoteTextPersistence — Strict 面板文本落盘状态机（audit-repair-202609 · T7/T8/T9 / DEF-NOTE-PERSIST-01/02/03/04/05）
 *
 * 职责（自 NotePaperStrictPanel 抽出，面板回归装配壳）：
 * 1. **差量落盘与排队互斥**：以「最后确认落盘文本」为基准，`computeTextEditOp` 产出
 *    最小 text_edit op；`flushBlockText` 具备 `inFlight` 互斥保护与操作排队（Queue），
 *    防止连续击键或回车确认时并发调用导致差量基准错位与文本重复插入。
 * 2. **刚性落盘防饿死**：400ms debounce 合并连续击键，1500ms `maxWait` 刚性落盘机制，
 *    防止高频输入下防抖持续推迟导致饿死；失焦 / 回车立即冲刷。
 * 3. **应急同步刷盘与离开守卫**：挂载 `beforeunload` 同步将未落盘草稿写入 localStorage
 *    应急抢救，并尽力触发冲刷；**打开/挂载文档时对称调用 `loadEmergencyDraftSync` 读回**，
 *    叠到 UI 并可再落盘；切换 / 新建文档前由文档管理器可靠等待冲刷完毕。
 * 4. **空笔记首块**：点击空白 → `newNoteBlockId` 生成合法 UUID → 经既有
 *    结构意图管线 insert paragraph；text_edit 必须等待 insert 完成后才发送
 *    （保证引擎已注册该块）。insert 失败回退空态，杜绝幽灵块 ID。
 * 5. **诚实状态机**：无写锥（无 Tauri 且无注入）＝只读，一律 `unsaved`，
 *    禁止假标 saved。written 事件由 adapt 层 CONN-G2（applied>0）统一广播，
 *    本 hook 不重复派发。
 * 6. **冲刷器注册**：`registerPendingFlush` 把「全部待落盘立即冲刷」交给宿主
 *    （useNoteDocumentManager 切换 / 新建文档前可靠等待冲刷）；
 *    面板卸载（非切文档路径）同样清定时器 + 尽力冲刷。
 *
 * ≠ EL-01；投影 ≠ 权威。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildInsertBlockIntent,
  submitStructureToCollabWire,
  type ApplyOpsAdapter,
} from '@crish/block-paper';
import { resolveProductStrictApplyOps } from '../../api/noteApplyOpsIpc';
import { computeTextEditOp } from './noteTextEditOp';
import { newNoteBlockId } from './noteBlockId';
import type { HydratedBlockProjection } from './hydrateProjection';
import {
  readEmergencyDraft,
  writeEmergencyDraft,
  removeEmergencyDraft,
} from '../../api/cache/runtimeCache';

/** 文本变更落盘 debounce 窗口（连续击键合并；失焦/回车立即冲刷不受此限） */
export const PERSIST_DEBOUNCE_MS = 400;

/** 高频连续输入下的刚性落盘窗口（防止持续击键导致防抖无限推迟饿死） */
export const PERSIST_MAX_WAIT_MS = 1500;

/** 窗口卸载应急同步抢救 localStorage 前缀 */
export const NOTE_EMERGENCY_DRAFT_PREFIX = 'crish_note_emergency_draft_';

export type NoteSaveStatus = 'saved' | 'syncing' | 'unsaved' | 'saving';

export interface UseNoteTextPersistenceOptions {
  docId: string;
  /** 直接注入写锥适配器（测 / 宿主）；省略时按环境解析（无 Tauri → 只读） */
  applyOpsProp?: ApplyOpsAdapter;
  blocks: readonly HydratedBlockProjection[];
  /** 文本块变更回调（宿主联动，如列表触碰置顶） */
  onBlockChangeProp?: (blockId: string, newText: string) => void;
  /** 文本块提交回调（宿主联动） */
  onTextCommitProp?: (blockId: string, newText: string) => void;
  /** 向宿主注册/注销待落盘冲刷器 */
  registerPendingFlush?: (flush: (() => Promise<void>) | null) => void;
  /**
   * hydrate 是否已达终态（ready | empty）。为 false 时不读回应急草稿，
   * 避免 loading 空块误判。省略时视为 true（单测 / 无 hydrate 宿主）。
   */
  hydrateReady?: boolean;
}

export interface UseNoteTextPersistenceResult {
  localSaveStatus: NoteSaveStatus | null;
  setLocalSaveStatus: (status: NoteSaveStatus) => void;
  /** 空笔记初始化首块的真实块 ID（insert 落盘前为 null） */
  initBlockId: string | null;
  handleInitFirstBlock: () => void;
  handleBlockChange: (blockId: string, newText: string) => void;
  handleTextCommit: (blockId: string, newText: string) => Promise<void>;
  /** 全部待落盘文本立即冲刷（切换 / 新建文档前调用） */
  flushPendingDraft: () => Promise<void>;
  /**
   * 挂载读回的应急草稿（blockId → text）。仅用于 UI 叠字，禁止回灌进
   * 传入本 hook 的权威 `blocks`（否则差量基准会把抢救文本当成已落盘）。
   */
  emergencyDrafts: Record<string, string> | null;
}

export function saveEmergencyDraftSync(
  docId: string,
  drafts: Record<string, string>
): void {
  writeEmergencyDraft(docId, drafts);
}

export function loadEmergencyDraftSync(
  docId: string
): Record<string, string> | null {
  return readEmergencyDraft(docId);
}

export function clearEmergencyDraftSync(docId: string): void {
  removeEmergencyDraft(docId);
}

/**
 * 将应急草稿叠到投影块的 text 上（纯函数，供面板展示「写必可读回」）。
 * 不修改入参；无草稿时原样返回（保持引用）。
 */
export function overlayEmergencyDraftTexts<
  T extends { id: string; text?: string },
>(
  blocks: readonly T[],
  drafts: Record<string, string> | null | undefined
): readonly T[] {
  if (!drafts) return blocks;
  const ids = Object.keys(drafts);
  if (ids.length === 0) return blocks;
  return blocks.map((b) =>
    Object.prototype.hasOwnProperty.call(drafts, b.id)
      ? { ...b, text: drafts[b.id] }
      : b
  );
}

export function useNoteTextPersistence({
  docId,
  applyOpsProp,
  blocks,
  onBlockChangeProp,
  onTextCommitProp,
  registerPendingFlush,
  hydrateReady = true,
}: UseNoteTextPersistenceOptions): UseNoteTextPersistenceResult {
  const [localSaveStatus, setLocalSaveStatus] = useState<NoteSaveStatus | null>(
    null
  );

  /** 挂载时 loadEmergencyDraftSync 读回；flush 排空后清除 */
  const [emergencyDrafts, setEmergencyDrafts] = useState<Record<
    string,
    string
  > | null>(null);
  /** 每个 docId 只读回/应用一次，防 blocks 刷新重入 */
  const rescueAppliedDocRef = useRef<string | null>(null);

  const resolvedApplyOps = useMemo(() => {
    if (applyOpsProp) return applyOpsProp;
    return resolveProductStrictApplyOps({ docId }).applyOps;
  }, [applyOpsProp, docId]);

  // ── 写盘基准 refs（卸载冲刷 / 异步回调用，禁止读过期闭包）──────────
  const resolvedApplyOpsRef = useRef(resolvedApplyOps);
  resolvedApplyOpsRef.current = resolvedApplyOps;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  /** 块 ID → 最后一次**确认落盘**的文本（差量 op 的基准） */
  const lastPersistedTextRef = useRef<Map<string, string>>(new Map());

  /** 块 ID → 待落盘文本 + debounce 定时器 + 首次排程时间戳 */
  const pendingFlushRef = useRef<
    Map<
      string,
      {
        text: string;
        timer: ReturnType<typeof setTimeout> | null;
        firstScheduledAt: number;
      }
    >
  >(new Map());

  /** 块 ID → 正在排队的落盘 Promise 链（防并发重入导致差量基准错位） */
  const blockQueueRef = useRef<Map<string, Promise<void>>>(new Map());

  /** 块 ID 集合：当前正在执行 IPC sendApplyOps 的块（inFlight 互斥） */
  const inFlightBlocksRef = useRef<Set<string>>(new Set());

  /** 保存失败的块 ID 集合（用于诚实保存状态机） */
  const failedBlocksRef = useRef<Set<string>>(new Set());

  /** 是否已发生过本地编辑交互（防止初次挂载时将 null 覆盖为 saved） */
  const hasEditedRef = useRef<boolean>(false);

  /** 空笔记初始化首块的真实块 ID（insert 落盘前 Body 不渲染可编辑行） */
  const [initBlockId, setInitBlockId] = useState<string | null>(null);
  const initBlockIdRef = useRef<string | null>(null);

  /** 首块 insert op 的落盘承诺（text_edit 必须等它完成，保证引擎块已注册） */
  const initInsertRef = useRef<Promise<boolean> | null>(null);

  const sendApplyOps = useCallback(
    async (opsJson: string, intentId: string): Promise<boolean> => {
      const adapter = resolvedApplyOpsRef.current;
      if (!adapter) return false;
      try {
        const outcome = await adapter(opsJson, { intentId });
        return Boolean(outcome && outcome.ok);
      } catch {
        return false;
      }
    },
    []
  );

  /**
   * 刷新全局保存状态（DEF-NOTE-PERSIST-05）：
   * 综合所有块的 pending、inFlight 与 failed 状态，禁止局部成功冒充全局已保存。
   */
  const updateSaveStatus = useCallback(() => {
    if (!hasEditedRef.current) return;
    if (!resolvedApplyOpsRef.current) {
      setLocalSaveStatus('unsaved');
      return;
    }
    if (failedBlocksRef.current.size > 0) {
      setLocalSaveStatus('unsaved');
      return;
    }
    if (inFlightBlocksRef.current.size > 0 || blockQueueRef.current.size > 0) {
      setLocalSaveStatus('saving');
      return;
    }
    if (pendingFlushRef.current.size > 0) {
      setLocalSaveStatus('saving');
      return;
    }
    setLocalSaveStatus('saved');
  }, []);

  /**
   * 单次单块实际落盘执行函数（内部持有 inFlight 标记，由队列严格串行调度）
   */
  const executeFlushBlock = useCallback(
    async (blockId: string): Promise<void> => {
      const pending = pendingFlushRef.current.get(blockId);
      if (!pending) return;

      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }

      const target = pending.text;
      const seed = blocksRef.current.find((b) => b.id === blockId)?.text ?? '';
      const oldText = lastPersistedTextRef.current.get(blockId) ?? seed;
      const op = computeTextEditOp(blockId, oldText, target);

      if (!op) {
        const cur = pendingFlushRef.current.get(blockId);
        if (cur && cur.text === target) {
          pendingFlushRef.current.delete(blockId);
        }
        if (pendingFlushRef.current.size === 0) {
          clearEmergencyDraftSync(docId);
          setEmergencyDrafts(null);
        }
        updateSaveStatus();
        return;
      }

      const adapter = resolvedApplyOpsRef.current;
      if (!adapter) {
        setLocalSaveStatus('unsaved');
        return;
      }

      if (blockId === initBlockIdRef.current && initInsertRef.current) {
        const insertOk = await initInsertRef.current;
        if (!insertOk) return;
      }

      inFlightBlocksRef.current.add(blockId);
      updateSaveStatus();

      const intentId = `text-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const ok = await sendApplyOps(JSON.stringify([op]), intentId);
        if (ok) {
          failedBlocksRef.current.delete(blockId);
          lastPersistedTextRef.current.set(blockId, target);
          const cur = pendingFlushRef.current.get(blockId);
          if (cur && cur.text === target) {
            pendingFlushRef.current.delete(blockId);
          }
          if (pendingFlushRef.current.size === 0) {
            clearEmergencyDraftSync(docId);
            setEmergencyDrafts(null);
          }
        } else {
          failedBlocksRef.current.add(blockId);
        }
      } catch {
        failedBlocksRef.current.add(blockId);
      } finally {
        inFlightBlocksRef.current.delete(blockId);
        updateSaveStatus();
      }
    },
    [docId, sendApplyOps, updateSaveStatus]
  );

  /**
   * 冲刷单块待落盘文本：
   * 带 inFlight 互斥保护与操作排队（Queue），同一 blockId 的落盘按序串行执行，
   * 前序完成并更新 lastPersistedText 后，后续才能生成新的差量 op。
   */
  const flushBlockText = useCallback(
    async (blockId: string): Promise<void> => {
      const prevPromise = blockQueueRef.current.get(blockId);

      const run = async () => {
        if (prevPromise) {
          try {
            await prevPromise;
          } catch {
            // 前序即使异常，后序仍排队执行以保护后续草稿落盘
          }
        }
        return executeFlushBlock(blockId);
      };

      const currentPromise = run();
      blockQueueRef.current.set(blockId, currentPromise);

      try {
        await currentPromise;
      } finally {
        if (blockQueueRef.current.get(blockId) === currentPromise) {
          blockQueueRef.current.delete(blockId);
        }
        updateSaveStatus();
      }
    },
    [executeFlushBlock, updateSaveStatus]
  );

  const flushBlockTextRef = useRef(flushBlockText);
  flushBlockTextRef.current = flushBlockText;

  /**
   * 文本变更排程：
   * 400ms debounce 合并连续击键，叠加 1500ms maxWait 刚性落盘防饿死。
   */
  const scheduleBlockText = useCallback(
    (blockId: string, newText: string) => {
      hasEditedRef.current = true;
      const prev = pendingFlushRef.current.get(blockId);
      if (prev?.timer) {
        clearTimeout(prev.timer);
      }

      const now = Date.now();
      const firstScheduledAt = prev?.firstScheduledAt ?? now;
      const elapsed = now - firstScheduledAt;
      const remainingMaxWait = Math.max(0, PERSIST_MAX_WAIT_MS - elapsed);
      const delay = Math.min(PERSIST_DEBOUNCE_MS, remainingMaxWait);

      if (delay <= 0) {
        pendingFlushRef.current.set(blockId, {
          text: newText,
          timer: null,
          firstScheduledAt: now,
        });
        void flushBlockTextRef.current(blockId);
      } else {
        const timer = setTimeout(() => {
          void flushBlockTextRef.current(blockId);
        }, delay);
        pendingFlushRef.current.set(blockId, {
          text: newText,
          timer,
          firstScheduledAt,
        });
      }
      updateSaveStatus();
    },
    [updateSaveStatus]
  );

  /**
   * 全部待落盘文本立即冲刷（切换 / 新建文档前由文档管理器调用）。
   * 排空语义（§6）：循环至 pending/queue/inFlight 皆空，或停滞/触顶时显式抛错；
   * 禁止固定两轮 pass 的伪排空。
   */
  const flushPendingDraft = useCallback(async (): Promise<void> => {
    /** 安全上界：防死循环；触顶视为显式失败，禁止静默截断 */
    const MAX_DRAIN_ROUNDS = 64;
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
      const candidateIds = new Set([
        ...pendingFlushRef.current.keys(),
        ...blockQueueRef.current.keys(),
        ...inFlightBlocksRef.current,
      ]);
      if (candidateIds.size === 0) return;

      const pendingSizeBefore = pendingFlushRef.current.size;
      await Promise.all(
        [...candidateIds].map((id) => flushBlockTextRef.current(id))
      );

      const remaining = new Set([
        ...pendingFlushRef.current.keys(),
        ...blockQueueRef.current.keys(),
        ...inFlightBlocksRef.current,
      ]);
      if (remaining.size === 0) return;

      // 队列或飞行仍在推进 → 继续下一轮
      if (blockQueueRef.current.size > 0 || inFlightBlocksRef.current.size > 0) {
        continue;
      }

      const pendingSizeAfter = pendingFlushRef.current.size;
      // pending 规模下降说明有进展（可能仍有残留/重入），继续排空
      if (pendingSizeAfter < pendingSizeBefore) {
        continue;
      }

      // 无进展且无飞行/排队 → 失败可见（含 apply 失败 / 无适配器早退）
      setLocalSaveStatus('unsaved');
      const pending = [...pendingFlushRef.current.keys()];
      const failed = pending.filter((id) => failedBlocksRef.current.has(id));
      throw new Error(
        `[flushPendingDraft] drain stalled (round ${round + 1}); pending=[${pending.join(',')}]` +
          (failed.length ? `; failed=[${failed.join(',')}]` : '')
      );
    }
    setLocalSaveStatus('unsaved');
    throw new Error(
      `[flushPendingDraft] exceeded ${MAX_DRAIN_ROUNDS} drain rounds with work remaining`
    );
  }, []);

  const flushPendingDraftRef = useRef(flushPendingDraft);
  flushPendingDraftRef.current = flushPendingDraft;

  /** 向宿主注册冲刷器（useNoteDocumentManager 切换/新建文档前调用） */
  useEffect(() => {
    if (!registerPendingFlush) return;
    registerPendingFlush(flushPendingDraft);
    return () => {
      registerPendingFlush(null);
    };
  }, [registerPendingFlush, flushPendingDraft]);

  // ── doc 切换：清空读回态，允许新文档再跑一次 loadEmergencyDraftSync ─────
  useEffect(() => {
    rescueAppliedDocRef.current = null;
    setEmergencyDrafts(null);
  }, [docId]);

  /**
   * 生产挂载/打开文档读回（与 beforeunload → saveEmergencyDraftSync 对称）。
   * hydrateReady 后才应用，避免 loading 空投影误判「已落盘」。
   * 每个 docId 只应用一次；差异写入 pending 并排程落盘，UI 经 emergencyDrafts 叠字。
   */
  useEffect(() => {
    if (!hydrateReady) return;
    if (rescueAppliedDocRef.current === docId) return;
    rescueAppliedDocRef.current = docId;

    const drafts = loadEmergencyDraftSync(docId);
    if (!drafts || Object.keys(drafts).length === 0) {
      setEmergencyDrafts(null);
      return;
    }

    const pending: Record<string, string> = {};
    for (const [blockId, text] of Object.entries(drafts)) {
      const block = blocks.find((b) => b.id === blockId);
      // 无对应块：仍保留可读回（空笔记崩溃等边缘）；有块且已一致则跳过
      if (block && (block.text ?? '') === text) {
        continue;
      }
      pending[blockId] = text;
    }

    if (Object.keys(pending).length === 0) {
      // 异步冲刷已在 beforeunload 后完成：清掉陈旧抢救快照
      clearEmergencyDraftSync(docId);
      setEmergencyDrafts(null);
      return;
    }

    setEmergencyDrafts(pending);
    for (const [blockId, text] of Object.entries(pending)) {
      // 权威 blocks 仍为落盘态；差量基准正确。叠字只走 emergencyDrafts。
      scheduleBlockText(blockId, text);
    }
  }, [docId, hydrateReady, blocks, scheduleBlockText]);

  // ── 窗口关闭 / 刷新应急同步刷盘守卫（DEF-NOTE-PERSIST-04）───────────────
  useEffect(() => {
    const handleBeforeUnload = () => {
      const pendingMap = pendingFlushRef.current;
      if (pendingMap.size > 0) {
        // 1. 同步抢救：将所有尚未落盘的草稿快照写入 localStorage，防止进程瞬间退出数据毁灭
        const emergencyDrafts: Record<string, string> = {};
        for (const [id, entry] of pendingMap.entries()) {
          emergencyDrafts[id] = entry.text;
          if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
        }
        saveEmergencyDraftSync(docId, emergencyDrafts);
      }
      // 2. 尽力触发异步 IPC 冲刷
      void flushPendingDraftRef.current();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [docId]);

  // 组件卸载（非切文档路径，如关闭侧栏/面板）：清定时器 + 尽力冲刷
  useEffect(() => {
    const pendingMap = pendingFlushRef.current;
    return () => {
      const ids = [...pendingMap.keys()];
      for (const p of pendingMap.values()) {
        if (p.timer) clearTimeout(p.timer);
      }
      for (const id of ids) {
        void flushBlockTextRef.current(id);
      }
    };
  }, []);

  // 投影权威刷新覆盖落盘基准（turn_into / 远端写入后重新对齐），防差量基准漂移
  useEffect(() => {
    for (const b of blocks) {
      const recorded = lastPersistedTextRef.current.get(b.id);
      if (
        recorded !== undefined &&
        !pendingFlushRef.current.has(b.id) &&
        recorded !== (b.text ?? '')
      ) {
        lastPersistedTextRef.current.set(b.id, b.text ?? '');
      }
    }
  }, [blocks]);

  const handleBlockChange = useCallback(
    (blockId: string, newText: string) => {
      onBlockChangeProp?.(blockId, newText);
      scheduleBlockText(blockId, newText);
    },
    [onBlockChangeProp, scheduleBlockText]
  );

  const handleTextCommit = useCallback(
    async (blockId: string, newText: string): Promise<void> => {
      hasEditedRef.current = true;
      onTextCommitProp?.(blockId, newText);
      const prev = pendingFlushRef.current.get(blockId);
      if (prev?.timer) clearTimeout(prev.timer);
      pendingFlushRef.current.set(blockId, {
        text: newText,
        timer: null,
        firstScheduledAt: prev ? prev.firstScheduledAt : Date.now(),
      });
      return flushBlockText(blockId);
    },
    [onTextCommitProp, flushBlockText]
  );

  /**
   * 空笔记初始化：点击空白 → 生成**合法 UUID** 块 ID → 经既有结构意图
   * 管线 insert paragraph（无写锥时诚实置 unsaved，禁止幽灵 ID）。幂等。
   */
  const handleInitFirstBlock = useCallback(() => {
    if (initBlockIdRef.current) return;
    hasEditedRef.current = true;
    if (!resolvedApplyOpsRef.current) {
      setLocalSaveStatus('unsaved');
      return;
    }
    const id = newNoteBlockId();
    const intent = buildInsertBlockIntent({
      parentId: null,
      flavour: 'paragraph',
      blockIds: [id],
    });
    const wire = submitStructureToCollabWire(intent);
    initBlockIdRef.current = id;
    setInitBlockId(id);
    lastPersistedTextRef.current.set(id, '');
    setLocalSaveStatus('saving');
    const insertPromise = (async (): Promise<boolean> => {
      const ok = await sendApplyOps(wire.json, wire.intentId);
      if (!ok) {
        // insert 失败：回退空态占位，杜绝把行绑定到不存在的块上
        if (initBlockIdRef.current === id) {
          initBlockIdRef.current = null;
          setInitBlockId(null);
        }
        setLocalSaveStatus('unsaved');
        return false;
      }
      setLocalSaveStatus('saved');
      return true;
    })();
    initInsertRef.current = insertPromise;
  }, [sendApplyOps]);

  return {
    localSaveStatus,
    setLocalSaveStatus,
    initBlockId,
    handleInitFirstBlock,
    handleBlockChange,
    handleTextCommit,
    flushPendingDraft,
    emergencyDrafts,
  };
}
