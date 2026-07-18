/**
 * @crish/shared-utils
 *
 * 跨包共享的工具函数，消除各包中的重复实现。
 */

export { isRecord, isPromiseLike, nonEmptyString, isNodeError } from "./guards";
export { clone, deepFreeze, compactJsonObject, isJsonObject, isJsonValue, stripNonSerializable } from "./object";
export { errorMessage } from "./error";
export { fsyncPath, fsyncPathAsync, fsyncDirectoryPath, fsyncDirectoryPathAsync, isExpectedDirectoryFsyncFailure } from "./fsync";
export { combineAbortSignals } from "./abort-utils";
export { RingBuffer } from "./ring-buffer";
export { BoundedMap, LruMap } from "./bounded-map";
export { AsyncMutex, AsyncSemaphore } from "./async-mutex";
export { JsonlAppendBatcher } from "./jsonl-append-batcher";
export type { JsonlAppendBatcherOptions } from "./jsonl-append-batcher";
export { deepEqual, shallowEqual } from "./deep-equal";
export { BoundedArray } from "./bounded-array";

