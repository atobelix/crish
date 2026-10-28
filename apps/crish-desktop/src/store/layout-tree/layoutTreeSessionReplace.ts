/**
 * 侧栏会话切换操作的稳定导入路径。
 * 实现统一归属 layoutTreeSessionOps，避免树变换模块之间形成循环依赖。
 */

export {
  replaceActiveSessionInLeaf,
  materializeDraftSession,
} from './layoutTreeSessionOps';
export type { SessionTabMeta } from './layoutTreeSessionOps';
