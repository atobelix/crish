/**
 * 轻量 UI 事件总线：在 window CustomEvent 之上加类型与统一前缀。
 * 事件名对外为短名（如 'open-chat'），派发时自动变成 `crish-open-chat`，
 * 与存量 `dispatchEvent(new CustomEvent('crish-…'))` 双向兼容。
 *
 * 契约：
 * - 仅接受 UiEventMap 内短名；运行时 isUiEventName 拒绝未知名
 * - emit / on / once 在无 window 时安全 no-op
 * - unsubscribe 幂等；once 触发后自动卸订阅
 * - 单个 handler 抛错不阻断同事件其他订阅者
 */

/** 已迁移的 UI 跨组件事件（按需扩展，勿一次塞满） */
export type UiEventMap = {
  'project-changed': void;
  'open-project-picker': void;
  'open-scheduled': void;
  'open-chat': void;
  'open-overview': void;
  'open-tasks': void;
  'pick-workspace': void;
  'open-agent-panel': { agentId?: string };
  'update-changed': void;
  /** 聊天顶栏 ⋯：切换本会话搜索条 */
  'toggle-msg-filter': void;
  /** 聊天顶栏 ⋯：导出当前会话 Markdown */
  'export-session-md': void;
  /** 聊天顶栏 ⋯：打开对话回溯预览（daemon experimental） */
  'open-conversation-rewind': void;
  /** 活动服务商/模型已切换（设置页或底栏 Picker） */
  'model-changed': { profileId: string; model: string };
  /** 服务商列表/密钥/模型表变更（设置页保存后刷新选择器） */
  'profiles-changed': void;
  /** 快捷键：聚焦主对话输入框 */
  'focus-composer': void;
  /** 快捷键：中断当前生成 */
  'stop-generation': void;
};

export type UiEventName = keyof UiEventMap;

/** void 事件的 detail 收窄为 undefined；有载荷则为载荷类型 */
export type UiEventDetail<K extends UiEventName> = UiEventMap[K] extends void
  ? undefined
  : UiEventMap[K];

export type UiEventHandler<K extends UiEventName> = (
  detail: UiEventDetail<K>
) => void;

/** DOM 事件名前缀（与存量 crish-* CustomEvent 一致） */
export const UI_EVENT_PREFIX = 'crish-' as const;

/**
 * 全部已注册短名（顺序稳定，便于测试与遍历）。
 * 新增事件时务必同步改 UiEventMap + 本表。
 */
export const UI_EVENT_NAMES = [
  'project-changed',
  'open-project-picker',
  'open-scheduled',
  'open-chat',
  'open-overview',
  'open-tasks',
  'pick-workspace',
  'open-agent-panel',
  'update-changed',
  'toggle-msg-filter',
  'export-session-md',
  'open-conversation-rewind',
  'model-changed',
  'profiles-changed',
  'focus-composer',
  'stop-generation',
] as const satisfies readonly UiEventName[];

const UI_EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(UI_EVENT_NAMES);

/** 是否需要携带 detail（非 void） */
type HasDetail<K extends UiEventName> = UiEventMap[K] extends void
  ? false
  : true;

/** emit 可选参：有载荷时必填，void 时可选 */
type EmitArgs<K extends UiEventName> =
  HasDetail<K> extends true
    ? [detail: UiEventMap[K]]
    : [detail?: UiEventMap[K]];

/** 运行时类型守卫：仅接受 UiEventMap 注册短名 */
export function isUiEventName(name: unknown): name is UiEventName {
  return typeof name === 'string' && UI_EVENT_NAME_SET.has(name);
}

/** 短名 → 实际 DOM 事件名（带 crish- 前缀） */
export function toUiEventDomName(name: UiEventName): string {
  return `${UI_EVENT_PREFIX}${name}`;
}

/**
 * DOM 事件名 → 短名；前缀不对或未注册 → null。
 * 便于桥接存量 `addEventListener('crish-…')` 与类型化总线。
 */
export function fromUiEventDomName(domName: unknown): UiEventName | null {
  if (typeof domName !== 'string' || !domName.startsWith(UI_EVENT_PREFIX)) {
    return null;
  }
  const short = domName.slice(UI_EVENT_PREFIX.length);
  return isUiEventName(short) ? short : null;
}

function getWindow(): (Window & typeof globalThis) | undefined {
  if (typeof window === 'undefined') return undefined;
  return window as Window & typeof globalThis;
}

/** 单订阅者异常隔离，避免拖垮同事件其余 handler */
function invokeHandler<K extends UiEventName>(
  handler: UiEventHandler<K>,
  detail: UiEventDetail<K>
): void {
  try {
    handler(detail);
  } catch {
    /* ignore subscriber errors */
  }
}

/**
 * 派发 UI 事件。void 类事件可不传 detail；有载荷时第二参为该载荷。
 * @returns 是否成功 dispatch（无 window / 未知名 / 抛错 → false）
 */
export function emitUiEvent<K extends UiEventName>(
  name: K,
  ...args: EmitArgs<K>
): boolean {
  // 防御性：调用方若强转 string 传入未知名，拒绝派发
  if (!isUiEventName(name)) return false;
  const w = getWindow();
  if (!w || typeof w.dispatchEvent !== 'function') return false;

  const detail = args[0];
  try {
    const event = new CustomEvent(toUiEventDomName(name), {
      detail: detail === undefined ? undefined : detail,
    });
    return w.dispatchEvent(event);
  } catch {
    return false;
  }
}

/**
 * 订阅 UI 事件；返回幂等取消订阅函数。
 * handler 收到的 detail 已按 UiEventMap 收窄（void 时为 undefined）。
 * 未知事件名 / 非函数 handler / 无 window → 返回 no-op off。
 */
export function onUiEvent<K extends UiEventName>(
  name: K,
  handler: UiEventHandler<K>
): () => void {
  if (!isUiEventName(name) || typeof handler !== 'function') {
    return () => undefined;
  }
  const w = getWindow();
  if (!w || typeof w.addEventListener !== 'function') {
    return () => undefined;
  }

  const domName = toUiEventDomName(name);
  let active = true;
  const listener = (ev: Event) => {
    if (!active) return;
    const detail = (ev as CustomEvent<UiEventMap[K]>)
      .detail as UiEventDetail<K>;
    invokeHandler(handler, detail);
  };

  w.addEventListener(domName, listener);

  return () => {
    if (!active) return;
    active = false;
    try {
      if (typeof w.removeEventListener === 'function') {
        w.removeEventListener(domName, listener);
      }
    } catch {
      /* ignore */
    }
  };
}

/**
 * 订阅一次：首次收到事件后自动卸订阅再调用 handler。
 * 返回的 off 可在触发前主动取消；触发后 / 重复调用均为幂等 no-op。
 */
export function onceUiEvent<K extends UiEventName>(
  name: K,
  handler: UiEventHandler<K>
): () => void {
  if (!isUiEventName(name) || typeof handler !== 'function') {
    return () => undefined;
  }

  let off: (() => void) | undefined;
  off = onUiEvent(name, (detail) => {
    const unsub = off;
    off = undefined;
    unsub?.();
    // onUiEvent 已做异常隔离；此处直接调用即可（仍包一层防止未来改动）
    invokeHandler(handler, detail);
  });

  return () => {
    const unsub = off;
    off = undefined;
    unsub?.();
  };
}

/**
 * 一次订阅多个事件，返回统一 off（幂等）。
 * 仅对 handlers 中出现的键建立监听；忽略 undefined 槽位。
 */
export function onUiEvents(handlers: {
  [K in UiEventName]?: UiEventHandler<K>;
}): () => void {
  if (!handlers || typeof handlers !== 'object') {
    return () => undefined;
  }

  const offs: Array<() => void> = [];
  for (const name of UI_EVENT_NAMES) {
    const handler = handlers[name];
    if (typeof handler === 'function') {
      // 各键独立收窄；运行时已校验为函数
      offs.push(onUiEvent(name, handler as UiEventHandler<typeof name>));
    }
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const off of offs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
  };
}
