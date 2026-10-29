# crish-mobile 收敛 · 实施方案

> 模块代号：**MB**　分支：`refactor/crish-mobile`　worktree：`C:\Users\orange\rf-mobile`　批次标签：`[BATCH-CRISH-MOBILE]`
> 波次：W5，在 G-MB 满足之后。提交：`refactor(MB-P<n>): <摘要> [BATCH-CRISH-MOBILE]`
> 进度写 worktree 同目录 `crish-mobile.progress.md`。依据：g7 MB-01..08 与 ST 方案留下的 ST-03。2026-10-29 核实。
> **现在不要改。** 整目录在写。本文件只是门控打开后的执行稿。

## 硬性规则
1. 只看代码，不看仓库文档。
2. 彻底改进：配对一条、连接一条、协议版本一个生成常量。不留转发 barrel。
3. 非必要不兼容。旧路径删除，不把第三套实现 re-export 成旧名字。
4. 测试只在 MB-P6 集中跑，不要改一点测一点。
5. 每阶段一个提交。
6. 禁止作弊：不加 skip、`eslint-disable`、`@ts-ignore`，不放宽 jest 覆盖率，不用 `--no-verify`。
7. 不 stash，不 push，不用 gh。门控非空时零改动，包括不「顺手」提交别人的未跟踪文件。

## a. 范围与门控
可改：`apps/crish-mobile/**`；为 ST-03 最小改动 `scripts/generate-engine-bindings.mjs` 与它写出的 `packages/shared-types` 生成物（只增加协议版本常量，不重做 ST-01）。不改 desktop、不改 src-tauri、不改 conversation-flow、不改 avatar-studio。

**门控 G-MB（编写时未满足：porcelain 340 行。不要开工）：**
```
git -C C:\Software\conex status --porcelain -- apps/crish-mobile
```
必须为空。另外，若本阶段要改生成器，`scripts/generate-engine-bindings.mjs` 与 `packages/shared-types/src/generated` 也必须为空，且 ST 已合入（ST 明确把 ST-03 留给本模块）。BLD 若先改根 `typecheck`，MB 基于那个结果开分支，避免两边写根 `package.json`。

最近已提交提交（不是工作区）：`8c79bb440`、`3aa975e9f`、`cd2c5114a`（2026-10-28，BATCH-MOBILE-R4）。在写批次可能已经改掉配对和 socket 的形状，所以 MB-P0 的结论优先于下面的表。

## b. 核实表
工作区仍能看到这些问题。rg 根为 `C:\Software\conex`。

| ID | 结论 | 函数 / 符号 | rg |
|---|---|---|---|
| MB-01 | 仍存在 | `reducePairState`（`pairing/pairMachine.ts`）、`buildPairHello`（`pairProtocol.ts`）、`PairingWiring`（`adapters/wiring/pairing/PairingWiring.ts`）、`ensurePairingWiringForApp`（`adapters/pairing/pairingController.ts`） | `rg -n "function reducePairState|function buildPairHello|class PairingWiring|function ensurePairingWiringForApp" apps/crish-mobile/src` |
| MB-02 | 仍存在 | `ReconnectingWsClient`（约 :293）、`WsGateway`、`RelaySocket`（:15）。`RelaySocket.fail` 的 `catch { // ignore }`（约 :175） | `rg -n "class ReconnectingWsClient|class RelaySocket|export class WsGateway|export function connect" apps/crish-mobile/src/network` |
| MB-03 | 仍存在，但不是第二套协议 | `OutgoingEnvelope` 与 `InboundEnvelope` 都是 `Omit<ContractEnvelope,'auth'> & { auth? }` | `apps/crish-mobile/src/network/WsEnvelope.ts` |
| MB-04 / ST-03 | 仍存在 | `protocolVersion.ts` 手写 `PROTOCOL_VERSION = 1`、`MIN_PROTOCOL_VERSION = 1`。真源 `crates/conex-types/src/device/version.rs` 同值。`WsGateway.ts`、`sessionSigning.ts` 引用手写常量。生成器不输出这两个常量 | `rg -n "PROTOCOL_VERSION" apps/crish-mobile/src crates/conex-types/src/device/version.rs scripts/generate-engine-bindings.mjs` |
| MB-05 | 仍存在（mobile 侧） | metro 无 `conditionNames`；jest `moduleNameMapper` 把 shared-types 与 shared-utils 指到 src；`package.json` 无 `@crish/shared-utils`；根 typecheck 不含 mobile（根脚本归 BLD） | `apps/crish-mobile/metro.config.js`、`jest.config.js`、`package.json` |
| MB-06 | 仍存在 | `approvalListScreen` 的 `void vm.refresh().finally`；`accountRuntime.ts` 的 `void hydrateAccount().finally`；`RelaySocket` 构造里 `void this.connect()`；`feedBridge` 多处裸 `void` | `rg -n "void vm\.|void hydrate|void this\." apps/crish-mobile/src` |
| MB-07 | 仍存在（门控本身） | 工作区 porcelain 340。未跟踪与已改并存，例如 `pairingController.ts`、`RelaySocket.ts` 在磁盘上。门控清空后这条应消失；若清空后仍有两套目录，按 MB-01/02 删 | `git status --porcelain -- apps/crish-mobile` |
| MB-08 | 仍存在 | `filesCache.ts` 的 `createLruCache` / `LruCache`；shared-utils 已有 `cache.ts` 的 `LruCache` 与 `bounded-map.ts` 的 `LruMap` | `rg -n "function createLruCache|class LruCache" apps/crish-mobile/src packages/shared-utils/src` |
| ST-03 深路径 | 仍存在 | 测试从 `packages/shared-types/src/primitive-types` 相对导入 `JsonValue`：`degraded.test.ts`、`pushConsumer.test.ts`、`feedBridge.test.ts`、`terminalWiring.test.ts`、`WsGateway.test.ts` | `rg -n "packages/shared-types/src" apps/crish-mobile` |

没有整条误报。MB-03 的「完全手写协议」不成立：字段来自生成类型，但两个别名仍然重复。MB-05 里「workspaces 排除 mobile」不成立（根 workspaces 已含 `apps/crish-mobile`），其余成立。

## c. 目标架构
一个配对模块：纯函数状态机 + 一个接线适配器。协议帧类型只用 `@crish/shared-types` 的生成类型。`PROTOCOL_VERSION` 与 `MIN_PROTOCOL_VERSION` 由生成器从 `version.rs` 的常量写出，mobile 禁止再手抄。网络只有一条传输：重连、信封编码、签名在同一个类型里；另外两个类删除。UI 触发的异步走一个 `reportFailure`（打日志并写入界面错误状态），禁止裸 `void` 丢掉拒绝。文件缓存用 shared-utils 的平台无关 LRU。Jest 与 Metro 使用包的 `development` 条件，不再手写两包 mapper。依赖在 `package.json` 里写明 `@crish/shared-utils`（`workspace:*`，与 BLD 的依赖写法一致）。

P0 必须先看在写批次留下哪一套配对、哪一套 socket，**以有生产调用且测试还在的那套为准**。不要预设 `pairingController` 或 `RelaySocket` 一定是留下的那个——它们现在是在写文件。

## d. 删除清单
P0 落选的配对目录（三处里的两处）：`src/pairing/`、`adapters/wiring/pairing/`、`adapters/pairing/` 中未选中的。落选的 socket：`ReconnectingWsClient.ts`、`WsGateway.ts`、`RelaySocket.ts` 中未选中的（编码函数若被选中实现使用，随选中文件留下，不另留一份）。`protocolVersion.ts`。`eventReducers.ts` 的转发（调用方直接从 `@crish/shared-utils` 导入）。`filesCache.ts` 里的本地 `createLruCache`。`OutgoingEnvelope` 与 `InboundEnvelope` 二留一，名字只留一个 `DeviceFrame`（或生成名），不留旧名别名。深路径 import。

## e. 分阶段与探针
`$B = refactor/crish-mobile`。改阶段不跑 jest。

**MB-P0** 不改代码。门控输出贴进 progress。列出配对三处与 socket 三处的生产调用方（排除测试）。选定唯一留下的文件，写进 `crish-mobile.verify.md`。若在写批次已经合成一套，把 MB-01/02 标成已解决并跳过对应删除，不发明第三套。核对 `version.rs` 的数值仍是生成输入。

选定规则（按顺序，前一条能决定就停）：
1. 生产代码（非 `*.test.ts`）里被 import 的实现留下；只被测试 import 的删。
2. 若两套都被生产 import，留下调用链到达界面入口（`app/` 或 `presentation/`）的那套，另一套的独特行为用测试迁过去，不留转发文件。
3. 若仍然分不出胜负，停下，记 D13，不要两套都改。
4. `RelaySocket.fail` 一类空 `catch` 不得因为「这套被选中」而保留。选中后先改成可见失败，再删其余文件。

P0 还要记下 jest 现阈值（`jest.config.js` 的 `coverageThreshold.global`：statements 60、branches 75、functions 70、lines 60）。后续提交不得降低这四个数。深路径 import 的五个测试文件名写入 verify，P1 逐个改完再 grep。

**MB-P1** ST-03。生成器输出 `PROTOCOL_VERSION` 与 `MIN_PROTOCOL_VERSION` 到 `packages/shared-types` 的 device 生成物（与 `version.rs` 数值一致；生成后 drift 必须为空）。删 `protocolVersion.ts`。`WsGateway`（或 P0 留下的连接类型）与 `sessionSigning.ts` 改 import 生成常量。测试里的 `packages/shared-types/src/...` 改成 `@crish/shared-types`。不删除 ST 方案负责的手写消息类型。
探针：`git grep "export const PROTOCOL_VERSION = 1" $B -- apps/crish-mobile` 为 0；`git grep "packages/shared-types/src" $B -- apps/crish-mobile` 为 0。

**MB-P2** MB-01。只留 P0 选定的配对实现。另一处的测试迁到留下的模块（断言不减弱）后删除旧目录。禁止 `export * from` 旧路径。
探针：`git grep -l "function reducePairState|class PairingWiring|function ensurePairingWiringForApp" $B -- apps/crish-mobile/src` 只剩一个文件（选定名以 verify 为准）。

**MB-P3** MB-02、MB-03。只留一个 socket 类型。`catch { // ignore }` 改为返回错误或 `tracing` 级别的日志加界面状态，禁止空 catch。合并信封别名。
探针：`rg "class ReconnectingWsClient|class RelaySocket" apps/crish-mobile/src/network` 只命中留下的一个文件；`rg "OutgoingEnvelope|InboundEnvelope" apps/crish-mobile/src/network/WsEnvelope.ts` 至多一个导出。

**MB-P4** MB-06、MB-08、SU-04 的 mobile 半边。增加 `reportFailure`。裸 `void` 调用 Promise 的点改走它。加一条仅扫 `apps/crish-mobile/src` 的 lint 或现有脚本规则，命中裸 `void` + Promise 即失败（测试里的显式 `void` 若是断言，P0 列出允许清单，不允许用文件级 disable）。`createLruCache` 改为 shared-utils 的 `LruCache` 或 `LruMap`（选语义相同的一个，不两套都包一层）。删 `eventReducers.ts`，改调用方 import。
探针：`rg "function createLruCache" apps/crish-mobile/src` 为 0；`rg "from '\./eventReducers'|from '@/domain/store/eventReducers'" apps/crish-mobile/src` 为 0。

**MB-P5** MB-05 的 mobile 半边。`package.json` 声明 `@crish/shared-utils`（以及已经使用的 shared-types）为 `workspace:*`。metro 打开 development 条件；jest 改用导出条件，删除这两包的 `moduleNameMapper` 源码路径。覆盖率数字不得下调。根 `typecheck` 含 mobile 由 BLD 做；若 BLD 未合入，本阶段不改根 `package.json`，在 progress 记依赖。TypeScript 版本对齐根 `^5.9.2` 由 BLD 的工具链门禁约束；本阶段不单独升一版 TS。
探针：`rg "shared-types/src/index" apps/crish-mobile/jest.config.js` 为 0；mobile `package.json` 含 `@crish/shared-utils`。

**MB-P6** 只跑 §h。

## f. 禁止捷径
门控非空时不改任何文件。禁止把未跟踪实验目录整包 `git add` 来「消掉 MB-07」。禁止保留三套实现再用 barrel 统一。禁止手抄协议版本「先对齐再生成」。禁止放宽 `exactOptionalPropertyTypes`（mobile 现在是 false，对齐 strict 若失败就改调用点，不改回 false）。禁止空 `catch`。禁止为了覆盖率把阈值调低或给测试加 skip。

## g. 规范
导入只用包名 `@crish/...` 或 `@/`。类型来自生成物，视图模型用 `Pick` / 映射，名字不得与生成类型相同。异步失败必须进入 UI 可见状态或日志，不依赖未处理拒绝。提交信息使用 MB 代号。worktree 为 `C:\Users\orange\rf-mobile`，基点是 HS/BLD 已合入后的集成分支头，不是现在的脏工作区。开跑前 `Get-Process cargo,rustc` 必须为空；cargo 只用 `-j 3`，`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\mobile`，工具链 `1.99.1`。前端用 Node 24。磁盘不足时只删已合入模块的 `conex-tgt\<名>\debug`，不删源码。

`reportFailure` 的形状固定为 `(error: unknown, where: string) => void`：写一条日志，并把最近一次失败放进调用方已经有的界面状态（审批列表、账号、配对各自的 error 字段）。不要新建全局事件总线。没有现成错误字段的屏幕，在该屏幕的状态里加一个 `error`，不把失败吞进 `finally`。

## h. 测试命令
仅 MB-P6。Node 24。不跑 cargo，除非 P1 改了生成器且要确认 Rust 常量测试仍过；那种情况下与其他 Rust 模块串行：
```
$env:RUSTUP_TOOLCHAIN = "1.99.1"
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\mobile"
cargo test -j 3 -p conex-types version
```
默认只跑前端：
```
npm run typecheck
npm --workspace @crish/crish-mobile test -- --ci
npm --workspace @crish/crish-mobile exec tsc --noEmit
npx knip
npm run gen:engine-bindings
git status --porcelain -- packages/shared-types apps/crish-mobile/src/network/protocolVersion.ts
```
最后一条必须为空（`protocolVersion.ts` 已不存在，生成物无意外漂移）。回归：
- R1 握手使用生成的 `PROTOCOL_VERSION`。把生成物改成与 `version.rs` 不同的数，mobile 测试必须失败；测完还原。
- R2 配对只走 P0 留下的状态机。旧目录路径 import 为 0。
- R3 断线后仍会重连，空 `catch` 为 0。
- R4 `approvalListScreen` 的刷新失败进入错误状态，而不是未处理拒绝。
- R5 `filesCache` 仍按容量淘汰，但实现来自 shared-utils，本地 `createLruCache` 不存在。
- R6 `eventReducers.ts` 不存在，原调用方仍能编译。

工作树准备（只在 G-MB 满足后，写在 progress 里，不在主仓库执行）：
```
git -C C:\Software\conex worktree add C:\Users\orange\rf-mobile -b refactor/crish-mobile <集成分支头>
```
Husky 与 `node_modules` 按 ROADMAP §1.3 从主仓库复制和做 junction。hook 失败修代码，不用 `--no-verify`。

## i. 审计
探针全部按 verify 里的选定文件名执行，不按本文旧路径机械比对。作弊清单额外看：覆盖率阈值是否下降、是否新增 `describe.skip`、深路径是否改名后还在、`PROTOCOL_VERSION` 是否仍是手写字面量。删除的测试文件必须在 progress 说明已迁到留下的模块或随死实现删除。

## j. 与 HS / SB / EC / TM / MP 的冲突
- **HS**：不改壳内 server/push。手机协议字段以 `device-protocol.json` 生成物为准。HS 不改该 JSON；本方案也不改字段，只消费版本常量。
- **SB**：无命令门禁交叉。不改 host_openers。
- **EC**：不改错误码表。mobile 若要显示错误，用已生成的 kind，不新写一套字符串码。
- **TM**：不改时间库。时间戳字段沿用生成类型。
- **MP**：不改 Rust `#[path]`。
- **ST**：ST-01/02 不重做。ST-03 按 ST 方案归本模块。生成器冲突时与 ST、BLD 串行。
- **BLD**：根 typecheck、exports 条件、`workspace:*` 归 BLD。本方案只改 mobile 的 metro/jest/依赖声明。SU-04 的 shared-utils 文件若 BLD 已删，本方案改为本地实现或恢复最小函数，不把 desktop 不需要的代码塞回 shared-utils。
- **CF / AV**：不碰。

## k. 已决
- 现在不改 mobile。G-MB 为空之前没有例外。
- ST-03 在本模块做：生成版本常量，删除手抄与深路径 import。ST 方案已把这三项划出 ST 的实施范围。
- D1/D2/D3/D6 不在本模块重做。配对与 socket 的「留哪一套」不是预设 winner，由 MB-P0 按调用方决定；决定之后另一套必须删除，不准兼容并存。
- MB-05 的根 `typecheck` 归 BLD；本模块不把 avatar-studio 或 mock-daemon 的工具链问题揽进来。
- 信封合并只删重复别名，不改 `device-protocol.json`，也不改生成器里已有字段。
- 覆盖率四个数（60/75/70/60）只许上升，不许下降。
