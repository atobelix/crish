# 01 · 前端 UI/UX 底层架构革新跨方案综合审计报告

> **审计文档代号**：`01-plans-comprehensive-cross-audit`  
> **审计定性**：6 份系统落地方案地毯式跨方案交叉审查、冲突裁决与盲点穿透独立报告  
> **首席方案审计专家**：Lead Architectural Auditor  
> **审计对象清单**：
> 1. `01-infra-packaging-and-export-convergence.md`（基础设施、包拓扑与导出收敛方案）
> 2. `02-style-system-and-tokens-unification.md`（样式系统与 Tokens 规范统一方案）
> 3. `03-headless-primitives-and-stability.md`（Headless 底层原语与稳定性方案）
> 4. `04-motion-physics-and-interaction-continuity.md`（动效物理学与交互连贯性方案）
> 5. `05-api-contract-and-react19-pure-functions.md`（组件 API 契约与 React 19 纯函数方案）
> 6. `06-dx-and-llm-first-governance.md`（开发者体验与 LLM-First 基础设施方案）  
> **审计基准与红线**：`AGENTS.md` 铁律与反退避原则、五大核心铁律、单一真理源（SSOT）、零双轨、零硬编码、排除 A11y 干扰。

---

## 一、审计执行摘要与总体评级

经过对第一轮产出的全部 6 份系统落地方案（总篇幅逾 6,500 行，涵盖物理包工程、Tokens 力学、Headless 原语、物理阻尼弹簧、React 19 契约与 DX 沙箱治理）进行逐行、逐段、逐图的地毯式交叉审查与逆向求证，审计结论如下：

### 1.1 总体评价
6 份方案均展现了极高的专业深度与问题洞察力，对既有架构中的顽疾（如 315 处深层越权穿透、31 个历史废弃别名、1,802 行高危胶水代码、打断撞墙顿挫、`bare` 妥协反模式、以及 30+ 门禁盲猜拉锯）进行了确凿的现场取证与量化解构，整体架构演进方向完全符合现代前端工程演进趋势。

### 1.2 核心警报与致命断层（The Critical Gaps）
然而，由于 6 份方案在第一轮由各专项独立推演，**跨方案之间暴露出了 7 处重大架构接口冲突、概念分裂与咬合脱节**，其中有两处属于可能导致系统彻底瘫痪或方案互斥的**阻断级（Blocker）矛盾**：
1. **【阻断级】弹层进出场生命周期“三方分裂大乱斗”**：P03 基于 `@base-ui/react` 原生 `@starting-style` 进出场，P04 却使用 Framer Motion `<AnimatePresence>` 重新包装一套 Dialog，P05 甚至还在代码中保留陈旧的 `useAnimatedPresence` 胶水！三者对 Dialog 架构的定义完全自相矛盾；
2. **【阻断级】计算几何 `SafeTriangle` 存废直接打架**：P01 在包拓扑和 Codemod 中大费周章地将 `SafeTriangle` 迁移至 `@crish/ui/primitives/geometry` 并暴露公开导出；而 P03 却将其定性为毒瘤并彻底物理删除；
3. **【高危级】组件样式实现规范同室操戈**：P02 刚性推行 CVA + `cn` 并设立契约门禁禁止手写 `filter(Boolean).join`；P05 的核心 `Button` 却自行手写字典与 `filter(Boolean).join`；
4. **【高危级】React 19 代差断裂**：P05 全量清退 `forwardRef` 推进 Ref-as-prop；P02 给出的 4 个核心组件重构示范代码却全量沿用 `React.forwardRef` 与 `Component.displayName`；
5. **【中高危】物理路径拓扑脱节**：P01 将组件抽离为独立包 `packages/ui`；P06 的沙箱、`agent-rules.md`、`llms.txt` 却全部写死在旧单体路径 `apps/crish-desktop/src/components/ui/`；
6. **【中危】导出收敛与 Opaque Exports 泄露漏洞**：P01 的自动化 Barrel 使用通配 `export *`，破坏了 P05 设定的极小公共导出表面（Opaque Exports）铁律；
7. **【中危】Codemod 边界遗漏与非法属性**：移动端 55 处穿透被漏网；Button `bare` 转换为 `<button>` 时若携带 `variant` 会引发 TSX 编译断裂。

---

## 二、五大铁律红线刚性复核矩阵

| 铁律红线 | 核心约束 | 逐方案遵从性审计与穿透结论 | 审计判决 |
| :--- | :--- | :--- | :---: |
| **1. 视觉样式 100% 绝对零变化** | 外观尺寸、色值排版、动效节奏像素级对齐，严禁引入花哨动效。 | • P01/P02/P03/P05/P06 均严格遵从外观等价；<br>• **P04 存在微调风险**：Switch 引入了 `scaleX: 1.08, scaleY: 0.96` 弹性形变蓄力，虽符合物理学，但必须严格受控，确保肉眼不可察觉，不得形成果冻感；TabStrip 胶囊滑动必须严格与现有下划线位置 100% 贴合，不得产生超出 Tab 边框的溢出光影。 | **部分告警 (Warning)** |
| **2. 坚决避免双轨 (No Dual-Track)** | 严禁新旧两套并存、禁止废弃路径与别名保留长期垫片。 | • P01/P02 坚决执行一次性 Codemod 收敛，物理删除旧别名与旧路径，非常优秀；<br>• **P03 与 P04 在 Dialog 上暗中形成了事实上的双轨**：既有一套 Base UI 原生渲染，又有一套 Framer Motion 包装，必须单一收敛；<br>• P05 的 `Dialog.tsx` 保留了多种历史语法糖分支判断，需进一步收敛。 | **发现冲突 (Defect)** |
| **3. 坚决避免任何硬编码 (Zero Hardcoding)** | 严禁写死文件列表、魔术数字、选择器白名单或内联样式。 | • P03 彻底拔除 30+ 选择器白名单，P02 彻底清退 74 处内联贝塞尔，方向正确；<br>• **P06 存在硬编码隐患**：Playground 的 `tauri-mock.ts` 与部分路径映射写死了相对层级；`SPACE_TOKEN_MAP` 字典需对齐项目真实 Token。 | **基本合格 (Pass-)** |
| **4. 无障碍 (A11y) 暂时不用管** | 不在 ARIA、读屏适配、语义树微调上空耗篇幅与工程资源。 | • P01/P02/P04/P06 严格遵守，零内耗；<br>• **P05 篇幅溢出**：第 1.2.2 节用较大篇幅探讨 `aria-labelledby` 挂载跳跃，并在代码中大量处理 ARIA 属性透传。必须明确：既有属性无损保留，但坚决不投入额外工作量进行专项 a11y 治理。 | **篇幅纠偏 (Correction)** |
| **5. 彻底根除门禁盲猜拉锯战** | 终结“写代码 -> 触发拦截 -> 盲目瞎猜修复”的恶性循环。 | • P06 提出的事前规则（`agent-rules.md`）、自动契约（`llms.txt`）、五元诊断与一键 Codemod（`gate:fix`）切中要害，是终结拉锯的关键；<br>• **落地性隐患**：Codemod 必须能幂等执行，且必须与 P01、P02、P05 的最新规范保持 100% 实时同构，否则会把代码修复成另一种违规形态。 | **高度认可 (High Pass)** |

---

## 三、跨方案重大架构接口冲突深度剖析与权威裁决（核心焦点）

### 冲突 1：P03（Base UI 原语）vs P04（Framer Motion）vs P05（React 19）在弹层进出场生命周期上的【三方分裂大乱斗】

#### 1. 冲突事实与代码铁证
- **P03（方案 03）第 2.2 节 & 第 3.1 节**：
  明确确立以 `@base-ui/react/dialog` 为单一真理源。采用 `BaseDialog.Root -> BaseDialog.Portal -> BaseDialog.Backdrop -> BaseDialog.Viewport -> BaseDialog.Popup` 分层模型。动效明确规定：**彻底淘汰 JS 计时器胶水与外部动画库，纯粹利用 Chromium / WebView2 原生支持的 CSS `@starting-style` 与 `transition-behavior: allow-discrete`**，在 `Dialog.module.css` 中声明 150ms 过渡，并声称彻底物理删除 `useAnimatedPresence.ts`。
- **P04（方案 04）第 4.4 节**：
  单独设计了一套基于 Framer Motion 的 Dialog：
  ```tsx
  // P04 第 4.4 节代码
  <AnimatePresence>
    {open && (
      <Portal target={portalTarget}>
        <div className={styles.overlay}>
          <m.div className={styles.backdrop} exit={{ opacity: 0 }} />
          <m.div role={role} className={panelClasses} exit={{ opacity: 0, scale: 0.985 }} transition={MOTION_SPRING.snappy}>
            {children}
          </m.div>
        </div>
      </Portal>
    )}
  </AnimatePresence>
  ```
  P04 绕过了 Base UI，自己手写了 Portal 和 Backdrop，用 `<AnimatePresence>` 控制挂载/卸载，也声称由它来替换并删除 `useAnimatedPresence.ts`。
- **P05（方案 05）第 4.2 节 & 第 4.3.2 节**：
  在设计声明式复合 Dialog 时，既没有引用 Base UI，也没有引用 Framer Motion，而是写着：
  `挂载状态管理（useAnimatedPresence 150ms 进退场动画）`，并在子组件中写着：`ctx.state === 'exiting' ? styles.dialogExit : styles.dialogEnter`。P05 依然把旧有的 `useAnimatedPresence` 作为依赖前提！

#### 2. 架构危害分析
这是整个战役中最严重的**架构概念撕裂**：
- 如果采纳 P04，则 P03 引进的 Base UI 弹窗焦点捕获、视口分层、嵌套遮罩防变黑（`data-nested-dialog-open`）全部沦为摆设；
- 如果采纳 P03 的纯 CSS `@starting-style`，则 P04 的临界阻尼物理弹簧就无法作用于 Dialog；
- 如果采纳 P05，则 144 行高危定时器胶水根本没有被删除，两个方案的“净收敛”断言全部破产！

#### 3. 首席审计专家最终裁决与收敛方案
必须确立**正交单一真理源职责分工（Orthogonal Single-Responsibility Architecture）**：

```
┌────────────────────────────────────────────────────────────────────────┐
│                   弹层与动效统一收敛分工架构                             │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   【弹层基础设施单一真理源】 ──> 完全归属 P03（@base-ui/react）           │
│   • 负责：DOM 挂载、Portal 拓扑、视口居中隔离、原生 FocusTrap 焦点圈定、    │
│           Esc 键监听、点击外部退栈、多层嵌套防发黑。                     │
│                                                                        │
│   【进出场生命周期与动效统一收敛】                                      │
│   • 规则 A（纯浮动弹层：Tooltip, Select, Menu, ContextMenu）：         │
│     100% 采用 P03 原生 CSS @starting-style 驱动！                       │
│     零 JS 运行时开销，零 Framer Motion 介入，极致轻量，彻底消灭定时器。 │
│                                                                        │
│   • 规则 B（全屏模态弹层：Dialog, ConfirmDialog）：                    │
│     统一采用 Base UI 提供的生命周期托管，坚决禁止外层包裹 AnimatePresence！│
│     视觉退场由 Base UI 原生注入的 [data-ending-style] / @starting-style │
│     或 Base UI 的 render prop 驱动。保持与 CSS Tokens 曲线 100% 纯净咬合。│
│                                                                        │
│   【Framer Motion 的法定正交边界】 ──> 严格限定于 P04 页面内交互连续性   │
│   • 1. 物理阻尼与初速度连续：Switch 滑块、Slider 拖拽与步进；          │
│   • 2. 跨节点 FLIP 布局投影：SegmentedControl 与 TabStrip 的 layoutId； │
│   • 3. 列表动态形变：SidebarSessionList 增删的流体高度坍缩折叠；       │
│   • 4. 操作微状态演进：SessionRow 的行内就地变身交互（In-Place Morph）。 │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```
- **落地指令**：
  1. P04 必须立即**删除第 4.4 节关于自研 Dialog 的重写方案**，将 Dialog 移出 Framer Motion 管辖范围；
  2. P05 必须立即**删除对 `useAnimatedPresence` 的一切引用与假设**，Dialog 纯函数层直接对齐 P03 的 Base UI 复合原语；
  3. `useAnimatedPresence.ts` 确定由 P03 彻底物理删除！

---

### 冲突 2：P01（包拓扑与导出）vs P03（底层原语）在 `SafeTriangle` / `SafeAimEngine` 上的【存废矛盾】

#### 1. 冲突事实与代码铁证
- **P01 第 3.2 节、第 4.2 节（规则 C）、第 5.2 节 & 第 6 节 Stage 1**：
  明确写明：在抽取 `packages/ui` 时，在 `primitives/geometry/` 下建立目录，承载 `SafeTriangle` 向量叉积几何计算，并在全仓 Codemod 中将 `ModelsCascadeSelect.tsx` 等处的深层引用批量重写为：`import { SafeTriangleTracker } from '@/components/ui/primitives'`，同时在 `sync-ui-exports.mjs` 中为其生成公开子路径导出 `./primitives/geometry`。
- **P03 第 1.4 节、第 2.3 节第 4 项 & 第 5.5 节**：
  将 `SafeAimEngine.ts`（436行）与 `SafeTriangle.ts`（209行）定性为“过度设计的典型代表、高危胶水代码”，明确声明：由于 `@base-ui/react/menu` 原生内置了无缝指针路径预测意图保护，**必须物理删除 `SafeTriangle.ts`、`SafeAimEngine.ts`、`useSafeAim.ts` 以及其关联单测（累计净删除 908 行）**！

#### 2. 架构危害分析
- P01 在建立新的标准化包导出表面时，把一个即将在 P03 中被彻底枪决的废弃算法模块“正规化”并暴露到了公共导出契约中；
- 若先执行 P01 再执行 P03，会导致刚重构完的代码瞬间被删除，CI 产生断裂；若反之，P01 的 Codemod 脚本会因找不到目标文件而抛出致命异常。

#### 3. 首席审计专家最终裁决与收敛方案
- **裁决**：遵循反退避与架构净收敛铁律，**`SafeTriangle` 与 `SafeAimEngine` 必须彻底物理删除，绝不在新包 `@crish/ui` 中保留任何公开导出！**
- **落地指令**：
  1. P01 必须修改第 3.2 节、4.2 节与 5.2 节，从 `primitives/` 白名单目录中**剔除 `geometry/SafeTriangle`**；
  2. P01 的 AST Codemod 必须修改映射规则 C：对 `ModelsCascadeSelect.tsx`，直接引导其重构使用 Base UI 的 Cascader / Submenu 原语，或将其内联清理，绝不再生成指向 `ui/primitives` 的废弃引用。

---

### 冲突 3：P02（样式与 CVA）vs P05（API 契约）在核心组件样式实现上的【同室操戈】

#### 1. 冲突事实与代码铁证
- **P02 第 3.2 节、第 4.1 节 & 第 6.3 节**：
  P02 制定了全仓原子组件采用 `class-variance-authority` (CVA) + `cn` 的绝对铁律，彻底拔除手写 `VARIANT_CLASS` 字典与 `filter(Boolean).join(' ')` 拼串，并在 `style-contract.test.ts` 中写入了刚性防御断言：
  ```typescript
  // P02 第 6.3 节刚性门禁
  expect(src).not.toContain('.filter(Boolean).join');
  expect(src).toContain('cn(');
  expect(typeof buttonModule.buttonVariants).toBe('function');
  ```
- **P05 第 3.1.1 节**：
  在给出 `buttonVariants` 的实现代码时，竟然完全推翻了 P02 的规范，自己手写了一套：
  ```typescript
  // P05 第 3.1.1 节代码
  const VARIANT_CLASS_MAP: Record<ButtonVariant, string> = { ... };
  const SIZE_CLASS_MAP: Record<ButtonSize, string> = { ... };
  export function buttonVariants(...) {
    const classes = [styles.button, VARIANT_CLASS_MAP[variant], ...];
    return classes.filter(Boolean).join(' '); // ！！！触发 P02 门禁硬拦截
  }
  ```

#### 2. 架构危害分析
- 同一个核心组件 `Button`，在 P02 和 P05 两个方案中给出了两份互不相容的实现；
- P05 的代码一旦提交，会瞬间被 P02 的契约门禁阻断，重新点燃“门禁拦截 -> 盲目猜测”的拉锯战。

#### 3. 首席审计专家最终裁决与收敛方案
- **裁决**：**P02 的 CVA + `cn` 架构为样式矩阵的唯一真理源！**
- **落地指令**：
  1. P05 必须彻底删除第 3.1.1 节手写的 `VARIANT_CLASS_MAP`、`SIZE_CLASS_MAP` 和 `classes.filter(Boolean).join(' ')`；
  2. P05 的 `Button.tsx` 必须直接从同目录（或共享工具）导入 P02 定义的 `buttonVariants`（基于 CVA），P05 仅专注于 Props 解构、`bare` 模式拔除与 React 19 纯函数范式。

---

### 冲突 4：P02（样式示范代码）vs P05（React 19 纯函数）在 `forwardRef` 上的【代差断裂】

#### 1. 冲突事实与代码铁证
- **P05 核心主题（第 5.1 节 & 第 5.2 节）**：
  全面升级 React 19，将 `ref` 作为标准 Prop，全量清退 `React.forwardRef` 与 `Component.displayName`，并设立 `check:react19-hygiene` 静态门禁进行阻断拦截。
- **P02 第 4.1 ~ 4.4 节**：
  给出的四大核心组件重构示范代码（`Button.tsx`、`Badge.tsx`、`Card.tsx`、`Input.tsx`），每一个依然包裹在 `React.forwardRef` 中，底部依然写着 `Component.displayName = '...'`，且 `Input.tsx:883-890` 依然在手写被 P05 宣布清退的 `setCombinedRef`！

#### 2. 架构危害分析
- P02 方案如果直接交付实施，产出的代码将被 P05 的 React 19 门禁全部判定为违规代码；
- 维护人员和 AI Agent 无法判定到底哪个方案的代码才是最终基准。

#### 3. 首席审计专家最终裁决与收敛方案
- **裁决**：**React 19 纯函数（Ref-as-prop）与 `useMergedRefs` 为组件函数签名的唯一真理源！**
- **落地指令**：
  1. P02 必须修改第 4.1 ~ 4.4 节的全部示范代码，彻底去除 `React.forwardRef` 和 `displayName`，统一采用 `export function Component({ ref, ...props }: Props)` 纯函数签名；
  2. P02 中 `Input.tsx` 的 Ref 合并逻辑必须改为直接调用 P05 的 `useMergedRefs`。

---

### 冲突 5：P01（独立包 `@crish/ui` 抽取）vs P06（DX 基础设施与沙箱）在代码物理路径上的【拓扑错位】

#### 1. 冲突事实与代码铁证
- **P01 第 5.2 节**：
  将原子 UI 组件物理抽离到 Monorepo 根下的独立包 `packages/ui`，并配置独立的 `package.json` 子路径导出。
- **P06 第 3.1 节、第 4.2 节 & 第 5.4 节**：
  设计随包分发规则 `agent-rules.md`、自动化契约 `llms.txt`、Playground 沙箱及 Codemod 修复器时，全盘写死了单体应用下的旧路径：
  - `apps/crish-desktop/src/components/ui/agent-rules.md`
  - `apps/crish-desktop/vite.ui.config.ts` 中的 `replacement: resolve(__dirname, 'src/components/ui/index.ts')`
  - `scripts/gatekeeper-codemod.mjs` 中的 `const DESKTOP_SRC = path.resolve(ROOT, 'apps/crish-desktop/src')`

#### 2. 架构危害分析
- 一旦 P01 实施 Stage 5（将物理文件迁移至 `packages/ui`），P06 搭建的所有沙箱配置、门禁脚本和自动生成的 `llms.txt` 将全线失效，指向被清空的旧目录；
- 造成包结构改造与开发体验基础设施相互割裂。

#### 3. 首席审计专家最终裁决与收敛方案
- **裁决**：**所有 DX 基础设施与沙箱工具必须原生支持并优先对齐 `packages/ui` 物理拓扑！**
- **落地指令**：
  1. P06 必须修改配置文件与沙箱设计，明确指定：
     - `agent-rules.md` 与 `llms.txt` 的最终真理物理位置为 `packages/ui/agent-rules.md` 与 `packages/ui/llms.txt`；
     - Playground 的 Vite 配置采用自适应解析逻辑：优先解析 `packages/ui/src/index.ts`，未抽取前兼容 `apps/crish-desktop/src/components/ui/index.ts`；
     - Codemod 修复脚本的扫描路径必须显式包含 `packages/ui/src/` 与 `apps/crish-desktop/src/` 双目录。

---

### 冲突 6：P01 自动化导出生成器与 P05 Opaque Exports 极小导出表面的【泄露漏洞】

#### 1. 冲突事实与代码铁证
- **P01 第 3.3 节**：
  `sync-ui-exports.mjs` 使用通配逻辑：遍历 `components/` 下所有文件夹，并在 `index.ts` 中生成 `export * from './components/${dir}/${importPath}'`。
- **P05 第 6.2 节**：
  严格规定了“极小公共导出表面（Minimal Public Surface / Opaque Exports）”铁律，严禁将组件内部 helper 函数、私有 CVA 实例、DOM Ref 句柄暴露到公开表面。

#### 2. 架构危害分析
- P01 的无差别 `export *` 会导致组件内部为了实现封装而定义的私有工具函数、私有常量被无意间全部暴露在 `@crish/ui` 根出口；
- 业务开发者或 AI Agent 在消费 `@crish/ui` 时，智能提示中将充斥大量内部垃圾符号，导致黑盒封装被击穿。

#### 3. 首席审计专家最终裁决与收敛方案
- **裁决**：**自动化导出生成器必须强制执行公开契约过滤！**
- **落地指令**：
  1. P01 的 `sync-ui-exports.mjs` 必须增加约定：每个组件文件夹内，若存在 `index.ts`，以 `index.ts` 作为唯一导出代表，禁止无序导出所有同级 ts 文件；
  2. 显式排除以 `_` 开头、包含 `.internal.`、`.helper.` 的私有文件，确保与 P05 的极小导出表面严格咬合。

---

### 冲突 7：P02（@layer 级联分层）与 P03（Base UI 状态属性与 Positioner）的【层叠穿透风险】

#### 1. 冲突事实与潜在隐患
- **P02 第 3.2.3 节**：
  在原子组件样式中引入 `@layer components`，使得组件内部样式特异度被降级，外部样式（处于未分层上下文）即使特异度只有 `(0, 1, 0)` 也能稳胜覆盖。
- **P03 第 3.3 节 & 第 4.1 节**：
  Base UI 的 Popup 带有许多依赖属性选择器的关键状态样式（如 `[data-open]`、`[data-starting-style]`、`min-width: var(--anchor-width)`）。
- **潜在隐患**：
  若外部业务无意中写了一个宽泛的选择器（例如针对某个包装容器的重置样式），由于外部样式未分层，其优先级高于 `@layer components`，可能会直接覆盖掉组件的 `display`、`transform` 或定位关键属性，导致弹层在进场瞬间隐形或位置错乱。

#### 2. 首席审计专家最终裁决与收敛方案
- **裁决**：**关键几何定位与状态基线与变体视觉样式分层隔离！**
- **落地指令**：
  1. P02 与 P03 必须协同明确：包裹在 `@layer components` 中的**仅限于背景色、文字颜色、边框、投影、内边距等可覆盖的视觉表现属性**；
  2. 涉及绝对定位、GPU Transform、尺寸锚定（`--anchor-width`）与遮罩层级（`inset: 0`）的基础骨架样式，**严禁包裹在降权的 `@layer` 中**，必须处于默认未分层流或 Positioner 托管层，确保骨架坚固不可被穿透破坏。

---

## 四、风险、盲点与可落地性评估

### 4.1 业务层编译断裂与白屏风险
1. **Button `bare` 属性移除的连带编译错误（盲点）**：
   - P05 的 Codemod 将 `<Button bare ...>` 自动替换为 `<button type="button" ...>`；
   - **重大盲点**：存量业务代码中有部分写法同时传入了 `<Button bare variant="ghost" size="sm" ...>`（原代码中这属于参数欺诈，被内部静默丢弃）。一旦直接转成原生 `<button>`，TypeScript 编译器在类型检查时会**立即抛出 TS2322 编译错误**：`Type '{ children: string; variant: string; size: string; type: "button"; }' is not assignable to type 'DetailedHTMLProps<ButtonHTMLAttributes<HTMLButtonElement>, HTMLButtonElement>'`！因为原生 `<button>` 根本不存在 `variant` 和 `size` 属性！
   - **必修补丁**：P05 的 Codemod 脚本必须增强清洗逻辑：在转换为 `<button>` 时，必须自动剔除 `variant`、`size`、`icon`、`loading` 等非 HTML 标准属性，并打印提示日志。
2. **移动端（crish-mobile）55 处深层越权导入漏网（盲点）**：
   - P01 普查数据中标明全仓 315 处深层越权包含 `apps/crish-mobile` 的 55 处；
   - 但在 P01 第 4.3 节的 Codemod 脚本中，`targetFiles` 却写死了 `collectSourceFiles(path.join(REPO_ROOT, 'apps', 'crish-desktop', 'src'))`，完全忽略了移动端！
   - **必修补丁**：P01 的 Codemod 收集器必须把 `apps/crish-mobile/src` 与 `packages/*` 全量纳入扫描目标。
3. **P02 内联动效 Codemod 对多属性 `transition` 的解析破坏（盲点）**：
   - P02 试图用简单正则匹配替换 CSS 中的 `transition: opacity 120ms ease;`；
   - **盲点**：项目中存在大量多属性符合声明，例如 `transition: transform var(--duration-fast) var(--ease-emphasized), opacity 150ms ease;`。若正则匹配不严密，直接替换会导致字符串断裂或语法错误。
   - **必修补丁**：P02 必须明确采用 PostCSS `postcss-value-parser` 进行 Token 级别的 AST 解析与精确重写，杜绝粗暴正则匹配。

### 4.2 动效与性能指标真实性复核
1. **Framer Motion 4.6 KB 真实性检验**：
   - P04 声明使用 `<LazyMotion features={domAnimation} strict>` 可以把运行时锁死在 4.6 KB；
   - 经打包器原理复核：`domAnimation` 确实包含物理弹簧与 FLIP 核心，该数据基于 gzip 压缩后测算真实可信。但关键在于**严禁在任何地方直接 `import { motion } from 'motion/react'`**，P04 设立的静态门禁 `check-motion-architecture.mjs` 必须在 Stage 1 立即上线，否则只要有一处全量引入，整个 34 KB 就会瞬间被打包进去。

### 4.3 验收断言可量化复核性审计
- **不可量化断言检举**：
  - P04 断言中的“Playwright 轨迹坐标一阶导数连续性检验”在目前的 Vitest / Playwright 测试套件中缺乏现成的测试脚手架，若作为硬性门禁可能导致落地时无法自动化跑通。
  - **建议修改为**：以数学仿真单元测试（`motionPhysicsContract.test.ts` 检验阻尼比 $\zeta=1.0$）结合组件状态切换下的类名/样式断言为主，真机高精轨迹抓轨作为辅助验证。

---

## 五、第三轮就地修改行动指南（各方案修订任务书）

在接下来的第三轮任务中，本首席审计专家将依据上述裁决，直接对 6 份方案文档进行就地修订。各文档的修正任务书如下：

### 5.1 对 `01-infra-packaging-and-export-convergence.md` 的修改任务
1. **剔除 `SafeTriangle`**：删除所有关于将 `SafeTriangle` 迁移至 `primitives/geometry` 的规划与描述，修改 Codemod 映射规则，彻底配合 P03 的物理删除；
2. **拓展 Codemod 扫描范围**：补齐 `apps/crish-mobile` 及其他 packages 的扫描配置，确保 315 处深层穿透一个不漏；
3. **强化导出隔离**：在 `sync-ui-exports.mjs` 中增加私有模块（`internal/`、前缀 `_`）的硬性过滤，对接 P05 的 Opaque Exports 契约。

### 5.2 对 `02-style-system-and-tokens-unification.md` 的修改任务
1. **全面纯函数化**：将第 4.1 ~ 4.4 节所有组件重构示范代码彻底改写为 React 19 纯函数范式（移除 `React.forwardRef` 与 `displayName`），对齐 P05；
2. **集成 `useMergedRefs`**：在 `Input.tsx` 中移除手写 `setCombinedRef`，改用 `useMergedRefs`；
3. **明确 @layer 边界**：在第 3.2.3 节补充对 Base UI 核心几何骨架属性不受 `@layer` 降权影响的保护说明；
4. **提升 Codemod 工具健壮性**：声明采用 PostCSS value-parser 处理复合 `transition` 属性。

### 5.3 对 `03-headless-primitives-and-stability.md` 的修改任务
1. **锁定弹层绝对权威**：在执行摘要与架构分层中，明确写入“全屏遮罩模态与锚定浮层为 Base UI 唯一单一真理源，生命周期完全由其原生接管”；
2. **收敛 A11y 篇幅**：弱化文档中对 a11y 的推演，将重点牢牢锁定在解决 1,802 行高危胶水代码、消除 `removeChild` 猴子补丁与布局抖动上；
3. **固化进退场机制**：明确 Dialog 与浮层组件的进出场统一采用 CSS `@starting-style` 与 `transition-behavior: allow-discrete`，杜绝任何 JS 定时器与外部动画库。

### 5.4 对 `04-motion-physics-and-interaction-continuity.md` 的修改任务
1. **坚决删除自研 Dialog 重写方案**：彻底移除第 4.4 节关于使用 `<AnimatePresence>` 重构 Dialog 的全部内容与伪代码；
2. **明确动效物理学法定管辖边界**：在文档总纲与第 3.1 节明确声明：Framer Motion 严格专属于“页面内交互连续性（Switch/Slider/SegmentedControl/TabStrip/SessionRow/列表FLIP）”，弹层由 P03 托管，形成正交互补；
3. **修正断言检验方式**：调整不可量化的物理轨迹测试断言为数学求解契约测试。

### 5.5 对 `05-api-contract-and-react19-pure-functions.md` 的修改任务
1. **全面采纳 CVA + `cn`**：彻底删除第 3.1.1 节手写的 `VARIANT_CLASS_MAP`、`SIZE_CLASS_MAP` 与 `filter(Boolean).join`，直接复用 P02 的 `buttonVariants`；
2. **根除 `useAnimatedPresence` 遗留认知**：在第 4.2 节和 4.3.2 节中彻底清除对 `useAnimatedPresence` 的一切描述，Dialog 复合原语直接对齐 P03 的 Base UI 实现；
3. **完善 Button `bare` Codemod**：在第 7.2.2 节补充自动剔除非法原生属性（`variant`、`size` 等）的安全防御机制；
4. **收敛 A11y 篇幅**：将重心聚焦于单程挂载渲染与纯函数契约，不再耗费精力于 a11y 专项展开。

### 5.6 对 `06-dx-and-llm-first-governance.md` 的修改任务
1. **物理路径全面对齐 `packages/ui`**：修正 Vite 配置、Playground 目录、`agent-rules.md` 与 `llms.txt` 的路径指向，支持 Monorepo 物理拓扑；
2. **Codemod 规则同步**：确保 `gatekeeper-codemod.mjs` 中的自动修复规则与 P02、P05 的最新规范保持 100% 同步，避免反向修改；
3. **Playground 故事集对齐**：确保沙箱接入的组件完全采用 React 19 纯函数与 Base UI 原语。

---

## 六、首席审计专家总签发裁决

本综合审计报告正式确立了本次 UI/UX 底层架构革新战役的**跨方案统一架构契约**。各专项方案之间的概念撕裂与接口矛盾已得到彻底澄清与裁决。

所有方案必须以本报告裁决的真理源边界为准绳进行修订与落地：
- **拓扑与导出**：以 P01 为基座，执行一次性全仓收敛，彻底剔除 `SafeTriangle`；
- **样式与 Tokens**：以 P02 的 CVA + `cn` 与高频 2.5% 为基准，全仓清退别名与内联动效；
- **底层原语与弹层**：以 P03 的 `@base-ui/react` 为唯一底座，纯 CSS `@starting-style` 掌管弹层，彻底消灭 1,802 行高危胶水代码；
- **动效物理学**：以 P04 的临界阻尼弹簧掌管页面内连续交互，严格退出弹层生命周期管辖；
- **组件 API 范式**：以 P05 的 React 19 纯函数（Ref-as-prop）与单程渲染为标准，严禁手写旧样板与参数欺诈；
- **开发体验与治理**：以 P06 的 `<40` 行规则、`llms.txt`、秒级沙箱与一键 Codemod 终结门禁拉锯。

> **下一步指令**：审计报告落盘入库后，立即向主 Agent 汇报核心发现与裁决结论，获取授权后由首席审计专家就地开展第三轮全量方案修订！
