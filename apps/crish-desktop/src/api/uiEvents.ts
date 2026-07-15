/**
 * 轻量 UI 事件总线：在 window CustomEvent 之上加类型与统一前缀。
 * 事件名对外为短名（如 'open-chat'），派发时自动变成 `crish-open-chat`，
 * 与存量 `dispatchEvent(new CustomEvent('crish-…'))` 双向兼容。
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
};

export type UiEventName = keyof UiEventMap;

const PREFIX = 'crish-';

/** 短名 → 实际 DOM 事件名（带 crish- 前缀） */
function toDomName(name: UiEventName): string {
  return `${PREFIX}${name}`;
}

/** 是否需要携带 detail（非 void） */
type HasDetail<K extends UiEventName> = UiEventMap[K] extends void ? false : true;

/**
 * 派发 UI 事件。void 类事件可不传 detail；有载荷时第二参为该载荷。
 */
export function emitUiEvent<K extends UiEventName>(
  name: K,
  ...args: HasDetail<K> extends true ? [detail: UiEventMap[K]] : [detail?: UiEventMap[K]]
): void {
  if (typeof window === 'undefined') return;
  const detail = args[0];
  try {
    window.dispatchEvent(
      new CustomEvent(toDomName(name), {
        detail: detail === undefined ? undefined : detail,
      }),
    );
  } catch {
    /* ignore */
  }
}

/**
 * 订阅 UI 事件；返回取消订阅函数。
 * handler 收到的 detail 已按 UiEventMap 收窄（void 时为 undefined）。
 */
export function onUiEvent<K extends UiEventName>(
  name: K,
  handler: (detail: UiEventMap[K] extends void ? undefined : UiEventMap[K]) => void,
): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  const domName = toDomName(name);
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<UiEventMap[K]>).detail as UiEventMap[K] extends void
      ? undefined
      : UiEventMap[K];
    handler(detail);
  };
  window.addEventListener(domName, listener);
  return () => window.removeEventListener(domName, listener);
}
