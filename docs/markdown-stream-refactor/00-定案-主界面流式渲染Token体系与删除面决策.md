# 战役定案：主界面流式渲染 Design Tokens 体系与删除面决策

> **依据规范**：[`docs/agent-roles/prompts/主控-全流程调度-v3.md`](file:///c:/Software/conex/docs/agent-roles/prompts/%E4%B8%BB%E6%8E%A7-%E5%85%A8%E6%B5%81%E7%A8%8B%E8%B0%83%E5%BA%A6-v3.md) §一.5  
> **审查依据**：06~10 5 份严苛审查报告与 15~17 3 份独立提案交叉验证结论。  
> **核心原则**：推进单位是「领域概念」，一个概念唯一主路径；收敛先于增强，先删后改，零死层、零幽灵变量、零硬编码裸写。

---

## 一、五大核心 Token 领域概念与主路径确立

经过 3 份独立提案的深度交叉比对，正式拍板确定 Conex 主界面流式渲染的 5 大 Design Token 领域维度：

### 1. 维度一：Markdown 正文排版与语法高亮 Token 体系 (`--md-*`, `--syntax-*`)
- **核心概念**：系统化正文排版阶梯与 syntect / hljs 语法高亮调色盘接线。
- **唯一主路径**：
  - H1~H6 建立完整的 Typography Scale 阶梯字号（`1.5em` ~ `0.9em`）与段落垂直韵律（`--md-text-paragraph-gap: 0.85em`）；
  - 行内代码胶囊（`.md-inline-code`）、路径链接按钮（`.md-path-link`）、任务复选框（`.md-task-item`）与代码块语言面包屑规范化；
  - 激活 `tokens.css` 中 20 组 100% 闲置的 `--syntax-*` Token，绑定至代码高亮选择器。
- **删除面（DEL）**：
  - 彻底删除 H1~H6 14px 正文字号扁平化退化；
  - 彻底删除路径链接退化为 Windows 原生立体灰按钮的裸奔状态；
  - 移除 `.md-code-copy` 中未定义的 `--status-success` 幽灵变量。

---

### 2. 维度二：流式表格与视口动效 Token 体系 (`--md-table-*`, `--stream-table-*`)
- **核心概念**：GFM 表格双主题排版规范、Sticky 吸顶表头与翡翠绿流式脉冲。
- **唯一主路径**：
  - 建立 `--md-table-*` 命名空间（边框、吸顶表头毛玻璃底色、斑马纹、行悬停色、发丝线 `--hairline`）；
  - 建立 `--stream-table-active-*` 品牌翡翠绿呼吸脉冲外框与轻光晕；
  - 接入 `scrollbar-width: thin` 与 `--tint-scrollbar-thumb` 极简滚动条。
- **删除面（DEL）**：
  - 彻底删除 `StreamingTableContainer.module.css` 与 `ChatMessageRow.module.css` 中的双源表格定义漂移；
  - 彻底删除 `hsl(215 90% 52%)` 违规电光蓝与暗色纯白反白描边；
  - 物理清除 `td:last-child[data-streaming='true']` 无法命中的死选择器。

---

### 3. 维度三：自定义 HTML 富交互组件与 Artifacts Token 体系 (`--artifact-*`, `--diff-*`, `--filetree-*`, `--aicard-*`)
- **核心概念**：`<widget-diff>`、`<file-tree>`、`<ai-card>` 及 `CustomTagPortal` 独立组件级 Design Tokens 体系。
- **唯一主路径**：
  - 建立 Diff 代码比对双主题 Tokens（新增森林绿、删除赤褐红），**将浅色模式对比度由 1.34:1 提升至 ≥5.24:1（100% 达标 WCAG AA）**；
  - 建立文件树 A/M/D 状态徽标与节点激活 Token；
  - 建立 AI 步骤卡片生命周期状态色阶（运行态翡翠绿呼吸、完成态克制中性墨阶）；
  - 悬浮边框严格遵循 AGENTS.md §13（焦点加深 ≤10%，杜绝粗深黑边）。
- **删除面（DEL）**：
  - 彻底物理清剿 `custom-tags.module.css` 中的 46 处裸写 HSL/Hex 与暗黑偏置 Fallback；
  - 物理删除非法 CSS 属性 `divide-x`；
  - 修复 TSX 中求值为 `undefined` 的未定义类名（`fileTreeItem`, `fileTreeChildren`）；
  - 清理孤立类 `.portalOverlay` 与 `.portalContent`。

---

### 4. 维度四：思考链折叠、时间线与状态横幅 Token 体系 (`--thought-*`, `--banner-*`, `--timeline-*`)
- **核心概念**：极简思考链折叠、流式呼吸微光、数字防抖与全局错误横幅规范。
- **唯一主路径**：
  - 新建独立物理样式文件 `TimelineThoughtSection.module.css`，将 `ChatMessageRow.module.css` 瘦身 230+ 行；
  - 建立 `--thought-*` 命名空间（折叠头底色、左侧指示条、展开体底色、耗时徽章、`tabular-nums` 消除数字跳动）；
  - 建立 `--banner-error-*` 命名空间，`ErrorMessageBanner` 彻底 Class 模块化。
- **删除面（DEL）**：
  - 彻底清剿 `MessageContent.tsx` 中 `ErrorMessageBanner` 的 8 处内联 `style={{...}}` 魔法数字；
  - 彻底拔除未定义的 `--bg-error-subtle` 假变量及 10 余个幽灵 `--flow-*` 变量；
  - 彻底删除暗色模式下对比度仅 1.76:1 的不可读文字 fallback `#4a4a4a` 与白雾渐变遮罩。

---

### 5. 维度五：流式动效、打字光标与性能分档 Token 体系 (`--stream-*`, `data-perf-tier`)
- **核心概念**：单源打字机光标、Chromium Compositor GPU 硬件加速与性能档位自适应。
- **唯一主路径**：
  - 收敛为单一打字光标类 `.conex-streaming-caret`（翡翠绿签名），统一动画曲线与频率；
  - 挂钟时间轴 `--sd-delay` 变量交错淡入；
  - 强绑定 `html[data-perf-tier='eco']`（动画时长 0ms 折叠，零 GPU 损耗）。
- **删除面（DEL）**：
  - 彻底删除 `ChatMessageRow.module.css` 与 `streaming-animation.css` 的双轨光标冲突；
  - 彻底删除光标中的 `#94a3b8` 蓝灰裸色。

---

## 二、先删后改实施阶段顺序（DAG）

```
【阶段 0：死层、硬编码与幽灵变量清剿】(强串行门禁)
  ├── 1. 清剿 custom-tags.module.css 46 处裸色、非法属性 divide-x 与 undefined 类
  ├── 2. 拔除 --bg-error-subtle、--flow-*、--status-success 等 12 个幽灵变量
  ├── 3. 根除 ErrorMessageBanner 8 处内联样式，创建 TimelineThoughtSection.module.css
  └── 4. 消除表格与光标双源定义漂移，修复死选择器
        │
        ▼
【阶段 1：全局 Design Tokens 体系注入 (tokens.css)】
  ├── 1. 注入 --md-* (正文排版/标题/行内代码/引用)
  ├── 2. 注入 --syntax-* (20 组语法高亮调色盘)
  ├── 3. 注入 --stream-table-* (流式表格与吸顶)
  ├── 4. 注入 --artifact-*, --diff-*, --filetree-*, --aicard-* (组件双主题与 WCAG 对比度)
  └── 5. 注入 --thought-*, --banner-*, --stream-caret-*, data-perf-tier 性能分档
        │
        ▼
【阶段 2：组件与渲染层全量 Token 接线】(四模块并行)
  ├── 1. custom-tags.module.css & 组件全量接入 Token (WCAG AA 100% 达标)
  ├── 2. StreamingTableContainer.module.css 接入表格与翡翠绿脉冲
  ├── 3. ChatMessageRow.module.css 接入排版矩阵与语法高亮
  └── 4. streaming-animation.css 接入 GPU 时间轴与 Eco 分档
        │
        ▼
【阶段 3：全链路门禁、视觉核验与 WCAG 对比度验收】
  ├── npm run typecheck (0 错误) + npm run check:line-counts (0 超标)
  ├── Vitest 样式与组件单测 100% 通过
  └── WCAG AA 对比度自动化断言通过 (Light 模式 Diff 与 Badge ≥4.85:1)
```
