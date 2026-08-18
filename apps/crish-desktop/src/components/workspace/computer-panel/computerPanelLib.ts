/**
 * 电脑操作面板纯函数层（二期 P2，S5 遗留⑩）：会话三态归一化 / 载荷校验 /
 * 按钮可用性矩阵。从 useComputerSession / ComputerPanel 抽出，零副作用，
 * 可独立单测（对齐 browserSessionLib 范式）。
 *
 * 状态契约（与引擎接线约定，定死；接线前命令未注册 → missing 降级本地化）：
 * - activation：ActivationGate 三态（04 §2 S3 SessionMode { Idle, Browser,
 *   Desktop }；任务书口径 Idle/BrowserActive/DesktopActive，本层契约值
 *   'idle'/'browser'/'desktop' 对齐 Rust serde 枚举，UI 文案表达活跃语义）；
 * - enabled：会话级显式开启标记（04 §4.1，session_meta 落盘
 *   computer_use_enabled=true；新会话默认关闭）。
 *
 * 接线点登记（06 文档 §8 遗留项 9/10）：
 * - computer_status 查询 + computer://state-changed 事件由引擎接线后驱动
 *   真实三态；未接线时前端本地化维护（enabled 本地置位不落盘）。
 */

export type ComputerActivation = 'idle' | 'browser' | 'desktop';

export const COMPUTER_ACTIVATIONS: readonly ComputerActivation[] = [
  'idle',
  'browser',
  'desktop',
];

/** 激活模式主文案（活跃态标题；未启用时呈现为「未开启」语境） */
export const COMPUTER_ACTIVATION_LABEL: Record<ComputerActivation, string> = {
  idle: '待机',
  browser: '浏览器活跃',
  desktop: '桌面活跃',
};

/** 激活模式描述（状态区副标题 / 三态悬浮说明） */
export const COMPUTER_ACTIVATION_DESC: Record<ComputerActivation, string> = {
  idle: '无 AI 会话活跃。',
  browser: 'AI 浏览器会话活跃（受管浏览器）；桌面操作工具面互斥拒绝。',
  desktop: '电脑操作会话活跃；AI 可注入本机输入 / 截屏感知。',
};

/** 未接线（命令面缺失）时面板的降级提示文案。 */
export const COMPUTER_UNWIRED_TEXT =
  '引擎未接线：开关为本地记录，不会落盘持久化；感知预览暂不可用。';

export function isComputerActivation(v: unknown): v is ComputerActivation {
  return (
    typeof v === 'string' &&
    (COMPUTER_ACTIVATIONS as readonly string[]).includes(v)
  );
}

/**
 * 归一化激活模式：合法值原样返回；未知 / 非法返回 null（调用方静默丢弃，
 * 防御引擎异常载荷）。
 */
export function normalizeComputerActivation(
  v: unknown
): ComputerActivation | null {
  return isComputerActivation(v) ? v : null;
}

/**
 * 解析 status 查询 / state-changed 事件载荷。
 * 字段均为可选（事件载荷可只携带变更域）；enabled 非法时忽略、activation
 * 非法时忽略；整载荷无效返回 null。
 */
export function parseComputerStatePayload(
  payload: unknown
): { enabled?: boolean; activation?: ComputerActivation } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const o = payload as Record<string, unknown>;
  const out: { enabled?: boolean; activation?: ComputerActivation } = {};
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  const activation = normalizeComputerActivation(o.mode ?? o.activation);
  if (activation) out.activation = activation;
  return Object.keys(out).length > 0 ? out : null;
}

// ── 按钮可用性矩阵 ──────────────────────────────────────────────
// 启用：未开启（已开启时按钮切换为「停用」）；
// 停用：已开启。

export function canEnableComputerSession(enabled: boolean): boolean {
  return !enabled;
}

export function canDisableComputerSession(enabled: boolean): boolean {
  return enabled;
}
