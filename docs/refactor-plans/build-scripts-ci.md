# 构建、脚本与包边界 · 实施方案

> 模块代号：**BLD**　分支：`refactor/build-scripts`　worktree：`C:\Users\orange\rf-bld`　批次标签：`[BATCH-BUILD-SCRIPTS]`
> 波次：W5。提交：`refactor(BLD-P<n>): <摘要> [BATCH-BUILD-SCRIPTS]`
> 进度写 worktree 同目录 `build-scripts-ci.progress.md`。依据：g7（只作线索）+ 2026-10-29 工作区核实（HEAD `bf3d60fa3`）。
> **不做** ST-01（归 ST）。**不做** CF-01..03（conversation-flow 的类型副本、humanize、死导出归 CF 删除）。**不做** AV（D2 整体删除 avatar-studio，本方案不把它收进 workspaces，也不整理死文件）。

## 硬性规则
1. 只看代码与配置，不看仓库文档来决定设计。基线文件只当数据读。
2. 彻底改进：一种包解析、一个严格 tsconfig、一套 vitest，不留垫片。
3. 非必要不兼容：假 build、幽灵依赖、里程碑常量、re-export 垫片都删。
4. 测试只在 BLD-P7 集中跑。
5. 每阶段一个提交。
6. 禁止作弊：不改守卫的判定去放行，不抬高基线，不加 ignore / skip / continue-on-error / `--no-verify`。
7. 不 stash，不 push，不用 gh。主仓库只读。

## a. 范围与门控
可改：根 `package.json`、`package-lock.json`、`turbo.json`、`tsconfig.base.json`、`vitest.config.ts`、`knip.config.ts`；`packages/block-paper`、`block-paper-contract`、`editor-kit`、`shared-utils`、`plugin-import-claude-codex`、`test-utils`；`apps/crish-desktop` 里与 alias、basename、虚拟滚动、intentId 直接相关的文件；`scripts/**` 与 `.github`；`analysis/`、根目录 `markdown-editor.html`、`premium-markdown.css` 的 git 跟踪状态。

不改：`packages/shared-types` 的手写类型与生成类型（ST）；`packages/conversation-flow` 与其 vite alias、workspaces 条目、typecheck 条目（CF 删）；`apps/avatar-studio`；`apps/crish-mobile/**`（MB。根 typecheck 把 mobile 加进命令是本方案，mobile 源码不改）；`apps/agent-workbench/src-tauri`。

**门控 G-BLD（编写时未满足，不要开工）：**
```
git -C C:\Software\conex status --porcelain -- scripts package.json package-lock.json .github turbo.json tsconfig.base.json vitest.config.ts apps/crish-desktop/package.json apps/crish-desktop/vite.config.ts apps/crish-desktop/tsconfig.app.json
```
必须为空。编写时：根 `package.json`、lock、desktop `package.json`、`vite.config.ts` 为 `M`；`scripts/check-blocked-executable-ssot.mjs` 与 `check-provider-single-track.mjs` 为 `M`；`.github` 为空。后两个脚本若仍脏，本方案不改它们的判定。

## b. 核实表
rg 根为 `C:\Software\conex`。

| ID | 结论 | 锚点 | rg |
|---|---|---|---|
| BS-01 | 仍存在 | 源码直出：block-paper 等 `"main": "./src/index.ts"`；shared-types/utils 走 dist + `development`；vite `resolve.alias` 手写到 src（无 plugin-import）；jest `moduleNameMapper` 只映射 shared-types 与 shared-utils；metro 无 `conditionNames` | `rg -n "\"main\":" packages/*/package.json`；`rg -n "alias:" apps/crish-desktop/vite.config.ts` |
| BS-02 | 仍存在 | desktop 多处 `import … from '@crish/plugin-import-claude-codex'`，`package.json` dependencies 无此包；mobile `eventReducers.ts`、`TerminalView.tsx` 引用 `@crish/shared-utils`，mobile `package.json` 只声明 shared-types。mobile 声明的落盘归 MB 门控，本方案只在根与 desktop | `rg -n "plugin-import-claude-codex" apps/crish-desktop/package.json apps/crish-desktop/src` |
| BS-03 | 仍存在 | block-paper `build` 为 `tsc --noEmit`；test-utils `clean` 调未声明的 rimraf；plugin-import 无 scripts，依赖 `"file:../shared-types"`；desktop 也是 `file:` | 各 `package.json` |
| BS-04 | 仍存在 | `tsconfig.base.json` `exactOptionalPropertyTypes: true`；plugin-import 与 desktop `tsconfig.app.json` 设为 false；desktop `noUnusedLocals: false` | `rg -n "exactOptionalPropertyTypes" --glob tsconfig*.json` |
| BS-05 | 部分过期 | **误报部分**：mobile 已在根 workspaces。**仍存在**：根 `typecheck` 脚本不含 crish-mobile；workspaces 仍无 avatar-studio（保持，归 AV 删除）与 `scripts/mock-daemon` | 根 `package.json` 的 `workspaces` 与 `typecheck` |
| BS-06 | 仍存在 | 根 typescript `^5.9.2`，mobile `~6.0.3`；根 react `19.2.3`；mock-daemon engines `node >=22`，根 `@types/node` `^25`，根 engines `^24.3.0` | 三个 `package.json` |
| BS-07 | 仍存在 | 根 `vitest.config.ts` 与包内 config 均有 `retry: 2`；包测试脚本指向根配置 | `rg -n "retry:" vitest.config.ts packages/*/vitest.config.ts` |
| BS-08 | 仍存在 | `turbo.json` 的 `typecheck` 依赖 `build:types`；只有 shared-types/utils 实现 build:types / build:js | `turbo.json` |
| BS-09 | 仍存在 | `shared-utils` `build:js` 为 `esbuild … --platform=node`；根 `index.ts` 导出 `detectHardware`、`usePlatformAdaptation`；`node-index.ts` 注释仍写不存在的 agent-daemon / agent-runtime | `packages/shared-utils/package.json`、`src/index.ts`、`src/node-index.ts` |
| BP-01 | 仍存在 | Rust `op.rs` `Op::TurnInto`；TS `opsWire.ts` 只有 insert/update_props/patch_attrs/move/delete/text_edit；`contract.smoke.ts` 的 `sampleIntents` 用 `{ kind:'turn_into', blockId, flavour }` | `rg -n "TurnInto|op: 'insert'" crates/conex-doc-collab/src/op.rs packages/block-paper-contract/src/opsWire.ts` |
| BP-02 | 仍存在 | `block-paper/src/index.ts` 导出 `createSilentFixture`、`createMockIntentSink`；`imeMatrix.ts` 导出 `IME_MATRIX_PACKAGE_TRACK` | `rg -n "createMockIntentSink|IME_MATRIX_PACKAGE_TRACK" packages` |
| BP-03 | 仍存在 | `editor-kit/src/diff/diffToReplace.ts` 与 `block-paper/src/leaves/pm/diffToReplace.ts` 都只 re-export contract | 这两个文件的文件头 |
| BP-04 | 仍存在 | `HeightMap`（editor-kit）与 `VirtualScrollManager`（desktop `api/VirtualScrollManager.ts`） | `rg -n "class HeightMap|class VirtualScrollManager" packages apps/crish-desktop/src` |
| BP-05 | 仍存在 | `nextIntentId` 模块计数器；`turnIntoIntent.ts` 等默认用它 | `rg -n "function nextIntentId|export function nextIntentId" packages/block-paper/src` |
| BP-06 | 仍存在 | desktop 生产对 editor-kit 的使用面窄（HeightMap / queryViewport 一类） | P0 用 import 图重数，不凭 g7 的 1 处数字 |
| SU-01 | 仍存在 | `usePlatformAdaptation` 仅 `App.tsx` 调用；`usePlatformAdaptationCtx` 无生产调用 | `rg -n "usePlatformAdaptation\(|usePlatformAdaptationCtx\(" apps packages` |
| SU-02 | 仍存在 | `wal.ts`、`fsync.ts`、`node-index.ts` 仍在；注释指向已不存在的包 | `rg -n "agent-daemon" packages/shared-utils/src/node-index.ts` |
| SU-03 | 仍存在 | 根 index 仍导出 `PrometheusMetricsExporter`、`ObjectPool` | `packages/shared-utils/src/index.ts` |
| SU-04 | 仍存在 | `eventReducers.ts` 全文 re-export `@crish/shared-utils`。文件在 mobile，**本方案不改**；shared-utils 侧若仅 mobile 使用，等 MB 门控后由 MB 决定搬回或留下。BLD 不在 shared-utils 再包一层 | 见 MB |
| SU-05 | 仍存在 | `basename` 多份：`toolArgsNormalizer.ts`、`skillsApiHelpers.ts`、`overview/helpers.ts`、diff 三个视图。`conversation-flow/humanize.ts` 那份归 CF，本方案不改 | `rg -n "function basename" apps/crish-desktop/src packages/shared-utils/src` |
| PI-01 | 仍存在 | 无 scripts；desktop 未声明依赖；vite 无 alias | plugin-import `package.json` |
| PI-02 | 仍存在 | `inferSep`、`joinImportPath` | `packages/plugin-import-claude-codex/src/detect.ts` |
| PI-03 | 仍存在（P0 重数死导出） | 静默 catch 与未用导出 | P0 `rg` 导出名单 |
| TU-01 | 仍存在 | 唯一消费方是 desktop integration setup；`build` 为 `tsc --noEmit`；`clean` 用 rimraf | `rg -n "@crish/test-utils" apps packages` |
| SC-01 | 仍存在 | `scripts/inspections-output.json` 仍跟踪 | `git ls-files scripts/inspections-output.json` |
| SC-02 | 仍存在 | 多个 `check-*` 自写遍历；根 `check:desktop` 是长 `&&` 链 | `package.json` 的 `check:desktop` |
| SC-03 | **部分成立，仍要做** | 见 e 的 P1。不是每个脚本都静默放行 | 下节 |
| SC-04 | 仍存在 | `scripts/mock-daemon/package-lock.json` 在；engines `>=22`；不在 workspaces | 该目录 |
| SC-05 | 仍存在 | `diff:save` 写到 `.agent-outputs` | 根 `package.json` |
| RH-01 | 仍存在 | `analysis/` 目录在 | `git ls-files analysis` |
| RH-02 | 仍存在 | `.gitignore` 仍有 `/model-price-data/**` 与 `.vscode/*` 例外 | `.gitignore` |
| RH-03 | 仍存在（P0 列跟踪清单，不凭 g7 的 316/59） | `.agents`、`skill` | `git ls-files .agents skill` |
| RH-04 | 仍存在 | 根 `markdown-editor.html`、`premium-markdown.css` 存在 | 两文件 |
| ST-01 | 归 ST | 不列入本方案阶段 | — |
| ST-02 | 归 ST | device/engine 重复生成物不在此重做 | — |
| CF-01..03 | 归 CF | `packages/conversation-flow/src/types.ts`、`humanize.ts` 不改 | — |

**SC-03 核实（2026-10-29）：**
- `check-crate-size.mjs` `parseBaseline`：缺文件或缺标记 → `process.exit(1)`。不是静默放行。基线仍在 `docs/multi-agent-repair/基线记录/crate-size-baseline.md`。`--update` 会把当前超限行数写回，**可以变大**。
- `check-line-counts.mjs` `parseBaseline`：返回 null 时当成没有基线继续跑（豁免消失，坏文件本身不一定非零）。基线在 `frontend-line-counts-baseline.md`。
- `check-perf-budgets.mjs` `loadBaseline`：`catch { return null }`。目标 `docs/performance-audit/基线记录/perf-budgets-baseline.json` **不存在**。有违规时最终 `failOut`，不是完全静默通过；解析错误文本被吃掉。
- `check-guard-system.mjs` `readBaseline`、`check-i18n-hardcoded.mjs` `readBaseline`：坏基线已 exit 1。载体仍是 docs 里的 md。i18n 的 `--update-baseline` 已拒绝抬高。
- `check-token-consistency.mjs` `readBaseline` 缺文件返回 null。P0 确认调用方是否把 null 当通过。

## c. 目标架构
内部包一种 exports：`development` 条件指向 src，默认指向构建产物；不发布的包可以只暴露 src，但 vite / jest / metro / tsc 都走条件，**删除 vite 手写 alias**。依赖只写 `workspace:*`。`build` 只留给真正产出 dist 的包；其余脚本改名为 `typecheck`。一份 strict base，子包不得关掉 `exactOptionalPropertyTypes`。vitest 每包中性 project，无 `retry`，覆盖率阈值只在根。shared-utils 根入口只有平台无关代码；DOM/React 在 `/browser` 或 desktop；Node 在 `/node`，且不假设已删除的 daemon。Op 线格式从 `conex-doc-collab` 的契约生成，TS 不手写第二套 enum。基线只在 `scripts/baselines/*.json`。守卫的 `--update` 只能删键或把数值改小。

## d. 删除清单
vite alias 数组；各包假 `build` 与 test-utils 的 rimraf clean；`retry: 2`；`IME_MATRIX_PACKAGE_TRACK` 与 block-paper barrel 里的 mock（迁到测试入口或删）；两个 `diffToReplace` 垫片；`conversation-flow` **除外**的本地 `basename`；shared-utils 中 P0 确认零生产调用的适配引擎与 Node 遗留（`wal.ts`、`fsync.ts`、`prometheus-exporter.ts`、`object-pool.ts` 等）；`diff:save` 指向 `.agent-outputs` 的脚本；跟踪的 `scripts/inspections-output.json`、`parsed-events-summary.json` 一类转储；`analysis/` 跟踪文件；根 `markdown-editor.html`、`premium-markdown.css`。不删 conversation-flow，不删 avatar-studio（别人的提交），不删任何守卫规则。

## e. 分阶段与探针
**BLD-P0** 不改代码。重跑门控。把每个 `check-*.mjs` 的基线路径分成「缺失即失败 / 解析失败继续跑」。g7 点名、本阶段必须入表的还有 `check-layout-tokens.mjs`、`check-inline-style-hardcode.mjs`、`check-swallowed-errors.mjs`、`check-hierarchy-ssot.mjs`（函数名以各文件的 `readBaseline` / `parseBaseline` / `loadBaseline` 为准）。列出 SC-01 里仍无 package.json、CI、husky、其他脚本引用的文件。死代码删除前用 rg 确认零生产引用。分类结果写进 `build-scripts-ci.verify.md`，P1 只改「继续跑」和「载体在 docs」这两类，不改已经失败即退出的比较式。

**BLD-P1（优先，SC-03）** 把仍在 `docs/**/*.md` 的基线原样转成 `scripts/baselines/<名>.json`（数值逐键相等，禁止顺便减小或增大；减小留到代码真的修掉之后）。解析失败、缺文件、缺字段：打印原因并 `process.exit(1)`，禁止 `catch { return null }` 后继续 PASS。`--update` / `--update-baseline`：相对旧 JSON，只允许键消失或数值变小；新键或更大值 exit 1。持平键在迁移提交里必须保留。判定函数（什么算违规）一字不放宽。`check-line-counts` 不得再把坏基线当成「无豁免所以通过」。`check-perf-budgets` 缺文件也必须失败，即使当前违规数为 0。
探针：`git grep "docs/multi-agent-repair/基线记录" $B -- scripts/*.mjs` 为 0（注释里的历史句子也删）；`git diff` 里基线数值无增大。

**BLD-P2** BS-01..09，跳过 CF/AV/ST。补 desktop 对 plugin-import 的依赖。根 typecheck 加入 mobile（只加命令，不改 mobile 源码；若因此失败，修的是配置分裂，不是放宽 strict）。mock-daemon 纳入 workspaces 并用包名引用 shared-types，engines 改成与根一致的 Node 24。删 vite alias，改 `resolve.conditions`。metro 的 development 条件由 MB 改 mobile 配置；本阶段只保证 exports 形态让条件解析成立。统一 `workspace:*`。删假 build。去掉 `exactOptionalPropertyTypes: false` 与 desktop `noUnusedLocals: false`。vitest 去掉 retry，阈值留根一份。`typecheck` 不再依赖 `build:types`。shared-utils 的 `build:js` 不再用 `--platform=node` 打根入口。
探针：`rg "retry:\s*2" vitest.config.ts packages` 为 0；desktop `package.json` 含 plugin-import；vite.config 无 `@crish/` alias。

**BLD-P3** BP-01..06。Op / BlockKind 进现有 `generate-engine-bindings.mjs` 的输入 JSON（不新建第二套生成器，不改 ST 负责的手写消息类型）。删 `opsWire.ts` 里手写 op 联合，只留编解码。删 `pending_turn_into` 兼容路径（P0 点名后）。mock 移出生产 barrel。删两个 diff 垫片，调用方改从 contract 导入。虚拟滚动只留 `VirtualScrollManager` 的 Fenwick 实现并放进 editor-kit，desktop 删本地类。`nextIntentId` 改为调用方注入，删模块计数器。
探针：`rg "kind: 'turn_into'" packages/block-paper-contract/src/opsWire.ts` 为 0；`rg "from '\./diff/diffToReplace'" packages/block-paper packages/editor-kit` 为 0。

**BLD-P4** SU-01..03、SU-05。删无人消费的适配引擎；`App.tsx` 去掉 `usePlatformAdaptation`。根入口不导出 React/DOM。`/node` 删掉零引用文件与过期注释。shared-utils 增加一个 `basename`（同时认 `\` 与 `/`，去掉末尾分隔符），desktop 本地函数删除。不改 conversation-flow，不改 mobile 的 `eventReducers.ts`。
探针：`rg "usePlatformAdaptation\(" apps/crish-desktop/src` 为 0；`rg "function basename" apps/crish-desktop/src` 为 0。

**BLD-P5** PI、TU。plugin-import 补上 typecheck 脚本（不要假 build）。`inferSep` 删除：路径由调用方传入已经分好的绝对路径，或走现有桌面 API，不在 WebView 里读 `process.env`。未用导出删除。test-utils：若 P0 确认只有 desktop integration 使用，并入 `apps/crish-desktop/tests`，删除包与 workspace 条目；mock 不要为了「承接 BP-02」再留一个空包。
探针：`rg "function inferSep" packages/plugin-import-claude-codex` 为 0。

**BLD-P6** SC-01、SC-02、SC-04、SC-05、RH。删 P0 名单里的孤儿脚本与 JSON 转储。抽出 `scripts/lib` 的目录遍历与报告函数，调用方改用它；**搬迁时断言与阈值原样拷贝**。token/color 同族合并成一个检查器的多规则，不减少规则。`git rm` 跟踪的 analysis 产物、原型 html/css、ignore 仍跟踪的 `model-price-data` 与 `.vscode`（`--cached` 只在 worktree）。`.gitignore` 收成一条代理工具目录规则，不误伤仍要跟踪的项目配置（P0 列出保留集）。
探针：`git ls-files` 不含 `inspections-output.json`、`markdown-editor.html`、`analysis/`。

**BLD-P7** 只跑 §h。

完成判据（与探针一起看，不能只看脚本退出 0）：
- P1 之后，`scripts/baselines/*.json` 能被对应脚本读到。把其中一个改成非法 JSON，该脚本必须非零退出，并且输出里有文件路径。改完还原，不提交坏文件。
- `check-line-counts.mjs` 在基线损坏时不得全绿。`check-perf-budgets.mjs` 在基线文件缺失时不得 PASS，哪怕当前违规数是 0。
- P2 之后，`vite.config.ts` 的 `resolve.alias` 不再指向 `packages/*/src`。根 `typecheck` 包含 `apps/crish-mobile`。`retry: 2` 在 vitest 配置里为 0。
- P4 之后，`packages/shared-utils/src/index.ts` 不再导出 `usePlatformAdaptation` 与 `detectHardware`。
- 任何阶段的基线 diff 若出现数值变大或新键，不得提交。迁移提交只允许逐键相等。
- P6 之后，`git ls-files` 不再包含 `scripts/inspections-output.json` 与根目录 `markdown-editor.html`。`check:desktop` 仍调用原来的每一条规则，只是入口可以变成一个聚合脚本。

## f. 禁止捷径
禁止把违规判定改松来让迁移变绿。禁止 `--update` 写入新键或更大的数。禁止在基线 JSON 里把豁免行数调高。禁止为了 strict 编译失败而把 `exactOptionalPropertyTypes` 改回 false。禁止删 conversation-flow 或 avatar-studio。禁止改 `check-blocked-executable-ssot.mjs` 的通过条件（那是 TS-P1；本方案若必须碰它，只能在它已干净且改动是收紧字符类，并与 TS 错开）。禁止用 `continue-on-error` 把 mobile typecheck 挂上却允许失败。

## g. 规范
Node 24、npm workspaces、`workspace:*`。脚本失败走 stderr + 非零退出。基线 JSON 无 BOM。新共享函数放 `scripts/lib`，不复制 walk。提交说明写清基线是「原样迁移」还是「数值下降」。

## h. 测试命令
仅 BLD-P7。前端 Node 24。本模块默认不跑 cargo。若 BP-01 改了 `conex-doc-collab`，才在没有其他 cargo 时：
```
$env:RUSTUP_TOOLCHAIN = "1.99.1"
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\bld"
cargo fmt -p conex-doc-collab -- --check
cargo clippy -j 3 -p conex-doc-collab --all-targets -- -D warnings
cargo test -j 3 -p conex-doc-collab
```
```
npm run typecheck
npm run lint
npm run test
npx knip
node scripts/check-crate-size.mjs
node scripts/check-line-counts.mjs --all
node scripts/check-perf-budgets.mjs
node scripts/check-guard-system.mjs
node scripts/check-token-consistency.mjs
npm run check:i18n
```
另写一个一次性探针（不进生产守卫）：故意把某 JSON 基线改坏，对应脚本必须非零；改完还原，不提交坏基线。

## i. 审计
§7.3 之外：基线 diff 只有键删除或数字下降（迁移提交允许逐键相等，不允许上升）。`+eslint-disable`、`+@ts-ignore`、`+retry` 必须为空。守卫脚本的比较符不得从 `>` 改成 `>=` 来放行。删除的测试必须随被删实现一起走。

## j. 与 HS / SB / EC / TM / MP 的冲突
- **HS / SB / TM / MP**：不改 src-tauri 与这些方案的 Rust 文件。BP-01 只碰 `conex-doc-collab` 的 Op 契约与生成输入；若该 crate 在写，停下。
- **EC**：不改错误码生成器。若 `generate-engine-bindings.mjs` 与 EC 的新脚本共用 CI 步骤，只追加 Op 生成命令，不改 EC 的失败条件。
- **ST**：不删 23 个手写类型，不做 ST-02 的 common 模块。BP-01 的生成挂在现有引擎绑定脚本上，与 ST 串行，后开工者 rebase。
- **CF**：不改 `packages/conversation-flow`，不删它的 workspace、typecheck、vite alias。那些条目留给 CF。SU-05 不删 humanize.ts。
- **AV**：不把 avatar-studio 加入 workspaces 或 strict。
- **MB**：不改 `apps/crish-mobile`。根 typecheck 增加 mobile 若与 MB 的 package.json 冲突，BLD 先合，MB 再改 mobile 依赖。SU-04 的转发 barrel 留给 MB。
- **TS**：可执行后缀脚本不在本方案改判定。

## k. 已决
- D1：CF-01..03 归 CF 删除，本方案不整理该包。
- D2：avatar-studio 不纳入、不整理。
- D10：错误码生成不在此重复。Op 生成复用引擎绑定脚本，不新建第二套。
- SC-03：基线改机器可读 JSON；解析失败必须非零退出；迁移数值只许相等；之后 `--update` 只许删除或下降。不得顺带放宽判定。
- BS-05 的「workspaces 排除 mobile」按现行代码作废；typecheck 漏 mobile 仍做。
- ST-01、ST-02 不做。ST-03 归 MB。
