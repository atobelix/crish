# 启动迁移注册表（MIG）

> **给执行 AI 的硬性规则**
> 1. 启动迁移只有一处按顺序调用。不在模块 import 时跑。不留动态「也许没有这个导出」。
> 2. 禁止作弊：不加 `eslint-disable` / `@ts-ignore` / `@ts-expect-error`；不调基线；不删断言；不用 `--no-verify`。
> 3. `npm run typecheck` / `lint` / `test` 只在 MIG-P4。Node 24。
> 4. 每阶段一提交：`refactor(MIG-P<n>): <中文摘要> [BATCH-DESKTOP-MIGRATIONS]`。
> 5. 只在 `C:\Users\orange\rf-mig` 改。不 stash、不 push、不动主仓库。
> 6. 不改 `sessionShellKeyMigration` 与 `sessionStore.ts`。那是 SS，D4 已决。
> 7. 行号是 2026-10-29 快照（HEAD `bf3d60fa3`）。按函数名 `rg` 重定位。

| 项 | 值 |
|---|---|
| 代号 | MIG |
| 分支 | `refactor/desktop-migrations` |
| worktree | `C:\Users\orange\rf-mig` |
| 批次标签 | `[BATCH-DESKTOP-MIGRATIONS]` |
| 进度 | 同目录 `desktop-startup-migrations.progress.md`（写在 worktree，不写主仓库） |
| 基点 | CF 合入之后再改 `entry-core.tsx`。SS 合入之后也不要回头改 shell key |

## a. 范围与门控

### a.1 纳入
把仍由启动路径散落调用的一次性迁移收进一个注册表，并改掉 import 期副作用与动态取函数。

| 函数 | 现在的调用 | 本模块 |
|---|---|---|
| `ensureSessionStoreShellKeyMigrated` | `sessionStore.ts` 模块体直接调用 | **不碰**。D4：SS 移到 `bootstrapStores` |
| `migrateLegacyUsageHistory` | `entry-core.tsx` 动态 import | 纳入 |
| `migrateLegacyLsPrices` | `bootstrap-full.ts` 动态 import | 纳入 |
| `migrateLegacyProfiles` | `AppBootstrap.ts` 里 `void` 且不 await | 纳入，改为 await |
| `migrateToLeafOwnedTabs` | `hydrateWorkspaceShell.ts` 用断言从包对象上取；`layoutTreeHydrateHelpers.ts` 另有静态调用 | 只留注册表一次静态调用 |
| `migrateFromLocalStorage` / `cleanupLegacyLocalStorageSessions` | `api/session-persistence/migrateFromLocalStorage.ts` | 纳入。不改 `sessionDeltaWriteBarrier.ts` |
| `cleanupLegacyLocalStorageSessionsGuarded` | `sessionRustDbLegacyCleanup.ts` | 纳入 |
| `migrateLegacyDockStateToV2` 与 `sessionTabMigration.ts` | layout-tree，557 行 | 纳入 L-01 |
| 两份 `layoutRestorePolicy.ts` | `store/layout-tree` 与 `store/workspace-shell` | 一并收成一份（L-02，挂在同一次布局启动上） |

### a.2 不纳入
- SS：`store/sessionStore.ts`、`store/bootstrapStores.ts`、`api/session-persistence/sessionShellKeyMigration.ts`、`sessionDeltaWriteBarrier.ts`、`storeAccess`、流式 hook、取消链。
- CF：conversation-flow、`renderThought`。只是 `entry-core.tsx` 可能同一文件，等 CF 合入再改其中的 usage 迁移调用。
- IPC：不改命令清单，不改 `ipc.call`。
- 不新做「迁移版本数据库」或双写旧 localStorage。

### a.3 门控
编写时下列路径 porcelain 为空：`store/layout-tree`、`store/workspace-shell`、`app/hydrateWorkspaceShell.ts`、`app/AppBootstrap.ts`、`bootstrap-full.ts`、`entry-core.tsx`、`api/modelPricingSource.ts`、`api/provider-profiles/migrateLegacyProfiles.ts`、`api/usage`、`api/session-persistence`。每阶段仍重跑：

```
git -C C:\Software\conex status --porcelain -- apps/crish-desktop/src/entry-core.tsx apps/crish-desktop/src/app apps/crish-desktop/src/bootstrap-full.ts apps/crish-desktop/src/store/layout-tree apps/crish-desktop/src/store/workspace-shell apps/crish-desktop/src/api/session-persistence apps/crish-desktop/src/api/usage apps/crish-desktop/src/api/modelPricingSource.ts
```

非空则停。`entry-core.tsx` 还要求 CF 已合入。

## b. 核实表

| 编号 | 结论 | 证据 |
|---|---|---|
| B-01 shell key | 仍在，但 **不做** | `sessionStore.ts` import 后立刻 `ensureSessionStoreShellKeyMigrated()`。函数在 `sessionShellKeyMigration.ts`。D4 已把调用点改派给 SS |
| B-01 usage | 仍存在 | `entry-core.tsx` 动态 `import('./api/usage/legacyUsageMigration')` 再 `migrateLegacyUsageHistory()` |
| B-01 价格 | 仍存在 | `bootstrap-full.ts` 动态 import `migrateLegacyLsPrices` |
| B-01 profiles | 仍存在 | `AppBootstrap.ts`：`void import(...).then(({ migrateLegacyProfiles }) => { void migrateLegacyProfiles(); })`，不 await |
| B-01 叶标签 | 仍存在 | `hydrateWorkspaceShell.ts`：`(layoutTreePkg as { migrateToLeafOwnedTabs?: MigrateFn }).migrateToLeafOwnedTabs`。同函数在 `layoutTreeHydrateHelpers.ts` 静态调用，两条路 |
| B-01 localStorage | 仍存在 | `migrateFromLocalStorage.ts` 的 `cleanupLegacyLocalStorageSessions` 转到 `cleanupLegacyLocalStorageSessionsGuarded` |
| B-02 | 仍存在 | 上面的可选链断言。函数是静态可导入的 |
| B-03 | 不做 | `compositionRoot` 服务定位与 store 门面归 SS。本模块不改 |
| L-01 | 仍存在 | `sessionTabMigration.ts` 物理 557 行。文件头仍是 v2→v3 一次迁移。`LegacyOpenTab` 在该文件。`migrateLegacyDockStateToV2` 定义在 `sessionTabModel.ts`，本文件再导出 |
| L-02 | 仍存在 | 两个 `layoutRestorePolicy.ts` 路径都在（layout-tree 与 workspace-shell） |

## c. 目标架构

`app/migrations/registry.ts` 导出 `runStartupMigrations(): Promise<void>`。`AppBootstrap` 在布局水合之前 `await` 它一次。注册表是一张显式数组，元素是 `{ id, run }`。顺序写死在数组里，不靠 import 副作用。

每个仍需保留的迁移在文件顶上有 `introduced` 与 `removeAfter` 常量（发布版本或提交说明里的产品版本字符串，与代码里已有的版本常量对齐；没有就不编造 semver，用注册表里的字面量并在测试里快照）。本方案**不**用 `Date.now()` 在 CI 里自动失败。

数据迁移（localStorage → SQLite、旧价格、旧 profile、旧 dock）在无法证明旧键已经没有写入者时，本体保留，但只从注册表进入。P0 若证明旧键写入为 0 且读取只剩迁移本身，则连迁移带「旧形状仍可读」的分支一起删，不留空函数。

`migrateToLeafOwnedTabs` 与 `migrateLegacyDockStateToV2` 只从注册表静态 import。`hydrateWorkspaceShell` 不再取可选函数，也不再自己迁移。

`layoutRestorePolicy` 只留 hydrate 实际调用的那一份。另一份删除，不 re-export。

`sessionShellKeyMigration` 不出现在这张表里。SS 的 `bootstrapStores` 单独调用。两边不要互相 import 来「排顺序」。

## d. 删除清单

- `hydrateWorkspaceShell.ts` 里的 `as { migrateToLeafOwnedTabs?: ... }` 动态取值。
- `entry-core.tsx`、`bootstrap-full.ts`、`AppBootstrap.ts` 里分散的迁移 import。调用只留 `runStartupMigrations`。
- `layoutTreeHydrateHelpers.ts` 里对 `migrateToLeafOwnedTabs` 的第二次调用（若它只是重复水合；P0 读调用点，若是纯函数在测试里用，生产只留一次）。
- 被证明无写入者的迁移整文件，及其专测里的旧形状。不能证明的不删。
- 多余的那份 `layoutRestorePolicy.ts`。
- 禁止留下 `runStartupMigrations` 再转调「兼容旧入口」的包装。

不删：`sessionShellKeyMigration.ts`；仍有真实旧数据要读的迁移函数；用户数据本身。

## e. 分阶段与探针

**MIG-P0** 不改代码。对每个旧 localStorage / persist 键 `rg` 写入点。写入只在迁移文件内部 → 标记可删。仍有生产写入 → 留在注册表。记下 `migrateLegacyProfiles` 失败是否被吞掉（现在 `void`）。进度里写「可删 / 保留」表。diff 两份 `layoutRestorePolicy`，决定留哪一份（以生产 import 为准）。

**MIG-P1** 新增注册表并把 a.1 里除 shell key、除 L-01 文件搬移以外的调用改进去。`migrateLegacyProfiles` 在启动函数里 await，错误进入现有 logger，不 `void` 掉。`hydrateWorkspaceShell` 改为静态 import 的已迁移状态，或不再迁移、只读注册表已经写好的状态。二者选「只跑一次」的那种，不要两处都跑。探针：

```
rg -n "ensureSessionStoreShellKeyMigrated" apps/crish-desktop/src
rg -n "migrateToLeafOwnedTabs\?:" apps/crish-desktop/src
rg -n "void migrateLegacyProfiles|migrateLegacyUsageHistory|migrateLegacyLsPrices" apps/crish-desktop/src -g "!**/migrations/**" -g "!**/*test*"
```

第一行只命中 SS 的文件（`sessionStore.ts` 或已迁到 `bootstrapStores.ts`），本模块 diff 不包含它们。第二行 0。第三行生产 0（定义可以在 migrations 目录）。

**MIG-P2** `sessionTabMigration.ts` 的生产入口只从注册表调用。删掉重复导出链：`sessionTabMigration.ts` 不再为了「路径不变」而 `export { migrateLegacyDockStateToV2 }`。调用方改从一个模块导入。文件仍可能 > 400 行：按职责拆成 `readLegacyDock` 与 `toLeafTabs`，不改转换结果。现有 `sessionTabMigration.test.ts` 断言保持。合并 `layoutRestorePolicy`。探针：`rg -n "layoutRestorePolicy" apps/crish-desktop/src -g "!**/*test*"` 只命中一个文件；`rg -n "from '\./sessionTabMigration'" apps/crish-desktop/src` 生产只命中注册表。

**MIG-P3** 按 P0 的「可删」表删除那些迁移与只为它们存在的测试。保留测试里对「当前形状」的断言。探针：可删 id 在 `rg` 中为 0。

**MIG-P4** §h。

## f. 禁止捷径

- 不把 `ensureSessionStoreShellKeyMigrated()` 挪到注册表「顺便完成 D4」。D4 的调用点是 `bootstrapStores`，执行人是 SS。
- 不留 `as { migrateToLeafOwnedTabs?: ... }` 再加一个静态 import。
- 不留空的 `run()` 占位以维持 id。
- 不用 `Date.now()` 让 CI 在某一天突然失败来假装截止。
- 不把迁移失败写成 `catch {}`。现有测试若断言「失败不阻塞启动」，保留这个行为但要有日志，不许新增空 catch。
- 不加 eslint-disable / ts-expect-error。动态 import 改静态 import 即可，不需要 expect-error。
- 不调行数基线。557 行靠拆文件下降，不靠把上限改成 557。

## g. 规范

业务 ts ≤ 400，硬阻断 > 650。`sessionTabMigration.ts` 现 557，P2 必须降到 400 以下或至少降到基线以下且不超过硬阻断；目标是 ≤ 400。`npm run check:line-counts` 基线只降。`npx knip` 无新未使用导出。启动代码保持 TypeScript strict。

## h. 测试

只在 MIG-P4，worktree，Node 24：

```
npm run typecheck
npm run lint
npm run test
npm run check:line-counts
npx knip
```

回归：R1 旧 dock 金样（现有 sessionTabMigration 测试）结果不变；R2 第二次启动不再重复迁移（幂等测试）；R3 `migrateLegacyProfiles` 失败时启动路径能看见日志而不是未处理的 void；R4 shell key 行为的测试仍由 SS 的文件覆盖，本模块 diff 不改那些断言。

## i. 审计

- [ ] A1 diff 不含 `sessionStore.ts`、`sessionShellKeyMigration.ts`、`bootstrapStores.ts`
- [ ] A2 生产代码不在 import 顶层调用迁移（注册表函数体内除外）
- [ ] A3 无动态可选 `migrateToLeafOwnedTabs`
- [ ] A4 `layoutRestorePolicy.ts` 只剩一个路径
- [ ] A5 无新的空 catch、eslint-disable、ts-expect-error
- [ ] A6 P0 标成可删的迁移没有残留；标成保留的仍只有注册表一个入口

## j. 与 SS/CF/ST 的文件冲突

- SS 独占 shell key、`bootstrapStores`、`sessionStore`、`session-persistence` 里的写屏障与 stream 管理。本模块可以改 `migrateFromLocalStorage.ts` 与 `sessionRustDbLegacyCleanup.ts`，但必须等 SS 合入，且 diff 不得包含 `sessionDeltaWriteBarrier.ts`。若 SS 的未提交范围盖住整个 `session-persistence` 目录，停。
- CF 改 `entry-core.tsx` 的激活段。MIG-P1 对这个文件的编辑放在 CF 合入之后。
- ST 不碰启动迁移。无类型生成。
- IPC 明确不做注册表。不要两边各写一个 `runStartupMigrations`。
- MD / UI / I18N 不改这些文件。I18N 若要抽迁移日志里的中文，等 MIG-P4 之后。

## k. 已决

- D4：`sessionShellKeyMigration` 移到 `bootstrapStores`，归 SS。本方案不实现 D4，也不在 import 期再留一次调用。
- D1 与迁移无关。不删 conversation-flow。
- 注册表不是 IPC 的步骤。IPC 方案禁止顺手做这件事。
- 不能证明旧数据已经不可能出现时，不删迁移本体。这不是兼容层，是还没跑完的一次性数据搬运。能证明没有写入者时必须删，不留空壳。
