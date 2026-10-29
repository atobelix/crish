# 桌面 i18n 去回退（I18N）

> **给执行 AI 的硬性规则**
> 1. 用户可见文案必须留下，并且有键。禁止为了清零把句子删掉。
> 2. 禁止作弊：不加 `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `i18n-allow`；不调基线向上；不改 `scripts/check-i18n-*.mjs` 来放行；不删断言。
> 3. `npm run typecheck` / `lint` / `test` 只在 I18N-P5 跑。Node 24。
> 4. 每阶段一提交：`refactor(I18N-P<n>): <中文摘要> [BATCH-DESKTOP-I18N]`。
> 5. 只在 `C:\Users\orange\rf-i18n` 改。不 stash、不 push、不动主仓库。
> 6. `apps/crish-desktop/src/i18n` porcelain 非空则停。编写时 `locales/en-US/settingsParts.ts` 与 `zh-CN/settingsParts.ts` 为脏。
> 7. 行号是 2026-10-29 快照（HEAD `bf3d60fa3`）。清单以 `t` 的类型错误和现有门禁为准，不以旧报告的 2,435 / 327 为准。

| 项 | 值 |
|---|---|
| 代号 | I18N |
| 分支 | `refactor/desktop-i18n` |
| worktree | `C:\Users\orange\rf-i18n` |
| 批次标签 | `[BATCH-DESKTOP-I18N]` |
| 进度 | 同目录 `desktop-i18n.progress.md`（写在 worktree，不写主仓库） |
| 基点 | MSG 结构拆分合入之后再改那些被拆的组件；其余文件可先做 |

## a. 范围与门控

### a.1 纳入
- `apps/crish-desktop/src/i18n/**`：`t` 的签名、`useI18n`、词典。`Trans.tsx` 仅在生产 0 引用时删除。
- 调用点：把 `t(key, '中文')` 收成 `t(key)` 或 `t(key, params)`，`params` 只能是 `TranslationParams`。中文原文进入 `locales/zh-CN`，英文进入 `locales/en-US`。
- g5 模块 N：逻辑层硬编码中文（toast、抛给用户的句子）、`markdownRenderLite.ts` 里用中文正则剥模型输出、`SafeIntl.ts` 的 `any`（P0 复证，没有则不改）。
- 组件里的 JSX 中文、属性中文。静态 `import { t }` 的组件改为 `useI18n()`，否则切语言不刷新。

### a.2 不纳入
- 不改门禁脚本的匹配规则、排除名单、阈值。`scripts/check-i18n-hardcoded.mjs`、`check-i18n-symmetry.mjs`、`check-i18n-unused-keys.mjs` 只许运行，不许编辑。
- 不删 CF 已经负责删除的 conversation-flow 文案。等 CF 合入，避免两边改同一键。
- 不改 SS 的会话 store / 流式 hook。`markdownRenderLite.ts` 若 SS 还要删 `IncrementalThoughtStripper`，本模块等 SS 合入再改剩下的活函数。
- 不改 `components/ui` 里待采用原语的结构（UI）。原语上的中文照样抽键，但若 UI 阶段未合入且文件会冲突，把该文件列入后阶段。
- 账号在写文件（`SettingsDevicesTab`、`AccountAuthCard`、`authApi`、`authStore`、`multiDevice`）porcelain 非空则不改。

### a.3 门控
```
git -C C:\Software\conex status --porcelain -- apps/crish-desktop/src/i18n
git -C C:\Software\conex status --porcelain -- scripts/check-i18n-hardcoded.mjs scripts/check-i18n-symmetry.mjs scripts/check-i18n-unused-keys.mjs
```
两条都要空。基线文件若在 `docs/i18n-full-remediation/基线记录/`，开工时对该路径同样 porcelain 为空才允许 `--update-baseline`。脚本本身编写时是干净的；i18n 目录不干净。

## b. 核实表

| 编号 | 结论 | 证据 |
|---|---|---|
| X-03 回退 | 仍存在 | `useI18n.ts` 的 `t(key, fallbackOrParams?: string \| TranslationParams, params?)`。第二参可以是中文。门禁 `analyzeFileWithAst` 会跳过 `t()` / `translate()` 调用内部，所以回退中文不进硬编码计数 |
| 粗计数 | 只作线索 | `\bt\(\s*'[^']+'\s*,\s*'` 在非测试 ts/tsx 命中 406。含误伤（第二参不是中文）。**不以 406 为完成标准**。完成标准是签名上不再有 `string` 回退，且 `tsc` 通过 |
| 硬编码存量 | 仍由棘轮管着 | `check-i18n-hardcoded.mjs` 按文件基线只降不升（`--update-baseline`）。报告的 2,435 不复算。P0 把脚本输出贴进 progress |
| N-01 | 仍存在 | 逻辑层中文仍被同一门禁计数。抽到词典，不删句子 |
| N-02 | 仍存在 | `markdownRenderLite.ts` 的 `stripThoughtPlaceholders` 用「正在思考中」「本轮总结」等正则。`streamExecutionHelper.ts` / `streamRunCompletion.ts` 用 `=== '正在思考中...'` 比较。这是行为，不是按钮文案 |
| N-03 | P0 复证 | 报告写 `SafeIntl.ts` 的 `(Intl as any).ListFormat`。本轮未打开该文件。`rg "as any" src/i18n/SafeIntl.ts` 为 0 则勾掉 |
| 静态 t | 仍存在为线索 | 报告点名 `SidebarContextMenus`、`PluginImportPanel`、`ExtensionsMainSurface`、`ModelsCascadeSelect`。P0 用 `rg "import \{ t \}" -g "*.tsx"` 列全表 |
| Trans | 可删 | `rg` 生产 import 只有 `i18n/Trans.tsx` 与其测试。无界面入口 |

## c. 目标架构

`t` 只有两种调用：`t(key)` 与 `t(key, params)`。没有字符串回退。缺键在开发与测试里失败（现有 translator 若会回退到 key 本身，测试断言不得把 key 当成功文案；缺键测试要失败）。zh-CN 与 en-US 由 `check-i18n-symmetry` 对齐。

组件用 `useI18n()`。模块级纯函数如果必须翻译，调用不带中文回退的 `t`，并在语言切换测试里证明会更新；做不到就改成由组件传入已翻译字符串。不新写第二套 i18n。

中文正则不再当模型输出的分类器。没有结构化标记之前，**不**把这组正则翻译成每种语言，也**不**删掉剥离后让占位符直接显示。见 e 的 N-02 停机条件。

## d. 删除清单

- `t` 的 `string` 回退参数，以及所有调用点上的中文第二参。句子本身搬进 `zh-CN`，不消失。
- `i18n/Trans.tsx` 与只测该组件的测试。不删 `useI18n` 测试。
- 仅被 Trans 使用、且 `check-i18n-unused-keys.mjs --strict` 报未使用的键。有其它引用的键不删。
- `SafeIntl` 上的 `as any`（仅当 P0 确认还在，且 `tsconfig` 的 lib 已经包含 `Intl.ListFormat`）。否则不升级整个 lib，停，记待决。

不删：仍显示在界面上的句子；`stripThoughtPlaceholders` 的生产行为（除非已有结构化字段可替代，且测试覆盖同一批噪音样本）。

## e. 分阶段与探针

**I18N-P0** 跑现有脚本，不改文件：

```
node scripts/check-i18n-hardcoded.mjs
node scripts/check-i18n-symmetry.mjs
node scripts/check-i18n-unused-keys.mjs
```

把计数贴进 progress。`rg "import \{ t \} from" apps/crish-desktop/src -g "*.tsx"` 列出静态导入。`rg "as any" apps/crish-desktop/src/i18n/SafeIntl.ts`。

**I18N-P1** 门控为空后，先改词典与非冲突目录的调用点：`api/**` 里不属于 SS/MD 在写清单的文件、`utils/**`、`services/**`（不含 UI 正在拆的组件）。每个中文第二参变成键。zh-CN 的值与原字面量逐字相同。en-US 写英文，禁止把中文复制进 en-US。此阶段签名仍暂时接受 string，否则中间提交无法通过 hook。提交说明写明「签名在 P4 删除」。新代码不得再增加带回退的调用。

**I18N-P2** 组件 JSX / 属性中文，跳过 MSG 将要拆的 `MessageContent.tsx`、`WorkflowForm.tsx`、`ApprovalAskCard.tsx`，以及 MD 的 markdown 组件、UI 的 `components/ui`（若那些模块未合入）。静态 `import { t }` 的 tsx 改为 `useI18n`。

**I18N-P3** MSG、MD、UI 合入后补它们改过的文件。账号脏文件仍排除。

**I18N-P4** 删除 `fallbackOrParams` 的 `string` 成员。`translator` 实现里删除「第二参是字符串就当文案」的分支。全仓 `tsc` 必须无「多传了 string」的错误。N-02：只改 `stripThoughtPlaceholders` 与那几处 `=== '正在思考中...'`。若引擎事件没有独立的 thinking 字段可代替这些比较，**停**，不要换一种中文正则，也不要删函数。SS 若尚未删 `IncrementalThoughtStripper`，不要提前删，避免和 SS 抢 `markdownRenderLite.ts`。

探针：

```
rg -n "fallbackOrParams" apps/crish-desktop/src/i18n
rg -n "t\(\s*'[^']+'\s*,\s*'" apps/crish-desktop/src -g "!**/*test*"
```

P4 之后两行都应为 0。测试里若用中文第二参，同样改掉，不许留在测试里维持旧签名。

基线：硬编码计数下降后，只运行 `node scripts/check-i18n-hardcoded.mjs --update-baseline`。禁止手改基线数字。脚本若拒绝上升，说明改坏了，修文案抽取，不许改脚本。

**I18N-P5** §h。

## f. 禁止捷径

- 不删 JSX 里的中文来让门禁变绿，除非同一句已经在词典里并被 `t` 使用。
- 不把中文留在源码里再加 `i18n-allow`。
- 不修改 `check-i18n-*.mjs` 的排除正则、不把文件加进 `EXCLUDE_FILE_RE`。
- 不把回退改成 `t(key, key)` 或空字符串。
- 不为 N-02 增加「每种语言一份占位符列表」当作修复。
- 不加 `eslint-disable`、`@ts-expect-error`。
- 不调高任何文件的硬编码基线。

## g. 规范

现有三支 check-i18n 就是门禁，只减不增。`check:line-counts` 词典文件若超限，按语言拆已有的 `settingsParts` 模式，不抬上限。`npx knip` 不新增未使用导出。ESLint / tsconfig 不改规则来放过 `t` 的多余参数；多余参数必须在类型上就是错误。

## h. 测试

只在 I18N-P5，worktree，Node 24：

```
npm run typecheck
npm run lint
npm run test
npm run check:i18n
npm run check:line-counts
npx knip
```

回归：R1 zh-CN 下原按钮句子仍在；R2 en-US 下这些键不是中文；R3 切换语言后使用 `useI18n` 的表面会更新；R4 缺键的测试失败而不是显示键名当成功。

## i. 审计

- [ ] A1 `t` 的类型里没有 `string` 回退
- [ ] A2 §e 探针为 0
- [ ] A3 `git diff` 不含 `scripts/check-i18n-*.mjs`
- [ ] A4 基线 diff 只有下降
- [ ] A5 抽查 10 条旧中文，zh-CN 词典里字面量还在
- [ ] A6 无新的 `i18n-allow` / eslint-disable / ts-expect-error

## j. 与 SS/CF/ST 的文件冲突

- SS 会改 `hooks/chat-stream/useStreamCallbacks.ts`、`useSlashSend.ts`（报告里的 toast 中文）以及 `markdownRenderLite.ts` 的死类。这些文件等 SS 合入再抽文案。不要在 SS 工作树上改。
- CF 会删 conversation-flow 与因此未使用的键。I18N 不提前删那些键，避免和 CF-P4 冲突。CF 合入后再跑 unused。
- ST 不碰词典。错误码文案若属于 EC 的生成物，本模块不手写第二份，只改桌面 `t` 调用。
- MSG 拆 `MessageContent`、`WorkflowForm`、`ApprovalAskCard`。I18N-P3 在 MSG 对应阶段合入之后改这些文件。
- MD / UI 同理：被它们整文件改写的，放 P3。

## k. 已决

- 目标就是删回退参数，存量清零。清零指源码不再把中文当回退或当 JSX 字面量，不是把功能文案删掉。
- 门禁只用现有 check-i18n，收紧靠 `--update-baseline` 的只降不升。禁止改脚本放行。
- N-02 没有结构化替代时停，不假装用 i18n 修好启发式。
- D1 的 CF 文案不在本模块删。D10 错误码生成不在本模块重做。
- 报告里的 2,435 与 327 只是线索。完成不以这两个旧数字为分母。
- 切语言不刷新的静态 `import { t }` 必须改成 `useI18n()`。只改词典、不改调用方式，不算做完 X-03。
- I18N-P1 为了让中间提交能过类型检查，暂时还留着 `string` 回退。这不是最终 API。本分支在 I18N-P4 删掉该参数之前不得合并。
- 词典键名用现有领域前缀，不新建平行的 `fallback.*` 命名空间。
