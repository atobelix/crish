/**
 * @crish/test-utils — 统一测试工具包
 *
 * 为 Layer J（测试基础设施）提供标准化的测试替身和 fixture 加载器，
 * 所有测试模块统一从此包导入，避免散落的 inline mock。
 *
 * 导出清单：
 * - FauxProvider（来自 provider/faux-provider.ts，含生命周期方法）
 * - FauxAgentProvider（来自 testing/faux-provider.ts，轻量版）
 * - FauxProviderCallGateway（ProviderGateway 测试装饰器）
 * - createMockTool（标准 MockTool 工厂）
 * - FixtureLoader（JSON fixture 加载器）
 * - createStorageMock / createStorageSpyMock / installBrowserStorageMocks
 * - manualClock（统一时间相关测试的手动时钟）
 * - sequentialIds（确定性顺序 ID 生成器）
 * - createTempDir / withTempDir / removeTempDirs（跨平台临时目录管理）
 */

export { FauxProvider } from "@crish/agent-runtime";
export type { FauxProviderOptions, FauxHealthCheckResult } from "@crish/agent-runtime";

export { FauxAgentProvider } from "@crish/agent-runtime";
export { FauxProviderCallGateway } from "@crish/agent-runtime";
export type { RoutingDecision, FauxCallGatewayOptions } from "@crish/agent-runtime";

export { createMockTool } from "@crish/agent-runtime";
export type { MockToolOptions } from "@crish/agent-runtime";

export { loadFixture, clearFixtureCache } from "@crish/agent-runtime";

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
