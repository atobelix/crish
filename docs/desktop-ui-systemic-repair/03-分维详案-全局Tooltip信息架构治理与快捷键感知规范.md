# 03-分维详案-全局 Tooltip 信息架构治理与快捷键感知规范

> **归属战役**：`docs/desktop-ui-systemic-repair/`  
> **上级总方案**：[`00-总方案-顶栏单轨同层收敛与Hover提示系统性治理.md`](./00-总方案-顶栏单轨同层收敛与Hover提示系统性治理.md)

---

## 一、维度目标与信息架构治理哲学

彻底解决界面 Tooltip 滥用、复读机噪音以及高价值快捷键信息缺失的问题。对齐行业一流桌面规范（VS Code、Linear、macOS HIG），构建自上而下的 Tooltip 设计系统契约。

### 加减法哲学与裁决标准
| 场景分类 | 处理决策 | 规范标准与示例 |
| :--- | :--- | :--- |
| **纯文字复读机** | **坚决物理切除** | 按钮本身已显式渲染「新建对话」、「保存配置」等文字标签时，严禁再加纯复读 Tooltip。 |
| **纯图标操作按钮 (Icon-only)** | **必须保留并标准化** | 如顶栏帮助 `?`、复制、编辑、撤回、分屏、设置等，必须有精准清晰的功能意图解释。 |
| **支持全局/局部快捷键的操作** | **必须增强 `<kbd>` 徽标** | 如「快捷键与帮助 <kbd>?</kbd>」、「编辑上一条消息 <kbd>E</kbd>」、「新建对话 <kbd>Ctrl+N</kbd>」。 |
| **长文本物理截断** | **条件触发 (Conditional)** | 会话标题、文件路径等长文本，仅在物理发生截断（`scrollWidth > clientWidth`）时才激活 Tooltip，未截断时不弹出。 |
| **高风险/不可逆破坏性操作** | **必须附带副作用预警** | 如撤回操作：「撤回上一条（还原文件修改并截断会话上下文）」。 |

---

## 二、纯逻辑执行步骤与任务单元

### 任务单元 3.1：`Tooltip` 原生契约升级（支持 `shortcut` 徽标）
- **文件域**：
  - `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx`
  - `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css`
  - `apps/crish-desktop/src/components/ui/Button/IconButton.tsx`
- **逻辑内容**：
  - 扩展 `TooltipProps`：
    ```ts
    export interface TooltipProps {
      content: React.ReactNode;
      children: React.ReactElement;
      /** 快捷键组合：单个字符串（如 'Ctrl+N'）或按键数组（如 ['Ctrl', 'N']） */
      shortcut?: string | string[];
      side?: TooltipSide;
      disabled?: boolean;
      delayShow?: number;
      delayHide?: number;
      ...
    }
    ```
  - 在 `Tooltip.module.css` 中设计精美克制的键盘徽标样式：
    ```css
    .tooltipKbd {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-left: var(--space-2);
      padding: 0 4px;
      height: 16px;
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      background: var(--bg-surface-active);
      border: 1px solid var(--hairline-strong);
      border-radius: var(--radius-xs, 3px);
    }
    ```
  - `IconButton` 同步透传 `shortcut` 属性至内部 `Tooltip`。

### 任务单元 3.2：核心高频纯图标操作 Tooltip 精准化与快捷键接入
- **文件域**：
  - 顶栏：`apps/crish-desktop/src/components/top-bar/AppTopBar.tsx`（帮助按钮 `?` -> `tooltip="快捷键与帮助"` + `shortcut="?"`）；
  - 消息行操作：`apps/crish-desktop/src/components/chat-message-row/UserMessageActionsBar.tsx`（编辑按钮 -> `shortcut="E"`；复制按钮 -> `content="复制消息"`）；
  - 助手消息操作：`apps/crish-desktop/src/components/chat-message-row/AssistantMessageActionsBar.tsx`（重新生成 -> `shortcut="R"`）；
  - 会话新建按钮：`apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx`（`+` 按钮增加 Tooltip：「新建对话 <kbd>Ctrl+N</kbd>」）。

### 任务单元 3.3：全局纯文字复读机式 Tooltip 物理切除
- **逻辑内容**：
  - 检索全仓带有可见文本又包裹了同名 Tooltip 的组件；
  - 物理切除外层包裹的无意义 Tooltip，释放内存并杜绝悬停干扰。

---

## 三、负向红线与验收断言

1. **负向断言**：
   - 严禁任何具有可见文本的按钮渲染与自身文本完全相同的 Tooltip；
   - 严禁在 Tooltip 中使用裸 Hex 色值，键盘徽标背景、边框、文字 100% 依赖 Design Tokens；
   - 严禁在快捷键展示中使用生硬无样式的大写字母。
2. **正向验收断言**：
   - 顶栏 `?` 按钮悬停时准确呈现胶囊气泡，左侧为文字「快捷键与帮助」，右侧带有微型单字符 `<kbd>?</kbd>`；
   - 屏幕阅读器 `aria-label` 与 Tooltip 文案保持语义一致，无无障碍语义断层。
