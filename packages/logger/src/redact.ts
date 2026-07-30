/**
 * @crish/logger — 日志脱敏模块
 *
 * RedactFn 类型定义在 logger.ts（Agent 2-A 产出），本文件 re-export 并提供：
 * - createChainedRedactor: 组合多个 redactor 函数
 * - defaultRedactor: identity 函数（不脱敏）
 * - setLogRedactor / redactSensitive: deprecated 全局兼容 shim
 *
 * 全局 shim 仅供 shared-utils/logger.ts 的 deprecated re-export 使用，
 * 向后兼容 agent-daemon/src/index.ts L204 的全局 setLogRedactor 调用。
 * 新代码应使用 Logger.prototype.setRedactor。
 */
export type { RedactFn } from './logger';
import type { RedactFn } from './logger';

/** identity 函数，不执行任何脱敏。作为默认 redactor。 */
export const defaultRedactor: RedactFn = (text: string) => text;

/**
 * 组合多个 redactor 函数，依次应用（左到右管道）。
 * 空参数返回 defaultRedactor。
 */
export function createChainedRedactor(...fns: RedactFn[]): RedactFn {
  if (fns.length === 0) return defaultRedactor;
  return (text: string) => fns.reduce((t, fn) => fn(t), text);
}

// ── deprecated 全局兼容 shim ──
// 模块级可变状态，仅用于向后兼容 shared-utils/logger.ts 的 re-export。
// 新代码应使用 Logger 实例的 setRedactor 方法。

let _defaultRedactor: RedactFn | undefined;

/**
 * 设置全局默认 redactor（deprecated）。
 * @deprecated 使用 `Logger.prototype.setRedactor` 替代。
 *   迁移：`logger.setRedactor(fn)` 替代 `setLogRedactor(fn)`。
 * @see Logger.prototype.setRedactor
 * @removeWhen Round 7 daemon 重构迁移完成
 */
export function setLogRedactor(fn: RedactFn | undefined): void {
  _defaultRedactor = fn;
}

/**
 * 使用全局默认 redactor 脱敏文本（deprecated）。
 * @deprecated 使用 Logger 实例的 redactor 替代。
 *   迁移：`logger.setRedactor(fn)` 后，logger.log() 自动脱敏。
 * @see Logger.prototype.setRedactor
 * @removeWhen Round 7 daemon 重构迁移完成
 */
export function redactSensitive(text: string): string {
  return _defaultRedactor ? _defaultRedactor(text) : text;
}
