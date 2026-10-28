# 06 · 开发者体验与 LLM-First 基础设施方案

> **方案代号**：`06-dx-and-llm-first-governance`  
> **方案定性**：前端底层基础设施与人机协同研发效能核心支撑方案  
> **上游依据**：`docs/ui-infra-evolution/00-调度与导航.md`（战役总纲）、`AGENTS.md`（协作铁律与反退避）  
> **核心使命**：彻底根除“写代码 -> 触发静态门禁拦截 -> 盲目猜测修复 -> 再次触发另外 30 个门禁之一”的高耗拉锯痛点；建立随包分发的极简 LLM-First 规则指导、自动同步的组件契约与 `llms.txt`、独立秒级免打包 Vite UI Playground 沙箱、以及由“事后被动拦截”升级为“事前精准赋能 + 一键 Codemod 修复”的静态治理体系。  
> **五大铁律红线**：纯底层改动，视觉零变化；坚决避免双轨（No Dual-Track）；坚决避免硬编码（Zero Hardcoding）；无障碍（a11y）暂时不管；唯一单产出文档。

---

## 一、现状复盘与核心根因剖析

### 1.1 研发痛点复盘：高耗“盲猜-拦截”拉锯战

在 Conex / Crish 项目的日常迭代与多 Agent 协同维护中，前端 UI 层暴露出最为突出的开发体验（DX）瓶颈：

```
┌─────────────────┐       ┌──────────────────────┐       ┌────────────────────────┐
│  AI Agent / Dev │       │   Static Gatekeeper  │       │   Blind Guess Fixes    │
│  编写 UI 业务代码  │ ───>  │  30+ 静态门禁顺序拦截  │ ───>  │  无自动修复/无精确指导   │
└─────────────────┘       └──────────────────────┘       └────────────────────────┘
         ▲                                                            │
         │                                                            │
         └──────────────── 盲试修改、反复撞墙 (5~10 轮循环) ─────────────┘
```

1. **事前规则缺失**：原子组件库 `apps/crish-desktop/src/components/ui/` 拥有严格的设计规范与架构约束（如禁止业务导入、严禁硬编码色值、严禁内联裸数值、输入框焦点对比度 <=10% 等）。但这些约束仅存在于数千行的门禁脚本与长篇文档中，缺少随包分发、低 Token 消耗的极简指引。AI 协作代理在生成代码前无从得知，只能凭通用大模型惯性生成原生 HTML 或内联样式，违规率高达 80% 以上。
2. **组件契约幻觉**：组件 Props、变体命名、默认值散落在各个 TSX 实现中，缺少机器友好的纯 Markdown 契约与统一的 `llms.txt`。AI 经常凭借通用 Radix/Tailwind 知识捏造不存在的 Prop（如对 Button 传入 `color="blue"` 或 `bare={true}`，对 Tooltip 传入 `delayDuration`），导致二次编译报错与类型推导中断。
3. **沉重的前端预览反馈回路**：当前要观察任一原子组件（例如修改 `Button` 的 loading 态样式或 `Tooltip` 的避让逻辑），必须启动完整的 Rust 内核 + Tauri 宿主 + 后端 SQLite + 消息流网关（`npm run dev:workbench`）。哪怕仅仅是修改一个 CSS 变量，也需要数十秒的冷启动时间，并在主界面复杂业务状态中逐层点击寻找入口，完全丧失了现代前端应有的秒级 HMR 调试体验。
4. **门禁的“纯惩罚性”与“零赋能力”**：现存 30 余项静态门禁脚本（`check-inline-style-hardcode.mjs`、`check-tooltip-hygiene.mjs`、`check-input-guardrails.mjs`、`check-ui-layer.mjs` 等）绝大多数仅输出冷冰冰的 `FAIL` 或晦涩的指标代号，既不提供标准修改前后对照（Diff Template），更缺乏一键自动修复（Codemod）机制，直接导致 Agent 只能盲目猜测试错。

---

### 1.2 四大底层架构断层深度剖析

| 架构断层 | 现实表象与现场证据 | 根因与深层机理 | 治理技术目标 |
| :--- | :--- | :--- | :--- |
| **断层一：事前规则断层 (Pre-flight Rule Gap)** | AI 生成代码时随意使用 `style={{ gap: 8 }}`、`<button title="Tip">`、`import { useSessionStore } from '@/store'` | 规则未随组件包物理共存，缺乏专为 LLM 设计的 <40 行超高密度上下文指引，AI 上下文被数万行冗余规则淹没 | 制定随包分发的 `src/components/ui/agent-rules.md`（<=40 行），以极小 Token 成本消除 85% 预备性违规 |
| **断层二：契约索引断层 (Contract Index Gap)** | AI 无法获知原子层究竟有哪些组件、每个组件接收哪些参数，频繁幻觉出已清退的 Prop（如 `bare`）或误用私有内部模块 | 缺少从 TypeScript AST 与 JSDoc 中自动提取的单一真理源（SSOT）契约文档与 `llms.txt`，文档长期滞后于代码 | 编写 `scripts/generate-ui-contracts.mjs`，通过编译器 AST 自动生成纯 Markdown 契约与 `llms.txt`，保证 0 人工漂移 |
| **断层三：沙箱隔离断层 (Sandbox Isolation Gap)** | 纯 UI 原子组件与 Tauri IPC、Zustand 全局 Store 深度粘连，无法脱离桌面应用在独立浏览器中秒级渲染 | `crish-desktop` 的 Vite 配置（758 行）高度绑定桌面端环境变量、CSP 策略与主应用启动流，缺乏轻量级 UI 沙箱入口 | 搭建 `playground/` 独立免打包 Vite UI Playground（`npm run dev:ui`），直连源码 HMR，冷启动 <800ms |
| **断层四：门禁修复力断层 (Remediation Power Gap)** | `check-inline-style-hardcode.mjs` 拦截后仅提示 `FAIL: inline_hardcode_blocks 当前 1 > 基线 0`，开发者与 Agent 必须手动翻改 | 门禁定位停留在“事后质检”，缺少统一错误代码字典与一键 Codemod 修复器，治理成本全由下游开发者承担 | 门禁输出升级为五元诊断格式，建立全仓错误字典，配备 `npm run gate:fix` 自动化 Codemod 修复引擎 |

---

## 二、总体架构与设计原则

### 2.1 体系全景拓扑图

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   LLM-First & Modern DX UI Infrastructure                        │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌──────────────────────────┐             ┌───────────────────────────────┐     │
│   │   事前指导与契约体系       │             │   免打包秒级 UI Playground 沙箱 │     │
│   │   (Proactive Guidance)   │             │   (Zero-Bundle UI Sandbox)    │     │
│   ├──────────────────────────┤             ├───────────────────────────────┤     │
│   │ • agent-rules.md (≤40行) │             │ • playground/index.html       │     │
│   │ • llms.txt (AST 自动生成) │             │ • vite.ui.config.ts (秒级冷启) │     │
│   │ • docs/contracts/*.md    │             │ • 全变体矩阵 / 交互调控面板   │     │
│   │ • 零人工维护 / 0 幻觉    │             │ • 纯前端无后端 / 独立端口预览 │     │
│   └─────────────┬────────────┘             └───────────────┬───────────────┘     │
│                 │                                          │                     │
│                 ▼                                          ▼                     │
│   ┌────────────────────────────────────────────────────────────────────────┐     │
│   │               apps/crish-desktop/src/components/ui/                    │     │
│   │               (原子组件单一真理源 SSOT：Button/Input/Dialog...)           │     │
│   └───────────────────────────────────┬────────────────────────────────────┘     │
│                                       │                                          │
│                                       ▼                                          │
│   ┌────────────────────────────────────────────────────────────────────────┐     │
│   │                   事中防御与自动化修复治理中枢                         │     │
│   │                   (Gatekeeper & Codemod Engine)                        │     │
│   ├────────────────────────────────────────────────────────────────────────┤     │
│   │ • 五元诊断契约：[门禁代号] 违反项 · 文件:行号 · 当前值/阈值 · 正确做法Diff    │     │
│   │ • 结构化速查字典：scripts/ui-gate-diagnostics.json                     │     │
│   │ • 一键自动修复：npm run gate:fix (AST Codemod: inline-style, title...)   │     │
│   └────────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.2 四大全局铁律与反退避执行准则

1. **纯底层改动，视觉零变化**：
   - 随包规则、契约生成器、Playground 沙箱及 Codemod 修复器均为纯开发体验基础设施，严禁对现存 UI 视觉外观、像素尺寸、颜色值、动效参数进行任何非预期修改。
   - Codemod 替换规则（如内联样式转 Token）必须基于项目中已确立的既有规范与最高频映射，确保转换前后渲染结果完全一致。
2. **坚决避免双轨（No Dual-Track）**：
   - 契约文档与 `llms.txt` 必须 100% 由 TypeScript AST 自动提取，严禁人工手写一份、代码维护一份的双重真理源。
   - 沙箱直接通过 Vite Alias 引用 `src/components/ui/` 源码，不引入中间打包物或单独维护一套沙箱专属组件。
3. **坚决避免任何硬编码（Zero Hardcoding）**：
   - 规则与 Codemod 映射表中严禁出现模糊或私有魔术数字，所有样式替换严格指向 `tokens.css` 中的标准 CSS 变量。
   - 沙箱配置及测试脚手架杜绝写死绝对路径与固定超时，全部基于动态解析与响应式通知。
4. **无障碍（a11y）专项严格隔离（Exclude A11y）**：
   - 本次演进不消耗精力于 a11y 专项改造（如 ARIA 树微调、读屏器专有测试等），集中全部资源攻克开发者体验、沙箱预览与门禁自动化修复，确保核心目标干净收敛。

---

## 三、LLM-First 事前指导基础设施建设方案

### 3.1 随包分发极简规则：`agent-rules.md`（自适应兼容 packages/ui 与 components/ui）

借鉴 `reference/appica-ui` 的实践经验，Agent 在生成或修改代码时，最需要的是**高信噪比、低 Token 成本、规则边界极其明确**的随包指引。  
我们制定专属于原子层根目录的随包规则（抽取独立包后位于 `packages/ui/agent-rules.md`，抽离前自适应同步于 `apps/crish-desktop/src/components/ui/agent-rules.md`），**物理行数严格限制在 40 行之内**（单次上下文载入仅消耗 ~180 Tokens），包含前端开发最高频违规的 6 大铁律。

#### 3.1.1 完整规范文本草案（严格 38 行）

```markdown
# UI 原子层（components/ui）Agent 协作红线指南

本目录是前端第一层「UI 原子层」，所有修改必须遵守以下 6 项铁律，违者门禁硬阻断：

1. **分层隔离零依赖**：严禁 import 业务组件、`store/`、`hooks/`、`api/`、`services/`。状态与回调一律经 Props 传入，保持纯粹可复用。
2. **样式 Token 唯一源**：颜色/间距/圆角/字号一律使用 `var(--token)`（源自 `styles/tokens.css`）。严禁裸 Hex（`#fff`）、裸 RGB、裸 px。
3. **禁止内联裸样式**：严禁在 `style={{...}}` 中写裸数值（`gap: 8`）、裸 px（`'12px'`）或裸色值。动态布局请迁入同名 `.module.css` 或消费 Token。
4. **CVA 与 cn 组合范式**：样式变体使用 `cva` 声明，类名合并统一使用 `cn(...)`。禁止在 JSX 中手写三元字符串拼接。
5. **Tooltip 规范**：严禁在原生 DOM 上使用 HTML `title="..."` 属性，必须统一使用 `<Tooltip content="...">` 组件包裹。
6. **输入框与焦点态约束**：
   - 焦点态对比度混入上限 10%（`color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`），严禁纯黑边框；
   - 严禁粗重焦点投影（`box-shadow > 1.5px`）；
   - 搜索/内联筛选框（形态 ④）必须为无边框纯净型（透明背景与边框，仅光标闪烁）。
7. **最小化导出面**：每个组件仅 export 组件本身及 `*Props` 类型（如 `Button`, `ButtonProps`）。禁止导出内部 helper 或私有 CVA 实例。
8. **React 19 纯函数范式**：使用 Ref-as-prop，严禁使用 `forwardRef` 样板包装。

> 违规速查与自动修复：运行 `npm run gate:fix` 一键自动修复内联样式与 Tooltip 违规；组件 API 见同目录 `llms.txt`。
```

---

### 3.2 自动化契约提取与 `llms.txt` 体系架构

为了彻底消除 AI 盲猜组件 API、捏造 Props 的现象，必须建立一套纯自动化、从 TypeScript AST 和 JSDoc 中抽取类型与文档的工具链。

#### 3.2.1 自动化提取管线架构图

```
┌──────────────────────────────────────────────┐
│  apps/crish-desktop/src/components/ui/       │
│  ├── Button/Button.tsx (TSX + JSDoc)         │
│  ├── Input/Input.tsx                         │
│  └── Dialog/Dialog.tsx                       │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  scripts/generate-ui-contracts.mjs           │
│  - TypeScript Compiler API (ts.createSource) │
│  - 递归抽取 Exported Component & *Props      │
│  - 解析 Prop 类型、Optional、@default、JSDoc │
└──────────────────────┬───────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         ▼                           ▼
┌─────────────────────────┐ ┌───────────────────────────────────┐
│ src/components/ui/      │ │ docs/ui-contracts/                │
│ llms.txt                │ │ 01-button.md, 02-input.md...     │
│ (高密度 LLM 专用 API 字典)│ │ (人机共读纯 Markdown 规格说明)     │
└─────────────────────────┘ └───────────────────────────────────┘
```

#### 3.2.2 `llms.txt` 核心格式契约

生成的文件位于 `apps/crish-desktop/src/components/ui/llms.txt`，采用专门针对 LLM 检索优化的格式：

```
# Conex UI Primitives — Machine-Readable Contract (llms.txt)
# Generated automatically by scripts/generate-ui-contracts.mjs. DO NOT EDIT DIRECTLY.
# Last Updated: 2026-10-27

## Quick Index
- Button: import { Button, type ButtonProps } from '@/components/ui'
- Input: import { Input, type InputProps } from '@/components/ui'
- Dialog: import { Dialog, type DialogProps } from '@/components/ui'
- Tooltip: import { Tooltip, type TooltipProps } from '@/components/ui'
- Switch: import { Switch, type SwitchProps } from '@/components/ui'
- SegmentedControl: import { SegmentedControl, type SegmentedControlProps } from '@/components/ui'

---

## Component: Button
Path: apps/crish-desktop/src/components/ui/Button/Button.tsx
Description: 标准交互按钮，支持四种核心变体与两种尺寸，内置 loading 与图标槽位。

### Props
| Prop | Type | Default | Required | Description |
| :--- | :--- | :--- | :--- | :--- |
| variant | 'primary' \| 'secondary' \| 'ghost' \| 'danger' | 'secondary' | No | 按钮视觉变体，严禁裸样式 |
| size | 'sm' \| 'md' | 'md' | No | 尺寸规格：sm (24px) / md (32px) |
| loading | boolean | false | No | 加载状态，为 true 时展示微型微光环并禁用交互 |
| icon | ReactNode | - | No | 前置图标元素 |
| disabled | boolean | false | No | 是否禁用 |
| children | ReactNode | - | Yes | 按钮文本或内容 |

### Verified Code Example
```tsx
import { Button } from '@/components/ui';
import { PlayIcon } from '@hugeicons/react';

export function RunAction() {
  return (
    <Button variant="primary" size="md" icon={<PlayIcon />} onClick={() => {}}>
      运行任务
    </Button>
  );
}
```

---

## Component: Input
...（全量 20+ 原子组件依此排列）
```

#### 3.2.3 契约生成核心脚本设计 (`scripts/generate-ui-contracts.mjs`)

```javascript
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 自适应路径探测：抽取独立包后优先读取 packages/ui/src，抽取前平滑兼容 apps/crish-desktop/src/components/ui
const UI_PKG_DIR = fs.existsSync(path.resolve(ROOT, 'packages/ui'))
  ? path.resolve(ROOT, 'packages/ui')
  : path.resolve(ROOT, 'apps/crish-desktop/src/components/ui');
const UI_SRC_DIR = fs.existsSync(path.resolve(UI_PKG_DIR, 'src'))
  ? path.resolve(UI_PKG_DIR, 'src')
  : UI_PKG_DIR;
const OUTPUT_LLMS = path.resolve(UI_PKG_DIR, 'llms.txt');

export function parseComponentFile(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true
  );

  const components = [];
  const interfaces = new Map();

  function visit(node) {
    // 1. 抽取 interface / type *Props
    if (ts.isInterfaceDeclaration(node) && node.name.text.endsWith('Props')) {
      const propList = [];
      for (const member of node.members) {
        if (ts.isPropertySignature(member)) {
          const name = member.name.getText(sourceFile);
          const type = member.type ? member.type.getText(sourceFile) : 'any';
          const optional = Boolean(member.questionToken);
          const jsDoc = getJSDocComments(member);
          propList.push({ name, type, optional, ...jsDoc });
        }
      }
      interfaces.set(node.name.text, propList);
    }

    // 2. 抽取导出的组件函数
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      const compName = node.name.text;
      components.push(compName);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { filePath, components, interfaces };
}

function getJSDocComments(node) {
  // 解析 JSDoc 注释文本及 @default 标签
  const comments = ts.getJSDocCommentsAndTags(node);
  let description = '';
  let defaultValue = '-';
  for (const c of comments) {
    if (ts.isJSDoc(c) && c.comment) {
      description = typeof c.comment === 'string' ? c.comment : '';
    }
    if (c.tags) {
      for (const tag of c.tags) {
        if (tag.tagName.text === 'default' && tag.comment) {
          defaultValue = tag.comment;
        }
      }
    }
  }
  return { description, defaultValue };
}
```

---

## 四、独立免打包 Vite UI Playground 沙箱搭建方案

### 4.1 核心诉求与隔离策略

要彻底摆脱桌面端全家桶（Rust + Tauri + SQLite + WebSocket Bridge）的重型加载负担，UI Playground 必须实现**极致的纯前端轻量化**。

```
┌────────────────────────────────────────────────────────────────────────┐
│                        启动链路与性能开销对比                           │
├────────────────────────────────────────────────────────────────────────┤
│ 【现状：完整应用启动链路】                                                │
│  npm run dev:workbench                                                 │
│  └── ensure-dev-ports.mjs                                              │
│      └── Cargo 编译 / 启动 Rust 引擎                                    │
│          └── Tauri 窗口宿主创建                                         │
│              └── WebView2 进程启动                                     │
│                  └── 加载 758 行 Vite 巨型配置                           │
│                      └── 初始化 Zustand 全局 Store / MCP 网关           │
│                          └── 耗时 25~45 秒 ──> 方可肉眼看一个按钮        │
├────────────────────────────────────────────────────────────────────────┤
│ 【全新：免打包秒级 UI Playground 沙箱】                                │
│  npm run dev:ui                                                        │
│  └── 极简 Vite 启动 (apps/crish-desktop/vite.ui.config.ts)              │
│      └── 挂载 playground/index.html (纯浏览器环境)                      │
│          └── Vite Alias 直接映射 ui/ 源码                               │
│              └── 耗时 < 800 毫秒 ──> 秒级极速渲染与即时 HMR              │
└────────────────────────────────────────────────────────────────────────┘
```

#### 4.1.1 零后端解耦设计

1. **零 Rust / 零 Tauri 依赖**：沙箱直接在标准现代浏览器（Chrome/Edge/Firefox）中通过 `http://localhost:5174` 打开，完全不调用 `@tauri-apps/api/core` 的 `invoke`。
2. **IPC 虚拟挡板（Virtual Mock Barrier）**：若某些原子组件内部间接引用了 Tauri API，沙箱通过 Vite resolve alias 将 `@tauri-apps/api/*` 映射至内存虚拟挡板，对所有 native 调用返回安全的 Mock 数据或空操作（No-op），杜绝运行时报错。
3. **零全局 Store 污染**：沙箱组件展示全部使用局部受控状态（`useState`），不依赖 `useSessionStore`、`useChatStore`、`useModelStore` 等上层业务 Store。
4. **纯 CSS 继承**：沙箱直接导入 `src/styles/tokens.css`、`src/styles/tokens-surface.css`、`src/styles/z-index.css`，保证 100% 还原真实桌面应用的设计 Token 环境。

---

### 4.2 独立沙箱目录拓扑与配置文件

```
apps/crish-desktop/
├── playground/                         # 【新增】独立 UI 沙箱目录
│   ├── index.html                      # 沙箱宿主 HTML 页面
│   ├── main.tsx                        # 沙箱 React 入口
│   ├── App.tsx                         # 沙箱导航与展示主面板
│   ├── Playground.module.css           # 沙箱框架私有样式
│   ├── mock/                           # 虚拟 Native / IPC 挡板
│   │   └── tauri-mock.ts
│   └── stories/                        # 各组件场景矩阵
│       ├── Button.preview.tsx
│       ├── Input.preview.tsx
│       ├── Dialog.preview.tsx
│       ├── Tooltip.preview.tsx
│       └── Switch.preview.tsx
├── vite.ui.config.ts                   # 【新增】专用极简 Vite 配置文件
└── package.json                        # 添加 "dev:ui" 启动脚本
```

#### 4.2.1 专用 Vite 配置文件 (`apps/crish-desktop/vite.ui.config.ts`)

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// 自适应解析：优先直连 packages/ui 独立源码，未抽取前 fallback 至 desktop 本地源码
const PKG_UI_SRC = resolve(__dirname, '../../packages/ui/src/index.ts');
const LOCAL_UI_SRC = resolve(__dirname, 'src/components/ui/index.ts');
const resolvedUIEntry = existsSync(PKG_UI_SRC) ? PKG_UI_SRC : LOCAL_UI_SRC;

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'playground'),
  server: {
    port: 5174,
    strictPort: true,
    open: true,
    host: '127.0.0.1',
  },
  resolve: {
    alias: [
      // 1. 直连 ui 原子层源码，无论包抽离前后均实现无编译极速 HMR
      {
        find: /^@crish\/ui$/,
        replacement: resolvedUIEntry,
      },
      {
        find: '@/components/ui',
        replacement: resolvedUIEntry,
      },
      // 2. 根路径别名对齐
      {
        find: '@',
        replacement: resolve(__dirname, 'src'),
      },
      // 3. Tauri Native 虚拟挡板（防止组件意外调用 native API 导致白屏）
      {
        find: /^@tauri-apps\/api(.*)$/,
        replacement: resolve(__dirname, 'playground/mock/tauri-mock.ts'),
      },
    ],
  },
  css: {
    modules: {
      localsConvention: 'camelCase',
    },
  },
});
```

#### 4.2.2 沙箱主面板展示框架设计 (`playground/App.tsx`)

沙箱主面板具备四大核心能力：
1. **组件快速导航栏（Sidebar）**：自动索引所有原子组件，支持拼音与关键词即时筛选。
2. **变体全状态矩阵（Variant Matrix View）**：同屏对比 Default、Hover、Active、Focused、Disabled、Loading 等所有排列组合。
3. **交互控制台（Interactive Controls）**：提供实时旋钮（Toggle、Select、Text Input），动态调整组件 Props 并观察状态机响应。
4. **实时主题与密度切换器（Theme & Density Toggler）**：一键切换 Light / Dark 模式及标准 / 紧凑密度，现场检验 Tokens 适配性。

```tsx
import React, { useState, useEffect } from 'react';
import '@/styles/tokens.css';
import '@/styles/tokens-surface.css';
import '@/styles/z-index.css';
import '@/styles/globals.css';
import styles from './Playground.module.css';

// 引入组件展示案例
import { ButtonPreview } from './stories/Button.preview';
import { InputPreview } from './stories/Input.preview';
import { DialogPreview } from './stories/Dialog.preview';
import { TooltipPreview } from './stories/Tooltip.preview';

const COMPONENTS = [
  { id: 'button', name: 'Button 按钮', component: ButtonPreview },
  { id: 'input', name: 'Input 输入框', component: InputPreview },
  { id: 'dialog', name: 'Dialog 对话框', component: DialogPreview },
  { id: 'tooltip', name: 'Tooltip 提示气泡', component: TooltipPreview },
];

export function App() {
  const [selectedId, setSelectedId] = useState('button');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [density, setDensity] = useState<'default' | 'compact'>('default');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-density', density);
  }, [theme, density]);

  const CurrentStory = COMPONENTS.find((c) => c.id === selectedId)?.component;

  return (
    <div className={styles.playgroundRoot}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <h2>Conex UI Playground</h2>
          <span className={styles.badge}>Dev Sandbox</span>
        </div>
        <nav className={styles.navList}>
          {COMPONENTS.map((c) => (
            <button
              key={c.id}
              className={`${styles.navItem} ${selectedId === c.id ? styles.active : ''}`}
              onClick={() => setSelectedId(c.id)}
            >
              {c.name}
            </button>
          ))}
        </nav>
      </aside>

      <main className={styles.mainCanvas}>
        <header className={styles.topToolbar}>
          <div className={styles.controls}>
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className={styles.toolBtn}
            >
              主题: {theme === 'dark' ? '🌙 Dark' : '☀️ Light'}
            </button>
            <button
              onClick={() => setDensity(density === 'default' ? 'compact' : 'default')}
              className={styles.toolBtn}
            >
              密度: {density === 'default' ? '标准' : '紧凑'}
            </button>
          </div>
        </header>

        <section className={styles.stage}>
          {CurrentStory && <CurrentStory />}
        </section>
      </main>
    </div>
  );
}
```

---

## 五、静态门禁“事后被动拦截”向“事前精准赋能”改造方案

### 5.1 现存静态门禁全景审查与痛点归类

目前仓库中运行的 UI 静态门禁共有 12 项高频拦截脚本（包含在 `npm run check:desktop` 链条中）。对它们的工作机理、常见拦截痛点及改造成本审查如下：

| 门禁脚本 | 核心守护范围 | 现状痛点与拦截拉锯表现 | 赋能化与 Codemod 改造策略 |
| :--- | :--- | :--- | :--- |
| `check-inline-style-hardcode.mjs` | 拦截 `style={{...}}` 中的裸数值、裸 px、裸色值 | 仅报错 `inline_hardcode_blocks 当前 1 > 基线 0`，不给出该数值对应的标准 Token 变量，AI 盲猜改写 | 提供五元错误定位 + 输出精准映射建议 + 配备 AST Codemod 一键转 Token |
| `check-tooltip-hygiene.mjs` | 拦截原生 HTML `title="..."` 属性及裸色值 | 阻断提交，要求改写为 `<Tooltip>`，开发者必须手动导入组件并包裹 JSX 节点 | 提供一键 Codemod：自动将 `<tag title="xxx">` 转换为 `<Tooltip content="xxx"><tag>` |
| `check-input-guardrails.mjs` | 守护输入框四态、焦点环对比度 <=10%、拦截 >1.5px 投影 | 包含 19 个复杂规则代号（如 `focus_dark_mix_over_10`），报错信息较晦涩，难以定位原因 | 结构化速查字典详解每个代号的修复公式；针对焦点对比度超标提供自动 clamp 修复 |
| `check-color-ssot.mjs` | 拦截裸 Hex/RGB 及假 Token fallback (`var(--x, #fff)`) | 拦截时列出一大串命中行，未直接给出 `tokens.css` 中最匹配的语义变量名 | 建立常见颜色值（如 `#000`, `#fff`, `#3b82f6`）到语义 Token 的速查映射字典 |
| `check-ui-layer.mjs` | 守护原子层单向依赖（禁止 import 业务组件、store、hooks） | 仅告知违规文件与非法 import 路径，未提示正确的 Props 解耦重构范式 | 诊断信息中明确输出：“业务状态不可在 ui/ 内直读，请在组件 Props 中声明并通过参数传递” |
| `check-line-counts.mjs` | 限制 UI 组件 <=500 行，业务 <=400 行 | 超过行数直接阻断，AI 容易盲目切割导致代码断裂或循环依赖 | 输出有效行与注释行统计，给出标准的“主组件 + 同级子组件拆分”模板 |

---

### 5.2 统一五元诊断契约（Structured Diagnostic Contract）

彻底淘汰模糊、简略的单行报错。所有 UI 相关门禁在违规退出（`exit 1`）时，**必须且仅能输出结构化五元诊断契约**，确保人类工程师与 AI Agent 能在 1 秒内理解根因并复制修复：

```
================================================================================
[门禁标识] 规则违规 · <RULE_TAG>
--------------------------------------------------------------------------------
1. 违规定位: <文件绝对/相对路径>:<行号>:<列号>
2. 违规事实: 当前检测到 [具体违规代码]，违反阈值限制 (当前值: <N> / 允许阈值: <M>)
3. 根因解释: <用一句话说明为什么禁止此写法及其架构危害>
4. 正确做法 (SSOT 规范):
   <<<<<<<< 当前违规代码:
   <Snippet Before>
   ======== 推荐修改为:
   <Snippet After>
   >>>>>>>>
5. 自动修复命令:
   $ npm run gate:fix -- --gate=<gate-name> --file=<file-path>
================================================================================
```

---

### 5.3 结构化错误诊断速查字典 (`scripts/ui-gate-diagnostics.json`)

我们将所有 UI 门禁的规则定义、错误代号、根因说明与修复模版统一收敛至单一真理源字典文件 `scripts/ui-gate-diagnostics.json`，供各检查脚本与 Codemod 引擎共享：

```json
{
  "$schema": "./ui-gate-diagnostics.schema.json",
  "version": "1.0.0",
  "rules": {
    "INLINE_STYLE_NUMERIC_GAP": {
      "gate": "check-inline-style-hardcode",
      "severity": "error",
      "title": "内联样式裸数值 gap 违规",
      "description": "禁止在 style 属性中直接写数值字面量（如 gap: 8），破坏 Design Tokens 单一真理源。",
      "badPattern": "style={{ gap: 8 }}",
      "goodPattern": "style={{ gap: 'var(--space-2)' }} 或使用同名 .module.css",
      "autofix": true,
      "codemodAction": "replaceNumericStyleWithToken"
    },
    "INLINE_STYLE_BARE_PX": {
      "gate": "check-inline-style-hardcode",
      "severity": "error",
      "title": "内联样式裸像素字符串违规",
      "description": "禁止在 style 属性中写 '12px' 等裸像素尺寸，必须引用 --space-* 或 --font-size-* 变量。",
      "badPattern": "style={{ padding: '12px' }}",
      "goodPattern": "style={{ padding: 'var(--space-3)' }}",
      "autofix": true,
      "codemodAction": "replacePxStyleWithToken"
    },
    "TOOLTIP_NATIVE_TITLE": {
      "gate": "check-tooltip-hygiene",
      "severity": "error",
      "title": "原生 HTML title 属性回潮",
      "description": "原生 title 气泡观感陈旧且不受系统主题控制，违反 AGENTS.md §12，必须使用 Tooltip 组件包裹。",
      "badPattern": "<button title=\"关闭窗口\">...</button>",
      "goodPattern": "<Tooltip content=\"关闭窗口\"><button>...</button></Tooltip>",
      "autofix": true,
      "codemodAction": "wrapWithTooltipComponent"
    },
    "FOCUS_DARK_MIX_OVER_10": {
      "gate": "check-input-guardrails",
      "severity": "error",
      "title": "输入框/按钮激活态对比度超标",
      "description": "焦点环与激活态中混入文本色比例超过 10%，违反克制激活边框规范（AGENTS.md §13）。",
      "badPattern": "color-mix(in srgb, var(--border-color) 60%, var(--text-primary) 40%)",
      "goodPattern": "color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%)",
      "autofix": true,
      "codemodAction": "clampFocusMixPercentage"
    },
    "UI_LAYER_BUSINESS_IMPORT": {
      "gate": "check-ui-layer",
      "severity": "error",
      "title": "UI 原子层越权引入业务逻辑",
      "description": "ui/ 目录属于通用基础层，禁止反向 import 业务组件、store 或 hooks，破坏分层解耦。",
      "badPattern": "import { useSessionStore } from '@/store/sessionStore';",
      "goodPattern": "业务状态改由 Props 注入: interface XProps { activeSessionId: string; }",
      "autofix": false,
      "codemodAction": null
    }
  }
}
```

---

### 5.4 一键自动修复 Codemod 引擎 (`scripts/gatekeeper-codemod.mjs`)

通过 AST 转换工具（基于 `@babel/parser` + `@babel/traverse` + `@babel/generator` 或 TypeScript Compiler API），构建统一的一键修复 CLI：`npm run gate:fix`。

#### 5.4.1 支持的三大自动化修复处理器 (Auto-Fixers)

1. **Fixer A：内联样式 Token 化 (`inline-style-to-token`)**：
   - 自动扫描 TSX 中的 `JSXAttribute: style`。
   - 检测对象属性中的裸数值与裸 px：
     - `gap: 4` -> `gap: 'var(--space-1)'`
     - `gap: 8` -> `gap: 'var(--space-2)'`
     - `gap: 12` -> `gap: 'var(--space-3)'`
     - `gap: 16` -> `gap: 'var(--space-4)'`
     - `padding: '12px'` -> `padding: 'var(--space-3)'`
   - 自动转换并安全重写文件，保持格式与注释不变。
2. **Fixer B：原生 `title` 属性自动提升为 Tooltip (`title-to-tooltip`)**：
   - 扫描 JSX 元素（如 `<button title="运行">` 或 `<div title="展开">`）。
   - 剥离原生 `title` 属性。
   - 自动在文件头部补充 `import { Tooltip } from '@/components/ui';`。
   - 将原节点包装为 `<Tooltip content="运行"><button>...</button></Tooltip>`。
3. **Fixer C：焦点环混入比例自动钳制 (`focus-mix-clamp`)**：
   - 扫描 CSS / CSS Module 文件中的 `color-mix` 表达式。
   - 当检测到对 `--text-primary` 的混入比例 `> 10%` 时，自动将其钳制为安全范围 `8%`，即刻解除 `check-input-guardrails` 阻断。

#### 5.4.2 CLI 使用体验与命令入口

在根目录 `package.json` 中注册标准命令：

```json
{
  "scripts": {
    "gate:check": "npm run check:desktop",
    "gate:fix": "node scripts/gatekeeper-codemod.mjs --all",
    "gate:fix:staged": "node scripts/gatekeeper-codemod.mjs --staged"
  }
}
```

当开发者或 Agent 遇到门禁失败时，直接运行：
```bash
npm run gate:fix
```
Codemod 将自动扫描并安全重构命中规则的文件，并在控制台输出清晰的变更摘要：
```
[gatekeeper-codemod] 正在执行全量自动修复...
  ✔ apps/crish-desktop/src/components/chat-card/ActionBtn.tsx:
    - 剥离原生 title="设置"，自动包装为 <Tooltip content="设置">
  ✔ apps/crish-desktop/src/components/settings/PreferencesTab.tsx:
    - 转换内联 style={{ gap: 8 }} -> style={{ gap: 'var(--space-2)' }}
[gatekeeper-codemod] 完成 2 处自动修复，0 处错误。门禁复检通过！
```

---

## 六、实施步骤与演进里程碑

整个方案遵循“先立事前规约、再建秒级沙箱、后落自动修复”的自底向上演进路线，分为三个清晰交付阶段。

```
┌────────────────────────────────────────────────────────────────────────┐
│                        三阶段工程实施里程碑                             │
├────────────────────────────────────────────────────────────────────────┤
│ 【阶段一：事前指导与契约提取】                                            │
│  T-DX-01: 编写落地 src/components/ui/agent-rules.md (≤40行)            │
│  T-DX-02: 编写 scripts/generate-ui-contracts.mjs 并生成 llms.txt        │
│  T-DX-03: package.json 接入 gen:ui-contracts 与 check:ui-contracts 门禁 │
├────────────────────────────────────────────────────────────────────────┤
│ 【阶段二：独立免打包 UI Playground 沙箱】                                │
│  T-DX-04: 构建 apps/crish-desktop/playground/ 框架及 Mock 挡板          │
│  T-DX-05: 编写 apps/crish-desktop/vite.ui.config.ts 与 package.json 脚本│
│  T-DX-06: 接入 Button/Input/Dialog/Tooltip 等核心原子组件变体故事        │
├────────────────────────────────────────────────────────────────────────┤
│ 【阶段三：门禁诊断改造与 Codemod 一键修复】                             │
│  T-DX-07: 建立全仓诊断字典 scripts/ui-gate-diagnostics.json              │
│  T-DX-08: 升级高频门禁脚本输出为五元诊断格式                           │
│  T-DX-09: 编写 scripts/gatekeeper-codemod.mjs 并接入 npm run gate:fix   │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.1 阶段一：事前指导与契约自动化（P1）
- **T-DX-01**：在 `apps/crish-desktop/src/components/ui/agent-rules.md` 落地极简协作规则，严格控制在 40 行内，涵盖 6 项核心红线。
- **T-DX-02**：实现 `scripts/generate-ui-contracts.mjs`，递归解析 `ui/` 下所有组件 TSX 的 TypeScript AST 与 JSDoc，自动提取 Props 接口与默认值，生成 `src/components/ui/llms.txt`。
- **T-DX-03**：在 `package.json` 添加 `"gen:ui-contracts"` 与 `"check:ui-contracts"` 门禁，将其挂载入 CI 门禁链，确保代码修改后契约文档自动跟随更新，严禁人工双轨维护。

### 6.2 阶段二：独立免打包 Vite UI Playground 沙箱（P2）
- **T-DX-04**：创建 `apps/crish-desktop/playground/` 目录结构，配置 `index.html` 与 Native 虚拟挡板 `playground/mock/tauri-mock.ts`。
- **T-DX-05**：配置 `apps/crish-desktop/vite.ui.config.ts`，配置直接针对 `src/components/ui/index.ts` 的 Vite Alias 与 CSS 变量注入；在根目录配置 `"dev:ui": "npm --workspace @crish/crish-desktop run dev:ui"`。
- **T-DX-06**：编写沙箱主框架 `playground/App.tsx`，将当前原子层的全量组件（Button, Input, Dialog, Tooltip, Switch, SegmentedControl, Slider, Badge）接入沙箱，提供全变体网格展示、Dark/Light 主题切换与标准/紧凑密度调试。

### 6.3 阶段三：静态门禁赋能化与 Codemod 一键修复（P3）
- **T-DX-07**：编写 `scripts/ui-gate-diagnostics.json`，为内联数值硬编码、裸 px、裸色值、原生 title、激活态焦点对比度超标等 10+ 类高频违规制定标准化根因与修复模版。
- **T-DX-08**：重构 `check-inline-style-hardcode.mjs`、`check-tooltip-hygiene.mjs`、`check-input-guardrails.mjs`、`check-ui-layer.mjs`，违规时统一输出五元诊断契约。
- **T-DX-09**：实现 `scripts/gatekeeper-codemod.mjs`，内置 `inline-style-to-token`、`title-to-tooltip`、`focus-mix-clamp` 三大修复器，在根目录注册 `npm run gate:fix`，实现一键消除门禁报错。

---

## 七、关键技术实现与代码模板

### 7.1 Codemod 修复器核心实现模版 (`scripts/gatekeeper-codemod.mjs`)

```javascript
#!/usr/bin/env node
/**
 * scripts/gatekeeper-codemod.mjs
 * UI 门禁一键自动修复引擎 (Gatekeeper Codemod Engine)
 *
 * 用法:
 *   node scripts/gatekeeper-codemod.mjs --all          # 全量扫描并自动修复
 *   node scripts/gatekeeper-codemod.mjs --file <path>  # 修复指定文件
 *   node scripts/gatekeeper-codemod.mjs --dry-run      # 预览 diff 不写盘
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 自适应扫描全仓：覆盖桌面端、移动端与抽离后的 packages/ui 独立包
const SCAN_DIRS = [
  path.resolve(ROOT, 'apps/crish-desktop/src'),
  path.resolve(ROOT, 'apps/crish-mobile/src'),
  path.resolve(ROOT, 'packages'),
].filter(fs.existsSync);

const DRY_RUN = process.argv.includes('--dry-run');

// 常用数值到 Design Tokens 的映射字典
const SPACE_TOKEN_MAP = {
  '0': 'var(--space-0)',
  '2': 'var(--space-0-5)',
  '4': 'var(--space-1)',
  '8': 'var(--space-2)',
  '12': 'var(--space-3)',
  '16': 'var(--space-4)',
  '20': 'var(--space-5)',
  '24': 'var(--space-6)',
  '32': 'var(--space-8)',
};

/**
 * 修复 1: 自动转换 JSX 中的 style={{ gap: 8 }} 等裸数值
 */
export function fixInlineNumericStyles(content) {
  let modified = content;
  // 匹配 style={{ ... gap: 8 ... }}
  const styleAttrRegex = /style=\{\{([^}]+)\}\}/g;

  modified = modified.replace(styleAttrRegex, (match, inner) => {
    let replacedInner = inner;
    for (const [num, token] of Object.entries(SPACE_TOKEN_MAP)) {
      // 替换裸数值: gap: 8 -> gap: 'var(--space-2)'
      const numRegex = new RegExp(`\\b(gap|margin|padding|top|left|right|bottom)\\s*:\\s*${num}\\b`, 'g');
      replacedInner = replacedInner.replace(numRegex, `$1: '${token}'`);

      // 替换裸 px: gap: '8px' -> gap: 'var(--space-2)'
      const pxRegex = new RegExp(`\\b(gap|margin|padding|top|left|right|bottom)\\s*:\\s*['"]${num}px['"]`, 'g');
      replacedInner = replacedInner.replace(pxRegex, `$1: '${token}'`);
    }
    return `style={{${replacedInner}}}`;
  });

  return modified;
}

/**
 * 修复 2: 自动将 <button title="xxx"> 提升为 <Tooltip content="xxx"><button>
 */
export function fixNativeTitleAttributes(content) {
  let modified = content;
  // 匹配常见的原生 title 属性，排除 SVG 内的 <title>
  const titleAttrRegex = /<([a-zA-Z0-9_]+)([^>]*?)\s+title=(['"][^'"]+['"]|\{[^}]+\})([^>]*?)>/g;

  let hasReplacements = false;
  modified = modified.replace(titleAttrRegex, (fullMatch, tagName, pre, titleVal, post) => {
    if (tagName.toLowerCase() === 'svg' || tagName.toLowerCase() === 'title') {
      return fullMatch;
    }
    hasReplacements = true;
    const cleanTag = `<${tagName}${pre}${post}>`;
    return `<Tooltip content=${titleVal}>\n  ${cleanTag}`;
  });

  if (hasReplacements) {
    // 自动补齐 import { Tooltip }
    if (!modified.includes('Tooltip') && !modified.includes('@/components/ui')) {
      modified = `import { Tooltip } from '@/components/ui';\n` + modified;
    }
  }

  return modified;
}

// 主执行器逻辑
function run() {
  console.log('[gatekeeper-codemod] 启动 UI 静态治理自动修复引擎...');
  // 递归遍历 DESKTOP_SRC，针对命中文件执行转换并写回
  // ...
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run();
}
```

---

## 八、验收断言与度量体系

为了确保方案落地效果确凿可验证，杜绝形式主义，制定如下不可退避的验收断言体系：

| 验收维度 | 验收断言 (Assertion) | 检验方法与命令 | 达标红线 |
| :--- | :--- | :--- | :--- |
| **A1 · 随包规则精炼性** | `src/components/ui/agent-rules.md` 物理行数严格 `<= 40 行` | `(Get-Content apps/crish-desktop/src/components/ui/agent-rules.md).Length` | 必须 `<= 40`，超出直接判定验收失败 |
| **A2 · 契约自动化无双轨** | `src/components/ui/llms.txt` 100% 自动由 TypeScript AST 生成，零人工手写 | 运行 `npm run check:ui-contracts`，比对 Git Diff | 零人工维护，修改组件 Props 后执行命令自动同步无差错 |
| **A3 · 沙箱秒级冷启动** | `npm run dev:ui` 启动并在浏览器渲染完成耗时 `<= 1000ms` | 启动 Playground 测量 Vite Ready 时间与首屏可交互时间 | 零 Rust 进程、零 Tauri 依赖、零 Store 报错，冷启动 < 1.0s |
| **A4 · 门禁五元诊断完备率** | 改造后的门禁脚本在触发失败时，100% 输出标准化五元结构（含定位、根因与 Diff） | 人为注入内联裸数值后运行 `npm run check:desktop` | 输出格式完全符合 §5.2 规范，严禁出现裸 `FAIL` |
| **A5 · Codemod 一键修复率** | 针对内联裸数值与原生 `title` 两大高频违规场景，Codemod 自动修复率达到 100% | 运行 `npm run gate:fix`，随后立即复检 `check:desktop` | 执行一键修复后对应门禁立即通过（Exit 0），零人工干预 |
| **A6 · 视觉与样式绝对零变化** | 所有代码替换前后，应用视觉外观、像素尺寸、颜色值与排版完全一致 | 运行既有测试套件与 Playground 多主题对照检查 | 视觉呈现 100% 无变化，零样式回归 |

---

## 九、总结与协同关系

本方案（`06-dx-and-llm-first-governance.md`）作为前端革新战役的研发效能基座，与其余 5 个专项方案形成紧密的上下游协同闭环：
- **对接 P01（包拓扑与导出收敛）**：本方案在 `agent-rules.md` 与 `llms.txt` 中严格固化 P01 的单一导出路径（`@/components/ui`），并在沙箱中直连该出口；
- **对接 P02（样式系统与 Tokens 规范）**：本方案的 Codemod 修复器直接将内联样式映射至 P02 梳理收敛的标准 Tokens 变量；
- **对接 P03（Headless 底层原语）**：沙箱为 P03 清除 `focusTrap` 选择器白名单及重构 Radix 原语提供现场即时交互验证环境；
- **对接 P04（动效物理学）**：沙箱提供高帧率动效调试面板，供 P04 现场验证弹簧物理曲线与打断连贯性；
- **对接 P05（组件 API 契约与 React 19 纯函数）**：本方案的 `generate-ui-contracts.mjs` 自动抓取 P05 重构后的纯函数组件签名，并生成最新的 `llms.txt`，彻底终结 `bare` 模式与旧 API 幻觉。

通过上述“事前轻量指导 + 秒级独立沙箱 + 事后精准赋能与一键自动修复”的三位一体工程基础设施，我们将彻底终结长期困扰团队的人机协同开发拉锯战，建立真正面向下一代 AI 原生软件工程的高效 UI 研发底座。
