/**
 * 信封类型抽取（T7 兼容面）。
 *
 * 原双 zod 解析模块的交叉 fallback 已删，
 * resolveEventType 收敛到单一解析入口 eventParser 的纯实现，
 * 本文件保留为 chatBridge facade 的 re-export 兼容位。
 */
export { resolveEventType } from './eventParser';
