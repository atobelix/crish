# 桌面 UI 组件库（UI）

> **给执行 AI 的硬性规则**
> 1. 彻底改进：库内一个实现、一条 import 路径。不留 re-export 垫片。
> 2. 禁止作弊：不加 `eslint-disable` / `@ts-ignore` / `@ts-expect-error`；不调基线；不删断言；不用 `--no-verify`。
> 3. 测试只在 UI-P4 跑 `npm run typecheck`、`lint`、`test`。Node 24。
> 4. 每阶段一提交：`refactor(UI-P<n>): <中文摘要> [BATCH-DESKTOP-UI]`。
> 5. 只在 `C:\Users\orange\rf-ui` 改。不 stash、不 push、不动主仓库。
> 6. `components/ui` 的 porcelain 非空则整模块停，不挑文件硬改。
> 7. 行号是 2026-10-29 快照（HEAD `bf3d60fa3`）。死代码必须 `rg` 证明 0 引用才删。无业务引用 ≠ 死代码。

| 项 | 值 |
|---|---|
| 代号 | UI |
| 分支 | `refactor/desktop-ui` |
| worktree | `C:\Users\orange\rf-ui` |
| 批次标签 | `[BATCH-DESKTOP-UI]` |
| 进度 | 同目录 `desktop-ui-components.progress.md`（写在 worktree，不写主仓库） |
| 基点 | 集成结果。不与 MSG 同时改 sidebar / PinAction |

## a. 范围与门控

### a.1 纳入
只改 `apps/crish-desktop/src/components/ui/**`，外加两处**采用**而不是删除：
- `chat-message-row/PinActionWithPicker.tsx`：改用库内 `ColorPicker`（UI-03）。
- `sidebar/SessionContextMenu.tsx`：若它是 `SmartPanel` 的唯一生产消费者，在删 `SmartPanel` 的同一阶段改到保留下来的 Menu。不改 `ContextMenuFlyout` 的几何（那是 MSG 明确留下的文件）。本阶段若发现消费者不止一个，停，列清单。

### a.2 不纳入
- 不删除待采用原语，即使生产业务 0 引用：`ContextMenu`、`DropdownMenu`、`Select`（含 `Combobox`）、`ColorPicker`、`PreviewCard`、`Tabs`、`TabStrip`、`animated-icons`、`DisclosureAffordance`。编写时它们只被 `components/ui` 内部、`ui/index.ts` 桶、以及自身测试引用。这是待采用，不是死代码。
- 不改 `workspace/PreviewCard.tsx`。那是另一个组件，同名。UI-01 说的无消费者是 `components/ui/PreviewCard`。
- 不改消息投影、Markdown、store、i18n 词典、`components/settings` 账号文件。
- 不把业务菜单（`ModelsCascadeSelect`、`TiptapSlashMenu`、`ContextMenuFlyout`）整批改写。那是 MSG / 编辑器范围。本模块把库收成能被采用的形状。

### a.3 门控
每一阶段开工前：

```
git -C C:\Software\conex status --porcelain -- apps/crish-desktop/src/components/ui
```

必须为空。编写时该命令为空，仍要重跑。任一阶段开始后若主仓库该目录变脏，停。

UI-P2 额外要求 `PinActionWithPicker.tsx` porcelain 为空。UI-P3 额外要求 `SessionContextMenu.tsx` 与 `sidebar` 目录里将要改的文件 porcelain 为空。编写时脏的是 `Sidebar.module.css`、`SidebarFooter.test.tsx`、`UserProfileCard.tsx`，P3 不要碰它们。

## b. 核实表

| 编号 | 结论 | 证据 |
|---|---|---|
| UI-01 | **不是死代码，禁止按报告删除** | `rg` 这些目录名的 import：业务侧没有 `from '.../ui/ContextMenu'` 一类引用；桶在 `ui/index.ts`。`ColorPicker` 仅自身与测试。报告建议「整体删除」与「待采用」冲突。以待采用为准 |
| UI-02 | 仍存在，收口方式改掉 | 库内同时有 `Menu`、`SmartPanel`、`SmartExpandablePanel`，以及待采用的 `ContextMenu` / `DropdownMenu`。`SmartExpandablePanel` import `../Menu/Menu.module.css`。不通过删除新原语来「只留一个」 |
| UI-03 | 仍存在 | `PinActionWithPicker.tsx` 自绘 HSV（物理约 470+ 行量级，文件在 chat-message-row）。`ColorPicker` 无业务引用。目标是 Pin 改用 `ColorPicker`，不是删 `ColorPicker` |
| UI-04 | 仍存在为线索 | 报告点名 `Dialog.tsx`、`SmartExpandablePanel.tsx`、`SmartPanel.tsx`、`ComboboxRoot.tsx`、`ContextMenu.tsx`、`ColorPicker.tsx`、`AnimatedCounter.tsx` 的 `as any`。开工 `rg "as any" components/ui -g "!**/*test*"` 列全表，逐个补类型。`ToastContext` 不在 `components/ui`，本模块不改 |
| UI-05 | 仍存在为线索 | `Tooltip.tsx`、`TabStrip.tsx` 的 `exhaustive-deps` 禁用。`PreviewCard` 同。修正依赖。禁止为了绿而删除 `TabStrip` / `PreviewCard` |
| UI-06 | 仍存在 | `ColorPicker` 默认色与 module css 里的 rgba / 色相渐变。改 token 或把色相条标成库内允许的数据，不删组件。不放宽 `check:color-ssot` |
| UI-07 | 仍存在 | `ui/utils/cn.ts` 转发 `internal/cn`（真实现 `export function cn`）。`internal/mergeRefs.ts` 转发 `utils/mergeRefs`。`internal/layer-stack/LayerStackService.ts` 是 `export * from './LayerStackManager'`，且 `LayerStackManager.ts` 又有 `export { LayerStackManager as LayerStackService }`。`ContextMenu/types.ts` 是 `export * from './contextMenuTypes'`。垫片可删，原语不可删 |

`ui/PreviewCard/PreviewCard.tsx` 物理 736 行，超过 650 硬阻断。这是待采用原语，**拆文件，不删除导出**。

## c. 目标架构

`components/ui` 是唯一原语目录。每个符号一条路径：

- `cn` 只从 `internal/cn` 引入（桶 `index.ts` 可以导出符号，但不再经 `utils/cn.ts` 转发）。
- `mergeRefs` 只留 `utils/mergeRefs.ts` 一份实现。
- 层栈类型只留 `LayerStackManager`。删除 `LayerStackService` 这个别名，调用方改名。这不是保留兼容导出。
- `ContextMenu` 的类型从 `contextMenuTypes.ts` 引入，删除 `types.ts` 垫片。

菜单：保留已经落地的 `Menu` 与待采用的 `ContextMenu` / `DropdownMenu`。它们是不同触发模式时，收成同一套项组件与同一层栈，而不是五套定位。`SmartPanel` 在唯一消费者迁走后删除。`SmartExpandablePanel` 若仍有生产消费者（报告写 ToolTabAddButton、ChatHeaderMore、ProjectPickerMenu、SubagentHeaderPanel、ComposePlusMenu），**不在消费者迁完之前删除**。迁消费者会出 `components/ui`，超出本模块时停，把文件名单写入 progress，交给后续，不留「SmartPanel 再导出 Menu」的垫片。

`ColorPicker` 保持为原语。`PinActionWithPicker` 只负责锚点与提交颜色，HSV 面板删除，改为渲染 `ColorPicker`。

`PreviewCard`（ui 这份）拆成子文件，每个 ≤ 500，对外导出面不变。

## d. 删除清单

允许删（删前 `rg` 该符号在 `apps/crish-desktop/src` 的非定义命中）：

- `ui/utils/cn.ts`（改完 import 与 `index.ts`、`style-contract.test.ts`）。
- `ui/internal/mergeRefs.ts` 垫片（调用方改 `utils/mergeRefs`）。
- `LayerStackService` 名字与 `LayerStackService.ts`。
- `ContextMenu/types.ts` 垫片。
- `SmartPanel/**`：仅当 `rg SmartPanel apps/crish-desktop/src -g "!**/ui/SmartPanel/**" -g "!**/*test*"` 在迁移提交里变为 0。
- `PinActionWithPicker` 内自绘 HSV 与 `colorPickerUtils` 中只被它使用的函数。`ColorPicker` 不删。

禁止删：a.2 列出的待采用目录；`Menu`；仍有消费者的 `SmartExpandablePanel`；`workspace/PreviewCard`。

`exhaustive-deps` 禁用注释在修好依赖后删除，不许换成另一条禁用。

## e. 分阶段与探针

**UI-P0** 不改代码。`rg "as any" components/ui -g "!**/*test*"` 与 `rg "eslint-disable" components/ui` 写入 progress。复测待采用目录的业务引用仍为 0 也不进入删除清单。

**UI-P1** 删 §d 的垫片，改 import。拆 `ui/PreviewCard/PreviewCard.tsx` 到 ≤ 500，导出名不变。补 UI-04 的 `as any`（含 `ColorPicker` / `ContextMenu` / `ComboboxRoot`）。去掉 Tooltip / TabStrip / PreviewCard 上站不住的 `exhaustive-deps` 禁用；依赖是真需要的就把值放进依赖数组。色值改 token，跑现有 color 脚本而不是加白名单。探针：

```
rg -n "ui/utils/cn|LayerStackService" apps/crish-desktop/src -g "!**/*test*"
rg -n "export \* from '\./contextMenuTypes'" apps/crish-desktop/src/components/ui/ContextMenu/types.ts
```

`types.ts` 应已不存在（`git cat-file` 或 `Test-Path` 为假）。`LayerStackService` 生产 0。`as any` 在 `components/ui` 生产代码 0。

**UI-P2** `PinActionWithPicker` 改为组合 `ColorPicker`。不改 `MarkdownBlockItem`。探针：`rg -n "function hsv|HSV" apps/crish-desktop/src/components/chat-message-row/PinActionWithPicker.tsx` → 0，且文件 import `ColorPicker`。

**UI-P3** 只在消费者清单短于开工记录时删除 `SmartPanel`。`SessionContextMenu` 改用 `Menu` 或 `ContextMenu`（二选一，写进提交说明，另一套原语保留待采用）。若 `SmartExpandablePanel` 仍有生产 import，保留目录，禁止做 `export { Menu as SmartExpandablePanel }`。探针：`rg -n "SmartPanel" apps/crish-desktop/src -g "!**/*test*"` → 0，或 progress 写明未删原因与剩余文件。

**UI-P4** §h。

## f. 禁止捷径

- 不因为 0 业务引用删除 ContextMenu、DropdownMenu、ColorPicker、PreviewCard、Tabs、TabStrip、animated-icons、DisclosureAffordance、Combobox。
- 不把待采用组件加进 knip ignore 或 eslint 忽略。
- 不新增 `eslint-disable`、`@ts-expect-error`。现有禁用只许删除。
- 不为了 color 脚本通过而把 `components/gallery/` 之类已不存在的路径写进白名单。本模块不改 `scripts/check-color-ssot.mjs` 的放行逻辑；白名单清理若要改脚本，只许删除指向不存在路径的条目，且该脚本 porcelain 必须为空。编写时脏的是另两个 check 脚本，不是 color 脚本；改之前仍要重跑 status。
- 不调 `check:line-counts` 基线。736 行靠拆文件下降。
- 不留 `as LayerStackService` 类型别名。

## g. 规范

组件 tsx ≤ 500，硬阻断 > 650。`npm run check:line-counts`、`check:color-ssot`、`check:text-color` 保持现有阈值。`npx knip`：待采用原语若被桶导出且仅测试使用，knip 报未使用时**不要**加 ignore，也不要为此删组件。把它们列为桶的公开导出并在 progress 记录 knip 的原有条目；若基线上 knip 已经为这些导出告警，本模块不得增加新的告警。若当前 knip 是绿的（桶导出算使用），保持绿色。开工先在 P4 之前的验证里看清基线，不要猜。

## h. 测试

只在 UI-P4，worktree，Node 24：

```
npm run typecheck
npm run lint
npm run test
npm run check:line-counts
npm run check:color-ssot
npx knip
```

回归：R1 Dialog / Menu 键盘与层栈测试仍绿；R2 ColorPicker 自身测试仍绿；R3 Pin 选择颜色仍能提交；R4 PreviewCard（ui）导出仍可从桶导入。

## i. 审计

- [ ] A1 待采用目录都还在（`git ls-tree -d` 九个目录都有输出）
- [ ] A2 垫片路径不存在
- [ ] A3 `as any` 在 `components/ui` 生产源码为 0
- [ ] A4 diff 除 PinAction 与 SessionContextMenu 外都在 `components/ui`
- [ ] A5 无新的 eslint-disable / ts-ignore / ignore
- [ ] A6 行数硬阻断为 0，基线未升高

## j. 与 SS/CF/ST 的文件冲突

- SS 方案把 `components/ui/**` 列为禁止触碰（BATCH-UI-PRIMITIVES）。本模块是那批原语的归宿，必须等 SS 合入且 a.3 为空，避免 SS 工作树还指着旧路径。
- CF 不改 `components/ui`。无直接冲突。
- ST 不改组件库。`as any` 若缺的是生成类型，停，不手写类型。
- MSG 禁止改 `components/ui`。本模块 P2 独占 `PinActionWithPicker.tsx`，MSG 的拆分清单不得包含它。P3 若改 `SessionContextMenu.tsx`，MSG-P4 不得改该文件。`ContextMenuFlyout.tsx` 双方都不改，留给原语 API 稳定之后的单独提交（谁做都要重跑 sidebar porcelain）。
- MD 不改 `components/ui` 与 PinAction。

## k. 已决

- UI-01 的「删除约 9,500 行」**否决**。新原语待采用。死代码标准是 `rg` 0 引用，且不在待采用名单里。
- 编写时 `components/ui` porcelain 为空，门控仍是每阶段重跑。
- 不与 MSG 抢 `components/ui`。业务菜单大迁移不是本模块一次做完的事。
- D1 与本模块无关。不删 conversation-flow。
- `sync-ui-exports` 若会把 0 引用原语从桶里拿掉，P0 先读脚本：待采用期间保持桶导出，不改脚本去「只导出有消费者」。改脚本前同样要求该脚本 porcelain 为空。
- 业务侧自研菜单（`ContextMenuFlyout`、`ModelsCascadeSelect`、`TiptapSlashMenu`）本波不改。UI-02 在库内收口，不把这些文件算进 UI 的 diff。
