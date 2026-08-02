/**
 * @crish/test-utils — 统一测试工具包
 *
 * 导出清单：
 * - createStorageMock / createStorageSpyMock / installBrowserStorageMocks
 * - manualClock（统一时间相关测试的手动时钟）
 * - sequentialIds（确定性顺序 ID 生成器）
 * - createTempDir / withTempDir / removeTempDirs（跨平台临时目录管理）
 */

// === 测试基础设施 mock（去重） ===
export {
  createStorageMock,
  createStorageSpyMock,
  installBrowserStorageMocks,
} from "./storage-mock.js";
export type { ViFnLike } from "./storage-mock.js";

export { manualClock } from "./manual-clock.js";
export type { ManualClock } from "./manual-clock.js";

export { sequentialIds } from "./sequential-ids.js";

export {
  createTempDir,
  withTempDir,
  removeTempDirs,
} from "./temp-dir.js";
