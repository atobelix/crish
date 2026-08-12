/**
 * WorkspaceEmptyState — 工作区空态装配壳（SD-30）
 *
 * ## SD-30 切开（目标 &lt;400）
 * - mirror 槽 → `workspaceEmptyStateMirrorSlot`
 * - paper 入口 → `workspaceEmptyStatePaperEntry`（写锥 + Strict / Skeleton 宿主）
 * - actions → `workspaceEmptyStateActions`
 * 本文件仅装配壳：公开 props / 默认关钉死 / 开合编排。
 *
 * ## 产品默认（W5-B 产品入口）
 * - 默认倾向 **Strict**：可点打开 `NotePaperStrictPanel` +
 *   `createProductStrictHydrateTransport`（Tauri→tauri-ipc / 无 Tauri→fixture）
 * - **W5-B-S Skeleton** 预览壳入口 **保留**（`open-note-paper-preview`）
 * - **CONN-B / B3 slash 写锥**：`resolveProductStrictApplyOps` —
 *   显式 applyOps / sink / note_apply_ops IPC / Tauri → 可写；
 *   **无后端 → 只读 catalog**（禁止假写路径）
 * - **CONN-D2 mdPrefix 写锥**：同 apply 解析；无后端 → disabled
 * - **CONN-E2 mirror 条**：默认 **不** 挂；opt-in 才装配
 * - **CONN-E3 detect 调度**：默认 **不** 调 detect
 *   （`enableMirrorDetectSchedule` **默认 false**；E2′ 只改宿主）
 * - **CONN-C2 PaperList**：默认 **不** 挂（`enableProductPaperList` **默认 false**）
 *
 * ## 诚实边界
 * - **可演示 ≠ EL-01 / EL-08 关闭**；**≠ 打开完成**
 * - fixture ≠ 生产权威；无 Tauri 回退 fixture **不是** 伪装 tauri-ipc
 * - 禁止去 `-S` 冒充 Strict；**≠ EL-01/03**；**≠** 重做 E2′ 宿主
 * - detect / PaperList **仅** opt-in；关时无 timer / 不双内容
 */

import React, { useState } from 'react';
import type {
  ApplyOpsAdapter,
  IntentSink,
  TurnIntoSink,
} from '@crish/block-paper';
import type { NoteApplyOpsIpc } from '../../api/noteApplyOpsIpc';
import type { NoteMirrorIpc } from '../../api/noteMirrorIpc';
import type { NoteHydrateTransport } from '../note-paper/hydrateProjection';
import type { CreateProductStrictSlashBindingOptions } from '../note-paper/productSlashSink';
import type {
  MirrorDriftReportView,
  MirrorWatchSource,
  ThreeWayDecision,
} from '../note-paper/mirrorDriftUi';
import { W5B_PRODUCT_DEFAULT_EMPTY_TRACK } from '../note-paper/w5bStrict';
import { WorkspaceEmptyStateLanding } from './workspaceEmptyStateActions';
import { useWorkspaceEmptyStateMirrorSlot } from './workspaceEmptyStateMirrorSlot';
import {
  buildPaperWriteConeDataAttrs,
  EMPTY_STATE_PAPER_HONESTY_ATTRS,
  useWorkspaceEmptyStatePaperBindings,
  WorkspaceEmptyStateSkeletonHost,
  WorkspaceEmptyStateStrictHost,
} from './workspaceEmptyStatePaperEntry';
import styles from './WorkspaceEmptyState.module.css';

/** 空态可打开的笔记纸面轨（双轨并存） */
export type NotePaperEmptyOpenMode = 'strict' | 'skeleton';

export type WorkspaceEmptyStateProps = {
  wsId: string;
  onActivate?: () => void;
  /**
   * 空态默认倾向轨（主 CTA）。
   * - 默认 `strict`（`W5B_PRODUCT_DEFAULT_EMPTY_TRACK`）：产品演示路径
   * - `skeleton`：主 CTA 突出预览壳（旧主路径；测/回退）
   * **两轨入口均保留**；本 prop 只影响主次与默认高亮，不删 Skeleton。
   *
   * 诚实：Strict 默认 hydrate 见 `createProductStrictHydrateTransport`
   * （可检测 Tauri → tauri-ipc；无 Tauri → fixture）；**可演示 ≠ EL**；
   * **≠ 打开完成**；后端默认 `hydrate_path=doc-session` 仍 **≠ EL-01/04/08**。
   */
  preferredNotePaperTrack?: NotePaperEmptyOpenMode;
  /**
   * 可选注入 Strict hydrate 通路（测 / mock / 自定义）。
   * 未注入时使用 `createProductStrictHydrateTransport`：
   * 可检测 Tauri → `tauri-ipc`；无 Tauri → fixture 演示（**≠ 生产权威**）。
   */
  strictHydrateTransport?: NoteHydrateTransport;
  /**
   * CONN-B / CONN-D2 / CONN-B3：可选注入真 apply 适配器（DocSession::apply / IPC 等价）。
   * 有值 → slash 可写 collab + MD 前缀 provisional turn_into 可写（source=injected-applyOps）。
   * 无值时走 `resolveProductStrictApplyOps`：
   *   可检测 Tauri / 显式 `strictApplyOpsIpc` → product-ipc；
   *   **无 Tauri 且无 IPC → 只读**（禁止静默 mock 可写）。
   * **≠ EL-01**；**≠ A-BLK-02/08/09 e2e**；桌面接线 ≠ 打开完成。
   */
  strictApplyOps?: ApplyOpsAdapter;
  /**
   * CONN-B3：可选注入 `note_apply_ops` IPC（mock 测 / 自定义后端）。
   * 优先于默认 Tauri 探测；**无 Tauri 时仅本 prop 可显式打开 product-ipc 写路径**。
   * **禁止** 空态默认隐式 mock。
   */
  strictApplyOpsIpc?: NoteApplyOpsIpc;
  /**
   * 可选直接注入 Intent sink（优先于 `strictApplyOps` 的 slash 通道）。
   * 测/高级宿主；生产形状应优先 applyOps + collab 工厂。
   */
  slashIntentSink?: IntentSink;
  /**
   * 可选直接注入 TurnInto sink（优先于 `strictApplyOps` 的 MD 前缀通道）。
   * CONN-D2；与 slash **分通道**。
   */
  turnIntoSink?: TurnIntoSink;
  /**
   * 透传 collab wire 选项（allocateId / resolveOrder 等）。
   * 仅当走 applyOps 路径时生效。
   */
  strictSlashWireOptions?: Omit<
    CreateProductStrictSlashBindingOptions,
    'applyOps' | 'slashIntentSink' | 'sourceLabel'
  >;
  /**
   * CONN-E2：显式 opt-in 装配 `MirrorDriftStatusBar`（默认 **关**，避免空态噪声）。
   * - `true` → 打开 Strict 时挂条（无 report 时 idle「未检测」，**不**强制假数据）
   * - 省略 / `false` → 仅当 `mirrorDriftReport != null` 时才挂（与 Strict 一致）
   * - **≠ EL-03**；**≠ inotify 满关**；**≠** 默认自动 poll+OS 双开
   */
  showMirrorDriftBar?: boolean;
  /**
   * CONN-E2：可选注入镜像漂移报告（detect 成功体 / mock / 演示）。
   * 有值 → Strict 挂 StatusBar 且展示分类；无值且未 `showMirrorDriftBar` → 不挂条。
   * **禁止** 空态默认伪造 drift 报告。
   * 与 CONN-E3：显式 prop **优先于** 调度产出的 report。
   */
  mirrorDriftReport?: MirrorDriftReportView | null;
  /**
   * 检测来源诚实标注（poll / os_event / injected / unknown）。
   * 默认 `unknown`；**禁止** 无 OS 时写 `os_event` 冒充满关。
   * CONN-E3 调度激活且仍为 unknown 时产品侧记为 `poll`（opt-in 调度，非 OS）。
   */
  mirrorWatchSource?: MirrorWatchSource;
  /**
   * 未推送本地 op 数（X-05）。默认 0；有 unpushed 时「接受镜像」须二次确认。
   */
  mirrorUnpushedOpCount?: number;
  /**
   * 三路决策回调（优先于 `mirrorIpc` 工厂）。
   * 测 / 宿主可直接断言；生产形状可接 `createMirrorThreeWayOnAction`。
   */
  onMirrorThreeWay?: (decision: ThreeWayDecision) => void;
  /**
   * CONN-E2 / E3：可选注入 mirror IPC（detect/import）。
   * - 三路：当 **未** 给 `onMirrorThreeWay` 时，自动 `createMirrorThreeWayOnAction`
   * - detect 调度（E3）：须与 `enableMirrorDetectSchedule` 同开才自动 detect
   */
  mirrorIpc?: NoteMirrorIpc;
  /**
   * CONN-E3：显式 opt-in 产品 detect→report 调度（默认 **关**）。
   * - `true` + `mirrorIpc` → 调用 `detectMirrorDrift` → 注入 report → 可挂 StatusBar
   * - `false` / 省略 → **无** detect 调用、**无** detect 定时器
   * - **不** 默认强制开 StatusBar 噪声；有 report 后按 E2 规则挂条
   * - 调度激活时挂条 idle 亦可（等待 detect）；**≠ EL-03**；**≠ inotify 满关**
   * - CONN-E2′：产品宿主（Workspace）可默传 `true`；**本组件默认仍 false**
   */
  enableMirrorDetectSchedule?: boolean;
  /**
   * CONN-E3：可选 detect 轮询间隔 ms。
   * 省略 / ≤0 → enable 时 **仅一次** detect（无 setInterval）。
   * >0 → 立即一次 + interval（仍须 opt-in；≠ 默认双开 poll+OS）。
   */
  mirrorDetectIntervalMs?: number;
  /**
   * CONN-C2：显式 opt-in 产品空态挂载 PaperList（默认 **关**）。
   * - 省略 / `false` → 打开 Strict **不** 传 `paperList` → `data-paper-list=0` +
   *   `presentationMode=react-rows`（仅 content-row；**防**默认真双内容）
   * - `true` → 传 `paperList` → 产品默认 `presentationMode=paper-list`
   *   （与 content-row **互斥**；chrome 分槽仍可同屏）
   * - **≠ EL-01**；**≠ W3-P 满窗**；库层 PaperList 已挂 ≠ 空态默认挂
   * - 测钉：`conn_c2_default_no_paper_list` / `conn_c2_opt_in_paper_list_mutex`
   */
  enableProductPaperList?: boolean;
};

/**
 * 工作区空态装配壳。
 * 默认关钉死：`enableMirrorDetectSchedule=false` / `enableProductPaperList=false`。
 */
export function WorkspaceEmptyState({
  wsId,
  onActivate,
  preferredNotePaperTrack = W5B_PRODUCT_DEFAULT_EMPTY_TRACK,
  strictHydrateTransport,
  strictApplyOps,
  strictApplyOpsIpc,
  slashIntentSink,
  turnIntoSink,
  strictSlashWireOptions,
  showMirrorDriftBar,
  mirrorDriftReport = null,
  mirrorWatchSource = 'unknown',
  mirrorUnpushedOpCount = 0,
  onMirrorThreeWay,
  mirrorIpc,
  enableMirrorDetectSchedule = false,
  mirrorDetectIntervalMs,
  enableProductPaperList = false,
}: WorkspaceEmptyStateProps) {
  const [openMode, setOpenMode] = useState<NotePaperEmptyOpenMode | null>(null);

  const strictDocId = `strict-${wsId}`;
  const skeletonDocId = `preview-${wsId}`;

  const paper = useWorkspaceEmptyStatePaperBindings({
    strictDocId,
    strictHydrateTransport,
    strictApplyOps,
    strictApplyOpsIpc,
    slashIntentSink,
    turnIntoSink,
    strictSlashWireOptions,
    enableProductPaperList,
  });

  const mirror = useWorkspaceEmptyStateMirrorSlot({
    strictDocId,
    showMirrorDriftBar,
    mirrorDriftReport,
    mirrorWatchSource,
    mirrorUnpushedOpCount,
    onMirrorThreeWay,
    mirrorIpc,
    enableMirrorDetectSchedule,
    mirrorDetectIntervalMs,
  });

  if (openMode === 'strict') {
    return (
      <WorkspaceEmptyStateStrictHost
        wsId={wsId}
        strictDocId={strictDocId}
        paper={paper}
        mirror={mirror}
        mirrorUnpushedOpCount={mirrorUnpushedOpCount}
        onClose={() => setOpenMode(null)}
      />
    );
  }

  if (openMode === 'skeleton') {
    return (
      <WorkspaceEmptyStateSkeletonHost
        wsId={wsId}
        skeletonDocId={skeletonDocId}
        onClose={() => setOpenMode(null)}
      />
    );
  }

  return (
    <div
      className={styles.workspaceEmptyState}
      role="status"
      aria-live="polite"
      data-ws-id={wsId}
      data-empty="true"
      data-preferred-note-paper-track={preferredNotePaperTrack}
      data-product-default-track={W5B_PRODUCT_DEFAULT_EMPTY_TRACK}
      {...buildPaperWriteConeDataAttrs(
        paper.slashBinding,
        paper.mdPrefixBinding,
        false
      )}
      {...mirror.dataAttrs}
      data-product-paper-list={paper.productPaperListAttr}
      {...EMPTY_STATE_PAPER_HONESTY_ATTRS}
      onPointerDown={onActivate}
    >
      <WorkspaceEmptyStateLanding
        preferredNotePaperTrack={preferredNotePaperTrack}
        onOpenStrict={() => setOpenMode('strict')}
        onOpenSkeleton={() => setOpenMode('skeleton')}
      />
    </div>
  );
}
