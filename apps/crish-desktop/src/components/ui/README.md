# ui 原子层（PE-05 T05.1）

> 本目录是前端三层结构的第一层「ui 原子层」的落地起点，依据
> `docs/rust-rewrite/plans/PE-05-frontend-componentization-plan.md` 与
> `docs/rust-rewrite/audits/AA-04-frontend-components-styles-review.md` 建设。

## 一、分层规则（评审门禁，`npm run check:ui-layer` 强制）

```
components/
├── ui/            ← 第一层：ui 原子层（唯一允许「通用」的层，本目录）
├── (域目录 28 个)  ← 第二层：业务组件层
└── App*/TopBar…    ← 第三层：页面/编排层
```

| 层 | 允许依赖 | 禁止依赖 |
|---|---|---|
| ui/ 原子层 | react、react-dom、`@radix-ui/*`、`src/styles/tokens.css`（CSS 变量）、`src/styles/z-index.css` | 一切业务组件（`components/` 下除 `ui/` 外的一切）、一切 store（zustand）、`hooks/`、`api/`、`services/`、其他域目录 |
| 业务组件层 | ui/、共享 hooks（`hooks/`）、store facade（`api/storeAccess.ts`）、api/、services/ | 跨业务域直接 import（复用先下沉到 ui/ 或抽共享 hook） |
| 页面/编排层 | 全部上层 | 编排职责不外泄 |

门禁脚本：`npm run check:ui-layer`——扫描本目录全部文件的 import，
命中 `components/(?!ui)`、`store/`、`hooks/`、`api/`、`services/` 任一
业务路径即失败（脚本实现见仓库根 `scripts/check-ui-layer.mjs`）。

## 二、样式规范（双轨合并后的唯一标准）

1. **tokens 唯一源**：所有颜色/圆角/间距/字号/字重/行高/z-index/过渡/阴影
   一律引用 `styles/tokens.css` 与 `styles/z-index.css` 的 CSS 变量；
   组件 CSS 与 tsx 内联样式禁用裸 hex/rgba（迁移期允许
   `var(--x, #fallback)` 过渡形态）。语义色走「语义名 → 单一变量」映射
   （`--color-success` / `--color-error` / `--color-warning` 等）。
2. **CSS Modules 命名**：类名一律 camelCase；语义为「组件内部私有形态」，
   不得与全局类同名（active/open/danger 等通用名按 `xxxActive` 前缀化）。
   `:global(...)` 引用全局类为禁止项。
3. **module.css 与组件同目录同名**（`Button/Button.tsx` ↔
   `Button/Button.module.css`）；禁止跨目录反向引用。
4. **z-index 单源**：运行期唯一真值为 `styles/z-index.css` 的 CSS 变量；
   TS 侧常量一致性由 `npm run check:zindex` 保证。

## 三、原子组件清单（API 摘要）

| 组件 | 目录 | 职责/锚点 |
|---|---|---|
| Button | `ui/Button/` | 对齐 `ui-btn` 体系语义：variant（primary/secondary/ghost/danger）+ size（sm/md）+ icon + loading + block |
| Input | `ui/Input/` | text/search/password 三型 + label + error + hint + clearable + prefixIcon/suffix |
| Dialog | `ui/Dialog/` | 弹窗基座锚点：FocusTrap 三件套（focusTrap + useRestoreFocus + useAnimatedPresence 为目录内私有实现）+ Esc + backdrop + aria；**T05.2 已收敛 7 套核心弹窗**（TelemetryDialog/CheatsheetModal/WithdrawConfirmDialog→`overlay/`、SkillEditorModal→`settings-skills/`、SettingsPanel/SettingsRulesTab→`settings/`、FirstRunWizard→`overlay/`），消费方从 barrel `'../ui'` 引入；T05.2 新增消费能力：`variant: 'fullscreen'`（SettingsPanel 全屏盖层）、`showCloseButton`（Withdraw 无关闭按钮设计）、`overlayClassName`（--dialog-z 层级覆盖）、`ariaLabel`（无 title 时的可访问名称）、`--dialog-width`（尺寸覆盖） |
| Menu | `ui/Menu/` | 菜单基座锚点：从 UnifiedSelectPopover 提炼；坐标计算单源 `position.ts`；后续 12 套菜单收敛于此 |
| Tooltip | `ui/Tooltip/` | 从旧 Tooltip 提炼的单实现，API 保持 {content, side, disabled, delayHide} 不变 |
| Select | `ui/Select/` | 基于 ui/Menu 的受控 Select（listbox 语义），供 SettingsSelect 等迁移 |

## 四、内部共享约定

- `ui/Dialog/useAnimatedPresence.ts` / `useRestoreFocus.ts` / `focusTrap.ts`
  是从 `hooks/` 与 `components/FocusTrap.tsx` 提炼的目录内私有实现
  （原子层禁止依赖 `hooks/`）；`ui/Tooltip` 复用了
  `ui/Dialog/useAnimatedPresence`，属 ui 层内部跨目录 import，门禁放行。
- 组件不得直接 import `hooks/`、`store/`、`api/`、`services/` 及
  `components/` 下其他目录；新消费方一律从 `ui/index.ts` barrel 引入。
