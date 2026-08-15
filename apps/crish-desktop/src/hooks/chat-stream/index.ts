import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useLayoutStore } from '../../store/layoutStore';
import { useTerminalStore } from '../../store/terminalStore';
import { getTransport } from '../../api/transport';
import type {
  UseChatStreamOptions,
  UseChatStreamResult,
  RunNotice,
} from './types';
import { useStreamBatchers } from './useStreamBatchers';
import { useStreamCallbacks } from './useStreamCallbacks';
import { useSlashSend } from './useSlashSend';

/**
 * 横幅同文案去重窗口（对齐 toast dedupe 语义，useToastQueue）。
 * 窗口内同文案重复 push → 可见时仅刷新 TTL、已消失则抑制，不叠层不重显。
 */
export const RUN_NOTICE_DEDUPE_WINDOW_MS = 30_000;

/** 横幅文案归一键：trim（对齐 normalizeToastMessage）。 */
export function normalizeRunNoticeKey(text: string): string {
  return String(text ?? '').trim();
}

/** 是否命中同文案去重窗口（prev 为上次 push 记录，now 为当前时刻）。 */
export function isRunNoticeWindowHit(
  prev: { key: string; at: number } | null | undefined,
  key: string,
  now: number,
  windowMs: number = RUN_NOTICE_DEDUPE_WINDOW_MS
): boolean {
  if (!prev || !key) return false;
  return prev.key === key && now - prev.at < windowMs;
}

export type RunNoticeController = {
  push: (notice: RunNotice, ttlMs?: number) => void;
  /** 全清（手动 ×、引擎恢复驱动）；持久条与非持久条一并清除 */
  dismiss: () => void;
  /** 仅清 TTL 横幅（发送 / onChunk / onComplete 路径），持久条保持显示 */
  dismissTransient: () => void;
  /** 卸载清理：清 TTL timer */
  dispose: () => void;
};

/**
 * 横幅单槽状态机（纯 TS，可单测，不依赖 React）：
 * - 同文案去重窗口：命中 → 可见刷新 TTL / 已消失抑制；
 * - persistent 变体：无 TTL 计时，重复同文案 push 幂等保持；
 * - dismissTransient 只清 TTL 横幅，持久条由 dismiss（手动/恢复驱动）清除。
 */
export function createRunNoticeController(
  setRunNotice: (notice: RunNotice | null) => void,
  nowFn: () => number = Date.now
): RunNoticeController {
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  let lastNotice: { key: string; at: number } | null = null;
  let persistentNotice: RunNotice | null = null;
  let visibleNotice: RunNotice | null = null;

  const clearTimer = () => {
    if (ttlTimer != null) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
  };

  const scheduleTtl = (ttlMs: number) => {
    const delay = Math.floor(Number(ttlMs));
    if (!Number.isFinite(delay) || delay <= 0) return;
    ttlTimer = setTimeout(() => {
      ttlTimer = null;
      visibleNotice = null;
      setRunNotice(null);
    }, delay);
  };

  const push = (notice: RunNotice, ttlMs = 8000) => {
    const key = normalizeRunNoticeKey(notice.text);
    if (!key) return;
    const now = nowFn();

    if (notice.persistent) {
      // 持久条：同文案已显示 → 幂等保持（防 R1 双事件重复 setState）；否则显示（无 TTL）
      if (
        persistentNotice &&
        normalizeRunNoticeKey(persistentNotice.text) === key
      ) {
        return;
      }
      clearTimer();
      persistentNotice = notice;
      lastNotice = { key, at: now };
      visibleNotice = notice;
      setRunNotice(notice);
      return;
    }

    if (isRunNoticeWindowHit(lastNotice, key, now)) {
      // 同文案 30s 窗口内：可见同文案 → 仅刷新 TTL 不叠层；已消失 → 抑制不重显
      if (visibleNotice && normalizeRunNoticeKey(visibleNotice.text) === key) {
        clearTimer();
        scheduleTtl(ttlMs);
      }
      return;
    }

    lastNotice = { key, at: now };
    clearTimer();
    persistentNotice = null; // 新错误覆盖旧持久条
    visibleNotice = notice;
    setRunNotice(notice);
    scheduleTtl(ttlMs);
  };

  const dismiss = () => {
    clearTimer();
    lastNotice = null; // 手动关闭后重置窗口，同文案可重新提示
    persistentNotice = null;
    visibleNotice = null;
    setRunNotice(null);
  };

  const dismissTransient = () => {
    clearTimer();
    visibleNotice = persistentNotice; // 持久条保持显示
    setRunNotice(persistentNotice);
  };

  const dispose = () => {
    clearTimer();
  };

  return { push, dismiss, dismissTransient, dispose };
}

export function useChatStream(
  options: UseChatStreamOptions
): UseChatStreamResult {
  const refs = useStreamBatchers();
  const { renderBufferRef } = refs;

  const wsId = options.wsId;
  const setActiveDiffSource = useTerminalStore((s) => s.setActiveDiffSource);
  const upsertSessionAgent = useLayoutStore((s) => s.upsertSessionAgent);

  const [runNotice, setRunNotice] = useState<RunNotice | null>(null);
  const runNoticeControllerRef = useRef<RunNoticeController | null>(null);
  if (runNoticeControllerRef.current == null) {
    runNoticeControllerRef.current = createRunNoticeController(setRunNotice);
  }

  const pushRunNotice = useCallback((notice: RunNotice, ttlMs?: number) => {
    runNoticeControllerRef.current?.push(notice, ttlMs);
  }, []);

  const dismissRunNotice = useCallback(() => {
    runNoticeControllerRef.current?.dismiss();
  }, []);

  const dismissTransientRunNotice = useCallback(() => {
    runNoticeControllerRef.current?.dismissTransient();
  }, []);

  // 持久条「恢复即消失」：transport 状态 failed/connecting → connected 切换点，
  // 引擎恢复时清掉 network/恢复类持久条（含残留 TTL 横幅）。
  useEffect(() => {
    const transport = getTransport();
    const unsub = transport.onStatus((s) => {
      if (s === 'connected') {
        runNoticeControllerRef.current?.dismiss();
      }
    });
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    const renderBuffer = renderBufferRef.current;
    return () => {
      runNoticeControllerRef.current?.dispose();
      renderBuffer?.stop();
    };
  }, [renderBufferRef]);

  const {
    runStreamingAssistant,
    handleStopGeneration,
    handleForceCancelGeneration,
  } = useStreamCallbacks(
    options,
    refs,
    { pushRunNotice, dismissRunNotice, dismissTransientRunNotice },
    { wsId, setActiveDiffSource, upsertSessionAgent }
  );

  const { handleSendChat } = useSlashSend(options, refs, runStreamingAssistant);

  const setRunNoticePublic: Dispatch<SetStateAction<RunNotice | null>> =
    useCallback((action) => {
      setRunNotice((prev) => {
        const next = typeof action === 'function' ? action(prev) : action;
        if (next == null) {
          // 外部置空视同 dismiss：同步清 controller 内部状态（timer / 持久条）
          runNoticeControllerRef.current?.dismiss();
        }
        return next;
      });
    }, []);

  return {
    runNotice,
    setRunNotice: setRunNoticePublic,
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
    handleForceCancelGeneration,
  };
}

export { useSlashSend } from './useSlashSend';
export * from './slashSendDraftManager';
export * from './slashSendQueueHelper';
export * from './slashSendPreflight';
