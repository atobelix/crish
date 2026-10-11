/**
 * helperAccess — api 侧对 store 纯函数的**叶子**公共入口（R3-M 汇合修复）。
 *
 * ## 为什么存在
 *
 * `getStreamTools`（streamingStore）与 `mergeSessionMessageFields`
 * （sessionSharedHelpers）尚未进入 `store/storeAccess.ts` 公共面（store 域
 * 冻结，本轮不补）。若直接经 `api/storeAccess.ts` re-export，会让
 * sessionProgressApi / sessionEventHydrate 与 store 侧形成新环；
 * 本文件是**叶子模块**（除 api 消费方外无人引用），不新增环。
 *
 * 待 store/storeAccess 补齐对应导出后，消费方可切换并移除本文件。
 *
 * @see docs/multi-agent-repair/reports/R3-T14-违规清单.md §1/§6.3
 */

export { getStreamTools } from '../../store/streamingStore';
export {
  mergeSessionMessageFields,
  sortMessagesByOrder,
} from '../../store/sessionSharedHelpers';
export {
  findInsertIndex,
  isSortedByMessageOrder,
  messageOrderKey,
} from '../../store/messageOrderKey';
