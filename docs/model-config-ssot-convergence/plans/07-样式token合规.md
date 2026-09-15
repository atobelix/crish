# W7 样式 token 合规

> **维度**：W7（独立，可与 W2–W6 并行）
> **上游**：`00-总方案.md` §0 U4、§3 INV-10
> **本维使命**：配置相关界面 100% 遵从 Design Tokens，**禁止**裸字号/圆角/字重/颜色/层级。
> **本维不改**：任何逻辑。

---

## 1. 问题（本维负责的条目）

| # | 问题 | 证据 |
| --- | --- | --- |
| 34 | 裸字号 / 圆角 / 字重（配置域 CSS） | `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css:89,113,114,147,200,201,206,207,216,226,227,228,243,267,302,303` |
| 34 | 同上 | `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css:424,442,490,875,883` |
| 34 | 同上 | `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css:46,449` |
| 35 | 裸 `zIndex: 2010` 未走 token | `apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx:155` |
| — | 魔术数 `max-height: 150px` | `ModelBadgePickerMenu.module.css:150` |

---

## 2. Token 权威源

**定义源**：`apps/crish-desktop/src/styles/tokens.css`（647 个已定义变量）+ `styles/z-index.css`（z-index 权威源）。

**实现前必读**：`tokens.css` 中已定义的**字号梯队 / 圆角梯队 / 字重梯队 / z-index 梯队**，不得发明新 token。

**若梯队中缺少所需值**：
- **禁止**发明伪 token（如 `--surface-primary`、`--text-on-brand` —— 上游已清剿过此类）。
- **禁止**直接写裸值。
- **必须**在 `tokens.css` 中**新增一个语义化梯队成员**（如梯队缺 `12.5px` 档则须评估是否复用 `12px`；**优先复用既有梯队**，只有当既有梯队确实无法表达时才新增）。

---

## 3. 目标态（逐项）

### 3.1 `ModelBadgePickerMenu.module.css`

| 行 | 现状 | 目标 |
| --- | --- | --- |
| `:89` | `border-radius: 4px;` | `var(--radius-sm)`（**须先确认该 token 值 = 4px**；否则按实际梯队选择） |
| `:113` | `font-size: 10.5px;` | 梯队中最接近的既有值（**优先** `var(--font-size-xs)` 之类；若无 10.5 档，评估改设计为 11px） |
| `:114` | `font-weight: 700;` | `var(--font-weight-heavy)` 或既有字重 token |
| `:147` | `font-weight: 500;` | `var(--font-weight-medium)` |
| `:150` | `max-height: 150px;` | 若属布局必要值 → 提取为**语义 token**（如 `--picker-list-max-height`）并在 `tokens.css` 定义；**禁止**留在组件内 |
| `:200,206,267` | `font-size: 12px;` | 对应字号 token |
| `:201,207,228` | `font-weight: 500;` | `var(--font-weight-medium)` |
| `:216` | `border-radius: 8px;` | `var(--radius-lg)` |
| `:226,302` | `border-radius: 6px;` | `var(--radius-md)` |
| `:227` | `font-size: 11px;` | 对应字号 token |
| `:243` | `font-weight: 600;` | 对应字重 token |
| `:303` | `font-size: 11.5px;` | 对应字号 token（若无该档，评估复用 11 或 12） |

### 3.2 `ModelsSettingsTab.module.css`

| 行 | 现状 | 目标 |
| --- | --- | --- |
| `:424,442,490` | `font-weight: 500;` | `var(--font-weight-medium)` |
| `:875,883` | `border-radius: 50%;` | `var(--radius-circle)`（**已存在该 token，属未复用**） |

### 3.3 `YamlConfigEditorModal.module.css`

| 行 | 现状 | 目标 |
| --- | --- | --- |
| `:46,449` | `font-weight: 600/500;` | 对应字重 token |

### 3.4 `ModelProfileList.tsx`

| 行 | 现状 | 目标 |
| --- | --- | --- |
| `:155` | `zIndex: 2010`（行内） | 从 `styles/z-index.css` 的梯队取值。**若梯队无该层** → 在 `z-index.css` 中定义语义层（如 `--z-popover`）并使用。**禁止**行内裸值。 |

**注**：`ModelProfileList.tsx:151-157` 的其余行内样式（`position: fixed`/`left`/`top`/`transformOrigin`）为**动态几何**，属合法保留（见 `survey/01` §7.4）。

---

## 4. 全量扫描范围（不止已知项）

本维**必须**对整个配置链路做一次穷尽扫描，而非只修已知行号：

**扫描目录**：
- `apps/crish-desktop/src/components/settings-models/**/*.module.css`
- `apps/crish-desktop/src/components/provider/**/*.module.css`
- `apps/crish-desktop/src/components/chat-card/**/*.module.css`（模型选择器部分）
- 上述目录下所有 `.tsx` 的**行内样式**

**扫描项**：
- `font-size:` 裸值（非 `var(`）
- `font-weight:` 裸值
- `border-radius:` 裸值
- `color:` / `background:` 裸 Hex / `rgb(` / `rgba(`
- `z-index:` 裸值
- 行内 `style={{}}` 中的颜色与层级裸值

**已确认干净**：颜色侧（无裸 Hex / 伪 token）—— 但**必须复核**，因 W2/W3 可能新增样式。

---

## 5. 文件域（互斥写集）

| 文件 | 本维改动 |
| --- | --- |
| `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css` | 裸值 → token |
| `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css` | 裸值 → token |
| `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css` | 裸值 → token |
| `apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx` | `zIndex` → token |
| `apps/crish-desktop/src/styles/tokens.css` | **仅在梯队确实缺失时**新增语义 token |
| `apps/crish-desktop/src/styles/z-index.css` | **仅在层级确实缺失时**新增语义层 |

**冲突警告**：`ModelsSettingsTab.module.css` 可能被 W2（空态引导样式）触碰 → **W2 先，W7 后**。
`ModelProfileList.tsx` 可能被 W5（删除 `PROTOCOL_TEMPLATES` 相关 import）触碰 → **W5 先，W7 后**。

---

## 6. 验收断言

### A 源码形状
在配置域四个目录内：
- `font-size:` 后**非** `var(` 的行数 = 0
- `font-weight:` 后**非** `var(` 的行数 = 0
- `border-radius:` 后**非** `var(` 的行数 = 0
- `z-index:` 后**非** `var(` 的行数 = 0
- 裸 Hex / `rgb(` / `rgba(` = 0
- `var(--xxx)` 中 `--xxx` 在 `tokens.css` / `z-index.css` **均未定义** 的数量 = 0（伪 token 检测）

### B 本会话真跑测
- 运行既有样式门禁（若存在 `check:desktop` 中的样式检查）→ 绿。
- 新增/扩展门禁脚本：`scripts/check-model-config-ssot.mjs` 中包含上述 grep 断言。
- `tsc --noEmit` 绿（行内样式改动不破坏类型）。
- 视觉回归：若有 storybook / 截图测试 → 跑一次确认无意外变化。

### C 真实宿主用户路径
- 真机打开设置模型页 + 对话模型选择器，浅色与深色主题各看一遍 → 断言：无字号异常、无圆角不一致、无层级错乱（浮层被遮挡）。

---

## 7. 未确认项（实现时必须先钉）

1. `tokens.css` 中**实际**的字号/圆角/字重/z-index 梯队值 —— 本文件只列了问题行号，未列出梯队全貌。实现前必须先读 `tokens.css` 建立对照表。
2. 是否有既有的样式门禁脚本（如 `check:desktop` 中的 stylelint 配置）—— 决定是扩展还是新建。
3. `max-height: 150px` 是否属必要的布局约束 —— 决定是 token 化还是改设计。
4. 上游 ε 轮（`docs/model-config-product-chain/execution/epsilon-轮次报告.md`）已清剿过 settings-models 域的幽灵 token，本维须**避免重复劳动**：先复核其成果，只补其遗漏（`ModelBadgePickerMenu.module.css` 的裸值是其未覆盖面）。

---

## 8. 与其它维的接口

- **并行性**：本维与 W2–W6 无逻辑依赖，可并行。但同文件冲突需串行（见 §5）。
- **上游继承**：ε 轮已清 `--surface-primary` / `--text-on-brand` 等幽灵 token；本维**不重复**，只处理裸值。
- **输出给 W8**：裸样式 grep = 0 是门禁断言之一。
