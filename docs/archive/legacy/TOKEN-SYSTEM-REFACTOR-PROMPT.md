# Token 系统重构执行提示词
# 配套文件：TOKEN-SYSTEM-REFACTOR-PLAN.md

> **使用方式**：将本文件与 `TOKEN-SYSTEM-REFACTOR-PLAN.md` 一起提供给执行 Agent。
> 执行任何 Phase 前，必须完整阅读这两个文件，不能跳过。

---

## 一、核心原则（违反即为执行失败）

### 1. 完整性
方案中列出的每一个问题、每一条替换，必须**全部处理完毕**。
不允许"改了一部分，剩下的留到下次"。
若某步骤无法完成，必须明确说明原因，**不能静默跳过**。

### 2. 无破坏性
必须先新建 Token / 常量文件，再执行替换。
**禁止先删旧值、再补新 Token**。
在替换完成之前，旧值必须仍然存在且有效。

### 3. 单一来源
同一个数值只能在一个地方定义。
CSS token 与 JS 常量若持有相同数值，必须明确哪个是权威来源，
另一个从权威来源派生，不允许两处各自独立硬编码。

### 4. 全局一致
修改一个 token 的默认值，必须同步更新**全项目所有文件**中该 token 的 fallback 值。
例如 `tokens.css` 里 `--chat-col-max: 760px`，则任何地方的
`var(--chat-col-max, 680px)` 都必须改成 `var(--chat-col-max, 760px)`。

### 5. 可验证
每个 Phase 完成后，**必须运行**验证命令并将结果输出。
若验证失败，必须修复后才能进入下一 Phase。

---

## 二、执行前的强制纠错（必须在方案中修正的错误）

在开始实施方案之前，先按以下内容修正方案本身的问题。

### 纠错 1：radius token 命名统一为语义命名

方案 Section 2.2 定义的是语义命名（`--radius-lg: 8px`），
但 Phase 3 执行步骤里写的是 `var(--radius-8)`——**这个 token 不存在**。

**执行时必须统一用语义命名**：

| 像素值 | 正确 token 名 | 禁止使用 |
|--------|--------------|----------|
| 4px | `var(--radius-xs)` | ~~`--radius-4`~~ |
| 5px | `var(--radius-sm)` | ~~`--radius-5`~~ |
| 6px | `var(--radius-md)` | ~~`--radius-6`~~ |
| 8px | `var(--radius-lg)` | ~~`--radius-8`~~ |
| 10px | `var(--radius-xl)` | ~~`--radius-10`~~ |
| 12px | `var(--radius-2xl)` | ~~`--radius-12`~~ |

---

### 纠错 2：z-index 层级数值重新校正

方案的 z-index 值存在区间混乱，直接照搬会导致弹出层被侧栏遮住。
**执行 Phase 2 前，必须先确认以下正确顺序成立**：

```
文档流 < 侧栏 < 弹出层 < 下拉菜单 < 浮动面板 < 模态遮罩 < Toast < 设置面板 < 设置弹层
```

方案中的错误：
- `--z-popover: 20` < `--z-sidebar: 100` → 弹出层低于侧栏，会被遮住
- `--z-dropdown-menu: 40` < `--z-sidebar: 100` → 下拉菜单被侧栏遮住
- `--z-floating-panel: 999` 注释说属于"1000-4999 区间" → 值与区间矛盾
- `--z-dropdown: 1000` 与 `--z-drag-highlight: 1000` 完全相同 → 同值冲突

**执行前先 grep 项目中所有 `z-index:` 的实际裸值，生成清单，
再按实际使用情况重新确定每个 token 的正确数值，
确保层级顺序无误后写入 `z-index.css`**。

修正参考（执行前须与实际代码核对）：
```css
--z-base: 0;
--z-decorative: 1;
--z-sticky-bar: 2;
--z-card-header: 3;
--z-card-footer: 5;
--z-pinned-bar: 10;
--z-scroll-fab: 12;
--z-sidebar: 100;
--z-sidebar-resizer: 100;
--z-popover: 200;          /* 必须 > --z-sidebar */
--z-splitter: 300;
--z-dropdown-menu: 400;    /* 必须 > --z-sidebar */
--z-breadcrumb: 600;
--z-floating-panel: 1000;
--z-dropdown: 1010;
--z-drag-highlight: 1020;
--z-drag-card: 1030;
--z-modal-backdrop: 9000;
--z-context-menu: 9500;
--z-toast: 10000;
--z-drag-overlay: 10010;
--z-cheatsheet: 12000;
--z-settings-panel: 13000;
--z-settings-dialog: 20000;
--z-permission-menu: 20040;
--z-settings-tooltip: 20060;
--z-usage-modal: 30000;
--z-first-run: 100000;
--z-model-flyout: 100000;
--z-skip-link: 100000;
```

---

### 纠错 3：Phase 3 正则替换禁止无差别替换多值属性

方案说"367 处 6px 用正则批量替换"，**这样做会误伤多值 shorthand**。

**以下情况禁止自动替换**：
```css
padding: 6px 12px;          /* 只有 6px 可能要换，但 12px 不换 */
margin: 0 0 6px 6px;        /* 多值，需人工判断 */
box-shadow: 0 2px 6px ...;  /* 6px 是模糊半径，不是间距 */
border-radius: 6px 6px 0 0; /* 只有部分角，语义不同 */
```

**只有以下形式可以自动替换**：
```css
gap: 6px;           /* ✅ 单值 */
padding: 6px;       /* ✅ 单值 */
margin-top: 6px;    /* ✅ 单值方向属性 */
margin-bottom: 6px; /* ✅ 单值方向属性 */
```

**正确替换流程**：
1. 先只处理明确的单值形式（正则精确匹配末尾分号前无其他数字）
2. 多值 shorthand 手动逐行审查，确认语义再决定是否拆开
3. `box-shadow`、`border`、`background`、`clip-path` 等属性中的像素值一律跳过

---

### 纠错 4：CSS-JS 双重定义，必须先明确权威来源

`constants/layout.ts` 有 `SIDEBAR_WIDTH_DEFAULT = 260`，
`tokens.css` 有 `--sidebar-width: 260px`，两者独立存在。

**在 Phase 1 建立常量文件时，必须决定哪个是权威**：

- **方案 A（推荐）**：JS 常量是权威，CSS token 由 JS 在运行时注入：
  ```ts
  document.documentElement.style.setProperty('--sidebar-width', `${SIDEBAR_WIDTH_DEFAULT}px`);
  ```
  `tokens.css` 中只保留 fallback 并注明"此值由 JS 在运行时覆盖"。

- **方案 B**：CSS 是权威，JS 需要读取时用 `getComputedStyle` 获取，禁止硬编码数字。

两种方案选一个，在 Phase 1 创建常量文件时就定好，不能留白。

---

## 三、每个 Phase 开始前的强制检查清单

### Phase 1 开始前
- [ ] `src/constants/` 目录不存在（避免覆盖）
- [ ] 读取 `tokens.css` 全部变量名，确认新增 token 无命名冲突
- [ ] 确认 `--transition-slide` 和 `--transition-hover` 在全项目引用次数为 0，再删除
- [ ] 决定 CSS-JS 权威来源方案（A 或 B），记录在 commit message 中

### Phase 2 开始前
- [ ] grep 统计项目中所有 `z-index: <数字>` 的实际值，生成完整清单
- [ ] 与上方修正后的 z-index 表核对，确认层级顺序逻辑正确
- [ ] `z-index.css` 已在 `index.css` 中导入，且顺序在 `tokens.css` 之后

### Phase 3 开始前
- [ ] `tokens.css` 中 radius 块全部使用语义命名，无 `--radius-8` 等尺寸名
- [ ] 明确哪些属性类型可以自动替换，哪些必须人工审查
- [ ] 替换前记录每种裸值的总出现次数，替换后对比剩余次数

### Phase 4/5 开始前
- [ ] `font-weight: 400` 的每处上下文已确认（`normal` vs `code` 字重语义不同）
- [ ] 语法高亮颜色 token 在 `theme-dark.css` 中已有对应暗色覆盖值

---

## 四、每步完成后的验证命令（必须执行并输出结果）

```bash
# TypeScript 编译（0 错误才能继续）
npx tsc --noEmit

# Phase 2 后：确认无裸 z-index 数字残留
grep -rn "z-index:\s*[0-9]" apps/crish-desktop/src \
  --include="*.css" --include="*.tsx" --include="*.ts"

# Phase 3 各步后：以 gap: 6px 为例
grep -rn "gap:\s*6px" apps/crish-desktop/src --include="*.css"

# 确认无错误 radius token 命名
grep -rn "\-\-radius-[0-9]" apps/crish-desktop/src --include="*.css"

# 确认无旧 chat-col-max fallback
grep -rn "chat-col-max,\s*680px" apps/crish-desktop/src --include="*.css"

# 确认无硬编码 settings 宽度
grep -rn "min(720px\|min(680px" apps/crish-desktop/src \
  --include="*.css" --include="*.module.css"

# Lint 检查
npm run lint
```

---

## 五、替换操作标准流程

### 替换一个 CSS token 的完整流程
```
1. 确认新 token 已在 tokens.css 中定义，值正确
2. grep 统计该裸值在目标属性中的总出现次数，记录数字 N
3. 执行替换（单值属性先行，多值 shorthand 后续人工审查）
4. grep 验证剩余出现次数
5. 若剩余 > 0，检查每处是否属于合理例外，记录原因
6. 进入下一个 token
```

### 替换一个 JS 常量的完整流程
```
1. 确认常量已在 constants/ 或 utils/ 中定义并 export
2. 在目标文件中 import 该常量（不要用 * import，按需具名导入）
3. 替换裸字符串或魔法数字
4. npx tsc --noEmit 验证编译
5. 进入下一处
```

---

## 六、绝对禁止事项

- ❌ 未建立 token 就删除任何已有裸值
- ❌ 对多值属性（`padding: 6px 12px`）做无差别正则替换
- ❌ z-index 层级顺序未经验证就执行 Phase 2
- ❌ 跳过 TypeScript 编译检查
- ❌ 只改 `tokens.css` 不同步更新所有文件中的 fallback 值
- ❌ 新建与已有 token 语义重叠但命名不同的 token（先 grep 确认无同义 token）
- ❌ 一次 commit 同时处理多个 Phase
- ❌ 省略任何一处替换，即使"看起来影响不大"
- ❌ 使用尺寸命名 radius token（`--radius-8`），只允许语义命名
- ❌ 在 CSS-JS 双重定义问题未解决的情况下推进 Phase 3+

---

## 七、已完成项（禁止重复处理）

以下已在 commit `5017cae7` 中完成：

| 完成内容 | 文件 |
|----------|------|
| `--settings-content-max: 720px` 新增 | `tokens.css` |
| `--chat-col-max` 680→760px，`--chat-col-max-wide` 720→840px | `tokens.css` |
| 全项目 `chat-col-max, 680px` fallback → 760px | 8个文件，16处 |
| 全项目设置面板 `min(720/680px)` → `var(--settings-content-max)` | 14个文件，22处 |
| `coverContent` `align-items: center` → `stretch` | `SettingsPanel.module.css` |
| `scrollbar-gutter: stable both-edges` 新增 | `SettingsPanel.module.css` |
| `storageKeys.ts`、`eventNames.ts`、`panelIds.ts` 新建 | `src/utils/` |

**下一步从 Phase 1.3（tokens.css 新增缺失 token：space/radius/font/color/animation）开始。**

---

## 八、Agent 协作分工建议

若使用多 Agent 并行执行，推荐按以下维度拆分，每个 Agent 独立负责一个域：

| Agent | 负责范围 | 输入 | 输出 |
|-------|----------|------|------|
| Token Builder | Phase 1：tokens.css 新增、z-index.css 新建 | 方案 Section 2.1-2.6 | 修改后的 CSS 文件 |
| Z-Index Agent | Phase 2：全项目 z-index 替换 | z-index.css（Token Builder 输出） | 所有 CSS/TSX 中 z-index 替换完毕 |
| Spacing Agent | Phase 3.1-3.6：间距/radius 替换 | tokens.css（Token Builder 输出） | 所有间距/radius 硬编码清除 |
| Font Agent | Phase 4-5：字体/颜色/animation 替换 | tokens.css（Token Builder 输出） | 所有字体颜色硬编码清除 |
| JS Constants Agent | Phase 1.1-1.2：constants/ utils/ 文件创建与替换 | layout.ts、componentDefaults.ts | TSX 文件中 import 常量替换完毕 |

**并行约束**：
- Token Builder 必须最先完成，其输出是所有其他 Agent 的前提
- Z-Index Agent 可与 Spacing Agent 并行（互不干扰）
- Font Agent 可与 Spacing Agent 并行
- JS Constants Agent 独立运行，可最早并行
- 所有 Agent 完成后，由主 Agent 汇总验证（运行全量 grep + tsc）

---

*文件生成时间：基于 TOKEN-SYSTEM-REFACTOR-PLAN.md 审查结果*
*项目：Crish Desktop | 分支：refactor/architecture*
