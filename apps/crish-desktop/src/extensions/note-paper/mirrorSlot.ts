/**
 * 产品 mirror 槽（CONN-E2 / E3）
 *
 * detect 调度 / 三路回调 / StatusBar 是否挂条 / 诚实 data-*。
 * `enableMirrorDetectSchedule` **默认仍由装配壳钉 false**（本槽不改默认）。
 *
 * ≠ EL-03；≠ inotify 满关；≠ 默认 poll+OS 双开；≠ 重做 E2′ 宿主
 */

import { useMemo } from 'react';
import type { NoteMirrorIpc } from '../../api/noteMirrorIpc';
import { createMirrorThreeWayOnAction } from '../../components/note-paper/mirrorThreeWayBridge';
import type {
  MirrorDriftReportView,
  MirrorWatchSource,
  ThreeWayDecision,
} from '../../components/note-paper/mirrorDriftUi';
import { useMirrorDetectProduct } from '../../components/note-paper/useMirrorDetectProduct';

/** CONN-E2 / E3 诚实锚（禁止假关 EL-03 / 宣称 inotify 满关） */
export const EMPTY_STATE_MIRROR_HONESTY_ATTRS = {
  'data-el03': 'not-claimed',
  'data-inotify-full': 'not-claimed',
} as const;

export type UseWorkspaceEmptyStateMirrorSlotInput = {
  strictDocId: string;
  showMirrorDriftBar?: boolean;
  mirrorDriftReport?: MirrorDriftReportView | null;
  mirrorWatchSource?: MirrorWatchSource;
  mirrorUnpushedOpCount?: number;
  onMirrorThreeWay?: (decision: ThreeWayDecision) => void;
  mirrorIpc?: NoteMirrorIpc;
  /** 须由装配壳默认 false 后再传入 */
  enableMirrorDetectSchedule: boolean;
  mirrorDetectIntervalMs?: number;
};

export type WorkspaceEmptyStateMirrorSlot = {
  scheduleActive: boolean;
  effectiveMirrorReport: MirrorDriftReportView | null;
  resolvedOnMirrorThreeWay: ((decision: ThreeWayDecision) => void) | undefined;
  mirrorBarEnabled: boolean;
  resolvedWatchSource: MirrorWatchSource;
  scheduleAttr: '0' | '1';
  detectPolicyAttr: '0' | '1';
  /** 透传给 Strict 面板的 showMirrorDriftBar（调度激活时强制 true） */
  panelShowMirrorDriftBar: boolean | undefined;
  dataAttrs: Record<string, string>;
};

/**
 * mirror 槽：opt-in 调度 + 三路 + 挂条判定。
 * enable=false（默认）→ 无 detect、无 timer。
 */
export function useWorkspaceEmptyStateMirrorSlot(
  input: UseWorkspaceEmptyStateMirrorSlotInput
): WorkspaceEmptyStateMirrorSlot {
  const {
    strictDocId,
    showMirrorDriftBar,
    mirrorDriftReport = null,
    mirrorWatchSource = 'unknown',
    mirrorUnpushedOpCount = 0,
    onMirrorThreeWay,
    mirrorIpc,
    enableMirrorDetectSchedule,
    mirrorDetectIntervalMs,
  } = input;

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

  const scheduleAttr: '0' | '1' = detectSchedule.scheduleActive ? '1' : '0';
  /** CONN-E2′：宿主策略探针（组件默认 0；≠ scheduleActive，无 ipc 仍可为 1） */
  const detectPolicyAttr: '0' | '1' =
    enableMirrorDetectSchedule === true ? '1' : '0';

  const dataAttrs: Record<string, string> = {
    'data-mirror-drift-bar': mirrorBarEnabled ? '1' : '0',
    'data-mirror-detect-schedule': scheduleAttr,
    'data-mirror-detect-policy': detectPolicyAttr,
    ...EMPTY_STATE_MIRROR_HONESTY_ATTRS,
  };

  return {
    scheduleActive: detectSchedule.scheduleActive,
    effectiveMirrorReport,
    resolvedOnMirrorThreeWay,
    mirrorBarEnabled,
    resolvedWatchSource,
    scheduleAttr,
    detectPolicyAttr,
    panelShowMirrorDriftBar:
      showMirrorDriftBar === true || detectSchedule.scheduleActive
        ? true
        : showMirrorDriftBar,
    dataAttrs,
  };
}
