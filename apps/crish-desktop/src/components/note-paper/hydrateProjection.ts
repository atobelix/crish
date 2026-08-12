/**
 * DocSession hydrate 后投影形状 + 可注入 hydrate transport（W5-B Strict · B-09）
 *
 * ## SD-24 切开（主文件 &lt;400）
 * 实现已拆；本文件保持既有 import 路径（`./hydrateProjection` / `index.ts` re-export）：
 * - `hydrateProjection.types`：投影 / transport 类型；`source` 与 `hydratePath` 分轨
 * - `hydrateProjection.fixture`：`createFixtureHydrateTransport`（成功体 `source:'fixture'`）
 * - `hydrateProjection.adapt`：NoteTransport / `note_document_hydrate` 适配
 * - `hydrateProjection.product`：产品工厂（有 Tauri → tauri-ipc；无 Tauri → fixture）
 *
 * ## 形状纪律
 * - 本模块定义的是 **hydrate 成功后的只读投影**（对齐 BlockProjection 子集：
 *   id / flavour / parentId / index / props / text），**不是** `createSilentFixture`
 *   静默假段落。
 * - 投影 ≠ 文档权威；写路径仍须经 Intent / NoteTransport.apply*（本模块只读）。
 *
 * ## 诚实边界（强制）
 * - **可演示 ≠ EL-01 / EL-08**；**≠ W5-C 隔离全关**；挂载冒充交付 = S5
 * - 产品 IPC 默认「打开文档完成」叙事依赖 W1-H；本 adapter **不**宣称 W1-H 已关
 * - `createFixtureHydrateTransport` = 可测 / 演示 Strict 方向子集；`source: 'fixture'`
 *   —— **fixture ≠ 生产权威**；禁止 fixture 伪装 `tauri-ipc`
 * - `adaptNoteTransportAsHydrate` = 把已有 `note_query_blocks` 形状映射为投影
 *   （Tauri / Memory 皆可注入）；**不等于** DocSession::hydrate 产品全链路完成
 * - `adaptNoteHydrateIpcAsTransport` = 专用 `note_document_hydrate` IPC →
 *   source=`tauri-ipc`（IPC 通道）
 * - **产品 Strict 默认**（`createProductStrictHydrateTransport`）：
 *   可检测 Tauri → `tauri-ipc`；无 Tauri → 仍 `fixture`
 *   —— **≠ 打开完成**；**≠ EL-04/01/08**
 * - 后端默认 `hydrate_path=doc-session`（`DocSession::hydrate` + CDCS 树投影）；
 *   旧 query 派生为 `hydrate_path=query-blocks`（对照轨，禁止抬成 full hydrate）
 * - 产品「打开完成」仍依赖 **G-HYD 全条件**；本 adapter **不**关账
 * - **SD-24 ≠ 打开完成**；切开 ≠ EL-01/04/08 关闭
 *
 * ## 禁止
 * - import 行级 EditorStore / lines[] 权威
 * - 用静默假段落冒充 hydrate 投影
 * - fixture 响应写 `source:'tauri-ipc'` 骗测
 * - 把 query 派生静默标成 doc-session / full hydrate
 */

export type {
  DocHydrateProjection,
  FixtureHydrateDoc,
  HydratedBlockProjection,
  NoteHydrateFailure,
  NoteHydrateOutcome,
  NoteHydrateSuccess,
  NoteHydrateTransport,
} from './hydrateProjection.types';

export {
  createEmptyStateStrictDemoTransport,
  createFixtureHydrateTransport,
  makeHydratedBlock,
} from './hydrateProjection.fixture';

export {
  adaptNoteHydrateIpcAsTransport,
  adaptNoteTransportAsHydrate,
  mapHydrateIpcSuccessToProjection,
  mapQueryHitToProjection,
} from './hydrateProjection.adapt';

export {
  createProductStrictHydrateTransport,
  resolveProductStrictHydrateSource,
  type CreateProductStrictHydrateTransportOptions,
  type ProductStrictHydrateSource,
  type ResolveProductStrictHydrateSourceOptions,
} from './hydrateProjection.product';
