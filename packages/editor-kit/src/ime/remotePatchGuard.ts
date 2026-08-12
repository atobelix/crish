/**
 * remotePatchGuard：合成中远端 / Agent 同块补丁决策（A-IME-06 语义子集）。
 *
 * 对齐：
 * - A-IME-06：合成中远端/Agent 改同块 → **暂缓**或 end 后合并；**禁止**默认整页 remount
 * - A-IME-02 交叉：同块结构 op 在 composing 期间拒绝（不静默拆块）
 *
 * 轨：**W6-B 方向** L1 语义自动化一格（🟨）；**≠** WebView L2 e2e；
 * **≠** 叶子核锁定；**≠** EL 关闭。真实 collab / Agent 接线属宿主；本模块纯决策可测。
 */

import type { BlockId } from '@crish/block-paper-contract';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 远端 / Agent 补丁种类（语义 stub，不绑真实 RS/Yjs/Agent 运行时）。
 * - `text_edit`：同块或异块文本增量
 * - `structure_op`：结构变换（拆/并/转/移…）
 * - `full_remount`：整页 / 整树 remount 请求（AppFlowy 反例路径）
 */
export type ImeRemotePatchKind = 'text_edit' | 'structure_op' | 'full_remount';

/** 补丁来源标签（可观测；决策不依赖 origin 分支，仅便于宿主日志） */
export type ImeRemotePatchOrigin = 'agent' | 'remote' | 'local';

/** 单条远端/Agent 补丁描述 */
export type ImeRemotePatch = {
  kind: ImeRemotePatchKind;
  /** 目标块；`full_remount` 可省略（作用于整文档） */
  blockId?: BlockId;
  origin?: ImeRemotePatchOrigin;
  /** 透传载荷（stub；本守卫不解释） */
  payload?: unknown;
};

/** A-IME-06 钉死合并策略：同块 text 暂缓至 end；结构拒；禁 full remount */
export type ImeRemoteMergeStrategy = 'defer_same_block_until_end';

/** 程序可读钉死常量（与矩阵 / 文档一致） */
export const IME_REMOTE_MERGE_STRATEGY: ImeRemoteMergeStrategy =
  'defer_same_block_until_end';

/** 拒绝码（composing 路径） */
export type ImeRemotePatchRejectCode =
  'composing_remote_structure' | 'composing_forbid_full_remount';

/**
 * 决策结果：
 * - `apply`：可立即下发（idle 或异块）
 * - `defer`：暂缓至 composition end 后合并
 * - `reject`：拒绝（同块结构 / full remount）
 */
export type ImeRemotePatchDecision =
  | {
      action: 'apply';
      reason: string;
      strategy: ImeRemoteMergeStrategy;
    }
  | {
      action: 'defer';
      reason: string;
      strategy: ImeRemoteMergeStrategy;
    }
  | {
      action: 'reject';
      code: ImeRemotePatchRejectCode;
      reason: string;
      strategy: ImeRemoteMergeStrategy;
    };

// ---------------------------------------------------------------------------
// 纯决策
// ---------------------------------------------------------------------------

/**
 * 合成中远端/Agent 补丁决策（无副作用）。
 *
 * @param composing 当前是否 composing
 * @param composingBlockId 合成块；idle 时 null
 * @param patch 远端/Agent 补丁
 *
 * 规则（A-IME-06）：
 * 1. idle → 一律 `apply`（含 full_remount；是否真 remount 由宿主决定）
 * 2. composing + `full_remount` → **reject**（禁止默认整页 remount）
 * 3. composing + 同块 `structure_op` → **reject**（不在合成中拆块）
 * 4. composing + 同块 `text_edit` → **defer**（end 后合并）
 * 5. composing + 异块（或无 blockId 的非 remount）→ **apply**
 */
export function decideRemotePatch(
  composing: boolean,
  composingBlockId: BlockId | null,
  patch: ImeRemotePatch
): ImeRemotePatchDecision {
  const strategy = IME_REMOTE_MERGE_STRATEGY;

  if (!composing || composingBlockId == null) {
    return {
      action: 'apply',
      reason: 'IME idle：远端/Agent 补丁可立即合并（A-IME-06）',
      strategy,
    };
  }

  // 规则 2：合成中禁止默认整页 remount
  if (patch.kind === 'full_remount') {
    return {
      action: 'reject',
      code: 'composing_forbid_full_remount',
      reason: 'IME composing：禁止远端/Agent 默认整页 remount（A-IME-06）',
      strategy,
    };
  }

  const targetsComposing =
    patch.blockId != null && patch.blockId === composingBlockId;

  if (!targetsComposing) {
    return {
      action: 'apply',
      reason: 'IME composing：异块远端/Agent 补丁放行（A-IME-06）',
      strategy,
    };
  }

  // 同块
  if (patch.kind === 'structure_op') {
    return {
      action: 'reject',
      code: 'composing_remote_structure',
      reason:
        'IME composing：禁止远端/Agent 同块结构 op（A-IME-06 / A-IME-02 交叉）',
      strategy,
    };
  }

  // text_edit 同块 → 暂缓
  return {
    action: 'defer',
    reason: 'IME composing：同块远端/Agent 文本暂缓，end 后合并（A-IME-06）',
    strategy,
  };
}
