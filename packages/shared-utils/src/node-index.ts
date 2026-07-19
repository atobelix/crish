/**
 * @crish/shared-utils/node
 *
 * Node.js 专用子路径 —— 包含 Node.js 原生模块依赖。
 * 仅用于后端包（agent-daemon, agent-runtime），
 * 不可被前端（crish-desktop）或 Worker 导入。
 */
export { fsyncPath, fsyncPathAsync, fsyncDirectoryPath, fsyncDirectoryPathAsync, isExpectedDirectoryFsyncFailure } from "./fsync";
export { JsonlAppendBatcher } from "./jsonl-append-batcher";
export type { JsonlAppendBatcherOptions } from "./jsonl-append-batcher";
