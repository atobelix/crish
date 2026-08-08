import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppToast } from '../services/ToastBus';

/** 统一 toast 回调：仅错误，或可撤销操作（第二参 onUndo）。 */
export type ShowToastFn = (message: string, onUndo?: () => void) => void;

/** 策略判定结果（测试 / 调用方可观测；hook 入口静默 drop）。 */
export type ToastPolicyDecision = 'show' | 'drop-success' | 'drop-empty';

/**
 * enqueueToast 纯结果：策略 drop / 去重（可刷新 TTL）/ 入队（可挤掉最旧）。
 * 与 React 无关，便于单测。
 * dedupe 时 refreshTtlMs 供 hook 重置 timer；若 onUndo 更新则带 next。
 */
export type ToastEnqueueResult =
  | { kind: 'drop'; reason: ToastPolicyDecision }
  | {
      kind: 'dedupe';
      existingId: string;
      /** 去重命中后应重置的 auto-dismiss TTL（ms） */
      refreshTtlMs: number;
      /** 仅当 onUndo 回调被替换时给出新队列 */
      next?: AppToast[];
    }
  | {
      kind: 'enqueue';
      item: AppToast;
      next: AppToast[];
      evictedIds: string[];
      /** 新条目应使用的 auto-dismiss TTL（ms） */
      ttlMs: number;
    };

/** 单条 toast 自动消失（TTL / auto-dismiss）。 */
export const TOAST_TTL_MS = 5000;

/** 同时展示上限；超出时挤掉最旧（FIFO）。 */
export const TOAST_MAX_QUEUE = 5;

/**
 * 归一 / 钳制 TTL：缺省、非有限、≤0 → TOAST_TTL_MS。
 * 供 enqueue 结果与 hook scheduleDismiss 共用，避免魔法数分叉。
 */
export function resolveToastTtlMs(ttlMs?: number): number {
  const n = Math.floor(Number(ttlMs));
  if (!Number.isFinite(n) || n <= 0) return TOAST_TTL_MS;
  return n;
}

/**
 * 成功/状态/提示类文案：不应进入 toast（产品禁令）。
 * 与 useToastQueue.policy.test 同源，防止成功刷屏回流。
 * 再扫：设置/模型/定时/字体/账户 页内 hint·setOk 成功与进度文案全覆盖。
 */
const FORBIDDEN_SUCCESS_TOAST_PATTERNS: readonly RegExp[] = [
  /^已打开/,
  /^已导出/,
  /^已复制/,
  /^已保存/,
  /^本机已保存/, // 旧降级文案以成功起头，易被当成成功刷屏
  /^已进入/,
  /^已加载技能/,
  /^已记住/,
  /^已设为当前/,
  /^已粘贴/,
  /^已加入/, // 白名单 / 列表（页内 hint）
  /^已创建/, // 分支 / 定时任务「已创建」
  /^已批准/,
  /^已停止目标/,
  /^已同步到引擎/,
  /^已添加/, // 「已添加；…」/「已添加并设为当前」
  /^已启用/,
  /^已删除/,
  /^已暂停/,
  /^已触发/, // 定时任务触发成功（workflowTriggerOkMessage）
  /^已连接/, // 账户页 daemon 连通 hint
  /^已列出/, // 字体扫描成功行内
  /^已切换/,
  /^已更新/,
  /^已应用/,
  /^已刷新/,
  /^已导入/,
  /^已恢复/,
  /^已重置/,
  /^已清空/,
  /^已移除/,
  /^已禁用/,
  /^已完成/,
  /^已记录/, // /learn 时间线成功，禁 toast 回流
  /^已写入/,
  /^已选取/,
  /^已选中/,
  /^密钥已保存/,
  /^地址已保存/,
  /^已获取\s/, // 「已获取 N 个模型…」
  /^连通成功/,
  /^保存成功/,
  /^同步成功/,
  /^更新成功/,
  /^操作成功/,
  /^连接成功/,
  /^扫描完成/,
  /^列表已更新/,
  // 进度类（应行内 spinner / hint，非 toast）
  /^正在/,
  /^连接中/,
  /^切换到演示/,
  /^切换到正式/,
  /^协作看板$/,
  /^预览浏览器/,
  // 纯提示/教育性文案（应行内，非 toast）
  /^提示：/,
  /^未扫描到本机字体/, // 空列表即反馈
  /^当前引擎不支持从界面启停/, // MCP 启停不可用：状态条 + title 即反馈
  // 再扫三轮：快捷菜单 / 模型单价·供应商开关 / 字体「已是」/ 更新检查（禁回流）
  /^当前已是/, // 「当前已是最新版本」（SettingsQuickMenu 历史 toast 点）
  /单价已保存/, // 模型单价页内 hint
  /^供应商已(?:启用|关闭)/, // 供应商开关页内 hint
  /字体已是/, // 「界面字体已是」「代码字体已是」
  /^已是默认/, // 「已是默认字体」
  /^无需更新/,
  /^检查完成/,
  /^最新版本$/,
];

/** 允许：错误、用法、降级、可撤销操作前缀 */
const ALLOWED_TOAST_PATTERNS: readonly RegExp[] = [
  /失败/,
  /错误/,
  /用法：/,
  /未找到/,
  /无法/,
  /未同步/,
  /未连接/,
  /未带/,
  /已截断/,
  /已关闭/,
  /已存在/,
  /已达上限/,
  /部分失败/,
  /请先/,
  /请填写/,
  /请等待/,
  /请输入/,
  /请重试/,
  /请确认/,
  /缺少/,
  /无效/,
  /拦截/,
  /不一致/, // 引擎回报模型不一致
  /没有可复制/, // 收紧：勿误放行「没有可用更新」类状态
  /没有可重新生成/,
  /不在当前过滤/,
  /^已归档:/, // 带 Undo
  /^已分叉:/, // 带 Undo
  /分叉/, // 可撤销
  /不能为负/, // 定价校验
  /不可加入/, // 白名单风险拦截
  /会话不可用/, // learn 降级：已本地保存但未写时间线
];

/** 文案归一：trim，供存储 / 去重 / 策略共用。 */
export function normalizeToastMessage(message: string): string {
  return (message ?? '').trim();
}

export function isForbiddenSuccessToast(message: string): boolean {
  const m = normalizeToastMessage(message);
  if (!m) return false; // 空串由 classify / shouldDrop 单独处理
  return FORBIDDEN_SUCCESS_TOAST_PATTERNS.some((re) => re.test(m));
}

export function isAllowedToast(message: string): boolean {
  const m = normalizeToastMessage(message);
  if (!m) return false;
  return ALLOWED_TOAST_PATTERNS.some((re) => re.test(m));
}

/**
 * showToast 入口门闩：空文案静默；无 onUndo 的成功/提示类静默丢弃；
 * 带 onUndo 的可撤销操作（归档/分叉）即使文案像成功也放行。
 */
export function shouldDropSuccessToast(
  message: string,
  onUndo?: () => void,
): boolean {
  const m = normalizeToastMessage(message);
  if (!m) return true;
  return !onUndo && isForbiddenSuccessToast(m);
}

/** 可观测策略结果：空 / 成功静默 / 放行展示。 */
export function classifyToastPolicy(
  message: string,
  onUndo?: () => void,
): ToastPolicyDecision {
  const m = normalizeToastMessage(message);
  if (!m) return 'drop-empty';
  if (shouldDropSuccessToast(m, onUndo)) return 'drop-success';
  return 'show';
}

/**
 * 引擎未同步/未连接降级 toast：先说问题，括号补「本机已保存」。
 * 禁止以「本机已保存；…」起头（易被读成成功）。
 */
export function formatEngineDegradeToast(error?: string | null): string {
  const detail = (error || '').trim();
  if (!detail || detail === '引擎未连接') {
    return '引擎未连接（本机已保存）';
  }
  // 若误传旧成功前缀，剥掉后按未连接/未同步重排
  if (detail.startsWith('本机已保存')) {
    // 兼容全角/半角分隔：；;：:
    const rest = detail.replace(/^本机已保存[；;：:\s]*/, '').trim();
    if (!rest || rest === '引擎未连接' || rest.startsWith('引擎未连接')) {
      return '引擎未连接（本机已保存）';
    }
    if (rest.startsWith('引擎未同步')) {
      return rest.includes('本机') ? rest : `${rest}（本机已保存）`;
    }
    return `引擎未同步：${rest}（本机已保存）`;
  }
  if (detail.startsWith('引擎未同步')) {
    return detail.includes('本机') ? detail : `${detail}（本机已保存）`;
  }
  return `引擎未同步：${detail}（本机已保存）`;
}

// ---------------------------------------------------------------------------
// Pure queue helpers (extractable from hook — unit-tested without React)
// ---------------------------------------------------------------------------

/**
 * 去重键：归一文案 + 是否可撤销。
 * 同一错误文案不叠两层；错误 vs 同文案 Undo 不互相折叠。
 */
export function toastDedupeKey(message: string, hasUndo: boolean): string {
  return `${hasUndo ? 'u' : 'e'}\0${normalizeToastMessage(message)}`;
}

/** 可注入 now/rand 的 id 工厂（测试稳定）。 */
export function createToastId(
  now: number = Date.now(),
  rand: string = Math.random().toString(36).slice(2, 8),
): string {
  return `toast-${now}-${rand}`;
}

/** 构造 AppToast：归一 message；可选稳定 id。 */
export function createToastItem(
  message: string,
  onUndo?: () => void,
  id?: string,
): AppToast {
  const normalized = normalizeToastMessage(message);
  const isError = /失败|错误|无法|拒绝/.test(normalized);
  return {
    id: id ?? createToastId(),
    message: normalized,
    ...(onUndo !== undefined ? { onUndo } : {}),
    ariaLive: isError ? 'assertive' : 'polite',
    type: onUndo ? 'info' : (isError ? 'error' : 'warning'),
    duration: TOAST_TTL_MS,
    timestamp: Date.now(),
  };
}

/**
 * 可撤销归档 toast 文案（与 ALLOWED /^已归档:/ 及侧栏 archiveUndoToastMessage 同构）。
 */
export function formatArchiveUndoToast(title: string): string {
  const t = normalizeToastMessage(title) || '会话';
  return `已归档: ${t}`;
}

/**
 * 可撤销分叉 toast 文案（与 ALLOWED /^已分叉:/ 及侧栏 branchUndoToastMessage 同构）。
 */
export function formatBranchUndoToast(title: string): string {
  const t = normalizeToastMessage(title) || '会话';
  return `已分叉: ${t}`;
}

/** 是否为策略认可的可撤销归档/分叉文案形。 */
export function isUndoToastShape(message: string): boolean {
  const m = normalizeToastMessage(message);
  return /^已归档:/.test(m) || /^已分叉:/.test(m);
}

/**
 * 构造可撤销 toast 条目：强制 onUndo；文案仍走策略（调用方宜用 format*UndoToast）。
 */
export function buildUndoToastItem(
  message: string,
  onUndo: () => void,
  id?: string,
): AppToast {
  return createToastItem(message, onUndo, id);
}

/**
 * 无 onUndo 时是否为「错误/门闩放行」候选（error-only 过滤）。
 * 成功/空/提示一律 false。
 */
export function isErrorToastCandidate(message: string): boolean {
  return classifyToastPolicy(message) === 'show';
}

/**
 * 批量 error-only 过滤：去掉成功/空/提示；保留错误类文案。
 * 不处理 onUndo 路径（可撤销由调用方单独构造）。
 */
export function filterErrorOnlyToastMessages(
  messages: readonly string[],
): string[] {
  return messages
    .map((m) => normalizeToastMessage(m))
    .filter((m) => m.length > 0 && isErrorToastCandidate(m));
}

/** 队列中同 dedupe 键的下标；无则 -1。 */
export function findDuplicateToastIndex(
  queue: readonly AppToast[],
  message: string,
  hasUndo: boolean,
): number {
  const key = toastDedupeKey(message, hasUndo);
  return queue.findIndex(
    (t) => toastDedupeKey(t.message, t.onUndo != null) === key,
  );
}

/**
 * 按 max 截断队列（FIFO 挤掉最旧），返回新队列与被挤 id。
 */
export function trimToastQueue(
  queue: readonly AppToast[],
  maxQueue: number = TOAST_MAX_QUEUE,
): { next: AppToast[]; evictedIds: string[] } {
  let max = Math.floor(Number(maxQueue));
  if (!Number.isFinite(max)) max = TOAST_MAX_QUEUE;
  if (max < 1) max = 1;
  if (queue.length <= max) {
    return { next: queue.slice(), evictedIds: [] };
  }
  const overflow = queue.length - max;
  const evictedIds = queue.slice(0, overflow).map((t) => t.id);
  return { next: queue.slice(overflow), evictedIds };
}

/** 按 id 移除一条（dismiss / TTL 到期）。 */
export function removeToastById(
  queue: readonly AppToast[],
  id: string,
): AppToast[] {
  return queue.filter((t) => t.id !== id);
}

export type EnqueueToastOptions = {
  /** 稳定 id（测试）；默认 createToastId() */
  id?: string;
  /** 队列上限；默认 TOAST_MAX_QUEUE */
  maxQueue?: number;
  /** auto-dismiss TTL ms；默认 TOAST_TTL_MS；≤0 / 非有限 → 回落默认 */
  ttlMs?: number;
};

/**
 * 纯 enqueue：策略门闩 → 去重（可刷新 TTL / 可替换 onUndo）→ 追加 → max 截断。
 * hook 的 showToast 只编排 timer，状态转移全在此。
 */
export function enqueueToast(
  queue: readonly AppToast[],
  message: string,
  onUndo?: () => void,
  options?: EnqueueToastOptions,
): ToastEnqueueResult {
  const policy = classifyToastPolicy(message, onUndo);
  if (policy !== 'show') {
    return { kind: 'drop', reason: policy };
  }

  const normalized = normalizeToastMessage(message);
  const ttlMs = resolveToastTtlMs(options?.ttlMs);
  const hasUndo = onUndo != null;
  const dupeIdx = findDuplicateToastIndex(queue, normalized, hasUndo);
  if (dupeIdx >= 0) {
    const existing = queue[dupeIdx]!;
    // 同键再触发：刷新 TTL；若带来新的 onUndo 则替换回调（归档/分叉重做）
    if (onUndo !== undefined && onUndo !== existing.onUndo) {
      const next = queue.slice();
      next[dupeIdx] = { ...existing, onUndo };
      return {
        kind: 'dedupe',
        existingId: existing.id,
        refreshTtlMs: ttlMs,
        next,
      };
    }
    return {
      kind: 'dedupe',
      existingId: existing.id,
      refreshTtlMs: ttlMs,
    };
  }

  const item = createToastItem(normalized, onUndo, options?.id);
  const appended = [...queue, item];
  const maxQueue = options?.maxQueue ?? TOAST_MAX_QUEUE;
  const { next, evictedIds } = trimToastQueue(appended, maxQueue);
  return { kind: 'enqueue', item, next, evictedIds, ttlMs };
}

/**
 * Multi-toast queue with auto-dismiss.
 * Policy: toast ONLY for errors and undoable actions (e.g. archive / branch + Undo).
 * Never for open panel / export success / copy success / routine status / tips.
 * Timers live in a ref Map so dismiss / unmount clear them;
 * showToast itself does not return a cleanup (callers ignore returns).
 */
export function useToastQueue() {
  const [toasts, setToasts] = useState<AppToast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** 镜像队列，便于 showToast 同步读 prev 做纯 enqueue（避免 setState 副作用）。 */
  const toastsRef = useRef<AppToast[]>([]);
  toastsRef.current = toasts;

  const clearTimer = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t != null) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const scheduleDismiss = useCallback(
    (id: string, ttlMs: number = TOAST_TTL_MS) => {
      clearTimer(id);
      const delay = resolveToastTtlMs(ttlMs);
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => {
          const next = removeToastById(prev, id);
          toastsRef.current = next;
          return next;
        });
      }, delay);
      timersRef.current.set(id, timer);
    },
    [clearTimer],
  );

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => {
        const next = removeToastById(prev, id);
        toastsRef.current = next;
        return next;
      });
    },
    [clearTimer],
  );

  const showToast: ShowToastFn = useCallback(
    (message, onUndo) => {
      const result = enqueueToast(toastsRef.current, message, onUndo);

      if (result.kind === 'drop') {
        if (import.meta.env?.DEV && result.reason === 'drop-success') {
          console.warn('[toast policy] dropped success/tip toast:', message);
        }
        return;
      }

      if (result.kind === 'dedupe') {
        // 同文案再触发：刷新 TTL，不叠层；onUndo 若更新则同步队列
        if (result.next) {
          toastsRef.current = result.next;
          setToasts(result.next);
        }
        scheduleDismiss(result.existingId, result.refreshTtlMs);
        return;
      }

      for (const id of result.evictedIds) {
        clearTimer(id);
      }
      toastsRef.current = result.next;
      setToasts(result.next);
      scheduleDismiss(result.item.id, result.ttlMs);
    },
    [clearTimer, scheduleDismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) {
        clearTimeout(t);
      }
      timers.clear();
    };
  }, []);

  return { toasts, showToast, dismissToast };
}
