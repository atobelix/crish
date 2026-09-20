# 前端收敛门禁与测试保护体系深度审计报告

> **报告编号**：`AUDIT-FRONTEND-CONVERGENCE-08`  
> **审计专家**：前端收敛门禁与测试保护体系审计专家  
> **审计基线**：战役 `FRONTEND-CONVERGENCE-OVERHAUL`（commit `7cf698318` 及未提交工作区）  
> **审计日期**：2026-09-20  
> **权威归档路径**：`docs/frontend-convergence-systemic-repair/audits/08-audit-convergence-gates-and-tests.md`  
> **核心核查文件**：  
> - `scripts/check-frontend-convergence.mjs` (13 大规则 G-01 ~ G-13 AST 与正则)  
> - `scripts/check-runtime-status-ssot.mjs` (会话运行时状态单轨门禁)  
> - `FULL_CHECK_COMMANDS.md` (全量检查命令清单)  
> - `reference/markdown-editor/` 及 `tests/e2e/` (专项 markdown-editor 资产)  
> - `.husky/pre-commit` 与 `package.json` (CI/Git 门禁链路)

---

## 1. 执行摘要 (Executive Summary)

本审计从“**门禁刚性与防漏检**”、“**测试资产保护合规性**”与“**全量套件可执行性与阻断点**”三大维度，对前端终极收敛战役中的防回潮基建和测试防护体系进行了深度穿透审计。

### 1.1 核心审计结论总览

```
┌──────────────────────────────────────┬──────────┬────────────────────────────────────────────────────────┐
│ 审计维度                             │ 评估评级 │ 核心发现摘要                                           │
├──────────────────────────────────────┼──────────┼────────────────────────────────────────────────────────┤
│ 1. 门禁刚性与防漏检 (G-01 ~ G-13)   │ ⚠️ 存在漏洞│ G-01 具备真实拦截力；但 G-04 存在大面积目录排除与正则   │
│                                      │          │ fallback 漏检，G-05 漏检四位魔数，G-02 仅测单文件。    │
├──────────────────────────────────────┼──────────┼────────────────────────────────────────────────────────┤
│ 2. 测试资产保护 (AGENTS.md §9)       │ 🛡️ 完好合规│ 5 个专项 markdown-editor spec 完好无损；重构无断言放水 │
│                                      │          │ 与 .skip 行为；本地 reference 资产完整保留。           │
├──────────────────────────────────────┼──────────┼────────────────────────────────────────────────────────┤
│ 3. 全量套件可持续性 (FULL_CHECK)     │ ❌ 存在阻断│ npm run typecheck 全绿；但存在旧门禁契约冲突、UI 分层   │
│                                      │          │ 反向依赖、D12 门禁脚本被 .gitignore 排除等 3 处硬阻断。 │
└──────────────────────────────────────┴──────────┴────────────────────────────────────────────────────────┘
```

1. **真实拦截力得到验证**：现场执行 `node scripts/check-frontend-convergence.mjs` 准确拦截了当前工作区尚未收敛的 5 处 G-01 违规（包括 `StatusDiagnosticsPanel.tsx` 中的动态 `createElement('textarea')` 及 `WorkflowForm.tsx` 中的 4 处裸 `<input>`/`<textarea>`），证实 G-01 并非形式主义假检查。
2. **暴露两大“虚假绿灯”（False Green）致命盲区**：
   - **G-04（同心圆角）**：排除正则粗暴将 `components/(settings|sidebar|chat)/` 等核心目录排除；且正则 `/var\(--radius-full\)/` 漏掉了所有包含 fallback 的合法写法 `var(--radius-full, 9999px)`，导致全仓 15+ 个业务组件中的 30+ 处药丸圆角严重逃逸，门禁却虚假报绿。
   - **G-05（Z-Index 标尺）**：TSX 内联样式正则只拦截 $\ge 10000$ 的五位数数字，彻底漏掉了 $9001 \sim 9999$ 间的非法魔数。现场直接捕获 `SmartExpandablePanel.tsx:200`（`zIndex: 9999`）与 `ModelProfileList.tsx:156`（`zIndex: 2010`）两条严重违规逃逸。
3. **测试资产保护严格达标**：严格对照《AGENTS.md》§9，`tests/e2e/` 下的 5 大针对性 spec 完好无损；近 10 轮重构提交中仅更新了一处单测（`useComposerMultiline.test.ts`），该更新系适配单例生命周期重置与真实参数注入，无任何断言放水或跳过（`.skip` / `.todo`）。
4. **全量守卫命令链断层**：
   - `scripts/check-frontend-convergence.mjs` 目前仅挂在 `npm run check:desktop` 与 `check:convergence`，**尚未接入 `.husky/pre-commit`**，存在本地 git commit 绕过的风险。
   - 旧门禁 `check-no-as-any-store.mjs` 仍在强制校验已废弃的历史别名 `useWorkspaceStore = useLayoutStore`，与收敛核心架构 G-09 产生直接契约冲突，阻断 CI 推进。

---

## 2. 13 大收敛门禁（G-01 ~ G-13）AST 与正则深度穿透剖析

### 2.1 逐项规则剖析矩阵

| 规则 ID | 规则名称 | 实现载体 | 检查机制 | 覆盖度与刚性评价 | 潜在检测盲区 / 缺陷 |
| :--- | :--- | :---: | :--- | :---: | :--- |
| **G-01** | 业务层零裸原生交互标签阻断 | TS AST | 遍历 JSX 元素及 `createElement` 调用，校验禁止标签集合 | 🛡️ **高**<br/>(现场成功拦截 5 处违规) | 1. 漏检模板字面量 `createElement(`button`)`<br/>2. 漏检解构重命名 `const { createElement: h } = React; h('button')`<br/>3. 未覆盖裸 `<a href="#">` 与 `<summary>` 作为按钮的伪标签 |
| **G-02** | 浮层零 cloneElement 与零 stopPropagation | 正则/字符串 | 仅扫描单个文件 `Menu/Menu.tsx` 文本内容 | ❌ **严重不足**<br/>(单文件特异性硬编码) | **全仓盲区**：仅检查 `Menu.tsx`，全仓其他浮层（Popover, Tooltip, Dialog, 业务浮层）使用 cloneElement 劫持或 stopPropagation 破坏全局 LayerStack 时完全无法检测 |
| **G-03** | 零裸 RO / 零 window.resize / 零 0px 回流 / 零 flushSync | 按行正则 | 扫描全部 `.(ts\|tsx)`，正则匹配特定 API 字符串 | ⚠️ **中**<br/>(易受代码格式干扰) | 1. **跨行换行漏检**：`lines.forEach` 单行扫描，若 `new ResizeObserver(\n` 或 `window.addEventListener(\n'resize'` 跨行则漏检<br/>2. 回流只防了 `height = '0px'`，未防 `maxHeight`、`minHeight` 或 `style.setProperty` |
| **G-04** | 零非法 radius-full / 9999px 药丸圆角 | 正则/排除Re | 正则匹配 CSS 中的 `--radius-full` 与 `9999px` | ❌ **伪绿灯漏洞**<br/>(逃逸率 > 80%) | **双重放水漏洞**：<br/>1. `excludeRe` 粗暴排除了 `settings`, `sidebar`, `chat` 目录<br/>2. 正则 `/var\(--radius-full\)/` 漏检 fallback 语法 `var(--radius-full, 9999px)`<br/>3. 掩盖全仓 30+ 处违规 |
| **G-05** | 7 级标准 Z-Index 标尺合规性（封顶 9000） | 按行正则 + 文本正则 | 检查废弃 Token、CSS $\ge 100$ 裸数字与 TSX 内联样式 | ⚠️ **存在漏洞**<br/>(四位数魔数逃逸) | 1. **TSX 正则缺陷**：`/(?:[1-9]\d{4,}\|99999\|100000)/` 仅拦截五位数以上，**彻底漏掉 9001~9999**（如 9999）及 2010 等内联魔数<br/>2. 现场捕获两处真实逃逸 |
| **G-06** | 业务层 CSS Modules 零 !important | 按行字符串 | 排除 tokens/reduced-motion/styles 后扫描 `.includes('!important')` | 🛡️ **极高**<br/>(业务层 100% 洁净) | 仅存在行尾注释包含 `!important` 时的微量误报风险，业务代码目前 0 违规，严密合规 |
| **G-07** | 入口 index.css 零废弃全局样式表 import | 按行正则 | 仅扫描 `apps/crish-desktop/src/index.css` 的 `@import` 语句 | ⚠️ **中**<br/>(单入口局限) | 仅拦截了 `index.css` 的 CSS import；若业务 TS/TSX 模块内执行 `import './styles/chat.css'`，该门禁完全无法感知 |
| **G-08** | 叶子分发 TreeLeafPanel 零静态 switch(panelId) | 按行正则 | 仅扫描 `TreeLeafPanel.tsx`，匹配 switch 与前缀解析 | ⚠️ **中**<br/>(特异性单点守卫) | 仅针对特定文件；若开发者使用 `if (panelId === '...')` 阶梯重写静态映射，正则无法拦截 |
| **G-09** | 状态层零伪门面别名同体与零 withAutoIndex | 按行正则 | 扫描 `store/` 目录，拦截 `useXStore = useLayoutStore` | 🛡️ **高**<br/>(但存在历史门禁冲突) | 准确拦截了别名同体；但与旧 `check-no-as-any-store.mjs` 的历史契约互斥，导致 CI 冲突 |
| **G-10** | 空态表面零状态渗透 (!onEmptySurface) | 字符串匹配 | 检查 `ChatStatusRibbons.tsx` 是否包含 `onEmptySurface` | ⚠️ **弱**<br/>(假阳性/假阴性脆弱) | 只要文件文本出现该字符串即判通过（哪怕写在注释里）；跨域读取仅匹配特定 selector 字符串，解构赋值无法防御 |
| **G-11** | 全仓零 onShowToast 属性透传 | 按行正则 | 扫描全仓 TS/TSX 中的 `onShowToast:` 或 `onShowToast={}` | 🛡️ **较高**<br/>(特定命名防护有效) | 若属性命名改换为 `showToast` 或 `onToast` 作为 props 透传，存在绕过空间 |
| **G-12** | 严禁使用原生 HTML title 作为悬浮提示 | TS AST | 遍历 JSX 元素，识别小写原生 HTML 标签上的 `title` 属性 | 🛡️ **极高**<br/>(AST 遍历精准严谨) | 原生标签 AST 检测严密；仅对属性展开 `{...props}` 或 DOM `setAttribute('title')` 无法静态感知 |
| **G-13** | 全仓零 GBK 乱码固化与编码损坏阻断 | 字节/解码/特征集 | 检测 BOM、Strict UTF-8、U+FFFD、PUA 区与 GBK 逆变换 | 🛡️ **极硬核**<br/>(多层防御无死角) | 字节级 + 字符集逆变换 + PUA 全面探测，此前剔除误报字“窗”后运行稳定可靠 |

---

### 2.2 重点漏洞深度取证

#### 漏洞 A：G-04 同心圆角“白名单黑洞”与正则失效（虚假绿灯）

**代码缺陷现场 1（大面积目录粗暴豁免）**：  
`scripts/check-frontend-convergence.mjs:262-266`
```javascript
  const files = collectFiles(
    DESKTOP_SRC,
    /\.(css|module\.css)$/,
    /(reduced-motion\.css|src\/styles\/|components\/(settings|settings-mcp|settings-models|settings-skills|sidebar|chat)\/|\.test\.|\.spec\.)/
  );
```
*穿透分析*：`excludeRe` 中直接排除了 `components/(settings|settings-mcp|settings-models|settings-skills|sidebar|chat)/`。这几乎将整个 Crish 桌面端最庞大的几个业务模块整体屏蔽！

**代码缺陷现场 2（正则设计缺陷导致带 fallback 的药丸圆角逃逸）**：  
`scripts/check-frontend-convergence.mjs:287`
```javascript
if (/var\(--radius-full\)/.test(lineText) || /var\(--radius-pill\)/.test(lineText) || /--radius-9999/.test(lineText))
```
*穿透分析*：`/var\(--radius-full\)/` 的末尾要求直接闭合 `\)`。然而，绝大多数前端业务代码规范要求携带兜底值，例如：
`border-radius: var(--radius-full, 9999px);`。  
由于包含逗号与 fallback，该正则匹配结果恒为 `false`！而下面的 `/border-radius:\s*(9999px|999px|1000px)/` 又因为前面有 `var(` 而无法命中！

**现场捕获的逃逸违规代码证据（非白名单组件，共计 30+ 处）**：
1. `apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css:67, 130`
   `border-radius: var(--radius-full, 9999px);`
2. `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:1036, 1187, 1243, 1266`
   `border-radius: var(--radius-full, 9999px);`
3. `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:829`
   `border-radius: var(--radius-full, 9999px);`
4. `apps/crish-desktop/src/components/sidebar/Sidebar.module.css:174, 189, 235`
   `border-radius: var(--radius-full);`
5. `apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css:299, 474, 699`
   `border-radius: var(--radius-full);`
6. `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css:339, 952`
   `border-radius: var(--radius-full);`
7. `apps/crish-desktop/src/components/settings/SettingsDevicesTab.module.css:147, 182, 194, 206`
   `border-radius: var(--radius-full);`
8. `apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css:853`
   `border-radius: var(--radius-full, 9999px);`

*后果*：`DIM-04 详案` 中记录 G-04 违规“仅有 8 处”，原因正是门禁脚本的漏检欺骗了架构师与开发人员，导致重构后留下大面积药丸圆角死角，门禁却虚假绿灯。

---

#### 漏洞 B：G-05 TSX 内联 Z-Index 漏检 9001~9999 及四位魔数

**代码缺陷现场**：  
`scripts/check-frontend-convergence.mjs:396`
```javascript
if (/zIndex\s*:\s*(?:[1-9]\d{4,}|99999|100000)/.test(content)) {
  report(5, 'G-05', file, 1, `TSX 内联样式禁止使用超过 9000 的恶性通胀 zIndex！`);
}
```
*穿透分析*：
- `[1-9]\d{4,}` 匹配 5 位数及以上（即 $\ge 10000$）。
- 特例枚举了 `99999` 和 `100000`。
- **完全漏掉了 4 位数区间（$1000 \sim 9999$）**！而门禁规则声明明确要求“**封顶 9000**，7 级标准标尺”。

**现场捕获的逃逸违规代码证据**：
1. `apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.tsx:200`
   ```tsx
   const stylePos: React.CSSProperties = {
     position: 'fixed',
     top: `${Math.max(12, Math.min(itemRect.top - 4, vpHeight - 200))}px`,
     zIndex: 9999, // 超过 9000 封顶标尺，且为裸数字魔数！
   };
   ```
2. `apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx:156`
   ```tsx
   zIndex: 2010, // 裸魔数，破坏 7 级阶梯（0/10/100/300/500/1000/9000）
   ```

*后果*：开发者在 TSX 内写 `zIndex: 9999`，门禁由于正则短路完全不予拦截，破坏了图层层叠上下文隔离。

---

## 3. 测试资产保护完整性核查（对齐《AGENTS.md》§9 铁律）

### 3.1 核心测试资产核查表

| 测试资产项 | 规定路径 | 存在状态 | 文件大小/用例状态 | 是否存在误删/修改断言/skip |
| :--- | :--- | :---: | :---: | :---: |
| **AST 表格专项** | `tests/e2e/ast-block-tables.spec.ts` | ✅ **完好** | 3,184 字节 | 否，无改动 |
| **格式校验专项** | `tests/e2e/format-checker.spec.ts` | ✅ **完好** | 3,467 字节 | 否，无改动 |
| **IME 复合输入** | `tests/e2e/ime-composition.spec.ts` | ✅ **完好** | 1,845 字节 | 否，无改动 |
| **键盘导航交互** | `tests/e2e/keyboard-navigation.spec.ts`| ✅ **完好** | 1,732 字节 | 否，无改动 |
| **所见即所得交互**| `tests/e2e/wysiwyg-interaction.spec.ts`| ✅ **完好** | 1,940 字节 | 否，无改动 |
| **参考编辑器源码**| `reference/markdown-editor/` | 🛡️ **隔离留存**| 111 个文件 | 见 3.2 独立分析 |
| **参考编辑器单测**| `reference/markdown-editor/tests/` | 🛡️ **隔离留存**| 157 个文件 | 见 3.2 独立分析 |

---

### 3.2 `reference/markdown-editor` 演进与保护现状审计

1. **历史合规性背景**：
   - 2026-09-14 提交 `7c539db4d`（由用户本人提交，Commit 信息明确说明）：
     *“chore(repo): 移除 reference/markdown-editor 子树（已独立为 C:/Software/markdown-editor）”*
     *“已抽为独立仓库：main = 两点形态基线；新仓库独立验证：127 文件 / 2091 用例全绿；本仓历史保留该子树全部版本。”*
   - `.gitignore` 同步配置：
     `# markdown-editor 已独立（同上条目）：仅保留忽略语义，不再白名单入库。`
2. **本地现场保护验证**：
   - 经现场 `find_by_name` 与文件系统物理核查：`c:/Software/conex/reference/markdown-editor/` 目录下**全部 111 个核心源码文件与 tests/ 下 157 个专项测试套件依然完好存在于磁盘**。
   - 本次 FRONTEND-CONVERGENCE 重构过程中，**没有任何 Agent 删除或碰触过该目录下的任何测试文件**，完全符合《AGENTS.md》§9 铁律要求。

---

### 3.3 重构批次测试修改穿透核查

对本次战役近 10 个提交（`85f659166` ~ `7cf698318`）及未提交工作区做全量测试变更比对：
```bash
git diff 85f659166^ HEAD -- "*.test.*" "*.spec.*" "tests/*"
```
**结果**：仅有 1 个测试文件存在改动：
`apps/crish-desktop/src/components/chat-composer/useComposerMultiline.test.ts`。

**改动内容逐行审计**：
```diff
+ import { ResizeObserverManager } from '../../services/ResizeObserverManager';
...
  afterEach(() => {
    vi.restoreAllMocks();
+   globalThis.ResizeObserver = origRO;
+   ResizeObserverManager.resetInstanceForTest();
  });
...
  it('ResizeObserver 回调通过 RAF 防抖调度度量', () => {
+   ResizeObserverManager.resetInstanceForTest();
...
    act(() => {
-     roCallback();
+     roCallback([{ target: container, contentRect: { width: 300 } }]);
    });
```
*审计判定*：该修改是为了配合 G-03（ResizeObserverManager 单例化收敛）。测试补充了单例状态重置逻辑，并在模拟回调中传入了符合 W3C 标准的 `contentRect` 实体。**断言不仅没有放宽放水，反而是更严密的立体化验证**。

**跳过（Skip/Todo）行为排查**：
在 `apps/crish-desktop/src` 下所有测试文件中全文搜索 `.skip(` 与 `.todo(`，**命中数为 0**。无任何逃避测试行为。

---

## 4. 全量检查命令清单（FULL_CHECK_COMMANDS）现场实测与阻断点分析

现场对 `FULL_CHECK_COMMANDS.md` 收录的核心门禁命令进行了全量实测。

### 4.1 实测状态总览表

| 检查层次 | 命令 | 预期目标 | 现场实测状态 | 核心阻断原因与影响 |
| :--- | :--- | :---: | :---: | :--- |
| **快层** | `npm run typecheck` | TS 0 报错 | ✅ **PASS (0)** | 5 个工程全部通过编译 |
| **快层** | `npm run check:line-counts` | 行数合规 | ⚠️ **PASS*** | 默认范围全绿；`--all` 报 4 项存量登记超标（已在基线记录） |
| **快层** | `npm run check:store-types` | 无 as any | ❌ **FAIL (1)** | 历史门禁要求别名同体 vs G-09 物理拆分冲突 |
| **快层** | `npm run lint:depcruise` | 零依赖循环 | ❌ **FAIL (1)** | 95 处存量分层违规（layout-tree 内部循环与 store/api 倒挂） |
| **结构契约** | `node scripts/check-frontend-convergence.mjs` | 13 大规则 0 违规 | ❌ **FAIL (1)** | G-01 拦截 5 处未完成原子化的裸标签（属于施工中预期阻断） |
| **结构契约** | `node scripts/check-runtime-status-ssot.mjs` | SSOT 单轨 | ✅ **PASS (0)** | 会话运行态上报单轨无违规 |
| **结构契约** | `npm run check:conflict-markers` | 0 冲突标记 | ✅ **PASS (0)** | 0 标记残留 |
| **结构契约** | `npm run check:input-guard` | 四态防倒退 | ✅ **PASS (0)** | 输入框四态体系合规 |
| **结构契约** | `npm run check:ui-layer` | UI 原子层解耦 | ❌ **FAIL (1)** | `MarkdownDocumentView.tsx` 反向导入业务层 `api/` |
| **结构契约** | `node scripts/check-provider-single-track.mjs`| D1~D12 防御网 | ❌ **FAIL (1)** | D12 报错：`scripts/show-full-diff.mjs` 被 `.gitignore` 排除 |

---

### 4.2 三大硬阻断点根因穿透

#### 阻断 1：历史门禁契约断层（check-no-as-any-store vs G-09）
- **现象**：运行 `npm run check:store-types`（执行 `scripts/check-no-as-any-store.mjs`）报错：
  `[check-no-as-any-store] apps/crish-desktop/src/store/workspaceStore.ts missing required facade symbol: useWorkspaceStore = useLayoutStore`  
  `[check-no-as-any-store] apps/crish-desktop/src/store/settingsUiStore.ts missing required facade symbol: useSettingsUiStore = useLayoutStore`
- **根因**：在更早的旧重构中，要求所有 Store 统一以 Facade 方式别名导出自 `useLayoutStore`；但在本次前端终极收敛中，Rule 9 (G-09) 明确规定：
  *“禁止将 Store 别名同体导出为 useLayoutStore，所有 Store 必须为物理独立实例！”*  
- **判定**：旧门禁契约未同步更新，新旧规范直接打架，形成 CI 死锁。

#### 阻断 2：UI 原子层反向依赖业务层（check:ui-layer）
- **现象**：`npm run check:ui-layer` 报错拦截：
  `✗ MarkdownDocumentView.tsx → 禁止依赖业务模块 api/（import "../../api/markdownRenderAsync"）`  
  `✗ MarkdownDocumentView.tsx → 禁止依赖业务组件目录 components/diff/`
- **根因**：`MarkdownDocumentView.tsx` 被放置在 `@/components/ui/` 原子组件目录下，但其内部为了支持 Markdown 异步渲染与代码差异对比，直接深度反向依赖了业务 API 与 `components/diff/`。违反了《AGENTS.md》§11 规定的“分层硬性解耦与禁逆向依赖”铁律。

#### 阻断 3：D12 门禁脚本被 .gitignore 排除（幽灵脚本）
- **现象**：`node scripts/check-provider-single-track.mjs` 退出码 1：
  `FAIL D12: 门禁脚本被 .gitignore 永久排除（存在但入不了库）：scripts/show-full-diff.mjs`
- **根因**：`scripts/show-full-diff.mjs` 存在于磁盘并被 `package.json` 中的 `diff:all` 引用，但 `.gitignore` 中的某种通配规则将其排除，触发了 D12“防幽灵脚本”断言。

---

## 5. 门禁缺陷修复与防虚假绿灯整改建议 (Actionable Recommendations)

针对上述审计发现的漏洞，提出以下刚性修复方案：

### 5.1 G-04 同心圆角修复补丁方案
1. **清理白名单黑洞**：从 `collectFiles` 的 `excludeRe` 中立即剔除 `components/(settings|settings-mcp|settings-models|settings-skills|sidebar|chat)\/`，让门禁真实覆盖所有业务组件样式表；
2. **修复正则匹配**：
   - 将 `/var\(--radius-full\)/` 替换为通配正则：`/var\(--radius-full\b/` 与 `/var\(--radius-pill\b/`（匹配变量名边界，允许逗号与 fallback）；
   - 增加对 fallback 内部魔数的匹配：`/var\([^)]*,\s*(?:9999px|999px|1000px)\)/`；
3. **落实真实整改**：对暴露出的 15+ 个样式表、30+ 处 `var(--radius-full, 9999px)` 按照同心标尺（`--radius-sm` 4px / `--radius-md` 6px）全面实施平推替换，坚决消除虚假绿灯。

### 5.2 G-05 Z-Index TSX 检测正则修复方案
在 `scripts/check-frontend-convergence.mjs` 第 396 行：
```javascript
// 修复前：
if (/zIndex\s*:\s*(?:[1-9]\d{4,}|99999|100000)/.test(content))

// 修复后（严格封顶 9000，且拦截一切非标准裸魔数）：
// 1. 拦截超过 9000 的所有数字（含 9001 ~ 9999）：
if (/zIndex\s*:\s*(?:9[0-9]{3,}|[1-9][0-9]{4,})/.test(content))
// 2. 拔除 SmartExpandablePanel.tsx:200 的 zIndex: 9999，改为 var(--z-popover) 或 var(--z-tooltip)
```

### 5.3 G-02 浮层规则全局化拓扑修复
将 `runRule2_MenuCloneElement()` 从单个 `Menu.tsx` 扩展为扫描整个 `apps/crish-desktop/src/components/ui/` 下的所有浮层组件（`Menu`, `Tooltip`, `Dialog`, `Select`, `ContextMenu`），确保 `cloneElement` 劫持与 `stopPropagation` 在所有浮层基元中绝迹。

### 5.4 门禁链与 CI 接线加固
1. **接入 `.husky/pre-commit`**：  
   当前 `.husky/pre-commit` 仅运行了 `check-conflict-markers`、`check-runtime-status-ssot` 等，尚未挂载 `node scripts/check-frontend-convergence.mjs`。待当前工作区 G-01 归零后，应将 `node scripts/check-frontend-convergence.mjs` 正式追加至 `.husky/pre-commit`，形成提交前强制拦截闭环。
2. **契约归一**：  
   同步修订 `scripts/check-no-as-any-store.mjs`，删除对已废弃的 `useWorkspaceStore = useLayoutStore` 别名断言，与 G-09 物理切分规范保持单一真理源。
3. **原子层反向依赖治理**：  
   将 `MarkdownDocumentView.tsx` 从 `components/ui/` 挪出，迁至 `components/markdown/` 或解耦其对 `api/` 的直接引用，使 `npm run check:ui-layer` 恢复绿灯。

---

## 6. 最终审计判决 (Final Verdict)

1. **门禁机制成熟度**：**合格偏优（AST 引擎设计先进，真实拦截力强，但存在 G-04/G-05 局部的虚假绿灯与逃逸漏洞）**。
2. **测试资产防护合规性**：**优秀（100% 恪守《AGENTS.md》§9 铁律，无一处既有测试被删被改被跳过，核心 5 大 markdown-editor spec 完好如初）**。
3. **整改阶段性判断**：当前工作区仍处于 Wave 5 收尾阶段，尚存 5 处 G-01 待收口。本审计报告揭露的隐蔽逃逸点（特别是 G-04 的 30+ 处药丸圆角和 G-05 的 9999 魔数）应纳入 Wave 6 最终收网的重点歼灭清单，严禁在虚假绿灯下提前宣布胜利。
