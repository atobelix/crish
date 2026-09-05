# 03-测试资产保护与门禁防线评审报告（测试护栏穿透审查与 CI 终审）

> **战役代号**：`UI-UNIFICATION-REDESIGN`  
> **评审对象**：`docs/ui-unification-redesign/independent-plans/` 全部 6 份独立实施详案（重点对齐 `06-test-guardrails-and-verification-plan.md`）  
> **评审角色**：测试资产保护与门禁防线审查 Subagent  
> **权威依据**：
> - `AGENTS.md`（§1 反退避铁律、§3 Git 提交纪律、§7 严禁补丁与绕过、§7.1 立体验证纪律、§8 反过度设计硬性红线、§9 测试资产保护铁律、§11 CI 治理与解耦断言、§13 输入与焦点态、§14 色彩空间、§15/§16 桌面调试 Tauri MCP 4000）
> - `.agents/LOGIC_PLAN_NO_RETREAT.md`（纯逻辑规划、效果锁与验证资产一等公民）
> - `FULL_CHECK_COMMANDS.md`（全仓现行真实门禁命令清单与已知失败基线）
> - 现行工程源码与测试用例（`style-contract.test.ts`、`Tabs.test.tsx`、`Button.test.tsx`、`check-ui-layer.mjs` 等）

---

## 一、评审总览与核心裁决（Executive Summary & Verdict）

### 1.1 评审结论：【有条件通过 / 需刚性整改 5 项阻断性缺陷后方可进入实施波】

各独立方案（尤其是方案 06）在测试防护意识、反退避原则（`Net-Negative LOC ≥ 650`）以及立体化守门层级设计上展现了极高的工程追求。然而，经对现行代码库真实文件、AST 依赖与现存单测用例展开**行级穿透式审计**，发现方案 06 及相关详案中存在 **5 项致命的死角与事实性偏差**。若不加修正直接按原案执行，**将导致 CI 门禁发生大面积假死报错（Exit 1）、合法活跃 Token 被误杀、或测试套件自身崩溃**。

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 测试资产与门禁防线审查核心风险与裁决矩阵                                                │
├────┬─────────────────────────────┬──────────┬──────────────────────────────────────────┬───────────────────────────────┤
│ 序 │ 审查模块 / 风险领域         │ 严重等级 │ 现场事实与缺陷根因                       │ 阻断后果与整改要求            │
├────┼─────────────────────────────┼──────────┼──────────────────────────────────────────┼───────────────────────────────┤
│ 1  │ `a11y-optical-contract`     │ **P0**   │ `AUDITED_16_TARGETS` 中 **12 处路径错误**│ 契约测试执行时将直接报 12 个   │
│    │ 16 处跳动数字靶标路径       │ **阻断** │ 臆造 `modals/`、`panels/`、`terminal/`   │ “文件不存在”致命异常，CI 瞬时 │
│    │                             │          │ 等不存在的目录（如 `PriceConfigModal`）  │ 爆红中断！必须纠偏为真实路径。│
├────┼─────────────────────────────┼──────────┼──────────────────────────────────────────┼───────────────────────────────┤
│ 2  │ `check-ui-negative-churn`   │ **P0**   │ ① 正则 `/--sep-[...]:/g` 误杀活 Token；   │ ① 全仓活组件仍消费 10 个 sep；│
│    │ 负产出自动化门禁脚本        │ **阻断** │ ② 引用不存在的 `ModernToolCall` 假路径； │ ② 假路径触发兜底导致削减量虚高│
│    │                             │          │ ③ `SidebarHeader/Footer` 私有类无对应文件│ 必须精准限定待删别名与物理文件│
├────┼─────────────────────────────┼──────────┼──────────────────────────────────────────┼───────────────────────────────┤
│ 3  │ `Tabs.module.css` 升级契约  │ **P1**   │ ① 方案 06 误将 `--tab-spring-bezier` 写成│ ① 替换代码无法命中真实变量；  │
│    │ 阻尼归一与圆角锁步          │ **高危** │   不存在的 `--tab-ease`；                │ ② DIM-02(8px) 与 06(button-   │
│    │                             │          │ ② DIM-02 方案与方案 06 发生断言冲突      │    radius)断言互搏，需对齐真源│
├────┼─────────────────────────────┼──────────┼──────────────────────────────────────────┼───────────────────────────────┤
│ 4  │ `style-contract.test.ts`    │ **P1**   │ ① `tokens.css` 含两处 `--button-radius`  │ ① 单边替换必漏 L26 导致断言失败│
│    │ 7px 升级与暗色覆盖          │ **高危** │   (L26 与 L458)，方案 06 漏记 L26；      │ ② 現行基线已有两处失败(3.5% vs│
│    │                             │          │ ② 当前基线已存在两处存量测试失败！      │    2.5% 漂移)，重构需同步归位 │
├────┼─────────────────────────────┼──────────┼──────────────────────────────────────────┼───────────────────────────────┤
│ 5  │ `check:ui-layer`            │ **P1**   │ `Tabs`, `SegmentedControl` 等 4 个文件   │ 方案 06 宣称该门禁为 Exit 1   │
│    │ 原子层解耦门禁集成          │ **高危** │ 现存对 `ResizeObserverManager` 逆向依赖  │ 硬阻断，但未规划解耦动作，合并│
│    │                             │          │ 当前主干执行即报 Exit 1 失败！           │ 必遭拦截。必须规划公共下沉。  │
└────┴─────────────────────────────┴──────────┴──────────────────────────────────────────┴───────────────────────────────┘
```

---

## 二、测试契约穿透审查（Test Contract Penetration Review）

### 2.1 `style-contract.test.ts:474-503` 7px 升级为 8px 的锁步安全性分析

#### 2.1.1 现场源码证据：`tokens.css` 存在“双重定义陷阱”
在现行 [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中，`--button-radius` 并非仅有一处定义，而是存在**两处历史硬编码**：
1. **第 26 行**：
   ```css
   /* tokens.css:25-31 */
   /* 几何尺寸与圆角契约 (锁定 7px 按钮圆角与 9999px 胶囊圆角) */
   --button-radius: 7px;
   --radius-full: 9999px;
   --radius-tooltip: var(--radius-full);
   --seg-outer-radius: var(--button-radius, 7px);
   --seg-inner-radius: var(--button-radius, 7px);
   ```
2. **第 458 行**：
   ```css
   /* tokens.css:457-458 */
   /* 设置/按钮圆角锁：默认档 7px，禁止再别名到 --radius-md 的 6 */
   --button-radius: 7px;
   ```

#### 2.1.2 脆弱面与锁步破坏风险
- 方案 06 在 §2.1.2 仅给出了针对 `tokens.css` 的单处 diff 示范（第 105-106 行），极易引导实施 Agent 仅修改第 458 行而遗漏第 26 行；
- `style-contract.test.ts:478` 采用正则匹配：`expect(lightBlock).toMatch(/--button-radius:\s*7px/);`。若升级后引入方案 06 的反向断言 `expect(lightBlock).not.toMatch(/--button-radius:\s*7px/);`，只要第 26 行未被同步清理，**测试将立即抛出异常阻断提交**；
- 此外，第 29-30 行的 `--seg-outer-radius` 与 `--seg-inner-radius` 均兜底指向 `var(--button-radius, 7px)`，且 `inner` 与 `outer` 半径相等（同心几何违规第 1 项）。

#### 2.1.3 刚性整改规范（原子事务提交要求）
必须在同一个原子 Commit 中完成以下 5 处锁步替换，缺一不可：
1. `tokens.css:26`：`--button-radius: 7px;` $\to$ `--button-radius: 8px;`；
2. `tokens.css:29-30`：`--seg-outer-radius: var(--button-radius, 8px);`，`--seg-inner-radius: calc(var(--seg-outer-radius) - 2px);`；
3. `tokens.css:458`：彻底删除重复声明 `--button-radius: 7px;`（收敛为第 26 行单一定义）；
4. `Button.module.css:11`：`--btn-radius: var(--button-radius, 7px);` $\to$ `var(--button-radius, 8px);`；
5. `SegmentedControl.module.css:65`：`--seg-outer-radius: var(--button-radius, 7px);` $\to$ `var(--button-radius, 8px);`；
6. `style-contract.test.ts:474-503`：同步更新断言，严禁留下半衰期窗口。

---

### 2.2 色系前缀暗色覆盖与动态注入 Token 白名单审查

#### 2.2.1 动态注入 Token 白名单（双层同源约束 1）审查
- **断言机制**：[`style-contract.test.ts:352-368`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts#L352-L368) 抓取 `themeStore.ts` 与 `themePersonalization.ts` 中全部 `setProperty('(--[\\w-]+)'`。
- **全量提取核验**：经对 [`src/api/themePersonalization.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themePersonalization.ts) 进行全量 AST 扫描，动态注入的 Token 精确为 **21 个**：
  `--font-size-adjust`, `--accent-green-light-adaptive`, `--accent-red-light-adaptive`, `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-card`, `--bg-elevated`, `--shell-chrome-bg`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--border-color`, `--border-subtle`, `--bg-workspace`, `--shell-inset-bg`, `--control-mix-color`, `--control-soft-bg`, `--control-soft-bg-hover`, `--control-soft-bg-active`, `--composer-bg`。
- **审查结论**：方案 01 §5.2 与方案 06 整理的 21 个白名单**100% 严丝合缝，零遗漏**。这些变量在 `tokens.css` 中享有绝对豁免权，严禁被误列为死变量删除。

#### 2.2.2 色系前缀暗色覆盖（Dark Branch Coverage）审查
- **断言机制**：[`style-contract.test.ts:163-180`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts#L163-L180) 扫描 Light 块中所有匹配 `/--(?:bg|text|border|accent|color|tint|sidebar|control)-[\w-]+\s*:/g` 的 Token，断言其必须在 Dark 块（`html[data-theme='dark']`）中重新定义，除非在 `DARK_EXCLUDE` 白名单中。
- **排查风险**：
  1. DIM-01 计划清除 `--thought-*` (30个) 与 `--banner-error-*` (8个)。由于 `--banner-error-*` 命中 `banner-`（不属于上述 8 个前缀），而 `--thought-*` 也不属于上述前缀，故删除思考链和横幅不会破坏前缀暗色覆盖；
  2. 但 DIM-01 涉及 `--accent-danger` 与 `--color-text-dim`：
     - `--accent-danger` 在 Light(L291) 与 Dark(L1088) 均存在；若清理时仅在 Light 删除而 Dark 遗漏，或反之，虽不会触发 `missing`，但破坏对称性；
     - DIM-04 计划引入 `--action-ghost-hover` 或 `--btn-hover-overlay`：由于前缀为 `--action-` 与 `--btn-`，不受前缀正则约束。但若在 Light 中引入任何 `--color-*` 或 `--tint-*`，**必须在 Dark 块同步声明**，否则该测试用例将直接断言失败。

#### 2.2.3 现场警报：`style-contract.test.ts` 现行基线存在 2 处存量失败
在当前工程主干执行 `npx vitest run apps/crish-desktop/src/styles/style-contract.test.ts`，实际退出码为 1，存在 **2 个未修复断言**：
1. `style-contract.test.ts:414`：
   `expect(lightBlock).toContain('--control-soft-bg-hover: var(--tint-active)');`
   - **现场**：`tokens.css:148` 声明的是 `--control-soft-bg-hover: var(--tint-hover);`。
2. `style-contract.test.ts:424`：
   `expect(block).toContain('--tint-hover: color-mix(in srgb, var(--text-primary) 3.5%, transparent)');`
   - **现场**：`tokens.css:66` 声明的是 `2.5%`，`tokens.css:67` 声明的是 `5%`（与测试断言的 `3.5%` 和 `6.5%` 漂移）。
- **裁决**：方案 01 与方案 06 必须在实施 Phase 0 将这两处既有漂移完成归一化处理（按设计规范统一定案），严禁将带病代码带入后续批次。

---

### 2.3 `Tabs.test.tsx:314, 328` 1.5 贝塞尔与 7px 升级方案审查

#### 2.3.1 方案 06 代码级重大笔误（`--tab-ease` 假变量名）
- **现场证据**：查阅现行 [`Tabs.module.css:7`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L7) 与 [`Tabs.test.tsx:314`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.test.tsx#L314)：
  ```css
  /* Tabs.module.css:7 */
  .root {
    --tab-spring-bezier: cubic-bezier(0.175, 0.885, 0.32, 1.5);
  ...
  ```
  在组件内部消费时为：`transition: transform var(--tab-duration) var(--tab-spring-bezier)`。
- **缺陷**：方案 06 §2.2.2（第 190 行）给出替换代码：
  ```css
  /* 方案 06 错误代码 */
  --tab-ease: cubic-bezier(0.175, 0.885, 0.32, 1.5);
  --tab-ease: cubic-bezier(0.2, 0, 0, 1);
  ```
  `Tabs.module.css` 全文根本没有 `--tab-ease` 变量！若照抄此代码，滑块的实际动效仍旧走带有 1.5 过冲的 `--tab-spring-bezier`，发生动效挂载失效。

#### 2.3.2 DIM-02 方案与方案 06 的断言冲突
- **冲突现场**：
  - `Tabs.module.css:84` 当前代码为：`--tab-outer-radius: var(--button-radius, 7px);`；
  - 方案 `02-dim02-geometry-and-motion-plan.md` 第 113 行明文规定将其规整为：`--tab-outer-radius: var(--radius-lg, 8px);`；
  - 但方案 `06-test-guardrails-and-verification-plan.md` 第 219 行测试断言却要求：`expect(CSS_SRC).toContain('--tab-outer-radius: var(--button-radius, 8px)');`！
- **破坏后果**：若执行 DIM-02 将其修改为 `var(--radius-lg, 8px)`，方案 06 设计的测试断言将**直接飘红爆错**！
- **裁决纠偏**：Tabs 是独立复合组件，不应在特定尺寸档位硬绑定按钮专属的 `--button-radius`，而应消费标准原子 Token `--radius-lg, 8px`。因此：
  1. `Tabs.module.css:84` 改为 `--tab-outer-radius: var(--radius-lg, 8px);`；
  2. `Tabs.test.tsx:328` 同步修改断言为：`expect(CSS_SRC).toContain('--tab-outer-radius: var(--radius-lg, 8px)');`。

---

## 三、单测破裂与下游脆弱面排查（Unit Test Breakage Risk Assessment）

### 3.1 `Button.test.tsx` 20+ 单测与 70+ 下游业务单测脆弱面映射

对 `apps/crish-desktop/src/components/ui/Button/Button.test.tsx` 全部用例及下游 70+ 业务单测进行全面排查，确立重构的四项“绝对不变量”：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       Button 单测脆弱面与绝对不变量契约清单                                             │
├────┬─────────────────────────────┬──────────────────────────────────────────┬──────────────────────────────────────────┤
│ 序 │ 脆弱断言与调用场景          │ 存量测试代码断言模式                     │ 重构绝对红线（严禁破坏）                 │
├────┼─────────────────────────────┼──────────────────────────────────────────┼──────────────────────────────────────────┤
│ 1  │ 原生 DOM 单节点契约         │ `btn.tagName === 'BUTTON'`               │ 绝对禁止在 `<button>` 外层包裹任何 `div` │
│    │ (Button.test.tsx:16)        │ `screen.getByRole('button')`             │ 或定位容器，保持纯净原生单节点。         │
├────┼─────────────────────────────┼──────────────────────────────────────────┼──────────────────────────────────────────┤
│ 2  │ loading 态文案保留契约      │ `screen.getByText('保存中')`             │ loading 态只能前置注入 spinner，绝对禁止 │
│    │ (Button.test.tsx:98)        │ `expect(btn).toHaveAttribute('aria-busy')`│ 替换或清空 `children` 文本！             │
├────┼─────────────────────────────┼──────────────────────────────────────────┼──────────────────────────────────────────┤
│ 3  │ 变体与尺寸类名映射          │ `styles.buttonSecondary, styles.buttonSm`│ 变体与尺寸名称禁止重构重命名；维持 CSS   │
│    │ (Button.test.tsx:32-76)     │ `data-size="sm", data-variant="secondary"`│ Modules 原有导出 key 与属性值无损。       │
├────┼─────────────────────────────┼──────────────────────────────────────────┼──────────────────────────────────────────┤
│ 4  │ 激活态双重契约              │ `toHaveClass(styles.buttonActive)`       │ 同时保留 `styles.buttonActive` 类名与     │
│    │ (Button.test.tsx:86-87)     │ `toHaveAttribute('data-active', 'true')` │ `data-active="true"` 属性。              │
├────┼─────────────────────────────┼──────────────────────────────────────────┼──────────────────────────────────────────┤
│ 5  │ 下游 70+ 业务单测事件透传   │ `fireEvent.click(btn)` / `onClick` 冒泡  │ 原生事件合成链保持 100% 畅通；禁用态阻断 │
│    │ (各业务测试)                │ `expect(onClick).toHaveBeenCalledTimes(1)`│ 原生事件，不依赖私有 JS 拦截。           │
└────┴─────────────────────────────┴──────────────────────────────────────────┴──────────────────────────────────────────┘
```

### 3.2 CSS `:has()` 光学微调 vs TSX 属性分发方案仲裁

在独立详案中，存在两套截然不同的光学配平方案：
- **Plan 03 方案**：在 `Button.tsx` 动态计算 `isOpticallyAsymmetric`，向 DOM 派发 `data-icon-pos="left|right"`，CSS 消费属性选择器 `.button[data-icon-pos='left']`；
- **Plan 06 方案**：宣称“TSX 零改动”，在 `Button.module.css` 消费纯 CSS `:has(> .buttonIcon:first-child)`。

#### 深度技术仲裁：
1. **Plan 06 纯 CSS `:has()` 的退化缺陷**：
   - 当 `<Button icon={<Icon />} />` 渲染**纯图标按钮**（无文本 `children`）时，`:has(> .buttonIcon:first-child)` 仍旧命中，导致纯图标按钮左侧内边距被错误收缩 2px，破坏几何对称；
   - 当 `loading={true}` 时，第一个子节点是 `<span className={styles.spinner} />`，并非 `.buttonIcon`，选择器失效；
2. **正确实现方式（纯 CSS 优雅方案）**：
   若坚持 TSX 零侵入，CSS 选择器必须同时匹配图标与文本标签：
   ```css
   /* 仅当同时包含前置图标和有效文本标签时，才触发左侧 2px 光学收口 */
   .button:has(> .buttonIcon:first-child):has(> .buttonLabel) {
     padding-inline-start: calc(var(--btn-px) - 2px);
   }
   /* 仅当同时包含后置图标和有效文本标签时，才触发右侧 2px 光学收口 */
   .button:has(> .buttonIcon:last-child):has(> .buttonLabel) {
     padding-inline-end: calc(var(--btn-px) - 2px);
   }
   ```
   **审查结论**：采用带 `:has(> .buttonLabel)` 的纯 CSS 补正方案，既保证 TSX DOM 结构 100% 不动、彻底隔离单元测试，又消除了纯图标按钮的偏心退化。

### 3.3 `scale(0.96)` 物理微触感的 JSDOM 与真实宿主兼容性
- **JSDOM 环境验证**：Vitest 运行在 JSDOM 下，JSDOM 不执行 CSS 渲染引擎的 Layout 与 Transform 计算，也不会自动派发 `:active` 伪类。因此，在 `Button.module.css` 中注入 `transform: scale(0.96)` 对全仓现存所有基于 RTL 的单元测试 **0 影响、0 破坏**；
- **真实宿主防护**：
  - 必须添加 `will-change: transform; transform-origin: center center;`，防止 WebView2 在形变瞬间产生字体抗锯齿模糊；
  - 必须添加 `.button:disabled { transform: none !important; }`，杜绝禁用控件响应按压手势；
  - 必须支持 `static?: boolean`（挂载 `data-static="true"`），专供树节点与会话列表拖拽把手逃逸。

---

## 四、新增契约测试套件完备性与误报排查（New Contract Test Verification）

### 4.1 `a11y-optical-contract.test.ts` 重大阻断缺陷排查

#### 4.1.1 缺陷 1：16 处 `tabular-nums` 审计靶标中存在 **12 处虚假/错误路径**
方案 06 §3.2.2（第 534-551 行）在契约测试中硬编码了 16 处必须具备 `tabular-nums` 的样式文件路径。**经全仓文件系统真实比对，其中 12 处路径完全错误**：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                方案 06 虚假路径与真实源码路径纠偏对照表 (Fatal Path Fixes)                              │
├────┬─────────────────────────────────────────────────┬─────────────────────────────────────────────────┬───────────────┤
│ 序 │ 方案 06 规划的错误相对路径                      │ 仓库中真实物理文件路径                          │ 错误原因      │
├────┼─────────────────────────────────────────────────┼─────────────────────────────────────────────────┼───────────────┤
│ 1  │ `components/modals/PriceConfigModal.module.css` │ `components/settings/PriceConfigModal.module.css`│ 臆造 modals/  │
│ 2  │ `components/modals/ScanResultsModal.module.css` │ `components/settings-models/ScanResultsModal...`│ 臆造 modals/  │
│ 3  │ `components/modals/YamlConfigEditorModal...`    │ `components/settings-models/YamlConfigEditor...`│ 臆造 modals/  │
│ 4  │ `components/settings/tabs/ModelsSettingsTab...` │ `components/settings-models/ModelsSettingsTab...`│ 臆造 tabs/    │
│ 5  │ `components/settings/tabs/SkillsSettingsTab...` │ `components/settings-skills/SkillsSettingsTab...`│ 臆造 tabs/    │
│ 6  │ `components/panels/SubagentHeaderPanel...`      │ `components/chat-card/SubagentHeaderPanel...`   │ 臆造 panels/  │
│ 7  │ `components/panels/ScheduledTasksPanel...`      │ `components/settings/ScheduledTasksPanel...`    │ 臆造 panels/  │
│ 8  │ `components/chat/ChatToolCallBlock.module.css`  │ `components/chat-tool-call/ChatToolCallBlock...`│ 路径层级错误  │
│ 9  │ `components/chat/ChatQueuePanel.module.css`     │ `components/chat-composer/ChatQueuePanel...`    │ 路径层级错误  │
│ 10 │ `components/terminal/TerminalCard.module.css`   │ `components/workspace/TerminalCard.module.css`  │ 臆造 terminal/│
│ 11 │ `components/analytics/UsageTrendChart...`       │ `components/settings/usage/UsageTrendChart...`  │ 臆造analytics/│
│ 12 │ `components/player/FlowScrubber.module.css`     │ `components/chat-message-list/FlowScrubber...`  │ 臆造 player/  │
└────┴─────────────────────────────────────────────────┴─────────────────────────────────────────────────┴───────────────┘
```
- **阻断后果**：方案 06 的测试代码写着 `catch { missingTabular.push(`${target.relPath} (文件不存在)`); }`。若原样运行，**该测试将立刻抛出 12 处“文件不存在”致命失败，直接导致 CI 快层瘫痪**！
- **整改要求**：必须在契约测试落盘前，将 `AUDITED_16_TARGETS` 纠偏为上述真实路径。

#### 4.1.2 缺陷 2：`IconButton` 正则误报
方案 06 使用正则 `/<IconButton\b([^>]*?)(\/?>)/gs` 校验 `aria-label`：
- **误报点 A**：JSX 注释 `{/* <IconButton icon={<X />} /> */}` 会被正则误扫；
- **误报点 B**：组件采用属性透传 `<IconButton {...ariaProps} />` 时会被误判为缺少 `aria-label`；
- **纠偏规范**：增加过滤机制，跳过注释块；由于 TypeScript 已经在类型层面将 `aria-label: string` 设为必填（`IconButtonProps` 强约束），契约测试应重点拦截空字符串 `aria-label=""`。

#### 4.1.3 缺陷 3：Focus Ring 正则误杀 `2px solid transparent`
方案 06 使用正则 `/#000000|#111111|\bsolid\s+black\b|\b2px\s+solid\b/.test(body)`：
- **误杀**：为适配 Windows 高对比度模式（Forced Colors），许多组件声明 `outline: 2px solid transparent;`。该声明完全符合无障碍规范，但会被 `\b2px\s+solid\b` 暴力拦截；
- **纠偏规范**：正则细化为 `/\b2px\s+solid\s+(?!transparent)/`，放行透明占位轮廓。

---

### 4.2 `motion-concentric-contract.test.ts` 缺陷排查

#### 4.2.1 全局正则 `/g` 跨循环状态机泄漏（Stateful RegExp Bug）
- **现场**：
  ```ts
  const ODD_RADIUS_RE = /border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;]+);/g;
  const CUBIC_BEZIER_RE = /cubic-bezier\s*\(\s*([\d.]+)\s*,\s*([\d.-]+)\s*,\s*([\d.]+)\s*,\s*([\d.-]+)\s*\)/g;
  ```
  上述两个全局正则表达式声明在循环外部。在 `lines.forEach` 中每次调用 `exec(line)` 时，若某行匹配成功，`lastIndex` 将停留在非零位置；当进入下一行时，如果该行长度小于 `lastIndex`，`exec` 将直接返回 `null` 并重置 `lastIndex = 0`，**从而漏检该行的严重违规**！
- **纠偏规范**：在单行扫描时移除 `/g` 标志，或在每行扫描前显式重置 `lastIndex = 0`，或直接对全文件 `content` 进行匹配。

#### 4.2.2 `value.startsWith('var(')` 误杀复合圆角
- 声明形如 `border-radius: 0 0 var(--radius-sm, 4px) var(--radius-sm, 4px);` 时，`value` 以 `0 0` 开头，不满足 `startsWith('var(')`；若其中 fallback 含有 `4px`，虽合法但也可能因模式不严密而引发误报；
- **纠偏规范**：圆角扫描应优先剥离 `var(...)` 结构，仅针对真正裸写的常量值进行断言。

---

### 4.3 `check-ui-negative-churn.mjs` 负产出门禁脚本缺陷排查

#### 4.3.1 致命误杀：`DEAD_TOKEN_PATTERNS` 将杀死活跃 SEP 变量
- **现场**：方案 06 第 814 行声明待清剿死变量规则：
  `{ name: '--sep-* (SEP脚手架遗留)', regex: /--sep-[a-zA-Z0-9_-]+\s*:/g }`
- **根因**：DIM-01 专项方案明确指出，仅清除 12 个脚手架未消费变量；而 `SmartExpandablePanel` 与 `SmartPanel` 正在深度消费 `--sep-radius-outer`, `--sep-padding`, `--sep-radius-inner`, `--sep-item-radius` 等 10 个活变量（见 `tokens.css:189-199`）；
- **阻断后果**：该脚本运行扫描 `tokens.css` 时，将**无差别抓出 10 个活 SEP 变量并判定为“违规残留”，直接 Exit 1 阻断 CI**！
- **纠偏规范**：必须将正则精确收敛为待清剿的 12 个变量名：
  `regex: /--sep-(?:font-size-(?:base|sm|header)|bg-(?:canvas|panel-solid|item-selected)|border-hover|accent-(?:color|light)|ease-(?:spring|shrink)|duration-(?:open|close))\s*:/g`。

#### 4.3.2 虚假文件导致负产出统计失真
- `BASELINE_TARGETS` 中列出的 `components/chat/ModernToolCall.module.css` 真实路径为 `components/chat-tool-call/ModernToolCall.module.css`；
- 脚本中若文件不存在，执行 `totalActualReduction += item.baselineLines;`，直接虚增了 520 行削减量，造成“假达标”风险；
- `PURGED_CLASS_PATTERNS` 中的 `SidebarHeader.module.css` 与 `SidebarFooter.module.css` 在仓库中根本不存在，相关私有类全部写在 `Sidebar.module.css` 中；脚本静默跳过不存在文件，导致私有类是否真正拔除处于**完全脱管状态**。

---

## 五、门禁链全景集成与覆盖率终审（CI Gates & Coverage Audit）

### 5.1 `FULL_CHECK_COMMANDS.md` 覆盖无死角核查

对比仓库唯一权威清单 `FULL_CHECK_COMMANDS.md` 与方案 06 的执行命令全景图：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                FULL_CHECK_COMMANDS 现行命令与方案 06 覆盖对照表                                         │
├──────────────────────┬─────────────────────────────────────────────────┬──────────┬────────────────────────────────────┤
│ 门禁层级             │ FULL_CHECK_COMMANDS.md 权威命令                 │ 方案覆盖 │ 审查评估与风险暴露                 │
├──────────────────────┼─────────────────────────────────────────────────┼──────────┼────────────────────────────────────┤
│ **快层门禁**         │ `npm run typecheck`                             │ ✅ 覆盖  │ 刚性守门，0 TS 错误                │
│ (Fast-Lane)          │ `npm run test:coverage -- --project=unit`       │ ✅ 覆盖  │ 需维持 45/70/65/45 基线            │
│                      │ `npm run check:line-counts`                     │ ✅ 覆盖  │ UI ≤500, 业务 ≤400, 硬阻断 650     │
│                      │ `npm run check:store-types`                     │ ✅ 覆盖  │ 禁 Zustand as any 逃逸             │
│                      │ `npm run lint:depcruise`                        │ ✅ 覆盖  │ 零循环依赖阻断                     │
├──────────────────────┼─────────────────────────────────────────────────┼──────────┼────────────────────────────────────┤
│ **中层集成**         │ `npm run test` (全量 vitest)                    │ ✅ 覆盖  │ desktop + workbench 全仓回归       │
│ (Middle-Lane)        │ `npx vitest run --config vitest.integration...` │ ✅ 覆盖  │ 集成 4 目录回归                    │
├──────────────────────┼─────────────────────────────────────────────────┼──────────┼────────────────────────────────────┤
│ **结构性契约**       │ `npm run check:conflict-markers`                │ ✅ 覆盖  │ 0 冲突标记残留                     │
│ (Structural)         │ `npm run check:css-encoding`                    │ ✅ 覆盖  │ UTF-8 无 BOM                       │
│                      │ `npm run check:convergence`                     │ ❌ 遗漏  │ **方案 06 遗漏**，需追加核验       │
│                      │ `npm run check:swallowed-errors-frontend`       │ ❌ 遗漏  │ **方案 06 遗漏**，需追加核验       │
├──────────────────────┼─────────────────────────────────────────────────┼──────────┼────────────────────────────────────┤
│ **新增战役专项**     │ `node scripts/check-ui-negative-churn.mjs`      │ 🌟 方案创│ 刚性锁死 Net-LOC ≥ 665 行削减      │
│                      │ `style-contract.test.ts` (8px & 同心)           │ 🌟 方案创│ 同步修复两处存量漂移               │
│                      │ `motion-concentric-contract.test.ts`            │ 🌟 方案创│ 纠偏正则后并入快层                 │
│                      │ `a11y-optical-contract.test.ts`                 │ 🌟 方案创│ 纠偏 12 处路径后并入快层           │
├──────────────────────┼─────────────────────────────────────────────────┼──────────┼────────────────────────────────────┤
│ **桌面物理终验**     │ Tauri MCP Socket 4000 (127.0.0.1:4000)          │ ✅ 覆盖  │ 绝对遵守 AGENTS.md §15/16 铁律，   │
│                      │ (严格禁止 9222 CDP)                             │          │ 验收物理微触感与深浅切换无涂抹     │
└──────────────────────┴─────────────────────────────────────────────────┴──────────┴────────────────────────────────────┘
```

### 5.2 `check:ui-layer` 现存阻断现场剖析与处置规划
在根目录实际执行 `npm run check:ui-layer`，当前存在 **4 处违规报错**：
```
[check:ui-layer] 发现 ui 原子层违规依赖：
  ✗ SegmentedControl.tsx → 禁止依赖业务模块 services/ (import ResizeObserverManager)
  ✗ SmartModelBadge.tsx → 禁止依赖业务模块 api/ (import modelAbbreviation)
  ✗ Tabs.tsx → 禁止依赖业务模块 services/ (import ResizeObserverManager)
  ✗ TabStrip.tsx → 禁止依赖业务模块 services/ (import ResizeObserverManager)
```
- **根因分析**：原子组件为了监听尺寸形变，逆向引用了上层 `services/ResizeObserverManager`；
- **处置方案**：
  1. `ResizeObserverManager` 属于通用基础 DOM 设施，本质不具备业务属性。必须将其下沉至 `packages/shared-utils` 或 `apps/crish-desktop/src/components/ui/utils/` 内部；
  2. `SmartModelBadge.tsx` 依赖的缩写逻辑下沉为纯函数或由外部 props 传入；
  3. 完成上述下沉后，`check:ui-layer` 方可正式作为 CI 快层硬阻断项，不再报错。

---

## 六、实施纠偏执行清单与行动计划（Actionable Plan）

为确保战役实施阶段测试资产绝对安全、门禁链无缝闭环，主控及各执行子 Agent 必须遵照以下整改规范推进：

### 6.1 Phase 0 准备期纠偏动作
1. **纠偏 `a11y-optical-contract.test.ts` 中的 12 处路径**：
   将其完整更新为本文 §4.1.1 的真实物理路径；
2. **纠偏 `motion-concentric-contract.test.ts` 正则**：
   去除跨行共享全局 `/g`，避免单行匹配遗漏；
3. **纠偏 `check-ui-negative-churn.mjs`**：
   - 将 `--sep-*` 规则收紧为 12 个特定废弃变量；
   - 修正 `ModernToolCall.module.css` 路径；
   - 将 `SidebarHeader/Footer` 私有类改在 `Sidebar.module.css` 中扫描；
4. **归一化现行 `style-contract.test.ts` 漂移**：
   修复 `--tint-hover` (3.5%) 与 `--control-soft-bg-hover` 的既有测试失败，使主干基线测试恢复全绿。

### 6.2 Phase 1 ~ Phase 2 锁步执行规程
1. **`tokens.css` 双行修改**：
   第 26 行与第 458 行的 `--button-radius` 必须在同一提交中更新为 8px，同时级联更新第 29-30 行同心计算；
2. **`Tabs.module.css` 变量纠偏**：
   替换 `--tab-spring-bezier`（严禁写成 `--tab-ease`），并将 `.sizeSm` 圆角统一对齐为 `var(--radius-lg, 8px)`；
3. **`Button.module.css` 光学对齐**：
   采用 `.button:has(> .buttonIcon:first-child):has(> .buttonLabel)`，严格保持 `Button.tsx` DOM 树为原生单节点 `<button>`。

---

## 七、终审结论签署

| 审查维度 | 审查断言 | 终审状态 |
| :--- | :--- | :--- |
| **测试资产保护铁律** | 严禁假重构真删测，严禁弱化存量断言 | **PASS (符合铁律)** |
| **8px 升级锁步机制** | `tokens.css` 双重定义需在原子提交中一并收敛 | **CONDITIONAL PASS (需按规范锁步)** |
| **Tabs 动效与几何契约**| 纠偏 `--tab-spring-bezier` 变量名并统一 8px 契约 | **CONDITIONAL PASS (需修正笔误)** |
| **Button 20+ 及下游单测**| 纯 CSS 选择器保证 TSX 单节点不变，单测 100% 兼容 | **PASS (方案完备)** |
| **新增契约测试完备性** | 纠正 12 处虚假靶标路径与 `--sep-*` 误杀规则 | **AMENDMENT REQUIRED (必须整改)** |
| **CI 门禁全景闭环** | 下沉 `ResizeObserverManager`，补齐结构检查命令 | **PASS (整改路径清晰)** |

> **签署意见**：  
> 本评审报告揭露的 5 项缺陷均为**真实代码级事实断言**。在方案实施阶段，各执行 Agent 必须以本报告给出的纠偏数据与修正代码为执行基准。通过上述刚性加固后，本次 `UI-UNIFICATION-REDESIGN` 战役的测试资产防护网将达到极高水准，完全确保重构全程零破损、零倒退、净负产出真达标！
