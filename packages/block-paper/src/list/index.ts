/**
 * W3-G · PaperList 窗口 DOM 列表
 *
 * - buildMountPlan*：纯函数 MountSpec / mountIds
 * - PaperList：仅窗口∪pin 挂 DOM；窗外真 remove + spacer
 *
 * **≠** EL-01；**≠** A-PERF 数值门；假数据列表 **≠** 权威树
 */

export {
  buildMountPlanByWindow,
  buildMountPlanByScroll,
  type PaperBlockProjection,
  type BuildMountPlanByWindowInput,
  type BuildMountPlanByScrollInput,
  type MountPlan,
} from './buildMountPlan';

export {
  PaperList,
  isPaperList,
  BP_PAPER_LIST,
  BP_PAPER_BLOCK,
  BP_PAPER_BLOCK_ID,
  BP_PAPER_SPACER_BEFORE,
  BP_PAPER_SPACER_AFTER,
  BP_PAPER_MOUNTED_COUNT,
  BP_PAPER_TOTAL_COUNT,
  type PaperListOptions,
  type PaperListScrollState,
  type PaperListWindowState,
} from './PaperList';
