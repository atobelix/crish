/**
 * 测试专用出口：只给测试提供 sink 替身，不进入生产 barrel。
 *
 * 使用方：`@crish/block-paper/testing`。桌面 note-paper 边界门禁禁止深引
 * `packages/block-paper/src/`，故用该子路径承载测试替身；生产入口仍不导出。
 */
export { createMockIntentSink } from './leaves/intentBridge';
export type { MockIntentSink } from './leaves/intentBridge';
export { createMockTurnIntoSink } from './leaves/mdPrefixHost.audit';
export type { MockTurnIntoSink } from './leaves/mdPrefixHost.audit';
