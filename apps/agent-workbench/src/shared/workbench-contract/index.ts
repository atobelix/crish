/** @file 100% 向后兼容的 barrel 重新导出 */

import type { JsonPrimitive, JsonValue, JsonObject } from "@crish/shared-types";
/** @deprecated 请直接使用 @crish/shared-types @see JsonPrimitive @removeWhen 所有消费者直接从 @crish/shared-types 导入 */
export type WorkbenchJsonPrimitive = JsonPrimitive;
/** @deprecated 请直接使用 @crish/shared-types @see JsonValue @removeWhen 所有消费者直接从 @crish/shared-types 导入 */
export type WorkbenchJsonValue = JsonValue;
/** @deprecated 请直接使用 @crish/shared-types @see JsonObject @removeWhen 所有消费者直接从 @crish/shared-types 导入 */
export type WorkbenchJsonObject = JsonObject;

export * from "./plan-document";
export * from "./approval";
export * from "./daemon-session";
export * from "./conversation-rewind";
export * from "./daemon-status";
export * from "./task-snapshot";
export * from "./workbench-ui";
export * from "./ui-projections";
export * from "./sidecar";
export * from "./config";
export * from "./guards";
