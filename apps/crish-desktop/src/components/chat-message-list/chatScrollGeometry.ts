/**
 * 会话消息流虚拟滚动垂直节奏常量（与 ChatMessageList 几何 SSOT 对齐）。
 * 绝对定位切片不吃 CSS padding，必须进入文档高度与 translate 偏移。
 * P3-T02/T03: 水平内衬已单点收敛至 .listInner 的 CSS 变量（--stream-pad-x），
 * 切片绝对定位使用 left: 0, right: 0，不再维护 TS 侧静态 CHAT_SCROLL_PAD_X 双源常量。
 */
export const CHAT_SCROLL_PAD_TOP = 48;
export const CHAT_SCROLL_PAD_BOTTOM = 16;

/**
 * R12 尾部缓冲（最新消息上推）：文档尾部在底衬之外再留一段呼吸区，
 * 使跟随静止点从「物理底」上移为「内容底上方 B 处」，最新一轮停在阅读舒适区。
 * B 随视口高缩放 clamp(160px, 28% × 视口高, 360px)：
 * 下限保证整段越过 composer 停靠区（104px）+ 列表底部渐隐（48px）的视觉压迫带；
 * 上限封顶窗口内 maxScroll 膨胀与大视口下的空白感。
 * 缓冲只在轮次窗口内存在（见 resolveTailBufferTargetPx），只由窗口与视口高派生，
 * 不读行高测量、不读 scrollHeight，结构上不可能与测高形成反馈环。
 */
export const CHAT_SCROLL_TAIL_BUFFER_MIN_PX = 160;
export const CHAT_SCROLL_TAIL_BUFFER_RATIO = 0.28;
export const CHAT_SCROLL_TAIL_BUFFER_MAX_PX = 360;

/** 尾部缓冲目标高度（px）：视口比例 + 上下限钳制，纯函数 */
export function resolveTailBufferPx(viewportHeight: number): number {
  const vh =
    Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  return Math.min(
    CHAT_SCROLL_TAIL_BUFFER_MAX_PX,
    Math.max(CHAT_SCROLL_TAIL_BUFFER_MIN_PX, vh * CHAT_SCROLL_TAIL_BUFFER_RATIO)
  );
}

/**
 * 尾部缓冲目标（纯函数，宿主在渲染期单点调用）：
 * R12b 窗口语义——缓冲只在「发送 → 本轮终态」窗口内存在，窗口内目标 =
 * resolveTailBufferPx（只随视口高）；窗口外（静止 / 阅读态）恒为 0，
 * 消息可滑到物理真底（R12 的会话闩锁常驻 + 溢出门旧口径自此废止：
 * 短会话发送同样张开，临时造出的可滚区正是发送上推的本意，窗口结束
 * 收合后 maxScroll 回到原值，无静止假滚动区残留）。
 * 窗口信号 turnActive 由宿主从轮次状态单点派生（processing 中的 assistant
 * 消息为主信号，发送帧由发送闩桥接）；目标不读内容量、不读测高，无反馈环。
 */
export function resolveTailBufferTargetPx(params: {
  turnActive: boolean;
  viewportHeight: number;
}): number {
  return params.turnActive ? resolveTailBufferPx(params.viewportHeight) : 0;
}

/** 缓冲开启斜坡：单帧增量占当帧内容增量的上限比例（不得主导内容自身位移） */
export const CHAT_SCROLL_TAIL_BUFFER_RAMP_CONTENT_FRACTION = 0.25;
/** 缓冲开启斜坡：单帧增量绝对上限（px/帧） */
export const CHAT_SCROLL_TAIL_BUFFER_RAMP_MAX_STEP_PX = 24;
/** 缓冲开启斜坡：内容停长时的兜底推进量（px/帧，保证有限帧内开满） */
export const CHAT_SCROLL_TAIL_BUFFER_RAMP_FALLBACK_STEP_PX = 12;

/**
 * 斜坡单帧步长（纯函数）：≤ 当帧内容增量的 25%、且 ≤ 24px；
 * 内容增量不足时以 12px 兜底（仍受 24px 上限与剩余量约束）。
 */
export function resolveTailBufferRampStepPx(
  contentIncrementPx: number,
  remainingPx: number
): number {
  const remaining =
    Number.isFinite(remainingPx) && remainingPx > 0 ? remainingPx : 0;
  if (remaining <= 0) return 0;
  const increment =
    Number.isFinite(contentIncrementPx) && contentIncrementPx > 0
      ? contentIncrementPx
      : 0;
  const cap = Math.min(
    CHAT_SCROLL_TAIL_BUFFER_RAMP_MAX_STEP_PX,
    Math.max(
      CHAT_SCROLL_TAIL_BUFFER_RAMP_FALLBACK_STEP_PX,
      increment * CHAT_SCROLL_TAIL_BUFFER_RAMP_CONTENT_FRACTION
    )
  );
  return Math.min(cap, remaining);
}

/**
 * 运行时从 DOM 元素或全局读取 `--stream-pad-x`（兼容 fallback `--chat-stream-pad-x`, 20px）。
 * CSS 为唯一样式真源，本函数仅供非样式计算场景安全读取。
 */
export function readStreamPadX(el?: HTMLElement | null): number {
  if (
    typeof window === 'undefined' ||
    typeof getComputedStyle === 'undefined'
  ) {
    return 20;
  }
  const target =
    el || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!target) return 20;
  const style = getComputedStyle(target);
  const raw =
    style.getPropertyValue('--stream-pad-x') ||
    style.getPropertyValue('--chat-stream-pad-x');
  const val = parseFloat(raw);
  return Number.isFinite(val) && val >= 0 ? val : 20;
}

/**
 * 运行时从 DOM 元素读取对话流水平安全内衬（左侧行首线 + 右侧功能区避让区）。
 * 严格基于盒模型与 --chat-stream-pad-x 契约，保证几何测量与 CSS 布局的单源真理（SSOT）。
 */
export function readStreamPadding(el?: HTMLElement | null): {
  padStart: number;
  padEnd: number;
} {
  const padX = readStreamPadX(el);
  if (
    typeof window === 'undefined' ||
    typeof getComputedStyle === 'undefined'
  ) {
    return { padStart: padX, padEnd: padX };
  }
  const target =
    el || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!target) return { padStart: padX, padEnd: padX };
  const style = getComputedStyle(target);
  const padLeftRaw = parseFloat(style.getPropertyValue('padding-left'));
  const padRightRaw = parseFloat(style.getPropertyValue('padding-right'));
  const padStart =
    Number.isFinite(padLeftRaw) && padLeftRaw > 0 ? padLeftRaw : padX;
  const padEnd =
    Number.isFinite(padRightRaw) && padRightRaw > 0 ? padRightRaw : padX;
  return {
    padStart,
    padEnd,
  };
}

/**
 * 文档总高 = 顶衬 + 内容 + 底衬 + 尾部缓冲（R12 第三项，默认 0 时与原公式逐值一致）。
 * 全仓生产调用点恰 4 处，必须取同一帧的同一缓冲值（单点注入纪律）。
 */
export function chatSpacerHeight(
  contentHeight: number,
  tailBufferPx = 0
): number {
  const h =
    Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
  const tail =
    Number.isFinite(tailBufferPx) && tailBufferPx > 0 ? tailBufferPx : 0;
  return CHAT_SCROLL_PAD_TOP + h + CHAT_SCROLL_PAD_BOTTOM + tail;
}

/** 将 VSM 内容偏移映射到滚动文档坐标（含顶部内衬） */
export function contentOffsetToDocOffset(contentOffset: number): number {
  return CHAT_SCROLL_PAD_TOP + Math.max(0, contentOffset);
}
