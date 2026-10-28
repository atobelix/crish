/**
 * 主对话审批 UI 策略（与 toast 策略一致：UI 状态即反馈，不弹成功 toast）。
 *
 * - 单条主时间线 pending → 仅内联 ApprovalAskCard，隐藏底部 dock（避免双份）
 * - 主时间线多条，或子 agent 有 pending → 显示 dock 作队列/跳转
 * - 按 toolCallId 去重：同一审批只计一次（防双消息残留双算）
 * - 操作允许/拒绝/记住：卡片消失即反馈，禁止成功 toast
 */

export type ApprovalPendingCounts = {
  /** 主会话消息上的 pending 数（去重后） */
  mainCount: number;
  /** 协作/子 agent 消息上的 pending 数（去重后） */
  agentCount: number;
};

export type PendingApprovalRef = {
  toolId: string;
  msgId: string;
  bucket: 'main' | 'agent';
  summary?: string;
};

/** UI 通道：none | 仅内联 | 底部 dock（与内联并存于队列场景） */
export type ApprovalRenderMode = 'none' | 'inline-only' | 'dock';

/** 调用方可一次取齐的 UI 决策（避免 mode/dock 各算各的漂移） */
export type ApprovalUiPlan = {
  mode: ApprovalRenderMode;
  /** 是否挂底部 dock（已钳「单条主列」；false 时仅靠内联卡） */
  showDock: boolean;
  /** 单条主列仅内联（dock 必须关） */
  inlineOnly: boolean;
  total: number;
  mainCount: number;
  agentCount: number;
};

type ApprovalMsgLike =
  | {
      id?: string;
      toolCalls?: ReadonlyArray<
        | {
            id?: string;
            status?: string;
            name?: string;
            explanation?: string;
          }
        | null
        | undefined
      > | null;
    }
  | null
  | undefined;

/** 将计数钳到非负整数，避免 NaN/负数/Infinity 导致 dock 误显 */
export function clampApprovalCounts(
  c: ApprovalPendingCounts
): ApprovalPendingCounts {
  const clamp = (n: number) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  };
  return { mainCount: clamp(c.mainCount), agentCount: clamp(c.agentCount) };
}

/**
 * 扫描消息列表中的 pending 审批；同一 toolId 只保留首次出现。
 * 主时间线先扫、子 agent 后扫——同 id 归主列，避免 dock 与内联双算。
 * 避免乐观更新 + 流式双写导致 dock 与内联卡「双份感」。
 * 容忍 null/undefined 消息与 toolCall 条目（流式半包）。
 */
export function collectPendingApprovals(
  mainMessages: ReadonlyArray<ApprovalMsgLike> | null | undefined,
  agentMessagesLists:
    | ReadonlyArray<ReadonlyArray<ApprovalMsgLike> | null | undefined>
    | null
    | undefined = []
): {
  counts: ApprovalPendingCounts;
  first: PendingApprovalRef | null;
  uniqueToolIds: string[];
} {
  const seen = new Set<string>();
  let mainCount = 0;
  let agentCount = 0;
  let first: PendingApprovalRef | null = null;
  const uniqueToolIds: string[] = [];

  const scan = (
    msgs: ReadonlyArray<ApprovalMsgLike> | null | undefined,
    bucket: 'main' | 'agent'
  ) => {
    if (!msgs) return;
    for (const m of msgs) {
      if (!m?.toolCalls) continue;
      for (const tc of m.toolCalls) {
        if (!tc || tc.status !== 'pending_approval') continue;
        const id = String(tc.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        uniqueToolIds.push(id);
        if (bucket === 'main') mainCount += 1;
        else agentCount += 1;
        if (!first) {
          const summary = (tc.explanation || tc.name || '').trim() || undefined;
          first = {
            toolId: id,
            msgId: String(m.id || '').trim() || id,
            bucket,
            ...(summary !== undefined && { summary }),
          };
        }
      }
    }
  };

  scan(mainMessages, 'main');
  for (const list of agentMessagesLists || []) {
    scan(list, 'agent');
  }

  return {
    counts: clampApprovalCounts({ mainCount, agentCount }),
    first,
    uniqueToolIds,
  };
}

export function totalPendingApproval(c: ApprovalPendingCounts): number {
  const { mainCount, agentCount } = clampApprovalCounts(c);
  return mainCount + agentCount;
}

/**
 * 统一渲染模式：单条主时间线 → inline-only（禁止 dock 双渲染）。
 */
export function approvalRenderMode(
  c: ApprovalPendingCounts
): ApprovalRenderMode {
  const { mainCount, agentCount } = clampApprovalCounts(c);
  if (mainCount + agentCount <= 0) return 'none';
  // 单条且已在主时间线 → 只靠内联卡（dock 再出现 = 双渲染）
  if (mainCount === 1 && agentCount === 0) return 'inline-only';
  return 'dock';
}

/**
 * 是否显示底部审批 dock。
 * false 时用户只看时间线内联卡（单条主列场景）—— 禁止单条双渲染。
 */
export function shouldShowApprovalDock(c: ApprovalPendingCounts): boolean {
  return approvalRenderMode(c) === 'dock';
}

/**
 * 单条主时间线是否应隐藏任何 sticky/dock 审批壳（仅内联）。
 */
export function isSingleMainTimelineApproval(
  c: ApprovalPendingCounts
): boolean {
  return approvalRenderMode(c) === 'inline-only';
}

/**
 * ChatCard / Ribbons 最终是否挂 dock。
 * 在 shouldShowApprovalDock 之上再钳一次「单条主列」与 total≤0，
 * 防止 counts 公式漂移时 dock 与内联 ApprovalAskCard 双份。
 */
export function resolveApprovalDockVisible(c: ApprovalPendingCounts): boolean {
  const counts = clampApprovalCounts(c);
  // 无 pending：永不挂 dock
  if (counts.mainCount + counts.agentCount <= 0) return false;
  // 单条主时间线：强制隐藏（即使未来 mode 公式改错也不双 dock）
  if (counts.mainCount === 1 && counts.agentCount === 0) return false;
  return shouldShowApprovalDock(counts);
}

/**
 * 一次算出 mode / showDock / inlineOnly，供 ChatCard 与测试共用。
 * 契约：inlineOnly ⇒ !showDock；none ⇒ !showDock。
 */
export function planApprovalUi(c: ApprovalPendingCounts): ApprovalUiPlan {
  const counts = clampApprovalCounts(c);
  const mode = approvalRenderMode(counts);
  const total = counts.mainCount + counts.agentCount;
  const showDock = resolveApprovalDockVisible(counts);
  return {
    mode,
    showDock,
    inlineOnly: mode === 'inline-only',
    total,
    mainCount: counts.mainCount,
    agentCount: counts.agentCount,
  };
}

/**
 * 不变量：inline-only 时不得 show dock；none 时两者皆关。
 * 供测试与调用方防御校验（含 plan ↔ legacy shouldShow 对齐）。
 */
export function assertApprovalUiNoDoubleRender(
  c: ApprovalPendingCounts
): boolean {
  const plan = planApprovalUi(c);
  const dockLegacy = shouldShowApprovalDock(c);
  // 核心：showDock 仅当 mode===dock；且与 legacy / resolve 一致
  if (plan.showDock !== (plan.mode === 'dock')) return false;
  if (plan.showDock !== dockLegacy) return false;
  if (plan.inlineOnly !== (plan.mode === 'inline-only')) return false;

  if (plan.mode === 'none') {
    return !plan.showDock && !plan.inlineOnly && plan.total === 0;
  }
  if (plan.mode === 'inline-only') {
    // 单条不双 dock：必须 showDock=false 且恰 1 主 0 协作
    return (
      !plan.showDock &&
      plan.inlineOnly &&
      plan.mainCount === 1 &&
      plan.agentCount === 0 &&
      plan.total === 1
    );
  }
  // dock 模式：showDock、非 single、total≥1（多主或含协作）
  return (
    plan.showDock &&
    !plan.inlineOnly &&
    plan.total >= 1 &&
    !(plan.mainCount === 1 && plan.agentCount === 0)
  );
}

/** dock 文案：队列 vs 子任务跳转，避免「待审批」 alone 含糊 */
export function approvalDockLabel(
  c: ApprovalPendingCounts,
  summary?: string
): string {
  const counts = clampApprovalCounts(c);
  const total = totalPendingApproval(counts);
  if (total <= 0) return '';
  // 单条主时间线 dock 本应隐藏；仍生成裸计数供调试，不含「队列」误导
  const bits: string[] = [`${total} 待审批`];
  if (counts.agentCount > 0 && counts.mainCount === 0) {
    bits.push('协作任务');
  } else if (
    counts.mainCount > 1 ||
    (counts.mainCount > 0 && counts.agentCount > 0)
  ) {
    bits.push('队列');
  }
  const s = (summary || '').trim();
  if (s) bits.push(s);
  return bits.join(' · ');
}

// ─── 二次确认（ApprovalAskCard）纯逻辑 ───────────────────────────

/** 允许按钮阶段：idle →（高风险）armed → commit */
export type AllowConfirmPhase = 'idle' | 'armed' | 'commit';

/**
 * 点击「允许 / 允许并记住」后的下一阶段。
 * needsDouble=false 时一次即 commit；true 时须先 arm 再 commit。
 */
export function nextAllowConfirmPhase(
  needsDouble: boolean,
  armed: boolean
): AllowConfirmPhase {
  if (!needsDouble) return 'commit';
  if (!armed) return 'armed';
  return 'commit';
}

/**
 * 是否应解除「再次确认」武装。
 * toolId 切换或后端不再要求二次确认时，禁止残留 is-confirm-armed。
 */
export function shouldResetAllowConfirmArmed(opts: {
  confirmArmed: boolean;
  needsDouble: boolean;
  prevToolId?: string | null;
  nextToolId?: string | null;
}): boolean {
  if (!opts.confirmArmed) return false;
  if (!opts.needsDouble) return true;
  const prev = String(opts.prevToolId || '').trim();
  const next = String(opts.nextToolId || '').trim();
  return prev !== next;
}

/** 允许按钮可见文案（与二次确认状态对齐） */
export function allowButtonLabel(needsDouble: boolean, armed: boolean): string {
  if (needsDouble && !armed) return '允许…';
  if (needsDouble && armed) return '再次确认允许';
  return '允许';
}

/**
 * 把技术摘要收成用户能懂的一句话（ApprovalAskCard 主标题）。
 * summary 优先为人话；否则按读写/删/git/包管理等启发式归类。
 */
export function plainApprovalQuestion(summary: string, cmd?: string): string {
  const s = (summary || '').trim();
  const c = (cmd || '').trim();
  // summary 已是人话时，直接问「是否允许…」
  if (/[\u4e00-\u9fff]/.test(s) && s.length <= 56 && !/^[\w./\\-]+$/.test(s)) {
    if (/^是否允许/.test(s)) return s;
    if (
      /正在|查看|修改|搜索|运行|安装|构建|列出|浏览|执行|启动|切换|推送|拉取|暂存|贮藏|创建|克隆|配置|发布|还原|回退|重置|请求|连接|传输|管理|查询|应用|进入|删除|复制|移动|格式化|检查|获取|操作|通过|处理|添加|卸载|编译|刷新|更新/.test(
        s
      )
    ) {
      return `是否允许：${s.replace(/^正在/, '')}？`.replace(/？？$/, '？');
    }
  }
  if (/读|查看|read/i.test(s) && !/写|删|edit|write|rm|修改/i.test(s)) {
    return '是否允许查看相关文件或信息？';
  }
  if (/写|编辑|修改|edit|write|patch/i.test(s)) {
    return '是否允许修改项目中的文件？';
  }
  if (/删|rm |remove|delete/i.test(s) || /删|rm |delete/i.test(c)) {
    return '是否允许删除文件或执行有风险的清理？';
  }
  if (/git |push|commit/i.test(c) || /Git|git/i.test(s)) {
    return '是否允许执行 Git 相关操作？';
  }
  if (
    /kubectl |aws |ssh |chmod |dotnet |cmake |make /i.test(c) ||
    /Kubernetes|AWS|SSH|权限|\.NET|CMake|Make/i.test(s)
  ) {
    return '是否允许执行系统或云资源相关操作？';
  }
  if (
    /npm |pnpm |yarn |bun |pip |cargo |go |composer |安装|构建/i.test(c + s)
  ) {
    return '是否允许运行安装或构建类命令？';
  }
  if (c) {
    return '是否允许运行下面这条命令？';
  }
  return '是否允许继续这项操作？';
}

// ─── 风险元数据展示（卡片 chips；只展示后端事实） ────────────────

export type ApprovalRiskChip = {
  key: string;
  label: string;
  tone: 'neutral' | 'warn' | 'danger' | 'info';
};

/**
 * 从后端风险字段生成卡片 chips（不猜工具名）。
 * 空输入 → []。
 */
export function buildApprovalRiskChips(
  meta:
    | {
        trustZone?: string;
        risk?: string;
        riskLevel?: string;
        requiresDoubleConfirm?: boolean;
        recommendSnapshot?: boolean;
      }
    | null
    | undefined
): ApprovalRiskChip[] {
  if (!meta) return [];
  const chips: ApprovalRiskChip[] = [];
  const zone = (meta.trustZone || '').trim().toUpperCase();
  if (zone) {
    chips.push({
      key: 'zone',
      label: zone,
      tone:
        zone === 'T4' || zone === 'T3'
          ? 'danger'
          : zone === 'T1' || zone === 'T2'
            ? 'warn'
            : 'neutral',
    });
  }
  const risk = (meta.risk || '').trim();
  if (
    risk &&
    risk.toLowerCase() !== zone.toLowerCase() &&
    !chips.some((c) => c.label.toLowerCase() === risk.toLowerCase())
  ) {
    chips.push({
      key: 'risk',
      label: risk,
      tone: /hardline|destructive|critical|secret/i.test(risk)
        ? 'danger'
        : 'warn',
    });
  }
  const level = (meta.riskLevel || '').trim().toLowerCase();
  if (
    level &&
    level !== 'unknown' &&
    !chips.some((c) => c.label.toLowerCase() === level)
  ) {
    chips.push({
      key: 'level',
      label: level,
      tone:
        level === 'critical' || level === 'high'
          ? 'danger'
          : level === 'medium'
            ? 'warn'
            : 'info',
    });
  }
  if (meta.requiresDoubleConfirm) {
    chips.push({ key: 'double', label: '需二次确认', tone: 'danger' });
  }
  if (meta.recommendSnapshot) {
    chips.push({ key: 'snap', label: '建议快照', tone: 'info' });
  }
  return chips;
}

/**
 * 审批卡 className（elevated / confirm-armed）。
 * 集中拼接，避免组件与 CSS 契约漂移。
 */
export function approvalCardClassName(opts: {
  needsDouble?: boolean;
  confirmArmed?: boolean;
}): string {
  const parts = ['approval-card'];
  if (opts.needsDouble) parts.push('approval-card--elevated');
  if (opts.confirmArmed) parts.push('is-confirm-armed');
  return parts.join(' ');
}
