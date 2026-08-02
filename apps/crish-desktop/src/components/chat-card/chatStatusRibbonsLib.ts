/**
 * ChatStatusRibbons 纯函数层：文案 / aria / 可见性门闩。
 * 从 ChatStatusRibbons.tsx 前 290 行抽出，零副作用，可独立单测。
 *
 * 6 种 ribbon 状态机常量：
 * - setup 四态：'engine-down' | 'needs-key' | 'needs-model' | 'sync-engine'（SetupHintKind）
 * - plan / goal 两态：由 PlanRibbonState / GoalRibbonState 布尔字段表达
 */
import type { RunNotice } from '../../hooks/useChatStream';
import {
  shouldShowNeedsKeySoftHint,
  shouldShowNeedsModelSoftHint,
} from '../../api/chatEmptyState';

/** setup soft-hint 互斥种类（data-setup-hint）；null = 不展示任何 setup 条。 */
export type SetupHintKind =
  | 'engine-down'
  | 'needs-key'
  | 'needs-model'
  | 'sync-engine';

/**
 * 单一出口：setup soft-hint 优先级（最多一条）。
 * FirstRun 盖层 → 全让位；密钥 → 模型 → 本地密钥待同步。
 *
 * 产品策略：默认引擎 keep-alive，**不因短暂断连展示 engine-down**
 *（fetchEngineStatus 在 keep-alive 下会报 ok:true + reconnecting）。
 * engine-down 仅在 ok 明确 false（显式断开 / 未启动 keep-alive）时出现。
 */
export function resolveSetupHintKind(opts: {
  needsKeySetup: boolean;
  needsModelSetup?: boolean;
  /** engineHint.ok；null = 尚未探测（不当离线） */
  engineOk?: boolean | null;
  /** engineHint.hasApiKey；仅 ok===true 时有意义 */
  engineHasApiKey?: boolean | null;
  localHasKey?: boolean;
  firstRunOpen?: boolean;
}): SetupHintKind | null {
  if (opts.firstRunOpen) return null;
  // null = 探测中：不展示离线条（避免启动闪一下「引擎离线」）
  if (opts.engineOk === false) return 'engine-down';
  if (
    shouldShowNeedsKeySoftHint({
      needsKeySetup: opts.needsKeySetup,
      firstRunOpen: false,
      ...(opts.engineOk !== undefined && { engineOk: opts.engineOk }),
    })
  ) {
    return 'needs-key';
  }
  if (
    shouldShowNeedsModelSoftHint({
      needsModelSetup: Boolean(opts.needsModelSetup),
      firstRunOpen: false,
      ...(opts.needsKeySetup !== undefined && { needsKeySetup: opts.needsKeySetup }),
      ...(opts.engineOk !== undefined && { engineOk: opts.engineOk }),
    })
  ) {
    return 'needs-model';
  }
  // 引擎已通、引擎侧无密钥、本地已有密钥 → 引导同步（不与 key/model 叠）
  if (
    opts.engineOk === true &&
    opts.engineHasApiKey === false &&
    Boolean(opts.localHasKey)
  ) {
    return 'sync-engine';
  }
  return null;
}

/** 计划模式 ribbon 主行（slim）。 */
export function formatPlanModeRibbonLabel(planApproved: boolean): string {
  return planApproved ? '计划模式 · 已批准' : '计划模式 · 只规划';
}

/** 计划模式 aria-label（比主行稍完整）。 */
export function resolvePlanModeAriaLabel(planApproved: boolean): string {
  return planApproved ? '计划模式，已批准' : '计划模式，只规划不改文件';
}

/** 计划条 title：与批准态一致，避免已批准仍写「不改文件」。 */
export function resolvePlanModeTitle(planApproved: boolean): string {
  return planApproved
    ? '计划模式：已批准，可执行改动'
    : '计划模式：只规划不改文件';
}

/**
 * 已批准后隐藏「批准」动作，避免幽灵按钮再次把权限切回 ask。
 * 未批准时才展示。
 */
export function shouldShowPlanApproveAction(planApproved: boolean): boolean {
  return !planApproved;
}

/** slim 条默认截断长度（密度优先；完整 goal 走 title / aria）。 */
export const GOAL_RIBBON_PREVIEW_MAX_LEN = 28;

/** 目标文案截断：ellipsis 仅用于 ribbon 主行，完整 goal 走 title。 */
export function formatGoalRibbonPreview(
  goalText: string,
  maxLen = GOAL_RIBBON_PREVIEW_MAX_LEN,
): string {
  const t = (goalText || '').trim();
  if (!t) return '';
  const cap = Math.max(4, maxLen | 0);
  if (t.length <= cap) return t;
  return `${t.slice(0, cap)}…`;
}

/**
 * 目标 ribbon 主行文案（与 TasksCard 同源分数）。
 * 轮次 1-based；无清单时不拼 done/total。
 */
export function formatGoalRibbonLabel(opts: {
  goalText: string;
  goalIteration: number;
  goalTasksDone?: number;
  goalTasksTotal?: number;
}): string {
  const rawIter = Number(opts.goalIteration);
  const iteration = Math.max(0, Number.isFinite(rawIter) ? rawIter | 0 : 0);
  const rawDone = Number(opts.goalTasksDone ?? 0);
  const rawTotal = Number(opts.goalTasksTotal ?? 0);
  const done = Math.max(0, Number.isFinite(rawDone) ? rawDone | 0 : 0);
  const total = Math.max(0, Number.isFinite(rawTotal) ? rawTotal | 0 : 0);
  const preview = formatGoalRibbonPreview(opts.goalText);
  const parts = [`目标 · 第 ${iteration + 1} 轮`];
  if (total > 0) {
    parts.push(`${Math.min(done, total)}/${total}`);
  }
  if (preview) parts.push(preview);
  return parts.join(' · ');
}

/**
 * 目标 ribbon 可访问名：完整 goal（不截断），口语化进度。
 * 与主行截断预览解耦，避免 SR 读到省略号残句。
 */
export function resolveGoalRibbonAriaLabel(opts: {
  goalText: string;
  goalIteration: number;
  goalTasksDone?: number;
  goalTasksTotal?: number;
}): string {
  const rawIter = Number(opts.goalIteration);
  const iteration = Math.max(0, Number.isFinite(rawIter) ? rawIter | 0 : 0);
  const rawDone = Number(opts.goalTasksDone ?? 0);
  const rawTotal = Number(opts.goalTasksTotal ?? 0);
  const done = Math.max(0, Number.isFinite(rawDone) ? rawDone | 0 : 0);
  const total = Math.max(0, Number.isFinite(rawTotal) ? rawTotal | 0 : 0);
  const full = (opts.goalText || '').trim();
  const parts = [`目标模式，第 ${iteration + 1} 轮`];
  if (total > 0) {
    parts.push(`进度 ${Math.min(done, total)} 之 ${total}`);
  }
  if (full) parts.push(full);
  return parts.join('，');
}

/** 目标清单进度 0–1；无清单 / 非法 total 返回 null（不画进度条）。 */
export function goalRibbonProgressRatio(
  done: number,
  total: number,
): number | null {
  const rawT = Number(total);
  const t = Math.max(0, Number.isFinite(rawT) ? rawT | 0 : 0);
  if (t <= 0) return null;
  const rawD = Number(done);
  const d = Math.max(0, Number.isFinite(rawD) ? rawD | 0 : 0);
  return Math.min(1, d / t);
}

/** 进度条 width %；无清单返回 null。 */
export function goalRibbonProgressPercent(
  done: number,
  total: number,
): number | null {
  const ratio = goalRibbonProgressRatio(done, total);
  if (ratio == null) return null;
  return Math.round(ratio * 100);
}

/**
 * 引擎 soft-hint 文案（与 needs-key 语义分离：说引擎，不提密钥）。
 * 正式版 keep-alive 下极少展示；若仍出现，用「恢复中」而非恐吓「离线」。
 */
export function resolveEngineDownSoftHintText(opts: {
  onEmptySurface?: boolean;
}): string {
  if (opts.onEmptySurface) return '引擎连接恢复中…';
  return '引擎连接恢复中，请稍候';
}

/**
 * 本地密钥待同步 soft-hint 文案。
 * 空态短句；非空态点明「点模型名」操作路径。
 */
export function resolveSyncEngineSoftHintText(opts: {
  onEmptySurface?: boolean;
}): string {
  if (opts.onEmptySurface) return '本地密钥待同步到引擎';
  return '本地已有密钥，点击下方模型名称同步到引擎';
}

/** setup soft-hint 动作按钮：可见文案 + aria（四种互斥）。 */
export function resolveSetupHintAction(kind: SetupHintKind): {
  label: string;
  ariaLabel: string;
} {
  switch (kind) {
    case 'engine-down':
      // 进模型设置可查 endpoint / 连通性；不与「去配置密钥」混用文案
      return {
        label: '模型设置',
        ariaLabel: '打开模型设置检查引擎连接',
      };
    case 'needs-key':
      return { label: '去配置', ariaLabel: '去配置服务商密钥' };
    case 'needs-model':
      return { label: '填写模型', ariaLabel: '填写或选择模型' };
    case 'sync-engine':
      return { label: '选择模型', ariaLabel: '选择模型以同步到引擎' };
    default: {
      // 穷尽守卫：未知 kind 不渲染幽灵动作
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * run-notice 是否挂载：null / 空文案不渲染，防幽灵条。
 */
export function shouldRenderRunNotice(
  notice: RunNotice | null | undefined,
): boolean {
  if (notice == null) return false;
  return Boolean(String(notice.text ?? '').trim());
}

/** run-notice 可访问名：系统提示 + 正文。 */
export function resolveRunNoticeAriaLabel(text: string): string {
  const t = String(text ?? '').trim();
  if (!t) return '系统提示';
  return `系统提示：${t}`;
}

/**
 * run-notice 播报急迫度：错误类 assertive，其余 polite。
 */
export function resolveRunNoticeAriaLive(
  kind?: string | null,
): 'polite' | 'assertive' {
  const k = String(kind ?? '')
    .trim()
    .toLowerCase();
  if (k === 'error' || k === 'fail' || k === 'failed' || k === 'fatal') {
    return 'assertive';
  }
  return 'polite';
}

/**
 * 是否真正挂载 approval dock DOM。
 * 默认 show=false 防双渲染；count≤0 也不挂（空条无意义）。
 */
export function shouldRenderApprovalDock(
  showApprovalDock: boolean,
  pendingCount: number,
): boolean {
  if (!showApprovalDock) return false;
  const n = Math.max(0, Number.isFinite(Number(pendingCount)) ? pendingCount | 0 : 0);
  return n > 0;
}

/** dock 可见文案：优先完整 summary（approvalDockLabel），否则裸计数。 */
export function resolveApprovalDockLabelText(
  count: number,
  summary: string,
): string {
  const s = (summary || '').trim();
  if (s) return s;
  const n = Math.max(0, Number.isFinite(Number(count)) ? count | 0 : 0);
  if (n <= 0) return '待审批';
  return `${n} 待审批`;
}

/** dock 可访问名：优先完整 summary，否则计数（比 label 更口语）。 */
export function resolveApprovalDockAriaLabel(
  count: number,
  summary: string,
): string {
  const s = (summary || '').trim();
  if (s) return s;
  const n = Math.max(0, Number.isFinite(Number(count)) ? count | 0 : 0);
  if (n <= 0) return '待确认项';
  return `${n} 项等待确认`;
}
