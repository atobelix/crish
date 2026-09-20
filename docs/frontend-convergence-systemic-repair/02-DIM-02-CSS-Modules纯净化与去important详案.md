# DIM-02: CSS Modules 纯净化与去 !important 详案 (G-06 收敛)

> **归属战役**：`FRONTEND-CONVERGENCE-OVERHAUL`  
> **权威目录**：`docs/frontend-convergence-systemic-repair/`  
> **核心目标**：彻底拔除全仓 12 个业务 CSS Module 中的全部 **91 处 `!important` 声明**，重构为基于现代 CSS 特异性（Specificity）与 Custom Properties 槽位的原生扁平样式流，保证计算样式与视觉表现 100% 像素级等价。

---

## 1. 现状全景与 4 大冲突根因模型

通过对 91 处 `!important` 的逐行排查（详见 `analysis/03-g06-css-modules-important.md`），所有违规项均可精确归因到以下 4 大系统性冲突模型：

```
┌────────────────────────────────────────────────────────────┬───────┬─────────┐
│ 冲突根因模型                                               │ 数量  │ 占比    │
├────────────────────────────────────────────────────────────┼───────┼─────────┤
│ 模型 A：原子组件复合高特异性竞争（Atomic Specificity Wall）│ 43    │ 47.3%   │
│ 模型 B：父容器状态后代选择器逆向锁死（Parent State Inversion）│ 17    │ 18.7%   │
│ 模型 C：防御型过度工程重置（Overengineered Reset Blindness）│ 21    │ 23.1%   │
│ 模型 D：平台层指令与 CSS 变量级联脱节（Platform Drift）    │ 10    │ 11.0%   │
├────────────────────────────────────────────────────────────┼───────┼─────────┤
│ 合计                                                       │ 91    │ 100.0%  │
└────────────────────────────────────────────────────────────┴───────┘
```

1. **模型 A（原子高特异性竞争，43 处）**：
   - *现象*：业务组件（如 `ChatComposer`）引入了标准 `<Button>`，但试图在其外层微调 `padding` 或 `font-size`。由于 `Button.module.css` 内部使用了 `.button.variantGhost.sizeSm` 复合三类名选择器（特异性 `(0,3,0)`），业务层的单个 `.actionBtn`（特异性 `(0,1,0)`）无法生效，开发者便图省事追加了 `!important`。
2. **模型 B（父容器状态逆向锁死，17 处）**：
   - *现象*：在拖拽状态、全屏状态或暗黑主题切换时，使用了形如 `.workspace[data-dragging="true"] .tab`（特异性 `(0,2,0)`），为了在深层子组件中强行覆盖边框或背景，多处层叠叠加 `!important`。
3. **模型 C（防御型过度重置，21 处）**：
   - *现象*：在 `YamlConfigEditorModal`、`FileAnnotationPopover` 等弹窗样式中，原作者为了防止浏览器默认行为或全局样式污染，盲目对 `margin: 0 !important;`、`outline: none !important;`、`box-shadow: none !important;` 进行地毯式重置。
4. **模型 D（平台指令与变量脱节，10 处）**：
   - *现象*：在 `ToastStackModern` 与 `NotePaperPanel` 中，处理滚动条显示或全屏浮层层叠时，为了压制局部内联样式或默认样式，使用了 `!important`。

---

## 2. 扁平化特异性（Flat Specificity）重构四大法则

为了彻底根除 `!important`，本方案确立 4 条刚性重构数学法则：

### 法则 1：原子基类降级为零特异性 `:where(...)`
原子组件层（如 `Button.module.css`、`Input.module.css`）中的基础变体选择器，采用现代 CSS `:where()` 伪类包裹其修饰类：
```css
/* 重构前：特异性 (0, 3, 0)，形成不可逾越的高墙 */
.button.variantGhost.sizeSm {
  padding: 4px 8px;
}

/* 重构后：特异性保持为基础 (0, 1, 0)，允许业务层轻松覆盖 */
.button:where(.variantGhost):where(.sizeSm) {
  padding: 4px 8px;
}
```

### 法则 2：CSS Custom Properties（变量槽位）优先协议
对于需要被业务定制的核心属性（高度、内边距、圆角、背景），在原子组件中暴露出私有变量槽：
```css
.button {
  padding: var(--btn-padding, 4px 8px);
  height: var(--btn-height, 28px);
}

/* 业务层消费：零特异性竞争，纯变量赋值，天然免 !important */
.customAction {
  --btn-padding: 2px 6px;
  --btn-height: 24px;
}
```

### 法则 3：同级复合选择器对等提升
当业务层确需在特定激活状态下提升权重时，使用同级双类名或同级属性选择器，将特异性精确提升到 `(0,2,0)`，而非滥用 `!important`：
```css
/* 重构前 */
.inputItem.active {
  border-color: var(--border-focus) !important;
}

/* 重构后：利用同级属性选择器锁定精确特异性 */
.inputItem[data-active="true"] {
  border-color: var(--border-focus);
}
```

### 法则 4：清退无意义的防御性重置
对所有 `margin: 0 !important;`、`border: none !important;` 进行全量现场核验。在 CSS Modules 的局部哈希作用域下，不存在全局标签选择器污染，直接安全删除 `!important` 标记。

---

## 3. 12 个样式文件 91 处定点清除详单

| 样式文件路径 | 违规数量 | 冲突根因分析 | 改造方案 |
| :--- | :---: | :--- | :--- |
| `components/chat-composer/ChatComposer.module.css` | **21** | 聚焦输入框与工具栏按钮覆盖 `.composerCard` 基础边框和高度 | 采用 `:where()` 降级卡片基类，工具栏微调改为 `--btn-size` 槽位注入 |
| `components/settings-models/YamlConfigEditorModal.module.css` | **12** | Monaco/CodeMirror 容器外部滚动条与字号防御性强刷 | 改用 `:global(.cm-editor)` 明确嵌套路径，剥离 `!important` |
| `components/note-paper/NotePaperPanel.module.css` | **11** | 便签块高亮态与双栏折叠宽度强行固定 | 使用 `data-collapsed="true"` 属性选择器匹配层叠 |
| `components/chat-message-row/ChatMessageRow.module.css` | **10** | 消息行操作按钮（复制/重试）在 hover 态下的显示权重 | 采用 `.messageRow:hover .actionCluster` 复合规则取代 `!important` |
| `components/files/FileAnnotationPopover.module.css` | **10** | 批注弹层输入框防御性清空外边距与焦点框重置 | 移除无意义重置，焦点环统一走项目标准 `--focus-ring` |
| `components/overlay/ToastStackModern.module.css` | **10** | 浮层堆叠时每张卡片的位移与透明度计算硬写 | 改由内联 CSS Variable（`--toast-offset-y`）统一驱动，样式表内仅负责过渡声明 |
| `components/binary-tree/BinaryTreeWorkspace.module.css` | **7** | 分屏叶子拉伸最小宽度与拖拽手柄绝对定位 | 规范 flex 布局参数（`flex: 1 1 0px`），消除绝对定位覆盖冲突 |
| `components/files/FilesCard.module.css` | **6** | 文件树节点缩进与选中态背景颜色高亮 | 采用 `.treeNode[aria-selected="true"]` 属性选择器精确覆盖 |
| `components/shell/sessionTabDrag.module.css` | **2** | 标签页拖拽浮影透明度与光标锁定 | 样式直接挂载于专用拖拽 DOM，剥离 `!important` |
| `components/sidebar/Sidebar.module.css` | **2** | 侧边栏收起时的宽度强制为 0 | 配合 `data-collapsed="true"` 类名，设置 `width: 0; overflow: hidden;` |
| `components/sidebar/SidebarSessionList.module.css` | **2** | 活跃会话背景色强制渲染 | 采用 `.sessionItem.isActive` 复合类名提升特异性 |
| `components/binary-tree/LeafToolTabStrip.module.css` | **0** | 历史关联文件审查 | 保持干净规范 |

---

## 4. 实施与验证路径

1. **第 1 批（重灾区治理：前 3 大文件 44 处）**：
   - 治理 `ChatComposer.module.css` (21 处)；
   - 治理 `YamlConfigEditorModal.module.css` (12 处)；
   - 治理 `NotePaperPanel.module.css` (11 处)；
   - 验证相关组件渲染无样式错乱。
2. **第 2 批（浮层与展示治理：次 3 大文件 30 处）**：
   - 治理 `ChatMessageRow.module.css` (10 处)；
   - 治理 `FileAnnotationPopover.module.css` (10 处)；
   - 治理 `ToastStackModern.module.css` (10 处)；
   - 跑通 `ToastStore.test.ts` 与 `ChatMessageRow` 相关单测。
3. **第 3 批（分屏与树形治理：剩余 5 文件 17 处）**：
   - 治理 `BinaryTreeWorkspace.module.css` (7 处)；
   - 治理 `FilesCard.module.css` (6 处)；
   - 治理 `sessionTabDrag`、`Sidebar`、`SidebarSessionList` (4 处)；
4. **第 4 批（门禁拦截归零）**：
   - 运行 `node scripts/check-frontend-convergence.mjs`，断言 G-06 违规从 91 项清零至 **0 项**！
