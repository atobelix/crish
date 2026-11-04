// 生成中发送队列（批 C 01-4/②）：某会话生成进行中时用户再发送的
// 消息进入本队列——按会话键隔离（`remote:<sessionId>` /
// `local:<threadId>`，与草稿/锚点同一键形）、逐条可撤、持久化
// （进程被杀恢复后仍在列，仍可撤回/续发，见 useSendQueue 的排空
// 状态机）。条目内容 = 发送意图本身：文本 + 附件快照（ComposerAttachment
// 为全内联可序列化形态——图片 dataUrl / 文本正文都在条目内，恢复
// 后按原意图组装发送，不依赖已失效的本地文件引用）。
// 持久面与草稿同源：kv settings 表经 configure 注入（persistBootstrap）；
// 未注入 / DB 降级时退化为内存态（会话内队列仍成立，跨启动不保留，
// 诚实降级）。队列上限按会话计，超限入队被拒（调用方给诚实提示，
// 不静默丢弃用户输入）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ComposerAttachment } from '../pure/attachments';

/** 单个排队发送意图 */
export interface SendQueueItem {
  id: string;
  /** 用户键入文本（可为空串：纯附件发送） */
  text: string;
  /** 附件快照（入队时刻的已选区副本；本地线程恒为空数组） */
  attachments: ComposerAttachment[];
  createdAtMs: number;
}

/** 每会话队列上限（超限拒绝入队，调用方提示，不静默吞） */
export const SEND_QUEUE_MAX_PER_KEY = 20;

/** 队列持久接口（SqlSettingsDao 的 get/set/delete 与之同形） */
export interface SendQueuePersist {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

const KEY_PREFIX = 'chat.send_queue.';

export function sendQueueKey(queueKey: string): string {
  return `${KEY_PREFIX}${queueKey}`;
}

/** 序列化（整队列一个 kv 值；条目形状由 parseSendQueue 对称校验） */
export function serializeSendQueue(items: readonly SendQueueItem[]): string {
  return JSON.stringify(items);
}

/** 解析落盘值：形状不对 → 空队列（无队列），绝不抛 */
export function parseSendQueue(raw: string | null): SendQueueItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const items: SendQueueItem[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { id, text, attachments, createdAtMs } = entry as Record<
        string,
        unknown
      >;
      if (typeof id !== 'string' || id === '') continue;
      if (typeof text !== 'string') continue;
      if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs)) {
        continue;
      }
      items.push({
        id,
        text,
        attachments: Array.isArray(attachments)
          ? (attachments as ComposerAttachment[])
          : [],
        createdAtMs,
      });
    }
    return items.slice(0, SEND_QUEUE_MAX_PER_KEY);
  } catch {
    return [];
  }
}

/** 默认持久化实现（接线层启动时注入一次） */
let defaultPersist: SendQueuePersist | null = null;

/** 已完成持久回填的队列键（每键只回填一次，防迟到回填覆盖新入队） */
const hydratedKeys = new Set<string>();

/** 接线层注入默认持久化（persistBootstrap 装配；传 null 复位为内存形态） */
export function configureSendQueuePersistence(
  persist: SendQueuePersist | null
): void {
  defaultPersist = persist;
}

export interface SendQueueState {
  /** 队列键 → 排队条目（FIFO，队首为下一条待发） */
  queues: Record<string, readonly SendQueueItem[]>;
  /** 入队（超上限返回 false，条目不入列） */
  enqueue: (queueKey: string, item: SendQueueItem) => boolean;
  /** 撤回单条（用户在队列行上撤销未发出的消息） */
  withdraw: (queueKey: string, itemId: string) => void;
  /** 取走队首（排空状态机确认发送受理后调用；无条目返回 null） */
  shift: (queueKey: string) => SendQueueItem | null;
  /** 把被拒的队首放回（发送未受理时回滚，保持原顺序） */
  unshift: (queueKey: string, item: SendQueueItem) => void;
}

/** 变更后尽力落盘（内存恒为同步真源；落盘失败不阻断交互） */
function persistQueue(queueKey: string, items: readonly SendQueueItem[]): void {
  const persist = defaultPersist;
  if (!persist) return;
  const key = sendQueueKey(queueKey);
  if (items.length === 0) {
    if (persist.delete) {
      void persist.delete(key).catch(() => undefined);
    } else {
      void persist.set(key, '').catch(() => undefined);
    }
    return;
  }
  void persist.set(key, serializeSendQueue(items)).catch(() => {
    // 队列内存副本仍在：本次进程内不丢；跨启动恢复降级（同草稿口径）
  });
}

export const sendQueueStore: StoreApi<SendQueueState> =
  createStore<SendQueueState>()((set, get) => ({
    queues: {},

    enqueue: (queueKey, item) => {
      const current = get().queues[queueKey] ?? [];
      if (current.length >= SEND_QUEUE_MAX_PER_KEY) return false;
      const next = [...current, item];
      set((s) => ({ queues: { ...s.queues, [queueKey]: next } }));
      persistQueue(queueKey, next);
      return true;
    },

    withdraw: (queueKey, itemId) => {
      const current = get().queues[queueKey] ?? [];
      if (!current.some((i) => i.id === itemId)) return;
      const next = current.filter((i) => i.id !== itemId);
      set((s) => ({ queues: { ...s.queues, [queueKey]: next } }));
      persistQueue(queueKey, next);
    },

    shift: (queueKey) => {
      const current = get().queues[queueKey] ?? [];
      const head = current[0];
      if (!head) return null;
      const next = current.slice(1);
      set((s) => ({ queues: { ...s.queues, [queueKey]: next } }));
      persistQueue(queueKey, next);
      return head;
    },

    unshift: (queueKey, item) => {
      const current = get().queues[queueKey] ?? [];
      if (current.some((i) => i.id === item.id)) return;
      const next = [item, ...current];
      set((s) => ({ queues: { ...s.queues, [queueKey]: next } }));
      persistQueue(queueKey, next);
    },
  }));

/**
 * 队列持久回填（引擎挂载时按会话键调用，一次性）：落盘队列并入内存
 * 队列之前（落盘条目更旧）；本进程已入队的新条目不被覆盖。无持久面
 * / 读失败 = 无回填，不报错。
 */
export async function hydrateSendQueueKey(queueKey: string): Promise<void> {
  if (hydratedKeys.has(queueKey)) return;
  hydratedKeys.add(queueKey);
  const persist = defaultPersist;
  if (!persist) return;
  try {
    const restored = parseSendQueue(await persist.get(sendQueueKey(queueKey)));
    if (restored.length === 0) return;
    const current = sendQueueStore.getState().queues[queueKey] ?? [];
    const known = new Set(current.map((i) => i.id));
    const merged = [
      ...restored.filter((i) => !known.has(i.id)),
      ...current,
    ].slice(0, SEND_QUEUE_MAX_PER_KEY);
    sendQueueStore.setState((s) => ({
      queues: { ...s.queues, [queueKey]: merged },
    }));
  } catch {
    // 回填失败 = 本次无恢复队列（内存态继续），不抛进交互路径
  }
}

/** 测试隔离：清空全部队列与回填标记（仅测试调用） */
export function resetSendQueueForTest(): void {
  sendQueueStore.setState({ queues: {} });
  hydratedKeys.clear();
  defaultPersist = null;
}
