/**
 * 编排图功能开关（T-D-12 前端侧，DAG-2）。
 *
 * localStorage 直读键 crish_flow_dag_visible（默认关），语义与
 * layoutTreeStore 的 restore-last-workspace 直读先例一致：
 * - 'true' / '1' → 开（opt-in 可视化）；
 * - 缺失 / 'false' / '0' / 脏值 → 关（安全默认）；
 * - localStorage 读取异常 → 关（私密模式 / 非浏览器环境兜底）。
 *
 * 明确不混入 settingsStore.appSettings：引擎事件权威回灌会覆盖
 * 本地选择，功能开关保持前端本地直读面（与 tabMode 同约定）。
 *
 * 开关关 → RuntimePanel 装配层零挂载 FlowDagView → 零轮询请求、
 * 零事件订阅；彻底下线 = 删除前端组件，引擎零改动。
 */

/** localStorage 直读键（唯一真源；与 Rust 侧无对应，纯前端开关） */
export const FLOW_DAG_VISIBLE_KEY = 'crish_flow_dag_visible';

/**
 * 读取编排图开关（同步直读；hook 形态，未来可加 storage 事件联动，
 * 本期为单次读取 + 会话内不感知跨 tab 变更）。
 */
export function useFlowDagVisible(): boolean {
  try {
    const raw = localStorage.getItem(FLOW_DAG_VISIBLE_KEY);
    return raw === 'true' || raw === '1';
  } catch {
    return false; // 安全默认：读取异常一律视为关
  }
}
