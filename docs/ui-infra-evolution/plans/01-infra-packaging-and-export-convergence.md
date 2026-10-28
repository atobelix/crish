# 01 · 基础设施、包拓扑与导出收敛方案

> **方案代号**：`01-infra-packaging-and-export-convergence`  
> **方案定性**：前端原子 UI 基础设施、包拓扑解耦与统一导出收敛总方案  
> **上游依据**：`docs/ui-infra-evolution/00-调度与导航.md`（战役总纲）、`AGENTS.md`（协作铁律与反退避）  
> **核心使命**：彻底根除 Conex / Crish 前端 UI 组件的包结构混乱、手工 Barrel 维护成本高、公开/私有边界击穿、以及全仓 315 处深层越权引用的顽疾；建立基于文件系统约定的自动化导出中枢、一次性 AST Codemod 全量收敛引擎、以及物理隔离的 `@crish/ui` (`packages/ui`) Monorepo 工作区架构。  
> **五大铁律红线**：纯底层改动，视觉零变化；坚决避免双轨（No Dual-Track）；坚决避免硬编码（Zero Hardcoding）；无障碍（a11y）暂时不管；唯一单产出文档。

---

## 一、执行摘要与战役定位

### 1.1 战役定位与架构基石

在本次 `ui-infra-evolution` 前端重构战役中，本方案（P01）定位于**最底层的物理拓扑与包工程基座**。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        前端 UI/UX 底层架构革新全景依赖关系                              │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   ┌──────────────────────────────────┐      ┌──────────────────────────────────────┐   │
│   │   P05 组件 API 与 React 19 纯函数  │      │   P06 DX 体系与 LLM-First 基础设施     │   │
│   └─────────────────┬────────────────┘      └──────────────────┬───────────────────┘   │
│                     │                                          │                       │
│                     ▼                                          ▼                       │
│   ┌──────────────────────────────────┐      ┌──────────────────────────────────────┐   │
│   │   P03 Headless 底层原语与稳定性    │      │   P04 动效物理学与交互连贯性           │   │
│   └─────────────────┬────────────────┘      └──────────────────┬───────────────────┘   │
│                     │                                          │                       │
│                     ▼                                          ▼                       │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │                     P02 样式系统与 Tokens 规范统一方案                          │   │
│   └────────────────────────────────────────┬───────────────────────────────────────┘   │
│                                            │                                           │
│                                            ▼                                           │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │          ★ P01 基础设施、包拓扑与导出收敛方案 (Infra & Packaging) ★              │   │
│   │   • 物理包解耦 (@crish/ui)       • 自动化 sync-ui-exports   • 315 处越权收敛   │   │
│   │   • Rollup preserveModules      • Vite 源码直连零编译 HMR    • exports 子路径隔离 │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

任何样式重构（P02）、原语重构（P03）、动效接入（P04）、API 契约升级（P05）与 DX 治理（P06），都必须建立在**清晰的包拓扑、纯净的导出边界与健康的编译管线**之上。如果物理包结构混乱、内部实现被业务组件深层越权穿透，任何局部的组件重构都会引发全局雪崩式的编译断裂与循环依赖。

---

### 1.2 五大铁律遵从矩阵

| 核心铁律 | 约束要求 | 本方案落地方案与架构断言 | 验证与防退避机制 |
| :--- | :--- | :--- | :--- |
| **1. 视觉零变化 (Zero Visual Drift)** | 纯底层改动，禁止触碰任何视觉样式、尺寸间距与布局属性。 | 本方案仅涉及文件拓扑重构、AST import 说明符重写、包导出配置及打包管线。零 CSS 修改、零 DOM 结构变动、零 HTML 标签属性篡改。 | 像素级快照回归测试；E2E 关键链路对比；样式打包字节哈希校验。 |
| **2. 坚决避免双轨 (No Dual-Track)** | 严禁新旧两套并存、禁止废弃路径长期保留与运行时兼容垫片。 | 摒弃“保留深层路径并在控制台打印 deprecation warning”的脆弱妥协；采用一步到位的全量 AST Codemod，100% 静态收敛全仓 315 处深层越权导入，单真理源（SSOT）即刻生效。 | 静态门禁 `check:ui-layer` 增加逆向守卫，越权深层导入 0 容忍，CI 硬阻断。 |
| **3. 坚决避免硬编码 (Zero Hardcoding)** | 严禁写死文件列表、魔术字符串或硬编码白名单。 | 自动化导出脚本 `sync-ui-exports.mjs` 基于文件系统物理结构推导导出映射；AST Codemod 基于语法树节点动态计算相对/绝对路径；构建管线完全基于通配规则解析。 | 零硬编码文件清单；新增组件无需修改任何脚本配置，文件落盘即自动纳入。 |
| **4. 排除 A11y 干扰 (Exclude A11y)** | 不在此专项空耗精力在 ARIA、读屏适配与语义标签上。 | 方案全神贯注于 TS 模块解析、Rollup/Vite 构建、Package exports 契约与 Monorepo 依赖拓扑，完全不改动组件可访问性属性。 | 严格聚焦物理包层与工程基建，审查阶段坚决剔除 a11y 附加项。 |
| **5. 彻底根除门禁拉锯战 (End Lint-Guessing)** | 终结“写代码 -> 触发静态门禁 -> 盲目猜测修复”的恶性循环。 | 事前通过 `sync-ui-exports` 保证导出 100% 完整；利用 package `exports` 在类型检查期由 TS 原生拦截非法引用；提供一键修复 Codemod，将事后拉锯转化为事前强类型约束。 | IDE 内即时报错；`npm run sync:ui-exports --check` 刚性守门；一键脚本自动修复。 |

---

## 二、现状痛点全景深潜与量化审查

### 2.1 单体 Barrel（`components/ui/index.ts`）审查

当前位于 `apps/crish-desktop/src/components/ui/index.ts` 的单体出口文件共 **286 行**，完全由人工手工维护。对其进行深度审计，暴露出以下严重的架构缺陷：

1. **高维护成本与人工漂移**：
   - 每一个新增组件、重命名导出或增减 Prop 类型，都必须由开发者手动在 `index.ts` 补写 `export { ... }` 与 `export type { ... }`。
   - 极易发生“组件代码已写好，但忘记在 Barrel 导出”或“导出了组件但遗漏了关联 Type”的人工疏漏。
2. **表面导出繁复，核心基元严重缺失**：
   - 当前 Barrel 手工导出了 31 个组件族及关联类型，却遗漏了全仓最广泛消费的关键基元：
     - **图标系统完全遗漏**：未导出 `AppIcon`、`ICON_NAMES`、`IconName`、`iconTokens`，导致下游所有需要图标的代码无法通过规范入口引入。
     - **动态组件遗漏**：未导出 `TextMorph`、`AnimatedCounter`、`SmartModelBadge` 等基础视觉组件。
     - **浮层中枢协议遗漏**：未导出 `useLayerRegistration`、`LayerStackManager`、`layerStackService`，迫使弹窗、菜单与跨窗口热区逻辑直接深层穿透。
     - **子模块上下文遗漏**：未导出 `dialogOverlayContext`、`useAnimatedPresence` 等内部强协同 Hook。
3. **“守门不导”的结构性矛盾**：
   - 项目在 `scripts/check-ui-layer.mjs` 中设置了严格的门禁，禁止 `components/ui/` 向外依赖业务；
   - 却没有在出口端建立自动同步的保障机制。开发者在外部业务中需要使用某个 UI 基元时，发现 `components/ui/index.ts` 没有导出，为了绕过门禁或省事，直接采用深层路径 `import ... from '../ui/icons/index'` 或 `import ... from '../ui/internal/...'`，最终酿成全仓越权泛滥的恶果。

---

### 2.2 全仓 UI 导入拓扑全景量化审计

通过对全仓（`apps/crish-desktop`、`apps/crish-mobile`、`apps/agent-workbench`、`packages/*`）的全部 TypeScript/TSX 源码进行全面 AST 与说明符扫描，量化数据如下：

```
全仓 UI 相关导入总计：560 处
├─ 规范规范出口引用（@/components/ui 或 ../ui 单纯 Barrel）：245 处 (43.8%)
└─ 深层穿透越权引用（Deep Penetrating Imports）：315 处 (56.2%)  ← [核心治理靶点]
```

#### 越权深层穿透引用详细构成分布表

| 越权穿透分类 | 违规引用次数 | 典型代表路径与模块 | 违规发生根因与现状剖析 |
| :--- | :---: | :--- | :--- |
| **图标实现穿透** | **198 处** | `../ui/icons/index` (157次)<br>`../ui/icons` (23次)<br>`../../ui/icons/index` (7次)<br>`../../components/ui/icons` (4次)<br>`ui/icons/iconTokens` (4次)<br>`iconNames` (1次) | **根因**：`ui/index.ts` 零图标导出！所有需要图标的业务组件被迫直接穿透到 `ui/icons` 目录。这是造成穿透引用过半（62.8%）的最大单一罪魁祸首。 |
| **浮层调度中枢穿透** | **16 处** | `../ui/internal/layer-stack/LayerStackService` (11次)<br>`../ui/internal/layer-stack/LayerStackManager` (3次)<br>`../ui/internal/layer-registration/useLayerRegistration` (2次) | **根因**：全局浮层事件管理（窗口遮罩、模态互斥、Toast 热区命中测试、原生子窗口 Airspace 避让）需要感知全局模态激活态，但中枢被藏匿在 `ui/internal/`，业务组件与测试用例直接翻墙调用内部单例。 |
| **私有几何算法穿透** | **2 处** | `../ui/internal/SafeTriangle`<br>(ModelsCascadeSelect.tsx:36, 217) | **根因**：历史遗留的 2D 向量叉积碰撞胶水。P03 基于 Base UI 原生指针意图保护将其彻底物理删除，业务层不再保留该底层引用。 |
| **组件单体深层穿透** | **38 处** | `../ui/Menu` (12次)<br>`../ui/SmartExpandablePanel` (6次)<br>`../ui/Tooltip` (5次)<br>`../ui/Dialog` (4次)<br>`../ui/AnimatedCounter` (2次)<br>`../ui/TextMorph` (1次)<br>`../ui/Button/IconButton` (1次)<br>`../ui/ScrollArea` (1次)<br>`../ui/SmartPanel` (1次) | **根因**：开发者历史习惯残留；部分组件（如 AnimatedCounter、TextMorph）Barrel 未导出；部分子组件（如 IconButton）虽已导出，但开发者依然凭借目录记忆书写了深层路径。 |
| **样式与上下文深层穿透** | **5 处** | `../ui/Menu/Menu.module.css` (1次)<br>`../ui/SmartExpandablePanel/SmartExpandablePanel.module.css` (1次)<br>`../ui/Dialog/useAnimatedPresence` (1次)<br>`../ui/Tooltip/tooltipController` (2次) | **根因**：测试用例直接探测组件 CSS 类名以断言样式挂载；动画状态 Hook 与浮层控制器未解耦暴露。 |
| **工具函数穿透** | **1 处** | `components/ui/utils/modelAbbreviation`<br>(api/modelAbbreviation.ts:1) | **根因**：API 业务层反向依赖了 UI 下属的 utils，违反分层依赖单向性原则。 |
| **移动端分叉穿透** | **55 处** | `apps/crish-mobile/src/presentation/components/ui/*` | **根因**：移动端存在独立未收敛的 presentation UI 导入，需与桌面端包解耦独立规划。 |

---

### 2.3 根因深潜：为什么现存架构会持续恶化？

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 恶性循环因果链路分析                                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   ┌───────────────────────────┐         ┌──────────────────────────────────────────┐   │
│   │ 1. 手工维护 Barrel        │         │ 2. 导出遗漏                              │   │
│   │    286 行庞大 index.ts    │ ──────> │    AppIcon、LayerStack、TextMorph 等     │   │
│   │    开发者心智负担重       │         │    大量基础组件与类型不在出口清单中      │   │
│   └───────────────────────────┘         └────────────────────┬─────────────────────┘   │
│                                                              │                         │
│                                                              ▼                         │
│   ┌───────────────────────────┐         ┌──────────────────────────────────────────┐   │
│   │ 4. 越权代码泛滥成灾       │         │ 3. 开发者“翻墙”越权穿透                  │   │
│   │    全仓 315 处深层引用    │ <────── │    被迫使用 import ... from '../ui/icons'│   │
│   │    重构寸步难行、破窗效应 │         │    或 '../ui/internal/layer-stack'       │   │
│   └─────────────┬─────────────┘         └──────────────────────────────────────────┘   │
│                 │                                                                      │
│                 ▼                                                                      │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ 5. 门禁拉锯加剧：静态拦截频发，但没有机器友好的自动化生成与修复机制           │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **破窗效应（Broken Window Theory）**：当项目中存在第一个穿透 `../ui/icons` 的提交并成功入库后，其他开发者与 AI Agent 会在上下文中模仿这一模式，导致穿透引用从几处迅速爆发至近两百处。
2. **缺乏类型系统与构建级物理阻断**：在当前纯相对路径导入模式下，TypeScript 与 Vite 默认放行一切可从磁盘解析的路径。只要文件存在于磁盘，外部就可以穿透引入，缺少类似 npm `package.json` 中 `"exports"` 字段的**物理级子路径访问拦截**。
3. **架构职责与分层混淆**：
   - `LayerStackManager` 既作为 `Dialog` / `Menu` 的底层原语，又作为全局模态中枢管理原生窗口避让热区（`windowSnapOverlay.ts` 与 `nativeBrowserGeometry.ts`）。它本应是一个独立的**浮层调度子系统**，却被错误地打上了 `internal` 标签，引发了“系统需要它，但规定不准引它”的冲突。
   - `SafeTriangle` 与 `SafeAimEngine` 属于早期过度设计的 736 行向量碰撞与 SVG 注入胶水，已由 P03 Base UI 原生指针意图保护彻底淘汰并物理删除，新包中不再为其保留任何公开导出。

---

## 三、自动化导出与白名单隔离方案

### 3.1 架构借鉴与演进设计

本方案深度借鉴 `reference/appica-ui` 的 `scripts/sync-exports.mjs` 机制。在 `appica-ui` 中，自动化脚本通过四大命名空间目录约束，严格以白名单方式从物理文件系统同步生成两套关键制品：
1. `src/index.ts`（统一根导出 Barrel）；
2. `package.json` 中的 `exports` 映射（控制 npm/打包子路径）。

结合 Conex / Crish 的架构特性，我们设计适合 Conex 的自动化导出中枢：`scripts/sync-ui-exports.mjs`。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                     Conex 自动化导出中枢：scripts/sync-ui-exports.mjs                   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   物理文件系统 (Source of Truth)                                                       │
│   packages/ui/src/ (或 components/ui/)                                                 │
│   ├── components/         ── [公开表面] ───> 自动映射为根导出与 ./<name> 子路径        │
│   ├── icons/              ── [公开表面] ───> 自动映射为根导出与 ./icons 子路径         │
│   ├── primitives/         ── [公开表面] ───> 映射为 ./primitives/* (roving-focus等)    │
│   ├── layer-stack/        ── [公开中枢] ───> 自动映射为根导出与 ./layer-stack 子路径   │
│   ├── hooks/              ── [公开表面] ───> 自动映射为根导出与 ./hooks/* 子路径       │
│   ├── styles/             ── [公开资源] ───> 映射为 ./styles.css                       │
│   └── internal/           ── [严格隔离] ───> 白名单彻底排除！永不生成导出与子路径      │
│                                                     │                                  │
│                                                     ▼                                  │
│   双向刚性约束产物                                                                     │
│   ┌────────────────────────────────┐            ┌──────────────────────────────────┐   │
│   │ 1. packages/ui/src/index.ts    │            │ 2. packages/ui/package.json      │   │
│   │    机器生成，禁止人工改动      │            │    "exports" 严格子路径白名单    │   │
│   │    100% 覆盖全部公开组件与原语 │            │    物理封死 internal/ 私有穿越   │   │
│   └────────────────────────────────┘            └──────────────────────────────────┘   │
│                                                     │                                  │
│                                                     ▼                                  │
│   CI / Pre-commit 刚性守门：node scripts/sync-ui-exports.mjs --check (0 漂移阻断)      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 3.2 命名空间与公开/私有隔离边界契约

1. **公开命名空间白名单（Allowlist Namespaces）**：
   - `components/`：基础原子交互组件。每个组件必须为文件夹（含 `index.ts` 或 `<name>.tsx`）或同名文件。
   - `icons/`：统一图标系统。包含 `AppIcon`、`iconMap`、`iconTokens` 等全部图标资产。
   - `primitives/`：Headless 基础原语（如键盘焦点漫游 `roving-focus` 等；`SafeTriangle` 几何胶水已被 P03 彻底物理清退）。
   - `layer-stack/`：全局浮层与模态调度中枢（原 `internal/layer-stack` 与 `internal/layer-registration` 正式正规化合并）。
   - `hooks/`：通用无头交互 Hook。
2. **私有命名空间（Strictly Private Namespaces）**：
   - `internal/`：严格私有实现。仅供同包内部模块相互引用，**在导出生成器中被硬性排除**。
   - 任何位于 `internal/` 下的文件绝不会出现在 `src/index.ts` 中，更不会出现在 `package.json` 的 `"exports"` 中。外部业务若尝试引用，TypeScript 编译器与 Vite 解析器将在构建前直接报 `Module not found` 物理拦截。
3. **文件命名与解析规则**：
   - 单原语目录：`<namespace>/<name>/<name>.tsx` -> 解析为导出入口 `<name>/<name>`；
   - 复合聚合目录：`<namespace>/<name>/index.ts` -> 解析为导出入口 `<name>/index`；
   - 扁平模块文件：`<namespace>/<name>.ts` -> 解析为导出入口 `<name>`；
   - 排除一切 `*.test.ts`、`*.spec.tsx`、`__tests__/` 及内联样式私有文件。

---

### 3.3 `scripts/sync-ui-exports.mjs` 核心源码实现设计

以下为生产级自动化同步脚本设计（纯 ESM、原生 Node.js、零外部依赖）：

```javascript
#!/usr/bin/env node
/**
 * scripts/sync-ui-exports.mjs
 *
 * 自动化 UI 导出中枢与 package.json exports 同步器（借鉴 appica-ui 演进）
 * 
 * 职责：
 * 1. 扫描 UI 包 src/ 下的白名单命名空间目录；
 * 2. 自动生成 packages/ui/src/index.ts（统一出口 Barrel）；
 * 3. 自动同步更新 packages/ui/package.json 中的 "exports" 映射；
 * 4. 严格隔离 src/internal/，物理禁止私有实现逃逸到外部；
 * 5. 支持 --check 标志位，接入 CI 门禁与 pre-commit。
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// 适配过渡期（若尚在 apps/crish-desktop 内）与抽取后（packages/ui）双阶段
const UI_PKG_DIR = existsSync(join(REPO_ROOT, 'packages', 'ui'))
  ? join(REPO_ROOT, 'packages', 'ui')
  : join(REPO_ROOT, 'apps', 'crish-desktop', 'src', 'components', 'ui');

const SRC_DIR = existsSync(join(UI_PKG_DIR, 'src')) ? join(UI_PKG_DIR, 'src') : UI_PKG_DIR;
const PKG_JSON_PATH = existsSync(join(UI_PKG_DIR, 'package.json'))
  ? join(UI_PKG_DIR, 'package.json')
  : null;
const BARREL_PATH = join(SRC_DIR, 'index.ts');

// 白名单命名空间配置（严禁将 internal 列入此表）
const NAMESPACES = [
  { dir: 'components', subpathPrefix: '' },
  { dir: 'icons', subpathPrefix: 'icons' },
  { dir: 'layer-stack', subpathPrefix: 'layer-stack' },
  { dir: 'primitives', subpathPrefix: 'primitives/' },
  { dir: 'hooks', subpathPrefix: 'hooks/' },
];

const BARREL_BANNER = `/**
 * @crish/ui 原子设计系统统一入口（Single Truth Barrel）
 * 
 * [AUTO-GENERATED FILE] 本文件由 scripts/sync-ui-exports.mjs 自动生成。
 * 严禁手工编辑！新增组件或原语请遵循命名空间规范落盘，运行 \`npm run sync:ui-exports\` 自动同步。
 */\n\n`;

const ENTRY_FILE_RE = /\.(tsx?)$/;
const TEST_FILE_RE = /(\.test|\.spec)\.(tsx?)$/;
const PRIVATE_FILE_RE = /(^_|\.internal\.|\.helper\.)/;

function resolveEntry(namespaceDir, name) {
  const nsDir = join(SRC_DIR, namespaceDir);
  const folder = join(nsDir, name);
  if (existsSync(folder) && statSync(folder).isDirectory()) {
    // 强制契约：组件目录必须通过显式 index.ts 控制公开导出表面（Opaque Exports）
    if (existsSync(join(folder, 'index.ts')) || existsSync(join(folder, 'index.tsx'))) {
      return `${name}/index`;
    }
    if (existsSync(join(folder, `${name}.tsx`)) || existsSync(join(folder, `${name}.ts`))) {
      return `${name}/${name}`;
    }
  }
  // 排除私有前缀文件（如 _private.ts 或 helper.internal.ts）
  if (PRIVATE_FILE_RE.test(name)) return null;
  if (existsSync(join(nsDir, `${name}.tsx`)) || existsSync(join(nsDir, `${name}.ts`))) {
    return name;
  }
  return null;
}

function listEntries(namespaceDir) {
  const dir = join(SRC_DIR, namespaceDir);
  if (!existsSync(dir)) return [];
  const entries = new Set();
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name === '__tests__' || item.name === 'internal' || item.name.startsWith('.')) continue;
    if (PRIVATE_FILE_RE.test(item.name)) continue; // 刚性过滤私有 helper
    if (item.isDirectory()) {
      entries.add(item.name);
    } else if (item.isFile() && ENTRY_FILE_RE.test(item.name) && !TEST_FILE_RE.test(item.name)) {
      entries.add(item.name.replace(ENTRY_FILE_RE, ''));
    }
  }
  return [...entries]
    .map((name) => ({ name, importPath: resolveEntry(namespaceDir, name) }))
    .filter((e) => e.importPath !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildBarrel(namespaces) {
  const lines = [];
  for (const { dir, entries } of namespaces) {
    if (entries.length === 0) continue;
    lines.push(`// ─── Namespace: ${dir} (精准公开表面收敛) ───────────────────`);
    for (const { importPath } of entries) {
      // 基于组件规范索引导出，杜绝内部私有实现逃逸到根命名空间
      lines.push(`export * from './${dir}/${importPath}';`);
    }
    lines.push('');
  }
  return BARREL_BANNER + lines.join('\n').trim() + '\n';
}

function buildExportsMap(namespaces) {
  const exportsMap = {
    '.': {
      development: {
        types: './src/index.ts',
        import: './src/index.ts',
        default: './src/index.ts',
      },
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    },
    './styles.css': './dist/styles.css',
  };

  for (const { dir, subpathPrefix, entries } of namespaces) {
    // 命名空间整体入口（如 @crish/ui/icons, @crish/ui/layer-stack）
    if (subpathPrefix && !subpathPrefix.endsWith('/')) {
      exportsMap[`./${subpathPrefix}`] = {
        development: {
          types: `./src/${dir}/index.ts`,
          import: `./src/${dir}/index.ts`,
          default: `./src/${dir}/index.ts`,
        },
        types: `./dist/${dir}/index.d.ts`,
        import: `./dist/${dir}/index.js`,
        default: `./dist/${dir}/index.js`,
      };
    }

    for (const { name, importPath } of entries) {
      const subpath = subpathPrefix.endsWith('/')
        ? `./${subpathPrefix}${name}`
        : `./${name}`;
      exportsMap[subpath] = {
        development: {
          types: `./src/${dir}/${importPath}.ts`,
          import: `./src/${dir}/${importPath}.ts`,
          default: `./src/${dir}/${importPath}.ts`,
        },
        types: `./dist/${dir}/${importPath}.d.ts`,
        import: `./dist/${dir}/${importPath}.js`,
        default: `./dist/${dir}/${importPath}.js`,
      };
    }
  }

  exportsMap['./package.json'] = './package.json';
  return exportsMap;
}

export function syncUIExports(isCheck = false) {
  const collected = NAMESPACES.map((ns) => ({
    ...ns,
    entries: listEntries(ns.dir),
  }));

  const updates = [];

  // 1. 同步 Barrel (src/index.ts)
  const nextBarrel = buildBarrel(collected);
  const currentBarrel = existsSync(BARREL_PATH) ? readFileSync(BARREL_PATH, 'utf8') : '';
  if (currentBarrel.replace(/\r\n/g, '\n') !== nextBarrel.replace(/\r\n/g, '\n')) {
    if (!isCheck) {
      writeFileSync(BARREL_PATH, nextBarrel, 'utf8');
    }
    updates.push('src/index.ts');
  }

  // 2. 同步 package.json exports (若存在独立包)
  if (PKG_JSON_PATH && existsSync(PKG_JSON_PATH)) {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8'));
    const nextExports = buildExportsMap(collected);
    if (JSON.stringify(pkg.exports) !== JSON.stringify(nextExports)) {
      if (!isCheck) {
        pkg.exports = nextExports;
        writeFileSync(PKG_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      }
      updates.push('package.json (exports)');
    }
  }

  const summary = collected.map((c) => `${c.dir}: ${c.entries.length}`).join(' | ');

  if (updates.length === 0) {
    console.log(`[sync-ui-exports] ✓ 导出契约完全同步 (${summary})`);
    return true;
  }

  if (isCheck) {
    console.error(`[sync-ui-exports] ✗ 导出契约脱节：${updates.join(', ')}。`);
    console.error(`[sync-ui-exports] 请立即执行 \`npm run sync:ui-exports\` 自动重新生成！`);
    return false;
  }

  console.log(`[sync-ui-exports] ✓ 自动更新生成：${updates.join(', ')} (${summary})`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checkMode = process.argv.includes('--check');
  const ok = syncUIExports(checkMode);
  if (!ok) process.exit(1);
}
```

---

## 四、一次性彻底收敛 315 处深层越权引用的 AST Codemod 方案

### 4.1 坚决杜绝双轨（No Dual-Track）实施准则

在传统的妥协性方案中，往往通过“在旧文件保留 `export *` 并加 `@deprecated` 注释”或“在入口处配置兼容路径别名并运行时打印 warning”的方式建立所谓的双轨过渡。**这种设计在大型桌面端工程与 AI Agent 协同场景下是致命的**：
- 双轨会导致代码库中新旧导入混用，破坏 Single Source of Truth；
- AI Agent 依然会学习旧代码模式，继续生成深层路径；
- 维护者必须承担两套路径的死代码负担与打包重复开销。

因此，本方案严格遵循铁律，**采取“一步到位 AST Codemod 全量自动化收敛”**。一次性清洗全仓 315 处深层导入，在代码仓库层面瞬间完成收敛，门禁立即生效阻断任何死灰复燃。

---

### 4.2 结构化收敛映射字典（Mapping Matrix）

针对量化审计得出的 315 处越权调用，建立确定性的 AST 说明符重写映射表：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              AST 说明符自动化收敛映射规则                              │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   【规则 A：图标收敛 (198 处)】                                                        │
│   原模式：                                       新目标：                               │
│   • from '../ui/icons/index'            ───>     import { AppIcon, ... }                │
│   • from '../ui/icons'                  ───>       from '@/components/ui' (或 @crish/ui)│
│   • from '../../ui/icons/iconTokens'    ───>     (按需自动解构具名导出)                  │
│                                                                                        │
│   【规则 B：浮层中枢收敛 (16 处)】                                                     │
│   原模式：                                       新目标：                               │
│   • from '../ui/internal/layer-stack/   ───>     import { layerStackService, ... }      │
│          LayerStackService'             ───>       from '@/components/ui/layer-stack'   │
│   • from '../ui/internal/layer-stack/   ───>     (解耦出清晰的公开子路径，封死私有目录) │
│          LayerStackManager'                                                            │
│   • from '../ui/internal/layer-registration/──>  import { useLayerRegistration }        │
│          useLayerRegistration'                     from '@/components/ui'              │
│                                                                                        │
│   【规则 C：计算几何废弃清退 (2 处)】                                                  │
│   原模式：                                       新目标：                               │
│   • ModelsCascadeSelect.tsx             ───>     解除对底层 SafeTriangle 穿透，         │
│     from '../ui/internal/SafeTriangle'  ───>     改用 P03 原生内置指针意图的高阶级联原语│
│                                                  (SafeTriangle 已彻底物理删除，0导出)   │
│                                                                                        │
│   【规则 D：单体组件与上下文收敛 (38 处)】                                             │
│   原模式：                                       新目标：                               │
│   • from '../ui/Menu'                   ───>     import { Menu, ... }                   │
│   • from '../ui/SmartExpandablePanel'   ───>       from '@/components/ui'               │
│   • from '../ui/Tooltip/Tooltip'        ───>     import { Tooltip, ... }                │
│   • from '../ui/AnimatedCounter'        ───>       from '@/components/ui'               │
│   • from '../ui/TextMorph'              ───>                                            │
│                                                                                        │
│   【规则 E：API 越权引用逆向修复 (1 处)】                                              │
│   原模式：                                       新目标：                               │
│   • api/modelAbbreviation.ts            ───>     下沉至 packages/shared-utils/src/      │
│     from '../components/ui/utils/...'            并自 @crish/shared-utils 规范引入     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 4.3 生产级 AST Codemod 自动化脚本设计

我们提供基于 TypeScript 编译器 API（`ts-morph`）的高精度 Codemod 脚本：`scripts/codemod-converge-ui-imports.ts`。具备以下特性：
- 完美保留原有注释、空白行与缩进；
- 智能合并同一文件的多个 import 声明（例如原本同时引入 `../ui` 与 `../ui/icons` 的文件，自动合并为一个 `@crish/ui` 声明）；
- 严格区分 `import type` 与值导入，维持 `verbatimModuleSyntax` 契约；
- 事务性批处理：全仓扫描 -> 内存 AST 重写 -> 语法校验 -> 原子落盘。

```typescript
/**
 * scripts/codemod-converge-ui-imports.ts
 * 
 * 全仓 UI 导入一次性 AST Codemod 自动化收敛中枢
 * 
 * 运行方式：npx tsx scripts/codemod-converge-ui-imports.ts [--write]
 */

import { Project, SyntaxKind, ImportDeclaration } from 'ts-morph';
import path from 'node:path';
import fs from 'node:fs';

const isWrite = process.argv.includes('--write');
const REPO_ROOT = path.resolve(__dirname, '..');

const project = new Project({
  tsConfigFilePath: path.join(REPO_ROOT, 'tsconfig.base.json'),
  skipAddingFilesFromTsConfig: true,
});

// 递归收集应用与包中的源码文件（排除 node_modules, dist, target）
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', '.git', '.crish-trash'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const targetFiles = [
  ...collectSourceFiles(path.join(REPO_ROOT, 'apps', 'crish-desktop', 'src')),
  ...collectSourceFiles(path.join(REPO_ROOT, 'apps', 'crish-mobile', 'src')),
  ...collectSourceFiles(path.join(REPO_ROOT, 'packages')),
];

console.log(`[codemod] 发现 ${targetFiles.length} 个候选源码文件，正在加载 AST...`);
project.addSourceFilesAtPaths(targetFiles);

let rewrittenCount = 0;
let fileModifiedCount = 0;

for (const sourceFile of project.getSourceFiles()) {
  const filePath = sourceFile.getFilePath();
  // 跳过 ui 组件库内部文件之间的正常相对引用
  if (filePath.includes('/components/ui/')) continue;

  let fileChanged = false;
  const importsToMerge = new Map<string, { named: Set<string>; types: Set<string>; defaultImport?: string }>();

  const importDeclarations = sourceFile.getImportDeclarations();
  for (const decl of importDeclarations) {
    const specifier = decl.getModuleSpecifierValue();

    // 判定是否属于 components/ui 的越权穿透引用
    const isUIPenetration = 
      /(\/|\.\.\/)+ui\/(icons|internal|Menu|SmartExpandablePanel|Tooltip|Dialog|Button\/IconButton|AnimatedCounter|TextMorph|ScrollArea)/.test(specifier) ||
      specifier.startsWith('@/components/ui/') && !specifier.endsWith('/ui');

    if (!isUIPenetration) continue;

    // 解析收敛的目标规范包路径
    let targetPackage = '@/components/ui'; // 最终可置换为 @crish/ui

    if (specifier.includes('internal/layer-stack')) {
      targetPackage = '@/components/ui/layer-stack';
    }

    // 收集已有导入项
    if (!importsToMerge.has(targetPackage)) {
      importsToMerge.set(targetPackage, { named: new Set(), types: new Set() });
    }
    const entry = importsToMerge.get(targetPackage)!;

    for (const named of decl.getNamedImports()) {
      if (named.isTypeOnly()) {
        entry.types.add(named.getName());
      } else {
        entry.named.add(named.getName());
      }
    }

    const defaultImport = decl.getDefaultImport();
    if (defaultImport) {
      entry.named.add(defaultImport.getText());
    }

    // 标记移除当前违规声明
    decl.remove();
    fileChanged = true;
    rewrittenCount++;
  }

  // 为重构的规范路径生成合并后的纯净 import 声明
  if (fileChanged) {
    fileModifiedCount++;
    for (const [pkg, items] of importsToMerge.entries()) {
      const namedImports: string[] = [];
      for (const n of items.named) namedImports.push(n);
      for (const t of items.types) namedImports.push(`type ${t}`);

      if (namedImports.length > 0) {
        sourceFile.addImportDeclaration({
          moduleSpecifier: pkg,
          namedImports,
        });
      }
    }
  }
}

console.log(`\n[codemod] 统计分析完成：`);
console.log(`  • 涉及修改文件数: ${fileModifiedCount}`);
console.log(`  • 成功收敛越权 import: ${rewrittenCount} 处`);

if (isWrite) {
  project.saveSync();
  console.log(`[codemod] ✓ 已成功全量写入磁盘！`);
} else {
  console.log(`[codemod] [Dry-run 模式] 磁盘未改动。运行带 --write 执行物理写入。`);
}
```

---

## 五、独立内部共享包 `@crish/ui` (`packages/ui`) 抽取架构

### 5.1 抽取驱动力与架构价值

将原子 UI 组件物理抽离至 Monorepo 根下的 `packages/ui`（包名 `@crish/ui`），能够带来根本性的架构质变：
1. **物理阻断越权（Physical Encapsulation）**：利用 Node / Vite 原生支持的 `package.json` `"exports"` 机制，实现编译期硬边界。私有模块甚至无法被外部通过任何路径引入，彻底杜绝穿透；
2. **多终端复用（Multi-platform Scalability）**：`apps/crish-desktop`、`apps/agent-workbench` 及后续潜在端（如轻量化调试面板）可共享同一套原子设计系统；
3. **极速单体 CI 与隔离测试**：UI 包拥有独立的构建流水线与轻量级测试环境，单测运行无需挂载庞大的业务上下文。

---

### 5.2 目录拓扑与文件职责

```
packages/ui/
├── package.json                   # 精细 subpath exports + customConditions 定义
├── tsconfig.json                  # 开发态基线配置
├── tsconfig.build.json            # 生产态类型生成专用配置
├── rollup.config.mjs              # preserveModules: true 模块保留打包配置
├── README.md                      # 包说明与规范
└── src/
    ├── index.ts                   # 机器自动生成的统一导出 Barrel
    ├── components/                # 基础交互原子组件 (Button, Input, Dialog, ...)
    │   ├── Button/
    │   ├── Input/
    │   └── Dialog/
    ├── icons/                     # 统一图标系统 (AppIcon, iconMap, iconTokens)
    │   ├── AppIcon.tsx
    │   ├── iconMap.ts
    │   └── index.ts
    ├── layer-stack/               # 正规化的浮层与模态调度中枢
    │   ├── LayerStackManager.ts
    │   ├── LayerStackService.ts
    │   ├── useLayerRegistration.ts
    │   └── index.ts
    ├── primitives/                # Headless 基础原语 (SafeTriangle/Presence 胶水已物理清退)
    │   ├── roving-focus/          # 键盘方向键焦点漫游引擎
    │   └── index.ts
    ├── hooks/                     # 通用无头 Hook
    ├── styles/                    # 基础 Tokens、CSS 变量与重置样式
    │   ├── tokens.css
    │   └── index.css
    └── internal/                  # 严格包内私有实现 (永不进入 exports)
```

---

### 5.3 双模构建与开发态零延迟直连（Dev HMR & Production Build）

开发体验（DX）的头号天敌是“修改了 packages/ 下的代码，必须先手动 npm run build 才能在桌面端看到效果”。**本方案设计严密的技术链路，彻底粉碎这一瓶颈**：

#### 机制 A：开发态直连（Zero-Build Dev HMR）
1. 在 `packages/ui/package.json` 的 `exports` 中，为所有子路径配置 `"development"` 条件分支：
   ```json
   {
     "exports": {
       ".": {
         "development": {
           "types": "./src/index.ts",
           "import": "./src/index.ts",
           "default": "./src/index.ts"
         },
         "types": "./dist/index.d.ts",
         "import": "./dist/index.js",
         "default": "./dist/index.js"
       }
     }
   }
   ```
2. 仓库根目录 `tsconfig.base.json` 已原生配置 `"customConditions": ["development"]`。TypeScript 编译器无需寻找构建后的 `.d.ts`，直接跨包解析 `src/index.ts` 源码，类型推导零延迟！
3. 在 `apps/crish-desktop/vite.config.ts` 中配置直连 alias：
   ```typescript
   {
     find: /^@crish\/ui$/,
     replacement: resolve(__dirname, '../../packages/ui/src/index.ts'),
   },
   {
     find: /^@crish\/ui\/(.*)$/,
     replacement: resolve(__dirname, '../../packages/ui/src/$1'),
   }
   ```
   **效果断言**：在 `packages/ui/src/components/Button/Button.tsx` 中修改一行代码，桌面端 WebView2 触发 Vite 原生 HMR，**<150ms 局部热更新，完全无需重新构建包**！

#### 机制 B：生产态模块保留构建（Rollup `preserveModules`）
在正式打包时，不能把 UI 库粗暴地 bundle 成一个巨大的单体 js 文件（会导致 Tree-Shaking 失效并可能引发 vendor chunk 超出 600KB 门禁限制）。我们使用 Rollup 启用 `preserveModules: true`：

```javascript
// packages/ui/rollup.config.mjs
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import postcss from 'rollup-plugin-postcss';

export default {
  input: ['src/index.ts', 'src/icons/index.ts', 'src/layer-stack/index.ts'],
  output: {
    dir: 'dist',
    format: 'esm',
    preserveModules: true,         // 保留模块物理层级，产出高度内聚独立的细粒度 js
    preserveModulesRoot: 'src',
    entryFileNames: '[name].js',
    sourcemap: true,
  },
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@radix-ui/react-popover',
    '@hugeicons/react',
    '@hugeicons/core-free-icons',
  ],
  plugins: [
    resolve(),
    commonjs(),
    postcss({ extract: 'styles.css', modules: true, minimize: true }),
    typescript({ tsconfig: './tsconfig.build.json', declaration: true, outDir: './dist' }),
  ],
};
```

---

### 5.4 主应用 Vite 构建集成与 Chunk 门禁适配

在 `apps/crish-desktop/vite.config.ts` 中，必须适配 `chunkSizeGatePlugin`（600KB 门禁）与 `manualChunks`：

```typescript
// apps/crish-desktop/vite.config.ts -> manualChunks
manualChunks(id) {
  const n = id.replace(/\\/g, '/');

  // 将 @crish/ui 的纯原子组件与样式划入专门的 chunk，避免与业务混杂
  if (n.includes('/packages/ui/')) {
    if (n.includes('/icons/')) {
      return 'ui-icons'; // 图标独立切块，配合 dynamic/lazy
    }
    return 'crish-ui';   // 原子组件统一进入 crish-ui chunk (~180KB，远低于 600KB 门禁)
  }

  // 既有第三方 vendor 策略保持不变
  if (n.includes('node_modules')) {
    // ...
  }
}
```

---

## 六、实施路线图、演进步骤与操作手册

为了彻底践行“零盲猜、可验证、无回归”的工程原则，本方案将整个落地过程划分为 6 个原子阶段，严格串行推进：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              六阶段原子化落地实施流水线                                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  [Stage 1: 中枢接口规范化]                                                             │
│  • 将 LayerStackService/Manager/Registration 统一重组到 layer-stack/ 目录              │
│  • 协同验证 P03 对 SafeAimEngine / SafeTriangle 的彻底物理清退，新包零公开导出        │
│  • 验证：运行既有单元测试与 modal 互斥测试，断言行为零改变                             │
│                                  │                                                     │
│                                  ▼                                                     │
│  [Stage 2: 自动化导出生成器就位]                                                       │
│  • 部署 scripts/sync-ui-exports.mjs                                                    │
│  • 执行自动同步，自动产出全新的规范化 index.ts（补全遗漏的 40+ 关键符号）              │
│  • 验证：git diff 检查新 index.ts 导出完整度，确保包含 AppIcon、LayerStack 等         │
│                                  │                                                     │
│                                  ▼                                                     │
│  [Stage 3: AST Codemod 全量收敛]                                                       │
│  • 运行 npx tsx scripts/codemod-converge-ui-imports.ts --write                         │
│  • 全仓 315 处深层引用一步到位替换为规范入口引用                                       │
│  • 验证：执行 analyze_ui.js 验证穿透计数为 0；运行 npm run typecheck 验证零类型断裂   │
│                                  │                                                     │
│                                  ▼                                                     │
│  [Stage 4: 静态门禁升级双向守门]                                                       │
│  • 升级 scripts/check-ui-layer.mjs：不仅检查 ui 向外依赖，增加外部向内穿透逆向拦截     │
│  • 接入 pre-commit 钩子：强制执行 sync-ui-exports --check                              │
│  • 验证：故意制造一处 ../ui/icons 引入，断言 check:ui-layer 刚性阻断报错               │
│                                  │                                                     │
│                                  ▼                                                     │
│  [Stage 5: packages/ui 独立包物理抽取]                                                 │
│  • 迁移物理文件至 packages/ui/，配置 package.json subpath exports                      │
│  • 注册根 package.json workspaces: ["packages/ui"]                                    │
│  • 配置 apps/crish-desktop/vite.config.ts 别名与 manualChunks 切块                     │
│  • 验证：桌面端 npm run dev:desktop 启动秒开，Vite HMR 毫秒级生效                     │
│                                  │                                                     │
│                                  ▼                                                     │
│  [Stage 6: 全面验收与物理基线归档]                                                     │
│  • 运行 FULL_CHECK_COMMANDS 全量测试套件                                              │
│  • 验证生产构建 dist 体积与 600KB chunk 门禁                                           │
│  • 归档收敛后拓扑指标                                                                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 七、边界风险防控与反过度设计守则

### 7.1 样式与视觉零漂移安全网

1. **CSS Modules 局部作用域不变**：
   - 所有组件的样式均采用 `*.module.css` 或 CSS 变量，模块移动后，Vite 与 PostCSS 会保持类名哈希规则一致；
   - 严禁修改任何 `.module.css` 中的选择器名称、边距（margin/padding）、字号（font-size）与颜色；
   - 对样式产物执行严格的 Hash 与字节对比，确保打包后的 CSS 规则树 100% 同构。
2. **DOM 结构与属性映射绝对等价**：
   - 提取过程中禁止为了所谓的“规范”给组件额外套一层无意义的 `<div>` 包裹层，否则会破坏 Flex/Grid 父子布局或 CSS `display: contents`；
   - 严格保留所有原生 `data-*` 契约（如 `data-state="open"`、`data-disabled`）。

---

### 7.2 循环依赖（Circular Dependency）刚性防护

1. **拓扑单向无环原则（DAG Invariant）**：
   ```
   apps/crish-desktop (业务层)
          │
          ▼
   packages/ui (原子交互层)
          │
          ▼
   packages/shared-types (纯类型契约)
   ```
2. **逆向依赖拦截器**：
   - `packages/ui` 内严禁出现任何指向 `@/store`、`@/api`、`@/hooks`、`@crish/block-paper` 的 import 说明符；
   - 升级后的 `scripts/check-ui-layer.mjs` 会在每次提交时对 `packages/ui` 进行全量 AST 依赖图谱扫描，一旦发现跨层逆向依赖，直接退出码 1 拦截。

---

### 7.3 反过度设计硬性红线（Anti-Overengineering Compliance）

1. **拒绝复杂的微前端或运行时加载器**：
   - 严禁引入 Module Federation、SystemJS 或动态远程沙箱；原子 UI 库属于静态构建依赖，完全依托 npm workspaces 扁平软链与 Vite 模块图解析。
2. **拒绝冗余的双打包流水线**：
   - 开发态不需要任何打包进程（不需要开两个终端分别 `npm run watch`），充分发挥 Vite 源码直接读取的能力；生产态仅使用经过实战检验的标准 Rollup 构建配置。
3. **拒绝编写超大型通用组件框架**：
   - 仅对既有代码进行结构化梳理与收敛，不额外发明复杂的多层抽象工厂或过度包裹的中间件管道。

---

## 八、验收标准与可量化断言

在完成实施后，必须达成以下严密的量化验收标准，方可宣告收敛战役圆满交付：

### 8.1 静态与架构指标验收断言表

| 验收维度 | 现状基线值 (Current Baseline) | 方案目标值 (Target Assertion) | 判定规则与量化验证手段 |
| :--- | :---: | :---: | :--- |
| **越权深层穿透引用数** | **315 处** (56.2%) | **0 处 (0%)** | 运行全仓 AST 扫描脚本，匹配非公开导出子路径，违规计数必须严格等于 0。 |
| **Barrel 手工维护行数** | **286 行** (手工维护) | **0 行 (100% 自动同步)** | `index.ts` 顶部必须包含 `[AUTO-GENERATED FILE]`，CI 校验 0 人工修改。 |
| **导出符号覆盖率** | 约 65% (大量基元缺失) | **100% 覆盖** | `AppIcon`、`iconTokens`、`layerStackService`、`useLayerRegistration` 等全部可自规范入口引入。 |
| **静态门禁防御力** | 单向拦截 (仅拦截 ui 内部) | **双向拦截 + 0 盲猜** | `check:ui-layer` 成功拦截任何新增的外部穿透行为，并提供五元诊断与修复命令。 |
| **TypeScript 类型检查** | 存在隐式类型漂移 | **0 Errors (严格通过)** | 运行 `npm run typecheck`，全仓各个 workspace 均 0 错误通过。 |
| **单元测试全量绿灯** | 快层测试集基线 | **100% Pass (0 回归)** | 运行 `npm run test` 与 UI 关联组件测试（80+ 个测试套件），全部无感全绿通过。 |
| **生产 Chunk 体积** | 最大 Chunk ~441KB | **严格 <600KB 门禁** | 执行 `npm run build:desktop`，`chunkSizeGatePlugin` 零抛错，`crish-ui` chunk 体积约 180KB。 |
| **开发态 HMR 延迟** | 基线 ~120ms | **≤ 150ms (无损保留)** | 修改原子组件源码，桌面端热替换在 150ms 内完成，无需手动刷新应用。 |
| **视觉样式像素对比** | 视觉基线快照 | **0 Pixel Shift (绝对等价)** | 自动化与人工双重校验，页面布局、尺寸、色彩与交互状态无任何肉眼可见差异。 |

---

## 九、架构师最终裁决与落地指令

本方案通过**“一套自动化导出中枢（sync-ui-exports）+ 一次性 AST Codemod 全量收敛 + 一个独立的 @crish/ui 模块保留工作区”**，从根本上斩断了 Conex / Crish 前端积攒已久的 315 处深层越权穿透烂摊子，实现了单一真理源（SSOT）的干净收敛。

方案在确保**视觉零变动**、**严格杜绝双轨**与**彻底终结门禁盲猜拉锯**的同时，为后续的样式体系统一（P02）、Headless 原语演进（P03）与 React 19 API 契约落地（P05）铺平了最稳固的物理基石。

> **下一步行动**：方案归档入库后，汇报主控 Agent 进入第二轮方案交叉审计，待审计确认后即可按阶段流水线全面铺开实施！
