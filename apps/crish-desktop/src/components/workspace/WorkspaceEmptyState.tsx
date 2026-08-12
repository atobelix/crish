import React, { useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import type {
  ApplyOpsAdapter,
  IntentSink,
  TurnIntoSink,
} from '@crish/block-paper';
import type { NoteApplyOpsIpc } from '../../api/noteApplyOpsIpc';
import { resolveProductStrictApplyOps } from '../../api/noteApplyOpsIpc';
import type { NoteMirrorIpc } from '../../api/noteMirrorIpc';
import styles from './WorkspaceEmptyState.module.css';
import { NotePaperPanel } from '../note-paper/NotePaperPanel';
import { NotePaperStrictPanel } from '../note-paper/NotePaperStrictPanel';
import {
  createProductStrictHydrateTransport,
  type NoteHydrateTransport,
} from '../note-paper/hydrateProjection';
import { createProductMdPrefixBinding } from '../note-paper/noteMdPrefixBridge';
import {
  createProductStrictSlashBinding,
  type CreateProductStrictSlashBindingOptions,
} from '../note-paper/productSlashSink';
import { createMirrorThreeWayOnAction } from '../note-paper/mirrorThreeWayBridge';
import { useMirrorDetectProduct } from '../note-paper/useMirrorDetectProduct';
import type {
  MirrorDriftReportView,
  MirrorWatchSource,
  ThreeWayDecision,
} from '../note-paper/mirrorDriftUi';
import {
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from '../note-paper/w5bSkeleton';
import {
  W5B_PRODUCT_DEFAULT_EMPTY_TRACK,
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from '../note-paper/w5bStrict';
import { Button } from '../ui';

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
 * 工作区空态。
 *
 * ## 产品默认（W5-B 产品入口）
 * - 默认倾向 **Strict**：可点打开 `NotePaperStrictPanel` +
 *   `createProductStrictHydrateTransport`（Tauri→tauri-ipc / 无 Tauri→fixture）
 * - **W5-B-S Skeleton** 预览壳入口 **保留**（`open-note-paper-preview`）
 * - **CONN-B / B3 slash 写锥**：`resolveProductStrictApplyOps` —
 *   显式 applyOps / sink / note_apply_ops IPC / Tauri → 可写；
 *   **无后端 → 只读 catalog**（禁止假写路径）
 * - **CONN-D2 mdPrefix 写锥**：同 apply 解析；无后端 → disabled；
 *   **≠ A-BLK-08/09 e2e**；provisional ≠ kind UI
 * - **CONN-E2 mirror 条**：默认 **不** 挂 `MirrorDriftStatusBar`；
 *   `showMirrorDriftBar` / `mirrorDriftReport` opt-in 才装配；无 report 不造假数据
 * - **CONN-E3 detect 调度**：默认 **不** 调 detect；
 *   `enableMirrorDetectSchedule` + `mirrorIpc` opt-in → detect→report
 * - **CONN-C2 PaperList 产品默认**：默认 **不** 挂 PaperList（`enableProductPaperList`
 *   默认 false → 不传 `paperList` → `data-paper-list=0` / `react-rows`）；
 *   opt-in true → `paperList` + 产品 `paper-list` 模式（**互斥** content-row）
 *
 * ## 诚实边界（08 §0.2 / 20 L3–L4 · R10 · CONN-A1 · CONN-B3 · CONN-E2/E3 · CONN-C2）
 * - **可演示 ≠ EL-01 / EL-08 关闭**
 * - **≠ 打开完成**；后端默认 `hydrate_path=doc-session`（真 `DocSession::hydrate` 投影）；
 *   对照轨 `prefer_query` → `query-blocks`；**path 字符串 ≠ G-HYD 打开完成 / ≠ EL-01/04/08**
 * - **fixture ≠ 生产权威**；无 Tauri 回退 fixture **不是** 伪装 tauri-ipc
 * - 有 Tauri 时失败/空/成功走真 IPC 三态，**不**静默回退 fixture
 * - 挂载冒充交付 = S5；禁止去 `-S` 冒充 Strict
 * - slash / mdPrefix 默认可写 **仅当** 有 apply 后端（IPC/注入）；**禁止** mock 生产默认
 * - 桌面 mdPrefix 接线 ≠ 打开完成
 * - mirror 条 **≠ EL-03**；**≠ inotify 满关**；X-05 不回退；**≠** 默认 poll+OS 双开
 * - detect 调度 **仅** opt-in；关时无 timer；**≠** 假关 EL-03
 * - PaperList **仅** `enableProductPaperList` opt-in；默认不双内容；**≠ EL-01**；**≠ W3-P 满窗**
 */
export function WorkspaceEmptyState({
  wsId,
  onActivate,
  preferredNotePaperTrack = W5B_PRODUCT_DEFAULT_EMPTY_TRACK,
  strictHydrateTransport,
  strictApplyOps,
  strictApplyOpsIpc,
  slashIntentSink,
  turnIntoSink: turnIntoSinkProp,
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

  const resolvedStrictTransport = useMemo(
    () =>
      strictHydrateTransport ??
      createProductStrictHydrateTransport(strictDocId),
    [strictHydrateTransport, strictDocId]
  );

  /**
   * CONN-B3：产品默认 apply 写锥解析。
   * - 显式 applyOps → injected
   * - 显式 applyOpsIpc / Tauri → product-ipc
   * - 无 → none（只读；禁止静默 mock）
   */
  const applyResolution = useMemo(
    () =>
      resolveProductStrictApplyOps({
        docId: strictDocId,
        ...(strictApplyOps !== undefined ? { applyOps: strictApplyOps } : {}),
        ...(strictApplyOpsIpc !== undefined
          ? { applyOpsIpc: strictApplyOpsIpc }
          : {}),
      }),
    [strictDocId, strictApplyOps, strictApplyOpsIpc]
  );

  /**
   * CONN-B：产品默认 slash 写锥绑定。
   * - 有 applyOps/sink → writable + createCollabApplySink
   * - 无 → readonly（UI 可测；不假装已 apply）
   */
  const slashBinding = useMemo(
    () =>
      createProductStrictSlashBinding({
        ...(applyResolution.applyOps !== undefined
          ? {
              applyOps: applyResolution.applyOps,
              ...(applyResolution.source === 'product-ipc'
                ? { sourceLabel: 'product-ipc' as const }
                : applyResolution.source === 'injected-applyOps'
                  ? { sourceLabel: 'injected-applyOps' as const }
                  : {}),
            }
          : {}),
        ...(slashIntentSink !== undefined ? { slashIntentSink } : {}),
        ...(strictSlashWireOptions ?? {}),
      }),
    [applyResolution, slashIntentSink, strictSlashWireOptions]
  );

  /**
   * CONN-D2：产品默认 MD 前缀 / turn_into 写锥。
   * - 有 applyOps/sink → writable + provisional collab（pending 形状）
   * - 无 → disabled（UI 可测；不假装已转块）
   * 与 slash **分通道**；同 applyResolution 可并行驱动。
   */
  const mdPrefixBinding = useMemo(
    () =>
      createProductMdPrefixBinding({
        ...(applyResolution.applyOps !== undefined
          ? {
              applyOps: applyResolution.applyOps,
              ...(applyResolution.source === 'product-ipc'
                ? { sourceLabel: 'product-ipc' as const }
                : applyResolution.source === 'injected-applyOps'
                  ? { sourceLabel: 'injected-applyOps' as const }
                  : {}),
            }
          : {}),
        ...(turnIntoSinkProp !== undefined
          ? { turnIntoSink: turnIntoSinkProp }
          : {}),
      }),
    [applyResolution, turnIntoSinkProp]
  );

  /**
   * CONN-E3：产品 detect→report 调度（opt-in）。
   * - enableMirrorDetectSchedule + mirrorIpc → detectMirrorDrift → report
   * - 默认关：无 detect、无 timer
   */
  const detectSchedule = useMirrorDetectProduct({
    enabled: enableMirrorDetectSchedule === true,
    docId: strictDocId,
    ipc: mirrorIpc,
    intervalMs: mirrorDetectIntervalMs,
  });

  /** 显式 prop report 优先；否则用调度产出 */
  const effectiveMirrorReport =
    mirrorDriftReport != null ? mirrorDriftReport : detectSchedule.report;

  /**
   * CONN-E2：三路回调装配。
   * - 显式 `onMirrorThreeWay` 优先（测断言 / 宿主接管）
   * - 否则有 `mirrorIpc` → `createMirrorThreeWayOnAction`（accept → import；X-05）
   * - 都无 → 不注入（StatusBar 仍可点，但无上层 sink）
   */
  const resolvedOnMirrorThreeWay = useMemo(() => {
    if (onMirrorThreeWay) return onMirrorThreeWay;
    if (!mirrorIpc) return undefined;
    return createMirrorThreeWayOnAction({
      docId: strictDocId,
      unpushedOpCount: mirrorUnpushedOpCount,
      ipc: mirrorIpc,
    });
  }, [onMirrorThreeWay, mirrorIpc, strictDocId, mirrorUnpushedOpCount]);

  /**
   * 是否应在 Strict 上装配 StatusBar（opt-in；默认关）。
   * E3 调度激活时也挂条（idle 或已有 report），便于产品路径可见。
   */
  const mirrorBarEnabled =
    showMirrorDriftBar === true ||
    effectiveMirrorReport != null ||
    detectSchedule.scheduleActive;

  /** 调度激活且宿主未改 source 时诚实标 poll（非 os_event） */
  const resolvedWatchSource: MirrorWatchSource =
    detectSchedule.scheduleActive && mirrorWatchSource === 'unknown'
      ? 'poll'
      : mirrorWatchSource;

  const scheduleAttr = detectSchedule.scheduleActive ? '1' : '0';
  /** CONN-E2′：宿主策略探针（组件默认 0；≠ scheduleActive，无 ipc 仍可为 1） */
  const detectPolicyAttr = enableMirrorDetectSchedule === true ? '1' : '0';
  /** CONN-C2：产品空态 PaperList 会计钉（默认 0；opt-in 1） */
  const productPaperListAttr = enableProductPaperList === true ? '1' : '0';

  if (openMode === 'strict') {
    return (
      <div
        className={styles.workspaceEmptyState}
        data-ws-id={wsId}
        data-empty="false"
        data-note-paper-strict="true"
        data-package-id={W5B_STRICT_PACKAGE_ID}
        data-track={W5B_STRICT_TRACK}
        data-slash-write-mode={slashBinding.mode}
        data-slash-sink-source={slashBinding.source}
        data-slash-sink={slashBinding.sink ? '1' : '0'}
        data-md-prefix-write-mode={mdPrefixBinding.mode}
        data-md-prefix-sink-source={mdPrefixBinding.source}
        data-md-prefix-sink={mdPrefixBinding.sink ? '1' : '0'}
        data-mirror-drift-bar={mirrorBarEnabled ? '1' : '0'}
        data-mirror-detect-schedule={scheduleAttr}
        data-mirror-detect-policy={detectPolicyAttr}
        data-product-paper-list={productPaperListAttr}
        data-el03="not-claimed"
        data-inotify-full="not-claimed"
        data-el01="not-claimed"
        data-w3p-full="not-claimed"
        data-testid="note-paper-strict-host"
        style={{
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          padding: 'var(--space-3, 12px)',
          textAlign: 'left',
        }}
      >
        <NotePaperStrictPanel
          docId={strictDocId}
          hydrateTransport={resolvedStrictTransport}
          slashIntentSink={slashBinding.sink}
          slashWriteMode={slashBinding.mode}
          slashSinkSource={slashBinding.source}
          turnIntoSink={mdPrefixBinding.sink}
          mdPrefixWriteMode={mdPrefixBinding.mode}
          mdPrefixSinkSource={mdPrefixBinding.source}
          paperList={enableProductPaperList === true ? true : undefined}
          title="笔记纸面（W5-B Strict · 空态演示）"
          onClose={() => setOpenMode(null)}
          mirrorDriftReport={effectiveMirrorReport}
          mirrorWatchSource={resolvedWatchSource}
          mirrorUnpushedOpCount={mirrorUnpushedOpCount}
          showMirrorDriftBar={
            showMirrorDriftBar === true || detectSchedule.scheduleActive
              ? true
              : showMirrorDriftBar
          }
          onMirrorThreeWay={resolvedOnMirrorThreeWay}
        />
      </div>
    );
  }

  if (openMode === 'skeleton') {
    return (
      <div
        className={styles.workspaceEmptyState}
        data-ws-id={wsId}
        data-empty="false"
        data-note-paper-preview="true"
        data-package-id={W5B_SKELETON_PACKAGE_ID}
        data-track={W5B_SKELETON_TRACK}
        data-testid="note-paper-preview-host"
        style={{
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          padding: 'var(--space-3, 12px)',
          textAlign: 'left',
        }}
      >
        <NotePaperPanel
          docId={skeletonDocId}
          blockCount={6}
          title="笔记纸面（W5-B-S 预览壳）"
          onClose={() => setOpenMode(null)}
        />
      </div>
    );
  }

  const strictIsPrimary = preferredNotePaperTrack === 'strict';

  const strictOpenButton = (
    <Button
      type="button"
      variant={strictIsPrimary ? 'primary' : 'secondary'}
      size="sm"
      data-testid="open-note-paper-strict"
      data-package-id={W5B_STRICT_PACKAGE_ID}
      data-track={W5B_STRICT_TRACK}
      aria-label="打开笔记纸面 Strict（W5-B · hydrate 演示；可演示≠EL；≠打开完成）"
      onClick={(e) => {
        e.stopPropagation();
        setOpenMode('strict');
      }}
      onPointerDown={(e) => e.stopPropagation()}
      icon={<Lucide.FileText size={14} aria-hidden />}
    >
      打开笔记纸面（Strict）
    </Button>
  );

  const skeletonOpenButton = (
    <Button
      type="button"
      variant={strictIsPrimary ? 'secondary' : 'primary'}
      size="sm"
      data-testid="open-note-paper-preview"
      data-package-id={W5B_SKELETON_PACKAGE_ID}
      data-track={W5B_SKELETON_TRACK}
      aria-label="打开笔记纸面预览壳（W5-B-S Skeleton）"
      onClick={(e) => {
        e.stopPropagation();
        setOpenMode('skeleton');
      }}
      onPointerDown={(e) => e.stopPropagation()}
      icon={<Lucide.NotebookPen size={14} aria-hidden />}
    >
      打开笔记纸面（预览壳）
    </Button>
  );

  return (
    <div
      className={styles.workspaceEmptyState}
      role="status"
      aria-live="polite"
      data-ws-id={wsId}
      data-empty="true"
      data-preferred-note-paper-track={preferredNotePaperTrack}
      data-product-default-track={W5B_PRODUCT_DEFAULT_EMPTY_TRACK}
      data-slash-write-mode={slashBinding.mode}
      data-slash-sink-source={slashBinding.source}
      data-md-prefix-write-mode={mdPrefixBinding.mode}
      data-md-prefix-sink-source={mdPrefixBinding.source}
      data-mirror-drift-bar={mirrorBarEnabled ? '1' : '0'}
      data-mirror-detect-schedule={scheduleAttr}
      data-mirror-detect-policy={detectPolicyAttr}
      data-product-paper-list={productPaperListAttr}
      data-el03="not-claimed"
      data-inotify-full="not-claimed"
      data-el01="not-claimed"
      data-w3p-full="not-claimed"
      onPointerDown={onActivate}
    >
      <div className={styles.emptyStateIconWrapper}>
        <Lucide.LayoutPanelLeft size={32} strokeWidth={1.5} aria-hidden />
      </div>
      <div className={styles.emptyStateTitle}>工作区暂无面板</div>
      <div className={styles.emptyStateDesc}>
        从侧栏打开对话，或用标签栏「+」添加文件、终端、预览等面板。
      </div>
      {/*
        产品默认 Strict（W5-B）+ Skeleton 预览壳（W5-B-S）双入口。
        可演示 ≠ EL；≠ 打开完成；fixture ≠ 生产权威；
        后端默认 hydrate_path=doc-session 仍 ≠ EL-01/04/08（CONN-A1）。
        CONN-B/B3：无 apply/IPC 默认 slash 只读；Tauri note_apply_ops 或注入后可写。
        CONN-D2：无 apply 默认 mdPrefix disabled；注入后 provisional turn_into 可写。
        CONN-E2：mirror 条默认关；showMirrorDriftBar / mirrorDriftReport opt-in；
          无 report 不造假；≠ EL-03 / ≠ inotify 满关 / X-05 不回退。
        CONN-E3：detect 调度默认关；enableMirrorDetectSchedule + mirrorIpc
          → detectMirrorDrift → report → StatusBar；关时无 timer。
        CONN-C2：PaperList 默认关（data-product-paper-list=0 / data-paper-list=0）；
          enableProductPaperList opt-in → paper-list 互斥 content-row；
          ≠ EL-01；≠ W3-P 满窗；禁默认真双内容。
        禁止 mock 生产默认；桌面接线 ≠ 打开完成 / ≠ A-BLK-08/09 e2e / ≠ EL-01。
      */}
      <div
        className={styles.emptyStateActions}
        data-testid="note-paper-empty-actions"
      >
        {strictIsPrimary ? (
          <>
            {strictOpenButton}
            {skeletonOpenButton}
          </>
        ) : (
          <>
            {skeletonOpenButton}
            {strictOpenButton}
          </>
        )}
      </div>
    </div>
  );
}
