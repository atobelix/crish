# T-A 功能修复轨道 · 详细计划（快照桥接线 + 断链命令修复）

> 产出：详细计划子 Agent（只读 + 本计划文档）。
> 输入：`40-final-plan/00-master-plan.md`（批次 1）+ `20-proposals/03`（快照桥）+ `20-proposals/04`（断链）+ `30-reviews/01~03`（R-09/R-10 裁决）。
> 复核基线：2026-08-09 工作区 `git status` 实测（`messageSnapshotsBridge.ts` 处于未提交脏状态，见 §0）。
> 性质：可派发执行的详细计划。全部行号与语义均经实读复核；行号引用按「语义定位优先」（30-03 评审：行号普遍漂移 3%~8%）。
> 范围：仅 T-A 批次 1 两项任务（03-步骤1 + 04-步骤1）。Rust 侧零改动（只读验证）。

---

## 0. 前置清理（批次 0.1，R-10 裁决落地）

| 项 | 内容 | 依据 |
|---|---|---|
| 脏状态事实 | `apps/crish-desktop/src/store/messageSnapshotsBridge.ts` 工作区 diff 为 `let _ops` → `const _ops`（HEAD 为 `let`），2026-08-08 knip 会话（fc4b3a5a）残留，未提交 | 实测 `git diff`；30-03 P0-4 |
| 处置 | 开工前 `git restore -- apps/crish-desktop/src/store/messageSnapshotsBridge.ts` 丢弃该改动（**不是提交**）。理由：`bindMessageSnapshotsOps` 必须**可变** `_ops`（注入语义），`const` 与注入方向相斥；本文件 100% 属本批域，整文件清理即可，无「只清本域行」约束 | R-10「若为并行域文件则只清理自己的行」——本文件非并行域 |
| 其他脏文件 | `buffer.rs` / `event_bridge_contract.rs` / `Cargo.toml` / `Cargo.lock` / `AGENTS.md` / `usePreviewNavigation.ts` / `layoutRestorePolicy.ts` / `tests/visual/helpers.ts` 属 markdown-editor R3 等并行轮次，**严禁卷入本批提交**；`crates/conex-browser*`、`apps/crish-mobile/`、`mini*.exe` 等为并行域/未跟踪，不触碰 | 30-03 ⑥-1/⑥-2 |
| 基线确认 | 派单前 `git status` 确认干净；提交时精确 add 本域文件 | 00 §3-5/6 |

---

## 1. 任务清单（文件级）

### 任务 A：快照桥接线（03-步骤1，P0-1）——6 个文件

| # | 文件 | 改动内容 | 原因（实读证据） |
|---|---|---|---|
| A1 | `apps/crish-desktop/src/store/messageSnapshotsBridge.ts` | ① `let _ops` 恢复（restore 后即为 HEAD 态，无需再动）；② 新增模块级注入函数 `bindMessageSnapshotsOps(ops: MessageSnapshotsOps): void`；③ 保持 `saveMessageSnapshot` / `clearMessageSnapshots` 的 `_ops?.` 空安全调用不变；④ 保留全部类型导出 | 桥「连可注入缝隙都不存在」：当前 `const _ops = null` 且无 setter（:31，实读）；注入函数必须先补回 |
| A2 | `apps/crish-desktop/src/store/bootstrapStores.ts` | 在 `initStoreAccess(...)`（:71-75）旁装配：`import { MessageSnapshots } from '../api/MessageSnapshots'` + `import { bindMessageSnapshotsOps } from './messageSnapshotsBridge'`；`try { const snapshots = new MessageSnapshots(); bindMessageSnapshotsOps({ save, clearSession }) } catch { logger.warn(...) }`；dev 分支 `logger.debug('[Snapshots] bridge bound', …)` | 注入点固定 bootstrapStores（模块图稳定后），符合桥头注释「bootstrapStores 在模块图稳定后注入」原设计（bridge.ts:3）；bootstrapStores 已调用点：AppBootstrap.ts:139 |
| A3 | `apps/crish-desktop/src/store/messageSnapshotsBridge.test.ts`（**新增**） | 桥行为单测锁四断言（见 §4 测试 1-4） | 防静默回归第一道防线（03 2.6-①） |
| A4 | `apps/crish-desktop/src/app/__tests__/AppBootstrap.test.ts` | 扩展 1 条结构断言：readFileSync 读 `../store/bootstrapStores.ts`，断言包含 `bindMessageSnapshotsOps(` | 装配效应测试（03 2.6-③）；该文件已有 readFileSync 结构断言模式（:12/:27） |
| A5 | `apps/crish-desktop/src/store/README.md` | 在 `## 门禁`（:183）前新增「## 消息快照桥（P0-1 接线状态）」小节：接线状态、纯内存边界（栈/容量在 Map 中，重启即失，MessageSnapshots.ts:147-148）、restore 侧（undo/peek/peekDelta/getStack）未接线为已知缺口 | 03 2.4「文档」行；防止「功能像存在其实没持久」的误解（03 ⑤-3） |
| A6 | 调用点（**零改动，仅读**）：`sessionMessageActions.ts:113-125`（withdrawMessage 保存侧）、`sessionCrudActions.ts:443`（deleteSession 清栈侧） | 载荷已完整（prevMessages/prevPinned/diffFilePaths 全构造），语义即接线目标 | 03 2.4「调用点零改动」；02 评审 02-3 全项实读确认 |

**undo/redo 消费方实读结论**（任务 A 的行为边界依据）：

| 消费方 | 类型 | 实测 |
|---|---|---|
| 撤回入口 `withdrawMessage`（sessionMessageActions.ts:85） | **保存侧** | 构造完整载荷后调 `saveMessageSnapshot`（:113-125，含 `afterMessages`） |
| 删除入口 `deleteSession`（sessionCrudActions.ts:410） | **清栈侧** | 删除成功后才 `clearMessageSnapshots(id)`（:443），天然幂等 |
| 归档入口 `archiveSession`（sessionOrderingActions.ts:61） | **不消费快照** | 无任何 saveMessageSnapshot 调用（grep 实证）；快照 operation 类型 `'archive'` 属预留（bridge.ts:10），不新增调用点 |
| 读侧 undo/peek/peekDelta/getStack（MessageSnapshots.ts:212-247） | **生产零调用** | 全仓 grep 非测试文件零命中（实读复核，02 评审 02-3-4 确认） |

### 任务 B：断链命令修复（04-步骤1，P0-2）——6 个文件（+1 可选新增）

| # | 文件 | 改动内容 | 原因（实读证据） |
|---|---|---|---|
| B1 | `apps/crish-desktop/src/api/rustCore.ts` | ① `:171` `'md_render'` → `'core_md_render'`；② `:186` `'highlight_code'` → `'core_highlight_code'`；③ `:157` 注释命令名清单更新为 `core_md_render / core_md_render_batch / core_md_render_stream / core_highlight_code / core_md_clear_cache` | Rust wire 键 = `core_md_render`（markdown_commands.rs:22）/ `core_highlight_code`（:67），rename 显式声明；前端快照 commandManifest.ts:132/135 与 manifest 均已一致，**三表中仅前端调用名字面量错位** |
| B2 | `apps/crish-desktop/src/services/TelemetryMonitor.ts` | ① `:103` `'perf_jsonl_append'` → `'core_jsonl_append'`；② `:21` logFilePath 机器路径硬编码清除 → 运行时派生；③ `:107` workspaceRoot 机器路径硬编码清除 → `getWorkspacePath()` 运行时取值（无工作区传 `undefined`）；④ missing 分支（:109-116）补可观测日志 | Rust `core_jsonl_append` 已注册（main.rs:190、command_manifest.rs:162），签名 `(path, lines, flush, workspace_root)` 与前端传参逐项匹配（core_commands.rs:546-551）；workspace 未开时 `WorkspaceFsGuard::for_default_workspace()` 兜底（core_commands.rs:575-578）；perf/jsonl.rs:5-7 注释自证「迁移由前端域承接」——历史任务补执行；双硬编码 = :21 + :107（04 ⑤-4 新发现） |
| B3 | `apps/crish-desktop/src/test-setup.ts` | 文档注释示例键改名：`:57-58`、`:76`、`:90-91` 的 `'md_render'` → `'core_md_render'` | mock 基础设施文档须与真实键一致（04 ⑤-1：mock 键从未存在于 Rust 注册面，不改则测试假绿灯） |
| B4 | `apps/crish-desktop/src/test-setup.test.ts` | 4 处 mock 键改名：`:45/:50`（ok 路径）、`:116/:118`（missing 路径）`'md_render'` → `'core_md_render'` | 同上 |
| B5 | `apps/crish-desktop/src/api/markdownRender.parity.test.ts` | 3 处 mock 键改名：`:109`、`:166`（missing 路径）、`:132`（ok 路径）→ `'core_md_render'`；同步修头注释（:7）与测试名（:127） | 同上；byte 兼容断言在真实键上才有意义 |
| B6 | `apps/crish-desktop/src/api/markdownRenderAsync.test.ts` | 13 处 mock 键改名（:54/:68/:88/:96/:102/:109/:118/:154/:164/:181/:194）→ `'core_md_render'`；同步修注释（:6/:13 相关行）；**在「Rust 命中」用例（:52-65）追加调用名断言**：`expect(vi.mocked(invoke)).toHaveBeenCalledWith('core_md_render', { text: 'hi' })` | 同上；调用名断言是「证明走真实键」的测试级证据 |
| B7（可选新增） | `apps/crish-desktop/src/services/TelemetryMonitor.test.ts` | 接线后行为单测：改名断言（invoke 收到 `core_jsonl_append`）、workspaceRoot 派生（无工作区时 `undefined`）、missing 分支走 `logInternalError`（spy console.warn）、1000 条缓冲语义保留 | 现无 TelemetryMonitor 单测（grep 实证仅 stressFuzzing.test.ts:119 Probe D 锤缓冲上限）；补锁防「接线后缓冲语义被改坏」 |

**任务 B 相关零改动清单（只读验证）**：Rust `markdown_commands.rs` / `core_commands.rs` / `perf/jsonl.rs` / `main.rs` / `command_manifest.rs`（wire 键已对齐，改名即通）；`markdownRenderAsync.ts`（消费链已就绪：Rust 优先 :39-43、missing 回退 worker :44-48，实读确认，无需改动）；`commandManifest.ts:132/135` 快照已正确。

---

## 2. 快照桥实现要点与三道防线

### 2.1 注入函数实现要点（A1）

```ts
// messageSnapshotsBridge.ts（新增，置于 _ops 声明之后）
let _ops: MessageSnapshotsOps | null = null; // 恢复可变性（R-10 restore 后 HEAD 即 let）

export function bindMessageSnapshotsOps(ops: MessageSnapshotsOps): void {
  if (ops === _ops) return;                    // 幂等：同实例重复绑定直接返回
  if (_ops !== null) {
    logger.warn('[Snapshots] bridge already bound — replacing previous ops');
  }
  _ops = ops;                                  // 重复注入以最后一次为准
}
```

- **必须 `let`**：注入语义是运行时替换 `_ops`；若强行保留 `const` 需引入可变容器对象（增加复杂度，无收益）。R-10 前置 restore 保证提交基线干净。
- 需 import `logger`（`../services/LoggerService`，仅依赖 shared-utils/redact，无 store 环，实读验证）。
- `saveMessageSnapshot` / `clearMessageSnapshots` 的 `_ops?.` 空安全调用**原样保留**——未注入时行为与现状一致（不抛错、无副作用），这是回退安全的地基（02 评审 ⑥-3）。
- 类型导出（SnapshotSaveEntry / SnapshotSaveOptions / MessageSnapshotsOps）全部保留。

### 2.2 装配实现要点（A2）

```ts
// bootstrapStores.ts，initStoreAccess(...) 之后（:71-75 旁）
try {
  const snapshots = new MessageSnapshots();
  bindMessageSnapshotsOps({
    save: (sessionId, entry, options) =>
      snapshots.save(sessionId, entry, { afterMessages: options?.afterMessages ?? [] }),
    clearSession: (sessionId) => snapshots.clearSession(sessionId),
  });
  if (process.env.NODE_ENV === 'development') {
    logger.debug('[Snapshots] bridge bound', { module: 'store' });
  }
} catch (err) {
  logger.warn('[Snapshots] bridge bind failed — snapshot protection disabled', { err });
}
```

- **签名适配要点**：桥 `MessageSnapshotsOps.save` 的 `options?: SnapshotSaveOptions`（afterMessages 可选）vs `MessageSnapshots.save` 的 `ctx: SaveContext`（afterMessages **必填**，MessageSnapshots.ts:134）。适配器兜底 `?? []`（withdrawMessage 调用点恒传 afterMessages :124，兜底仅防御未来调用点漏传；空数组时 computeDiff 退化为全量倒向 patch，语义仍安全）。
- **注入点约束**：固定 `bootstrapStores()` 内（模块图稳定后，AppBootstrap.ts:139 调用）；**禁止**在 store 定义期 import `MessageSnapshots`（init 环风险，桥头注释原意，03 ⑥-7）。
- **禁止空 catch**：构造/装配失败必须 `logger.warn` 显式告警（03 2.4「注入失败…禁止空 catch」），并明确提示快照保护未生效。
- dev 可见性日志沿用 StoreFreq 模式（`logger.debug`，bootstrapStores.ts:26-37 同款守卫）。
- 接线后 `save` 返回的 snapshot id（bridge ops 类型要求 string）由 `snapshots.save` 直接透传，wrapper `saveMessageSnapshot` 仍返回 void（调用点契约不变）。

### 2.3 三道防回归防线

| # | 防线 | 载体 | 触发条件 |
|---|---|---|---|
| 1 | 单测锁 | 新增 `messageSnapshotsBridge.test.ts` 四断言（§4 测试 1-4）：未注入不抛错无副作用 / 注入后 save 真实入栈 / clear 清空 / 重复注入幂等 | 注入点丢失或语义退化即红 |
| 2 | 装配效应测试 | `AppBootstrap.test.ts` 扩展 1 条：readFileSync 断言 `bootstrapStores.ts` 含 `bindMessageSnapshotsOps(` | 未来清理误删注入即红（本批即刻生效） |
| 3 | 注入点门禁（**后置，批次 5 落地**） | `scripts/check-no-raw-setstate.mjs`（03-步骤4 新增）顺带断言 bootstrapStores 含注入调用 | 03 2.6-②；本批用防线 2 临时覆盖，批次 5 后双保险 |

**防线 3 的依赖说明**：`check-no-raw-setstate.mjs` 属 03-步骤4（批次 5），本批不新建脚本；完成判据中的「注入点存在」检查由防线 2 承担，批次 5 接线后自动升级为门禁。

### 2.4 完成判据（任务 A）

- `bindMessageSnapshotsOps` 在 `bootstrapStores.ts` 有装配调用（grep 命中）；
- bridge 单测四断言全绿；AppBootstrap.test.ts 扩展断言绿；
- 全仓 grep `messageSnapshotsBridge`：仅 bridge / bootstrapStores / sessionMessageActions / sessionCrudActions / 测试命中，无其他绕行（实测基线：生产代码仅 2 个 action import，见 §1 grep 实证）；
- `npm run typecheck` + `npm run check:desktop` 全绿。

---

## 3. 断链命令修复精确改动

### 3.1 rustCore.ts 两处字面量 + 注释（B1）

| 位置（实读） | 现内容 | 改为 |
|---|---|---|
| rustCore.ts:171 | `invokeResult<string>('md_render', { text })` | `invokeResult<string>('core_md_render', { text })` |
| rustCore.ts:186 | `invokeResult<string>('highlight_code', args)` | `invokeResult<string>('core_highlight_code', args)` |
| rustCore.ts:157 | `//   md_render / md_render_batch / md_render_stream / highlight_code / md_clear_cache` | `//   core_md_render / core_md_render_batch / core_md_render_stream / core_highlight_code / core_md_clear_cache` |

- 不改函数签名、不改 fallback 语义（missing → null → 调用方回退 worker，markdownRenderAsync.ts:39-48 链路原样生效）。
- **highlight 断链为双层问题**（04 ⑤-2）：改名后 `highlightCode` wrapper 仍**无生产消费者**（全仓 grep：唯一消费 `renderMarkdown`；高亮全部走 `codeHighlight.ts` JS 版 / `workers/markdown-render-standalone.ts`）。本批只解除断链状态；接线（streamingCodeHighlighter 走 Rust）或退役交 04-步骤3 幽灵裁决联动（**推荐接线**，与 07 性能维度流式渲染联动，04 ②-2.1 注）。

### 3.2 TelemetryMonitor.ts 五项动作（B2）

| # | 位置（实读） | 改动 | 精确内容 |
|---|---|---|---|
| 1 | :103 | 命令名 | `invokeResult<void>('core_jsonl_append', {...})` |
| 2 | :107 | workspaceRoot 硬编码清除 | `workspaceRoot: getWorkspacePath()?.trim() || undefined`（复用 workspaceFsApi.ts:6-7 再导出的 `getWorkspacePath`；无工作区传 undefined → Rust `for_default_workspace()` 兜底，core_commands.rs:575-578） |
| 3 | :21 | logFilePath 硬编码清除 | 字段保留仅存文件名常量（`telemetry_runtime.jsonl`），flush 时派生完整路径：`root ? \`${root}/logs/telemetry_runtime.jsonl\` : 'logs/telemetry_runtime.jsonl'`；随工作区切换自然更新；相对路径由 Rust 侧按 workspace_root 解析 |
| 4 | :109-116 | missing 分支可观测日志 | 现 `result.status !== 'ok'` 分支只对 `'error'` 打印（:114-116），missing 静默回灌缓冲（:110-113）。补：`else if (result.status === 'missing') { logInternalError('[telemetry] core_jsonl_append missing — telemetry 落盘未生效', { path: logFilePath }); }`，**沿用 :119 的非 test 环境守卫**（`process.env.NODE_ENV !== 'test'`），与既有 catch 分支风格一致，避免 stressFuzzing Probe D（stressFuzzing.test.ts:119-135）测试输出刷屏 |
| 5 | :15/25/72-74 | 缓冲语义 | 1000 条上限 + 10 条触发 flush + 5s 定时 flush **原样保留**（改动 1-4 不动这些行） |

- `logInternalError` 现成工具：userFacingErrors.ts:244-249（`console.warn('[crish-desktop][scope]', …)`，自带 try/catch 兜底，作为 swallow-ok 样板）。
- **接线后果**：错误日志面（全局 error/unhandledrejection 采集，:29-34）从「永久 missing 静默失败」恢复为真实落盘；flush 失败仍回灌缓冲重试（:110-113 语义保留）。

### 3.3 markdown 加速「从未生效 → 修复生效」的验证证明链

原 04 审计判定「从未生效」的证据链：rustCore.ts:171 调 `'md_render'` → Rust 无此 wire 键 → 每次 invoke 都 missing → markdownRenderAsync.ts:44-48 永远走 worker 回退。修复生效需**四层证明**（缺一不可，防假绿灯）：

| 层 | 证明方式 | 断言/命令 |
|---|---|---|
| 1. 调用名 = 真实键 | `markdownRenderAsync.test.ts`「Rust 命中」用例追加 `expect(vi.mocked(invoke)).toHaveBeenCalledWith('core_md_render', { text: 'hi' })` | vitest 绿；调用名断言在真实键上（改名后 mock 键 `core_md_render` 与调用名一致，测试即证明） |
| 2. 真实键路径全绿 | parity / async / test-setup 三个测试文件 mock 键全部改为 `core_md_render`（B3-B6） | `npx vitest run` 三文件全绿；**若 mock 键仍为假键，修复后测试在假键上绿 = 假绿灯**（04 ⑤-1，本批 1c 强制项） |
| 3. 生产代码无旧名 | grep 门禁 | `rg "'md_render'|'highlight_code'|'perf_jsonl_append'" apps/crish-desktop/src` 生产代码零命中（测试面仅经统一 mock helper） |
| 4. 运行时冒烟（本地，不入库） | ① dev 运行 + 打开长会话首屏：首屏 4-15s 卡顿消失（markdown_commands.rs:4 设计意图）；② 可选强证据：在 `markdown_commands.rs:23` 入口临时加 `eprintln!("[probe] md_render called")` 观察 stderr 命中，验证后还原（Rust 零改动仅指提交物）；③ telemetry 验证：dev 触发一次 unhandledrejection，5s 后检查 `<工作区>/logs/telemetry_runtime.jsonl` 真实追加（04 步骤1 判据「本地冒烟」） | 手测 + `Test-Path`/读 JSONL 尾部 |

---

## 4. 测试清单

### 4.1 新增测试

| # | 文件 | 用例 | 断言要点 |
|---|---|---|---|
| 1 | `src/store/messageSnapshotsBridge.test.ts` | 未注入时 save/clear 不抛错且无副作用 | 调用 `saveMessageSnapshot` / `clearMessageSnapshots` 不 throw；无任何实例被创建（不直接断言内部，验证「调用面兼容现状」） |
| 2 | 同上 | 注入后 save 真实入栈 | `bindMessageSnapshotsOps` 注入真 `MessageSnapshots` 适配器 → save → 断言 `getStack(sessionId)` 长度 1、`peekDelta` 的 startIndex/inserted 正确（如 append-tail withdraw：startIndex=2、inserted=['u2','a2'] 形态） |
| 3 | 同上 | clear 清空 | 注入后 save 两次 → `clearSession` → `getStack` 长度 0；`clearSession` 对不存在会话幂等不抛错 |
| 4 | 同上 | 重复注入幂等 | 注入 A → 注入 B（不同实例）→ save 生效且以 B 为准（最后一次为准）；同实例重复注入不报错 |
| 5 | `src/app/__tests__/AppBootstrap.test.ts` | 扩展：bootstrapStores 装配后桥已绑定 | `readFileSync('../store/bootstrapStores.ts')` 断言含 `bindMessageSnapshotsOps(`（沿既有结构断言模式 :27/:92-100） |
| 6 | `src/api/markdownRenderAsync.test.ts` | 扩展「Rust 命中」用例 | `vi.mocked(invoke)` 被以 `'core_md_render'` 调用（沿 test-setup.test.ts:242-250 的 mocked(invoke) 先例） |
| 7（可选） | `src/services/TelemetryMonitor.test.ts` | 接线行为锁 | invoke 收到 `'core_jsonl_append'`；无工作区时 workspaceRoot 为 undefined；missing 状态 → `console.warn`（logInternalError）被调；1000 条缓冲上限保留 |

### 4.2 既有测试回归面（必须全绿）

| 文件 | 回归点 | 说明 |
|---|---|---|
| `src/store/sessionActions.test.ts` | withdrawMessage 既有用例（:836 附近 archive 族 + 撤回相关） | 桥接线后 action 内副作用多走真分支，既有断言必须不破（03 步骤1 验证命令指定三件套） |
| `src/store/layoutStore.test.ts` | 布局 action 回归 | 同上 |
| `src/api/markdownRender.parity.test.ts` / `markdownRenderAsync.test.ts` / `test-setup.test.ts` | 改名后的三态 mock 回归 | mock 键 = 真实键后全绿；`test-setup.test.ts` 的 rustCore 集成段（:262-294）不受影响 |
| `src/__tests__/stressFuzzing.test.ts` | Probe D（:119-135）缓冲 1000 上限 | TelemetryMonitor 改动 1-4 不得破坏；missing 分支日志非 test 守卫保证不刷屏 |

### 4.3 测试用例数口径（R-09 修正）

- `MessageSnapshots.test.ts` 实测 **14 组 `it(`**（2 个 describe），非方案原文「21 组」——R-09 已采纳修正。本批接线相关描述、成本对比引用一律用 **14 组** 口径；接线/退役成本对比结论不受影响（02 评审 P0-2）。

---

## 5. 验证与提交

### 5.1 验证命令（批次 1 门禁）

| 域 | 命令 | 期望 |
|---|---|---|
| 快照桥 | `npx vitest run src/store/messageSnapshotsBridge.test.ts src/store/sessionActions.test.ts src/store/layoutStore.test.ts` | 四断言 + 既有回归全绿 |
| 断链 | `npx vitest run src/api/markdownRender.parity.test.ts src/api/markdownRenderAsync.test.ts src/test-setup.test.ts` | 真实键 mock 全绿 |
| 类型 | `npm run typecheck` + `npm run check:desktop` | 全绿 |
| Rust 回归 | `cargo test --workspace`（在 `apps/agent-workbench` 域执行） | manifest/注册面测试族（`registration_surface_matches_manifest` 等）继续绿——本批 Rust 零改动，仅确认无回归 |
| grep 门禁 1 | `rg "'md_render'|'highlight_code'|'perf_jsonl_append'" apps/crish-desktop/src` | 生产代码零命中（测试面仅统一 mock helper 键 `core_md_render`） |
| grep 门禁 2 | `rg -i "c:/software/conex" apps/crish-desktop/src` | 零命中（双硬编码清除判据） |
| grep 门禁 3 | `rg "messageSnapshotsBridge"` | 仅 bridge / bootstrapStores / 两个 action / 测试命中 |
| 快层口径 | `npm run test:coverage -- --project=unit`（45/70/65/45） | 快层全绿（03 评审⑥-4 强制回归面） |

### 5.2 批次 1 提交清单（两个提交，带批次号）

| 提交 | 文件面 | 提交信息建议 |
|---|---|---|
| 前置 | （非提交）`git restore -- apps/crish-desktop/src/store/messageSnapshotsBridge.ts` | — |
| 提交 A（T-A-1 快照桥） | `store/messageSnapshotsBridge.ts`、`store/bootstrapStores.ts`、`store/messageSnapshotsBridge.test.ts`（新）、`app/__tests__/AppBootstrap.test.ts`、`store/README.md` | `fix(store): wire messageSnapshots bridge with real MessageSnapshots singleton (T-A-1, P0-1)` |
| 提交 B（T-A-2 断链） | `api/rustCore.ts`、`services/TelemetryMonitor.ts`、`test-setup.ts`、`test-setup.test.ts`、`api/markdownRender.parity.test.ts`、`api/markdownRenderAsync.test.ts`、（可选）`services/TelemetryMonitor.test.ts` | `fix(api): repair broken invoke keys core_md_render/core_highlight_code/core_jsonl_append (T-A-2, P0-2)` |

**纪律**：精确 `git add` 本域文件；绝不 `git add .` / `git add -A`（并行域脏文件 R3 等严禁卷入）；禁止 `--no-verify`；两任务文件面互不重叠（`store/` vs `api/`+`services/`），可并行派 2 个 Agent，提交由主控统一执行。

---

## 6. 风险与回退

| # | 风险 | 等级 | 分析与缓解 |
|---|---|---|---|
| 1 | **快照桥接线后行为变化：undo 生产零调用——接线是否引入新行为** | 低 | 实读确认读侧（undo/peek/peekDelta/getStack）生产零调用，接线后**不新增任何 UI 行为**。实际变化仅：① withdrawMessage 每次撤回产生 O(n) 倒向 diff 计算 + 内存快照（上限 5MB / 栈深 20 淘汰内置，MessageSnapshots.ts:139-140）；② deleteSession 真实清栈（原先 no-op）；③ dev 日志一行。**回退 = 移除 bootstrapStores 装配块（约 15 行）**，未注入时桥保持现状 no-op 语义（空安全 `_ops?.`），即「接线是纯增量，回退零成本」（02 评审 ⑥-3）。防线 1 单测锁保证注入丢失即红，不会再次静默失效 |
| 2 | **断链修复后 markdown 渲染路径变化：Rust 渲染首次真正进入主路径** | 中 | 此前所有完成态渲染走 worker（JS），修复后走 Rust（pulldown-cmark + syntect + ammonia）。若 `conex_markdown` 输出与 JS 渲染在个别 case 不一致 → 用户可见差异。缓解：① parity 测试 byte 兼容断言（真实键 mock 下）先于上线红；② `INTENTIONAL_DIFFERENCES` 表（parity 测试 :25-28/88-97）登记已知差异；③ worker fallback 完整保留（markdownRenderAsync.ts:44-48 不动）；④ 差异只在 Rust 侧修，不回退前端（04 ⑥-1）。**highlight 无行为变化**（wrapper 无生产消费者，仅解除断链状态） |
| 3 | **telemetry 接线后真实落盘（敏感面）** | 中 | 从「永远失败」变「真实写入」，errorStack 含路径/上下文落盘。缓解：路径经 `WorkspaceFsGuard` 校验（越界 → InvalidInput，core_commands.rs:580-585），不会静默写盘；5000ms 周期 + 1000 条上限保留可收敛；日志文件落在工作区 `logs/` 下（随工作区切换）；logs 目录轮转策略为工程卫生项，登记不阻断 |
| 4 | **bridge 单测的环境依赖** | 低 | `MessageSnapshots.save` 用 `crypto.randomUUID`（:177），vitest node 环境（Node ≥19）全局可用；测试文件不放 `@vitest-environment jsdom` 头部，走默认 node 环境即可（与 MessageSnapshots.test.ts 同款） |
| 5 | **AppBootstrap.test.ts 结构断言脆弱性** | 低 | 该测试断言 `app.length` 恰为 16（:76）——本批**不新增 AppBootstrap.ts 的 effect**（注入在 bootstrapStores 内部，AppBootstrap.ts:139 调用点不变），故 effect 计数断言不受影响；新增断言只读 bootstrapStores.ts 源文件，路径用 `resolve(__dirname, '../store/bootstrapStores.ts')` 相对解析 |
| 6 | **测试面改名遗漏 → 假绿灯残留** | 低 | 04 ⑤-1 清单 4 文件全覆盖（B3-B6）；改后 grep 门禁 1 复核；`IncrementalMarkdownParser.parity.test.ts:6` 注释已用 `core_md_render`（无需改）；workers/*.ts、api/markdownRender.ts 的注释为反引号描述性文字（不含 `'md_render'` 字面量），不触发 grep 门禁，可顺手更正但不强制 |
| 7 | **与并行轮次（R3 markdown-editor）的提交混入** | 中 | 工作区存在 R3 未提交面（buffer.rs、Cargo.*、AGENTS.md 等）与未跟踪并行域（crates/conex-browser*、apps/crish-mobile/）。本批**严禁**整体提交；精确 add 后 `git status` 复核；提交信息带批次号（00 §3-5） |

---

## 附：本计划的关键实读证据索引

| 事实 | 证据 |
|---|---|
| 桥无注入缝隙、`const _ops = null` | messageSnapshotsBridge.ts:31（且工作区有未提交 `let→const` 脏 diff） |
| 保存侧载荷完整 | sessionMessageActions.ts:91-125（slice + pinned 深拷贝 + toolCalls.diffs 路径收集 + afterMessages） |
| 清栈侧 | sessionCrudActions.ts:441-444（removed 后 clear） |
| 读侧生产零调用 | 全仓 grep（非测试文件）零命中 |
| 14 组测试（R-09） | MessageSnapshots.test.ts：14 个 `it(`、2 个 describe |
| Rust wire 键 | markdown_commands.rs:22（core_md_render）、:67（core_highlight_code）；main.rs:190、command_manifest.rs:162（core_jsonl_append） |
| jsonl 签名与兜底 | core_commands.rs:546-551、575-578；perf/jsonl.rs:5-7（迁移责任注释） |
| 断链字面量 | rustCore.ts:171/:186；注释漂移 :157 |
| telemetry 双硬编码 + missing 静默 | TelemetryMonitor.ts:21/:103/:107；:109-116 仅 error 分支打印 |
| 消费链就绪 | markdownRenderAsync.ts:39-48（Rust 优先 + worker 回退） |
| mock 假键面 | test-setup.ts:57-58/76/90-91；test-setup.test.ts:45/50/116/118；parity:109/132/166；async:54-194（13 处） |
| 装配点 | bootstrapStores.ts:71-75（initStoreAccess 旁）；调用点 AppBootstrap.ts:139 |
| logInternalError | userFacingErrors.ts:244-249 |
| 工作区脏状态 | `git status` 实测（本文件 + R3 并行域面） |
