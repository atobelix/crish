# AV · 移除 avatar-studio

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. D2 已决：整体删除。不要整理工具链、不要开 strict、不要清死代码后保留应用。
> 2. 禁止作弊：不放宽 knip、token、lint、typecheck。基线只删不增。
> 3. 一个删除提交，然后 AV-P2 只验证、不提交。提交：`refactor(AV-P1): 移除无人引用的 avatar-studio [BATCH-AVATAR-STUDIO-REMOVAL]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-avatar`，分支 `refactor/avatar-studio-removal`。不在主仓库删除任何文件。主仓库里被 gitignore 的 `apps/avatar-studio/node_modules` 和 `dist` 留给用户在合入 main 之后自行删除。
> 5. 进度写 `C:\Users\orange\conex-review\plans\avatar-studio删除.progress.md`。
> 6. Node 24。不跑 cargo。
> 7. 恢复点写进提交说明：`git checkout edf23de8c -- apps/avatar-studio`。

| 项 | 值 |
|---|---|
| 方案代号 | `AV` |
| 波次 | W4。门控 G-AV 编写时已满足，开工前重跑 |
| 已决 | **D2 = 整体移除** `apps/avatar-studio` |

依据：ROADMAP §5.1 与 §9.2 D2。不另有 `plans\` 长文，本文件就是执行方案。

## a. 范围

独立 Vite 应用，不在根 workspaces 里，自带 lockfile。desktop、tauri、mobile、packages 都没有引用它。非 md 文件里的引用只有：

- `knip.config.ts` 里忽略 `apps/avatar-studio/**` 的注释和条目（编写时约 82–87 行）
- `scripts/check-token-consistency.mjs` 的默认扫描根（编写时约 90–93 行）
- `docs/multi-agent-repair/基线记录/token-consistency-baseline.md` 里 2 条 avatar-studio 记录

没有 CI 构建，产品里没有入口。`knip.config.ts` 的注释把它登记为「孤岛应用……暂缓处理」。D2 就是这个裁决。

工具链已经分叉（TS、React、tsconfig 非 strict，见 g7 BS-04/05/06），并含约 6.6k 行死文件（AV-02）。最近一次提交 `edf23de8c`（10-22）只给一个本身没人 import 的 `avatarHome.ts` 加了 JSON。

可改：`apps/avatar-studio`（`git rm -r`）、上面三个引用点。其他文件不改。

## b. 问题清单

| # | 结论 |
|---|---|
| AV-01 | 产品无入口的孤岛应用。删除不丢用户可见功能，git 历史保留 |
| AV-02 | 大量死文件。随应用一起删除，不单独清 |
| AV-03..06 | 工具链分叉。删除后不再需要对齐根仓库的 TS / React / strict |

开工前复核引用面：

```powershell
rg -n "avatar-studio" --glob "!*.md" --glob "!**/node_modules/**"
# 期望只剩 knip.config.ts 与 check-token-consistency.mjs
```

若出现产品入口（desktop 路由、tauri 命令、CI 作业），停工，不要删。

## c. 目标架构

仓库里没有 `apps/avatar-studio`。knip 不再忽略它。token 扫描根只保留桌面端。没有替代包，没有重导出。

## d. 删除清单

- `git rm -r apps/avatar-studio`（编写时 44 个跟踪文件，约 26k 行）
- `knip.config.ts` 里对应注释和 `'apps/avatar-studio/**'` 条目
- `scripts/check-token-consistency.mjs` 的扫描根只留桌面端，并改掉注释
- token 基线里 avatar-studio 的 2 条，只删不增

## e. 分阶段步骤

**AV-P1 · 删除**（一个提交）
- 按 d 节执行。
- 提交说明包含恢复点 `git checkout edf23de8c -- apps/avatar-studio`。
- 判据：§i 的探针。

**AV-P2 · 验证，不提交**
- 跑 §h。失败就在同一分支上用 `refactor(AV-P1): fixup …` 修，不 amend 已被引用的提交。

## f. 禁止事项

不在主仓库执行 `git rm` 或删除 `node_modules`。不新增 knip ignore。不改 token 脚本的判定去放行其他应用。不把 avatar-studio 的源码挪到别的目录「先留着」。

## g. 项目规范

删除后 `npx knip`、`node scripts/check-token-consistency.mjs`、`npm run lint`、`npm run typecheck`、`npm run check:line-counts` 全绿。基线 diff 只允许删除。

## h. 集中测试

```powershell
npx knip
node scripts/check-token-consistency.mjs
npm run lint
npm run typecheck
npm run check:line-counts
```

## i. 审计清单

`$B = refactor/avatar-studio-removal`。

```powershell
git -C C:\Software\conex ls-tree -d $B apps/avatar-studio
# 无输出
git -C C:\Software\conex grep -nE "avatar-studio" $B -- ":!*.md"
# 0。基线 4 处：knip.config.ts 两处、check-token-consistency.mjs 两处
git -C C:\Software\conex grep -n "avatar-studio" $B -- "docs/multi-agent-repair/基线记录/token-consistency-baseline.md"
# 0。基线 2 条，只删不增
```

- [ ] A1 探针达到预期
- [ ] A2 基线 diff 没有新增行
- [ ] A3 改动文件只有 a 节列出的那些
- [ ] A4 提交说明里有恢复点

## j. 门控

**G-AV**：

```powershell
git -C C:\Software\conex status --porcelain -- apps/avatar-studio knip.config.ts scripts/check-token-consistency.mjs "docs/multi-agent-repair/基线记录/token-consistency-baseline.md"
# 必须为空
```

编写时（ROADMAP 07:05）这条为空。开工前重跑。与其他模块没有源码交叉。可以和 Rust 模块并行，但不要同时跑会写同一份 lock 的 npm 命令。本方案不改 lock。

## k. 已决事项

D2 = 整体移除。不存在「保留并整理」的阶段。没有剩余的「待用户决策」。
