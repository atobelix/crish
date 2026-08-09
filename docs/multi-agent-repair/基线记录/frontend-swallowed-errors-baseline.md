# 前端吞错基线（no-silent-catch · frontend swallowed errors）

> 归属：05 代码质量方案（`docs/frontend-audit/20-proposals/05-code-quality-proposal.md` 步骤①③）· 批次 7.3
> 日期：2026-08-10（建线）· 维护：`node scripts/check-swallowed-errors-frontend.mjs [--update]`
> 语义：统计全仓 TS/TSX **生产代码**（测试文件豁免，同 eslint 配置豁免面）的
> "未注解空 catch"：① 空 catch 块（无绑定/有绑定，body 无语句或仅 EmptyStatement）；
> ② Promise 链静默 `.catch(() => {})` / `.catch((e) => {})`（空体）。
> 注释豁免：**阶段 A**（当前）body 内有任意注释即视为已注解（不计数）；
> **阶段 B**（清零后切换 `markerRequired: true`）仅 `/* swallow-ok: 原因 */` marker 豁免。
> 门禁：eslint 本地规则 `local/no-silent-catch`（lint:all / CI lint job 自动生效，零新增 job）；
> 任一文件未注解空 catch 数 > 基线 → lint fail（ratchet）；无基线条目的文件零容忍。
> 本文件为量化数据文件，标记区由脚本维护；正文表格为验收时点口径，以标记区为准。

## 口径说明（与审计 10-analysis/05-code-quality-audit.md 的差异）

- 审计口径：306 空 catch = 空体 **含仅注释体**（289 无绑定 + 17 有绑定）+ 33 处 `.catch(() => {})`；
- 门禁口径（本基线）：**排除仅注释体**（阶段 A 注释即注解），且以 eslint 规则 AST 形态为准
  （`.catch((e) => {})` 一并计入）。故本基线计数 < 审计 306，差异即基线的一部分；
  后续收紧以规则自身口径为门禁事实（05 方案 §3.3 定案）。
- 测试文件（*.test.ts(x) / *.spec.ts / __tests__ / tests/ / test-utils）不计入门禁（对标
  Rust check-swallowed-errors 的测试豁免语义）；审计 306 亦为生产口径，两者一致。
- 阶段 A 下"有注释的空 catch"不在此基线内，也不被门禁拦截；阶段 B 切换后所有空 catch
  必须带 `swallow-ok` marker——届时本基线将归零。

## 生产代码计数（门禁口径，2026-08-10 建线）

| 文件（相对仓库根） | 未注解空 catch |
|---|---|
| （见下方标记区，脚本维护） | — |

合计：未注解空 catch **N** 处（N 个文件）。高发榜前 10 见治理记录。

## 治理记录（步骤③分批清零）

- 2026-08-10（批次 7.3 第一批）：基线建线（阶段 A）；第一批清理文件清单
  （TerminalCard.xterm.tsx / sessionRustDb.ts / sessionLocalStorage.ts / profileStore.ts /
  fontStore.ts / previewBrowserStore.ts / themeStore.ts / ConnectionLifecycle.ts /
  CrossTabCoordinator.ts —— useStreamCallbacks.ts 因并行域改动延后）→ `--update` 收紧基线。
- 未决：`useStreamCallbacks.ts`（并行域 M 状态）、`bootstrap-services.ts:81/116` 与
  `bootstrap-full.ts:8`（03-D2 独占裁决 P0-3，05 步骤③ grep 实测剔除）留待后续批次。

<!-- BASELINE_START -->
apps/crish-desktop/src/bootstrap-full.ts 1
apps/crish-desktop/src/components/files/FileActions.tsx 3
apps/crish-desktop/src/components/files/FileViewerCard.tsx 2
apps/crish-desktop/src/components/files/FilesCard.tsx 1
apps/crish-desktop/src/components/settings/SettingsShortcutsTab.tsx 1
<!-- BASELINE_END -->
