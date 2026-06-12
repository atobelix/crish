/**
 * @crish/shared-utils
 *
 * 跨包共享的工具函数，消除各包中的重复实现。
 */

export { isRecord, isPromiseLike, nonEmptyString, isNodeError } from "./guards";
export { clone, compactJsonObject, isJsonObject, isJsonValue, stripNonSerializable } from "./object";
export { errorMessage } from "./error";
export { fsyncPath, fsyncPathAsync, fsyncDirectoryPath, isExpectedDirectoryFsyncFailure } from "./fsync";
export { combineAbortSignals } from "./abort-utils";
