/**
 * A-INV-02 镜像漂移 UI 方向 · 纯类型与 X-05 决策（桌面子集）
 *
 * ## 轨 / 诚实边界（钉死）
 * - **包方向**：A-INV-02 / W2-E 产品可点 UI **方向子集**（状态展示 + 三路入口骨架）
 * - 底层检测来源可能是 **poll**（`MirrorWatcher`）或 **OS 事件**（`MirrorOsWatcher`）
 *   再调 `detect_mirror_drift`；本模块 **只消费报告**，**不**实现 poll/inotify。
 * - **≠ inotify / FSEvents 产品满关**（有状态条 ≠ OS watcher 生产全链路）
 * - **≠ A-INV-02 全产品满关**（无对话框产品化全链 / 无 apply 落盘；IPC 见 `noteMirrorIpc`）
 * - **≠ EL-03**（大文档存活 / 热集内存叙事属他包；本 UI **禁止** 假关 EL-03）
 * - **X-05**：有 unpushed 时 **禁止** 默认 `DropUnacked` 静默盖写；须用户显式确认丢弃
 * - **CONN-E**：detect/import 产品 IPC 可点名；三路经 `mirrorThreeWayBridge` 提交
 * - **诚实未做**：timer poll 与 OS watcher **双开** debounce
 * - 产品空态默认 **无** report / **不**挂条；CONN-E2 经 EmptyState
 *   `showMirrorDriftBar` / `mirrorDriftReport` **opt-in** 装配
 *
 * 对齐 store：`crates/conex-workspace-store/src/mirror.rs` 的
 * `MirrorDriftClass` / `ThreeWayStrategy` / `import_mirror_proposal` 语义（前端镜像命名）。
 */

// ---------------------------------------------------------------------------
// 与 store 对齐的枚举（camelCase wire 友好；语义不可缩）
// ---------------------------------------------------------------------------

/** detect 输出的漂移分类（对齐 MirrorDriftClass） */
export type MirrorDriftClass =
  | 'none'
  | 'mirror_only'
  | 'authority_only'
  | 'both'
  | 'no_meta'
  | 'missing_file';

/**
 * 三路策略（对齐 ThreeWayStrategy）。
 * 须由调用方 **显式** 选择；**禁止** 在 unpushed>0 时默认 DropUnacked。
 */
export type ThreeWayStrategy =
  'retain_local_and_reimport' | 'drop_unacked' | 'conflict_blocks';

/**
 * 漂移报告快照（UI 只读消费；可由 mock / 未来 IPC 注入）。
 * 字段对齐 `MirrorDriftReport` 子集。
 */
export type MirrorDriftReportView = {
  docId: string;
  class: MirrorDriftClass;
  /** mirror 文件路径展示（可空） */
  path?: string;
  lastExportRev?: number;
  authorityRev?: number;
  pendingLag?: number;
  mirrorChanged?: boolean;
  authorityChanged?: boolean;
  fileExists?: boolean;
};

/**
 * 检测/唤醒来源（诚实标注；**不**冒充 inotify 满关）。
 * - `poll`：上层 timer / MirrorWatcher 轮询
 * - `os_event`：OS FS 事件 hint（notify）后再 detect
 * - `injected`：单测或手动注入报告
 * - `unknown`：未声明
 */
export type MirrorWatchSource = 'poll' | 'os_event' | 'injected' | 'unknown';

/** 用户在状态条上点的动作（三路入口） */
export type MirrorThreeWayAction =
  /** 接受 mirror 侧（提案路径；X-05 门禁后映射策略） */
  | 'accept_mirror'
  /** 保留文档权威侧，忽略本次 mirror 漂移（不 import） */
  | 'keep_doc'
  /** 标记冲突，不自动 apply */
  | 'mark_conflict';

/** 决策结果：可提交策略 / 仅本地 keep / 被 X-05 挡住 */
export type ThreeWayDecision =
  | {
      ok: true;
      action: MirrorThreeWayAction;
      /** 映射到 store ThreeWayStrategy；keep_doc 无 strategy */
      strategy: ThreeWayStrategy | null;
      /** keep_doc 不调用 import_mirror_proposal */
      callsImport: boolean;
      /** 是否声明将丢弃 unpushed（仅显式 DropUnacked） */
      discardsUnpushed: boolean;
    }
  | {
      ok: false;
      action: MirrorThreeWayAction;
      code: 'x05_silent_drop_blocked' | 'no_drift' | 'unknown_action';
      reason: string;
    };

export type ResolveThreeWayOpts = {
  /** 未推送 / 未 ACK 本地 op 数；>0 时禁静默 DropUnacked（X-05） */
  unpushedOpCount: number;
  /**
   * 用户是否 **显式** 确认丢弃 unpushed。
   * 仅当 `true` 时 accept_mirror 可映射 DropUnacked；默认 false。
   * **禁止** UI 默认传 true。
   */
  confirmDiscardUnpushed?: boolean;
  /** 当前漂移分类；无漂移时 accept 可拒 */
  driftClass?: MirrorDriftClass;
};

// ---------------------------------------------------------------------------
// 文案 / 可观测
// ---------------------------------------------------------------------------

export const MIRROR_DRIFT_CLASS_LABEL: Record<MirrorDriftClass, string> = {
  none: '无漂移',
  mirror_only: '仅镜像变',
  authority_only: '仅权威变',
  both: '双变',
  no_meta: '无镜像元数据',
  missing_file: '镜像文件缺失',
};

export const MIRROR_WATCH_SOURCE_LABEL: Record<MirrorWatchSource, string> = {
  poll: 'poll',
  os_event: 'os-event',
  injected: 'injected',
  unknown: 'unknown',
};

export const THREE_WAY_ACTION_LABEL: Record<MirrorThreeWayAction, string> = {
  accept_mirror: '接受镜像',
  keep_doc: '保留文档',
  mark_conflict: '标记冲突',
};

/** 产品诚实脚注（UI 可展示；≠ 关 EL-03） */
export const MIRROR_DRIFT_UI_HONESTY =
  '底层可能仍是 poll 或 OS 事件 hint → detect；≠ inotify 产品满关；≠ EL-03；≠ A-INV-02 全关';

/** 包方向 ID（调度/DOM 锚；**不是** 09 官方关包号） */
export const A_INV_02_UI_DIRECTION_ID = 'A-INV-02-UI' as const;

// ---------------------------------------------------------------------------
// 决策（X-05）
// ---------------------------------------------------------------------------

/**
 * 将三路 UI 动作解析为可安全提交的策略。
 *
 * X-05 铁律：
 * - unpushed>0 且用户点「接受镜像」但 **未** 显式 confirmDiscardUnpushed
 *   → **拒绝**（禁止默认 DropUnacked 静默盖写）
 * - unpushed=0 时 accept → `retain_local_and_reimport`（候选补丁；仍不直接 apply）
 * - unpushed>0 + 显式确认 → `drop_unacked`（唯一允许丢弃路径）
 * - keep_doc → 不调 import
 * - mark_conflict → `conflict_blocks`
 */
export function resolveThreeWayAction(
  action: MirrorThreeWayAction,
  opts: ResolveThreeWayOpts
): ThreeWayDecision {
  const unpushed = Math.max(0, opts.unpushedOpCount | 0);
  const confirmDrop = opts.confirmDiscardUnpushed === true;
  const cls = opts.driftClass;

  if (cls === 'none' || cls === 'authority_only' || cls === 'no_meta') {
    if (action === 'accept_mirror') {
      return {
        ok: false,
        action,
        code: 'no_drift',
        reason: '当前无镜像侧可导入漂移（none / authority_only / no_meta）',
      };
    }
  }

  switch (action) {
    case 'keep_doc':
      return {
        ok: true,
        action,
        strategy: null,
        callsImport: false,
        discardsUnpushed: false,
      };

    case 'mark_conflict':
      return {
        ok: true,
        action,
        strategy: 'conflict_blocks',
        callsImport: true,
        discardsUnpushed: false,
      };

    case 'accept_mirror': {
      if (unpushed > 0 && !confirmDrop) {
        return {
          ok: false,
          action,
          code: 'x05_silent_drop_blocked',
          reason: `存在 ${unpushed} 条 unpushed op；拒绝静默 DropUnacked。须显式确认丢弃，或先 keep_doc / mark_conflict`,
        };
      }
      if (unpushed > 0 && confirmDrop) {
        return {
          ok: true,
          action,
          strategy: 'drop_unacked',
          callsImport: true,
          discardsUnpushed: true,
        };
      }
      // unpushed === 0：候选 reimport，不声明丢弃
      return {
        ok: true,
        action,
        strategy: 'retain_local_and_reimport',
        callsImport: true,
        discardsUnpushed: false,
      };
    }

    default:
      return {
        ok: false,
        action,
        code: 'unknown_action',
        reason: `未知三路动作: ${String(action)}`,
      };
  }
}

/** 是否应展示三路操作入口（有可处理漂移） */
export function shouldShowThreeWayActions(
  cls: MirrorDriftClass | undefined | null
): boolean {
  if (!cls) return false;
  return cls === 'mirror_only' || cls === 'both' || cls === 'missing_file';
}

/** 漂移是否「需要用户注意」（状态条高亮） */
export function isDriftAttention(
  cls: MirrorDriftClass | undefined | null
): boolean {
  if (!cls) return false;
  return cls !== 'none' && cls !== 'authority_only';
}

/**
 * 构造最小可测报告（单测 / 注入）。
 */
export function makeMirrorDriftReportView(
  partial: Partial<MirrorDriftReportView> &
    Pick<MirrorDriftReportView, 'docId' | 'class'>
): MirrorDriftReportView {
  return {
    lastExportRev: 0,
    authorityRev: 0,
    pendingLag: 0,
    mirrorChanged: partial.class === 'mirror_only' || partial.class === 'both',
    authorityChanged:
      partial.class === 'authority_only' || partial.class === 'both',
    fileExists: partial.class !== 'missing_file',
    ...partial,
  };
}
