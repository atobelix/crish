/**
 * file - 流式 I/O 管道核心基元
 *
 * 提供 StreamingFileReader / StreamingJsonlReader / StreamingDiffParser / FileWatchdog
 * 四个流式文件处理类，将 I/O 模式从全量读入内存改为分块流式处理。
 */
export { StreamingFileReader } from "./streaming-file-reader";
export type { StreamingFileReaderOptions } from "./streaming-file-reader";

export { StreamingJsonlReader } from "./streaming-jsonl-reader";
export type { StreamingJsonlReaderOptions } from "./streaming-jsonl-reader";

export { StreamingDiffParser } from "./streaming-diff-parser";
export type { DiffChange, ParsedHunk } from "./streaming-diff-parser";

export { FileWatchdog } from "./file-watchdog";
export type { FileChangeEvent, FileWatchdogOptions } from "./file-watchdog";
