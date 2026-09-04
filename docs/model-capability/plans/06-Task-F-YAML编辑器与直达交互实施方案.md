# Task-F：YAML 配置文件编辑器与直达交互实施方案

> **文档标识**：`docs/model-capability/plans/06-Task-F-YAML编辑器与直达交互实施方案.md`  
> **制定时间**：2026-09-03  
> **责任角色**：Task-F（YAML 编辑器与直达交互工程师）  
> **归属战役**：`docs/model-capability/` AI 服务商与模型管理全面重构战役  
> **输入依据**：
> - [`00-AI服务商与模型管理全面重构终极方案.md`](../00-AI服务商与模型管理全面重构终极方案.md)
> - [`01-多Agent协同实现方案与任务分工总纲.md`](../01-多Agent协同实现方案与任务分工总纲.md)
> - [`plan-reviews/07-反过度设计与工程可行性审计.md`](../plan-reviews/07-反过度设计与工程可行性审计.md)
> - [`analysis/03-设置界面YAML编辑与直达交互方案.md`](../analysis/03-设置界面YAML编辑与直达交互方案.md)
> - [`analysis/06-模型开关状态机与全链路过滤一致性方案.md`](../analysis/06-模型开关状态机与全链路过滤一致性方案.md)  
> **执行纪律**：只读现有源码，仅允许创建与修改白名单内的物理文件域；**严禁执行 Git 提交**；严格遵守反过度设计红线（零新增大型 npm 依赖、严禁跨服务商隐式静默切模）。

---

## 一、 任务定位与物理文件域绝对正交原则

### 1.1 背景与用户痛点穿透
针对用户批评：*“不是设置界面能有直接编辑yaml文件的选项吗，怎么没有，是你都还没做吗”*，系统将外部 YAML 配置文件（`~/.conex/models.yaml`）确立为模型能力、思考协议与计费参数的**绝对唯一真源（SSOT）**。

开发者既需要一个**无需切换外部 IDE 即可在客户端内极速微调几个参数的内置轻量编辑器**，也需要**一键唤起本机 VS Code / Cursor / 记事本等外部主力编辑器**的快捷直达能力。

### 1.2 物理文件域白名单（零重叠、零锁冲突）

根据 `01-多Agent协同实现方案与任务分工总纲.md` 矩阵，Task-F 的改动严格圈定在以下 **3 个物理文件**内，严禁越界修改其他任务包文件：

| 文件路径 | 状态 | 职责说明 |
| :--- | :---: | :--- |
| `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.tsx` | **[新建]** | 内置轻量 YAML 代码编辑器弹窗组件 |
| `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css` | **[新建]** | 编辑器双层滚动、行号栏、语法高亮与顶栏组合按钮样式 |
| `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx` | **[修改]** | 顶栏注入组合按钮、接入弹窗开闭、同厂商自愈降级与 `metaTick` 驱动 |

#### 与其他任务包的正交边界防碰撞设计
1. **与 Task-D（样式瘦身）绝对隔离**：Task-D 专职精简 `ModelsSettingsTab.module.css`。为了杜绝任何合并冲突，**顶栏 `[ 配置文件 (YAML) ▾ ]` 组合按钮所需的新增 CSS 类全量定义在 `YamlConfigEditorModal.module.css` 中**，并在 `ModelsSettingsTab.tsx` 侧直接引用，Task-F **绝对不修改** `ModelsSettingsTab.module.css`！
2. **与 Task-C（级联菜单）接口对接**：Task-C 负责 `ModelProfileList.tsx` 中的 `ModelsCascadeSelect` 内部过滤。Task-F 仅负责在 `ModelsSettingsTab.tsx` 中向 `<ModelsCascadeSelect>` 正确透传 `metaTick` 并承接 `onChange` 事件。
3. **与 Task-A（状态底座）接口对接**：Task-A 为 `useModelProfilesState` 补充 `metaTick` 输出。Task-F 在 `ModelsSettingsTab.tsx` 中直接解构并消费 `metaTick`。

---

## 二、 顶栏 `[ 配置文件 (YAML) ▾ ]` 组合按钮与交互设计

### 2.1 交互布局与 Split Button 结构

在 `ModelsSettingsTab.tsx` 顶栏的 `headerMeta` 区域，将原先单一的 `<AddProviderMenu>` 升级为双按钮操作组（Action Group）：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 模型                               [ 配置文件 (YAML) ▾ ]   [+ 添加服务商 ▾]  │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Split Button 组合设计细节：
1. **左侧主操作按钮（`Button variant="secondary" size="sm"`）**：
   - 带有 `Lucide.FileCode2` 代码文件图标与文案 `“配置文件 (YAML)”`；
   - 点击行为：**立即呼出内置轻量 YAML 编辑器弹窗 (`YamlConfigEditorModal`)**；
   - 键盘无障碍：带有明确的 `aria-label="在内置编辑器中编辑配置文件 (YAML)"`。
2. **右侧下拉箭头按钮（`Button variant="secondary" size="sm"`）**：
   - 图标为 `Lucide.ChevronDown`，紧贴主按钮右侧（视觉呈连体 Split 状态，中间以发丝微边框隔开）；
   - 点击行为：通过 `Menu` 基座展开 **“配置文件打开与直达”** 浮动下拉菜单。

```
┌──────────────────────────────────────────────┐
│ 配置文件 (models.yaml)                        │
├──────────────────────────────────────────────┤
│ ❐  内置编辑器打开                             │
├──────────────────────────────────────────────┤
│ 外部编辑器调起                                │
│   Visual Studio Code                        │
│ 󰨞  Cursor                                    │
│ 󰅩  Zed                                       │
│ 📝 Windows 记事本 (Notepad)                   │
│ ↗  系统默认程序打开 (Default App)             │
├──────────────────────────────────────────────┤
│ 📁 在文件资源管理器中定位                      │
│ 📋 复制完整绝对路径                           │
└──────────────────────────────────────────────┘
```

### 2.2 宿主打开器（Host Openers）对接与安全降级

直接复用已有的 [`hostOpenersApi.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/hostOpenersApi.ts)：
1. **动态嗅探**：通过 `listHostOpeners()` 扫描本机已安装编辑器，按 VS Code、Cursor、Zed、Windsurf、Notepad 优先级过滤与排序；
2. **外部打开**：
   - 指定编辑器：调用 `openWithHostOpener(openerId, configFilePath)`；
   - 系统默认：调用 `openPathDefault(configFilePath)`；
   - 资源管理器定位：调用 `openWithHostOpener('system-file-manager', configFilePath)` 或 `openPathDefault` 回退；
3. **复制路径**：点击“复制完整绝对路径”后，调用 `navigator.clipboard.writeText(configFilePath)`，并弹出轻量 Toast 提示 `“已复制配置文件绝对路径”`。
4. **安全与防崩兜底**：若调起失败，捕获异常并通过 `notify(false, err.message)` 展示柔和错误 Toast，不导致界面崩溃。

---

## 三、 内置轻量代码编辑器设计（`YamlConfigEditorModal`）

### 3.1 零新增依赖与双层同步滚动架构（Synchronized Dual-Layer Editor）

> **红线遵从**：坚决贯彻《反过度设计审计》，**严禁引入 Monaco Editor 或 CodeMirror**，零 npm 依赖新增。利用前端现有 `highlight.js`（`api/codeHighlight.ts`）与原生 DOM 构建轻量编辑器。

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ 外层容器: position: relative; font-family: var(--font-mono, JetBrains Mono, monospace)│
│                                                                                      │
│ ┌──────────────────────┐  ┌────────────────────────────────────────────────────────┐ │
│ │ 行号栏 (.gutter)     │  │ 背景层 (.highlightLayer): <pre><code ... />            │ │
│ │ position: sticky;    │  │ - highlightCode(code, 'yaml') 彩色高亮渲染              │ │
│ │ 渲染当前行号 1..N    │  │ - pointer-events: none; user-select: none;             │ │
│ │ 出错行标红背景高亮   │  ├────────────────────────────────────────────────────────┤ │
│ │                      │  │ 前景层 (.textareaInput): <textarea spellCheck={false}> │ │
│ │                      │  │ - 负责捕获用户键盘敲击、光标选区与输入法                │ │
│ │                      │  │ - color: transparent; caret-color: var(--text-primary);│ │
│ └──────────────────────┘  └────────────────────────────────────────────────────────┘ │
│                                                                                      │
│ 滚动同步: 仅监听 <textarea> 的 onScroll 单向驱动 <pre> 与 .gutter 垂直/水平滚动        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

#### 关键 CSS 像素几何不变量（防止亚像素错位）
`<pre>` 与 `<textarea>` 必须具有**绝对一致的盒模型参数**，杜绝光标在多行后与背景文字发生漂移：
- 字体族：`font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', Consolas, monospace);`
- 字体大小与行高：`font-size: 13px; line-height: 20px;`（严格采用像素整数值，禁止无单位浮点数）
- 内边距与盒模型：`box-sizing: border-box; padding: 12px 16px; margin: 0; border: 0;`
- 折行设置：`white-space: pre; word-wrap: normal; overflow-wrap: normal; tab-size: 2;`（禁用软折行，确保每行恒等高 20px）
- 单向事件驱动：仅在 `<textarea>` 绑定 `onScroll`：
  ```typescript
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = scrollTop;
      preRef.current.scrollLeft = scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = scrollTop;
    }
  };
  ```

### 3.2 键盘输入增强与 2 空格缩进处理

在 `<textarea>` 的 `onKeyDown` 事件中注入代码编辑增强：

1. **Tab 键缩进拦截（严禁插入 `\t`）**：
   - **单光标无选区**：阻止默认焦点跳转（`e.preventDefault()`），在当前光标处插入 **2 个标准半角空格**，光标向后移动 2 个字符；
   - **多行选中缩进**：按下 `Tab` 将选中的所有行统一向右缩进 2 空格；
   - **反向缩进**：按下 `Shift + Tab` 将选中的所有行向左削减至多 2 空格；
2. **快捷键体系**：
   - `Ctrl+S` / `Cmd+S`：拦截浏览器默认保存，触发 `handleSave()`；
   - `Esc`：若内容被修改（`isDirty === true`），拦截关闭并唤起防丢失确认弹窗；若无未保存修改，直接平滑关闭。

### 3.3 语法校验、红底错误高亮与一键跳转

1. **语法诊断器（Diagnostic Engine）**：
   - 内容输入时防抖 200ms 触发校验；
   - 优先通过 IPC 调用 Rust 后端 `validate_models_yaml`（保证与后端 `serde_yaml` 100% SSOT 对齐）；
   - 若处于未接线或纯前端测试环境（IPC 返回 `missing`），启用内置轻量纯前端 YAML 语法探测规则：
     - 检测是否包含非法制表符 `\t`（YAML 核心禁令）；
     - 检测键值对缺少冒号或缩进异常（如同一层级缩进奇偶数混乱）；
   - 输出错误结构体：
     ```typescript
     interface YamlSyntaxError {
       line: number;      // 1-indexed
       column?: number;   // 1-indexed
       message: string;   // 人类可读提示
     }
     ```
2. **三位一体视觉反馈**：
   - **行号栏标红**：行号栏第 `error.line` 行渲染背景色 `rgba(239, 68, 68, 0.25)` 与红色文字；
   - **底栏错误横幅（Error Banner）**：在弹窗左下角渲染醒目警告栏：
     `“⚠ 第 14 行: 检测到使用了 Tab 制表符，YAML 仅允许使用 2 个空格缩进 [点击跳转]”`；
   - **一键精准跳转**：点击横幅或快捷按钮，自动将 `<textarea>` 聚焦，将光标定位至该行起始位置，并将编辑器垂直滚动条平滑居中至该行：
     ```typescript
     const jumpToErrorLine = (targetLine: number, targetCol: number = 1) => {
       const textarea = textareaRef.current;
       if (!textarea) return;
       const lines = code.split('\n');
       let charOffset = 0;
       for (let i = 0; i < targetLine - 1 && i < lines.length; i++) {
         charOffset += lines[i].length + 1; // +1 for '\n'
       }
       const finalPos = Math.min(code.length, charOffset + Math.max(0, targetCol - 1));
       textarea.focus();
       textarea.setSelectionRange(finalPos, finalPos);
       // 滚动至视口中央
       const targetScrollTop = Math.max(0, (targetLine - 1) * 20 - 120);
       textarea.scrollTop = targetScrollTop;
     };
     ```
3. **保存刚性阻断**：当存在阻断级语法错误时，右下角“保存并热重载”按钮呈禁用态，并在 Tooltip 中提示错误信息。

### 3.4 脏状态追踪与防丢失确认（Unsaved Changes Guard）

1. 记录初始载入的内容快照 `originalCode`；
2. 每次输入后对比 `code !== originalCode`，动态维护 `isDirty` 布尔状态；
3. 弹窗标题右侧渲染脏标记小圆点：`● 有未保存修改`；
4. 当用户点击右上角关闭按钮、按 `Esc` 或点击遮罩时：
   - 若 `!isDirty`：直接关闭；
   - 若 `isDirty`：打开基于 `ConfirmDialog` 的确认对话框：
     - 标题：`“放弃未保存的修改？”`
     - 内容：`“你对 models.yaml 的修改尚未保存，退出后更改将丢失。”`
     - 动作：`[继续编辑]`（取消） / `[放弃更改退出]`（确认，重置后关闭）。

### 3.5 模板内置与持久化热重载

1. **默认配置文件模板（Empty Seed Template）**：
   若首次打开时外部文件为空或尚未创建，系统自动注入标准规范模板（包含 DeepSeek、Claude、OpenAI 示例及参数注释）；
2. **持久化保存与状态回馈**：
   - 点击“保存并热重载”后调用 IPC `workbench_save_models_yaml`（若缺失则回退写入本地存储）；
   - 保存成功后更新 `originalCode = code`，`isDirty` 归为 `false`；
   - 保存按钮瞬时转为绿色成功指示：`[✔ 已保存并热重载]`，持续 1.5 秒；
   - 触发 `onSaved()` 回调，驱动父级页面执行 `refresh()`。

---

## 四、 审计 1 刚性落实：同厂商自愈降级与置空引导

### 4.1 审计 1 裁决要点（严禁跨服务商静默切模）

根据 `07-反过度设计与工程可行性审计.md` §2.2.1 与 §3.1 纠偏指南：
- 🚨 **硬性红线（禁令 4）**：严禁后台自动为用户跨服务商切换模型！不同厂商的计费、推理风格与上下文格式差异极大，跨厂商静默切模直接破坏用户意志。
- **正向状态机契约**：
  1. **同厂商自愈降级**：当用户在界面停用当前正在使用的全局活动模型（`globalActiveModelId`）时，系统**仅允许在同服务商内部**降级至首个可用的已启用模型；
  2. **置空引导**：若该服务商下所有模型均被禁用，活动模型**直接置空**（清空活动状态），界面展示醒目占位符 `[请选择模型 ▾]`，引导用户手动显式挑选。**绝对禁止自动跨厂商降级到其他已配置密钥的服务商**！

### 4.2 纯逻辑自愈决策函数（可测试单例）

在 `ModelsSettingsTab.tsx` 中实现该决策算法：

```typescript
export interface ActiveSelection {
  profileId: string;
  model: string;
}

/**
 * 停用模型后的活动模型自愈解析器（落实审计 1，严禁跨厂商切换）
 */
export function resolveActiveModelAfterMetaChange(
  currentActive: ActiveSelection | null,
  profiles: readonly ProviderProfile[],
  isModelEnabled: (profileId: string, model: string) => boolean
): { nextActive: ActiveSelection | null; selfHealed: boolean } {
  if (!currentActive || !currentActive.profileId || !currentActive.model) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 1. 若当前活动模型仍然处于启用态，无需自愈
  if (isModelEnabled(currentActive.profileId, currentActive.model)) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 2. 当前活动模型已被禁用！仅在同服务商内部寻找下一个已启用的模型
  const currentProfile = profiles.find((p) => p.id === currentActive.profileId);
  const sameProviderNext = currentProfile?.models.find((m) => {
    if (m === currentActive.model) return false;
    return isModelEnabled(currentActive.profileId, m);
  });

  if (sameProviderNext) {
    // 同厂商平滑自愈
    return {
      nextActive: {
        profileId: currentActive.profileId,
        model: sameProviderNext,
      },
      selfHealed: true,
    };
  }

  // 3. 该厂商已无任何可用模型 -> 绝对禁止跨厂商自作主张！直接置空引导手动选择
  return { nextActive: null, selfHealed: true };
}
```

### 4.3 接入 `metaTick` 响应式驱动

在 `ModelsSettingsTab.tsx` 中：
1. 从 `useModelProfilesState()` 解构获得 `metaTick`；
2. 监听 `metaTick` 变动（即元数据发生 `setModelEnabled` 或接收到 `model-meta-changed` 事件）：
   ```typescript
   useEffect(() => {
     if (!activeProfileId || !globalActiveModelId) return;

     const currentActive: ActiveSelection = {
       profileId: activeProfileId,
       model: globalActiveModelId,
     };

     const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
       currentActive,
       profiles,
       (pId, m) => getModelMeta(pId, m).enabled !== false
     );

     if (selfHealed) {
       if (nextActive) {
         activateProfileModel(nextActive.profileId, nextActive.model);
         notify(true, `当前模型已停用，已自动切换至同厂商模型: ${nextActive.model}`);
       } else {
         clearActiveModelId();
         notify(false, `当前服务商已无可用模型，请手动选择模型`);
       }
     }
   }, [metaTick, profiles, activeProfileId, globalActiveModelId, notify]);
   ```
3. 向 `<ModelsCascadeSelect>` 透传 `metaTick={metaTick}`，确保级联菜单在元数据变更后同步重绘。

---

## 五、 逐行级完整代码实现蓝图（Executable Code Blueprints）

### 5.1 `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css`

```css
/**
 * YamlConfigEditorModal.module.css
 * YAML 代码编辑器弹窗与顶栏组合按钮专用样式
 * 遵循系统 Design Tokens 规范，不触碰 ModelsSettingsTab.module.css
 */

/* ── 顶栏组合按钮 (Split Button / Action Group) ─────────────────── */
.headerActionGroup {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
}

.configButtonCombo {
  display: inline-flex;
  align-items: stretch;
  position: relative;
}

.configButtonCombo > button:first-child {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: none;
}

.configMenuTrigger {
  border-top-left-radius: 0 !important;
  border-bottom-left-radius: 0 !important;
  padding-left: 6px !important;
  padding-right: 6px !important;
  min-width: 26px !important;
  border-left: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08)) !important;
}

.yamlDropdownMenu {
  min-width: 220px;
  padding: 6px;
  background: var(--bg-card, #ffffff);
  border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
  border-radius: var(--radius-lg, 8px);
  box-shadow: var(--shadow-lg, 0 10px 25px -5px rgba(0, 0, 0, 0.1));
}

.menuSectionTitle {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary, #888888);
  padding: 6px 8px 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.menuItemBtn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-primary, #111111);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast, 120ms ease);
}

.menuItemBtn:hover {
  background: var(--bg-hover, rgba(0, 0, 0, 0.04));
}

.menuDivider {
  height: 1px;
  background: var(--border-subtle, rgba(0, 0, 0, 0.06));
  margin: 4px 0;
}

/* ── 弹窗内部布局 ─────────────────────────────────────────────────── */
.modalTitleRow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary, #111111);
}

.modalTitleIcon {
  color: var(--brand-primary, #0066cc);
}

.dirtyDot {
  color: var(--warning-color, #f59e0b);
  font-size: 10px;
  line-height: 1;
  margin-left: 2px;
}

.modalSubHeader {
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.filePathBadge {
  display: inline-block;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-tertiary, #666666);
  background: var(--bg-secondary, rgba(0, 0, 0, 0.03));
  padding: 2px 6px;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 顶部辅助工具栏 ───────────────────────────────────────────────── */
.editorToolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
  background: var(--bg-secondary, rgba(0, 0, 0, 0.02));
}

.toolbarLeft {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbarRight {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbarInfo {
  font-size: 12px;
  color: var(--text-tertiary, #888888);
}

/* ── 双层同步代码编辑器视口 ───────────────────────────────────────── */
.editorViewport {
  display: flex;
  height: 60vh;
  min-height: 380px;
  position: relative;
  background: var(--bg-card, #ffffff);
  border-bottom: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
  overflow: hidden;
}

/* 行号栏 Gutter */
.gutter {
  width: 46px;
  flex-shrink: 0;
  background: var(--bg-secondary, rgba(0, 0, 0, 0.02));
  border-right: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
  overflow: hidden;
  user-select: none;
  box-sizing: border-box;
  padding: 12px 0;
}

.gutterLine {
  height: 20px;
  line-height: 20px;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  color: var(--text-tertiary, #999999);
  text-align: right;
  padding-right: 10px;
  box-sizing: border-box;
}

.gutterLineError {
  background: rgba(239, 68, 68, 0.25) !important;
  color: var(--danger-color, #ef4444) !important;
  font-weight: 700;
}

/* 双层编辑舞台容器 */
.editorStage {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

/* 背景语法高亮层 */
.highlightLayer {
  position: absolute;
  inset: 0;
  margin: 0;
  box-sizing: border-box;
  padding: 12px 16px;
  font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', Consolas, monospace);
  font-size: 13px;
  line-height: 20px;
  white-space: pre;
  word-wrap: normal;
  overflow-wrap: normal;
  tab-size: 2;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  background: transparent;
  color: var(--text-primary, #111111);
}

.highlightCode {
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  background: transparent !important;
  padding: 0 !important;
}

/* 前景输入捕获层 */
.textareaInput {
  position: absolute;
  inset: 0;
  margin: 0;
  box-sizing: border-box;
  padding: 12px 16px;
  font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', Consolas, monospace);
  font-size: 13px;
  line-height: 20px;
  white-space: pre;
  word-wrap: normal;
  overflow-wrap: normal;
  tab-size: 2;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: transparent;
  caret-color: var(--text-primary, #111111);
  overflow: auto;
  z-index: 1;
}

/* ── 底栏与错误横幅 ───────────────────────────────────────────────── */
.modalFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  width: 100%;
  box-sizing: border-box;
}

.errorBanner {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: var(--radius-md, 6px);
  padding: 4px 10px;
  color: var(--danger-color, #ef4444);
  font-size: 12px;
  max-width: 60%;
  cursor: pointer;
  transition: background var(--transition-fast, 120ms ease);
}

.errorBanner:hover {
  background: rgba(239, 68, 68, 0.18);
}

.errorBannerText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.successIndicator {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--success-color, #10b981);
  font-size: 12px;
  font-weight: 500;
}

.footerActions {
  display: flex;
  align-items: center;
  gap: 8px;
}
```

---

### 5.2 `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.tsx`

```tsx
/**
 * YamlConfigEditorModal.tsx
 * 模型配置文件 (models.yaml) 轻量内置代码编辑器弹窗
 *
 * 核心技术实现：
 * 1. 零新增 npm 依赖：基于现有 highlight.js + 原生 textarea 构建双层同步滚动高亮；
 * 2. 严格 20px 整数行高与等宽字体栈，杜绝亚像素偏移；
 * 3. 智能 Tab 键 2 空格缩进处理，刚性杜绝制表符 \t；
 * 4. 实时语法诊断、行号红底高亮与底栏错误横幅一键精准跳转；
 * 5. 脏状态检测与退出防丢确认对话框（ConfirmDialog）；
 * 6. 快捷键支持（Ctrl+S 保存 / Esc 退出拦截）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { Button, ConfirmDialog, Dialog } from '../ui';
import { highlightCode } from '../../api/codeHighlight';
import { invokeTyped } from '../../api/tauriInvoke';
import styles from './YamlConfigEditorModal.module.css';

interface YamlConfigEditorModalProps {
  open: boolean;
  onClose: () => void;
  configFilePath?: string;
  onSaved?: () => void;
}

interface YamlSyntaxError {
  line: number;
  column?: number;
  message: string;
}

const DEFAULT_MODELS_YAML_TEMPLATE = `# ==============================================================================
# Conex / Crish - 统一模型能力与参数配置文件 (models.yaml)
# ==============================================================================
# 说明：
# 1. 本文件是全系统模型能力、参数、思考形态与计费标准的【绝对唯一真源 (SSOT)】。
# 2. 字段说明：
#    - model: 模型标识 (必填)
#    - vendor: 供应商名称 (必填)
#    - displayName: 界面展示名 (可选)
#    - contextWindow: 上下文窗口上限 (可选)
#    - maxOutputTokens: 单次最大生成上限 (可选)
#    - thinkingFormat: 思考格式 (reasoning_effort | thinking_budget | null)
#    - thinkingBudgetDefault: 默认预算 (可选)
#    - thinkingBudgetMax: 最大预算 (可选)
# ==============================================================================

version: 1

models:
  # --- DeepSeek ---
  - model: deepseek-chat
    vendor: deepseek
    displayName: DeepSeek V3
    contextWindow: 65536
    maxOutputTokens: 8192

  - model: deepseek-reasoner
    vendor: deepseek
    displayName: DeepSeek R1 (深度思考)
    contextWindow: 65536
    maxOutputTokens: 8192
    thinkingFormat: reasoning_effort

  # --- Anthropic Claude ---
  - model: claude-3-7-sonnet-20250219
    vendor: anthropic
    displayName: Claude 3.7 Sonnet
    contextWindow: 200000
    maxOutputTokens: 64000
    thinkingFormat: thinking_budget
    thinkingBudgetDefault: 4096
    thinkingBudgetMax: 64000

  # --- OpenAI ---
  - model: gpt-4o
    vendor: openai
    displayName: GPT-4o
    contextWindow: 128000
    maxOutputTokens: 16384
`;

const LOCAL_STORAGE_BACKUP_KEY = 'crish_models_yaml_backup_v1';

export const YamlConfigEditorModal: React.FC<YamlConfigEditorModalProps> = ({
  open,
  onClose,
  configFilePath = '~/.conex/models.yaml',
  onSaved,
}) => {
  const [code, setCode] = useState<string>('');
  const [originalCode, setOriginalCode] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [syntaxError, setSyntaxError] = useState<YamlSyntaxError | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const isDirty = useMemo(() => code !== originalCode, [code, originalCode]);

  // 计算行数
  const lineCount = useMemo(() => {
    return Math.max(1, code.split('\n').length);
  }, [code]);

  // 语法高亮 HTML（走现有 highlightCode）
  const highlightedHtml = useMemo(() => {
    // 结尾换行补全，避免 pre 在末尾少算一行高度
    const safeCode = code.endsWith('\n') ? code + ' ' : code;
    return highlightCode(safeCode, 'yaml');
  }, [code]);

  // 1. 读取配置文件
  const loadConfigFile = useCallback(async () => {
    setLoading(true);
    try {
      // 尝试调用后端读取 IPC
      const res = await invokeTyped<string>('workbench_read_models_yaml', {
        path: configFilePath,
      });

      if (res.status === 'ok' && typeof res.data === 'string' && res.data.trim()) {
        setCode(res.data);
        setOriginalCode(res.data);
        return;
      }

      // 未接线或纯前端回退：从 localStorage 恢复或使用预设模版
      let fallbackContent = '';
      try {
        fallbackContent = localStorage.getItem(LOCAL_STORAGE_BACKUP_KEY) || '';
      } catch {
        /* ignore */
      }

      const initial = fallbackContent || DEFAULT_MODELS_YAML_TEMPLATE;
      setCode(initial);
      setOriginalCode(initial);
    } finally {
      setLoading(false);
    }
  }, [configFilePath]);

  useEffect(() => {
    if (open) {
      void loadConfigFile();
      setSaveSuccess(false);
      setSyntaxError(null);
    }
  }, [open, loadConfigFile]);

  // 2. 实时语法诊断校验（带轻量前端探测防呆与后端校验）
  useEffect(() => {
    const timer = setTimeout(async () => {
      // 规则 A: 刚性拦截制表符 \t
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('\t')) {
          setSyntaxError({
            line: i + 1,
            column: line.indexOf('\t') + 1,
            message: 'YAML 规范严禁使用 Tab 制表符缩进，请替换为 2 个标准空格',
          });
          return;
        }
      }

      // 规则 B: 尝试通过 Rust 后端 serde_yaml 进行精细校验
      const res = await invokeTyped<{
        valid: boolean;
        line?: number;
        column?: number;
        message?: string;
      }>('validate_models_yaml', { content: code });

      if (res.status === 'ok') {
        if (!res.data.valid) {
          setSyntaxError({
            line: res.data.line || 1,
            column: res.data.column || 1,
            message: res.data.message || 'YAML 语法格式错误',
          });
          return;
        }
      }

      setSyntaxError(null);
    }, 200);

    return () => clearTimeout(timer);
  }, [code]);

  // 3. 滚动单向同步处理
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = scrollTop;
      preRef.current.scrollLeft = scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = scrollTop;
    }
  };

  // 4. Tab 键缩进与快捷键处理
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab 键处理
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;

      const { selectionStart, selectionEnd, value } = textarea;

      if (selectionStart === selectionEnd) {
        // 单光标插入 2 空格
        const next = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd);
        setCode(next);
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = selectionStart + 2;
        });
      } else {
        // 多行选中缩进/反缩进
        const startLineIdx = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const endLineIdx = value.indexOf('\n', selectionEnd);
        const sliceEnd = endLineIdx === -1 ? value.length : endLineIdx;
        const targetBlock = value.slice(startLineIdx, sliceEnd);
        const blockLines = targetBlock.split('\n');

        let nextBlock = '';
        let diff = 0;

        if (e.shiftKey) {
          // 反缩进
          const processed = blockLines.map((l) => {
            if (l.startsWith('  ')) {
              diff -= 2;
              return l.slice(2);
            }
            if (l.startsWith(' ')) {
              diff -= 1;
              return l.slice(1);
            }
            return l;
          });
          nextBlock = processed.join('\n');
        } else {
          // 正向缩进 2 空格
          const processed = blockLines.map((l) => {
            diff += 2;
            return '  ' + l;
          });
          nextBlock = processed.join('\n');
        }

        const next = value.slice(0, startLineIdx) + nextBlock + value.slice(sliceEnd);
        setCode(next);
        requestAnimationFrame(() => {
          textarea.selectionStart = startLineIdx;
          textarea.selectionEnd = Math.max(startLineIdx, selectionEnd + diff);
        });
      }
      return;
    }

    // Ctrl+S / Cmd+S 保存
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      void handleSave();
    }
  };

  // 5. 保存并热重载
  const handleSave = async () => {
    if (syntaxError) return;
    setSaving(true);
    try {
      const res = await invokeTyped<{ ok: boolean }>('workbench_save_models_yaml', {
        path: configFilePath,
        content: code,
      });

      // 无论后端是否已接线，同步写入 localStorage 容灾备份
      try {
        localStorage.setItem(LOCAL_STORAGE_BACKUP_KEY, code);
      } catch {
        /* ignore */
      }

      if (res.status === 'error') {
        throw new Error(res.message);
      }

      setOriginalCode(code);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      onSaved?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败';
      setSyntaxError({ line: 1, message: msg });
    } finally {
      setSaving(false);
    }
  };

  // 6. 一键跳转至错误行
  const handleJumpToError = () => {
    if (!syntaxError || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const targetLine = syntaxError.line;
    const targetCol = syntaxError.column || 1;

    const lines = code.split('\n');
    let charOffset = 0;
    for (let i = 0; i < targetLine - 1 && i < lines.length; i++) {
      charOffset += lines[i].length + 1;
    }

    const pos = Math.min(code.length, charOffset + Math.max(0, targetCol - 1));
    textarea.focus();
    textarea.setSelectionRange(pos, pos);

    // 垂直滚动定位
    const targetScrollTop = Math.max(0, (targetLine - 1) * 20 - 100);
    textarea.scrollTop = targetScrollTop;
  };

  // 7. 关闭请求（防丢失检查）
  const handleRequestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={handleRequestClose}
        size="lg"
        variant="modal"
        showCloseButton={true}
        title={
          <div className={styles.modalTitleRow}>
            <Lucide.FileCode2 size={16} className={styles.modalTitleIcon} aria-hidden />
            <span>模型能力与参数配置 (models.yaml)</span>
            {isDirty && <span className={styles.dirtyDot} title="有未保存修改">●</span>}
          </div>
        }
        description={
          <div className={styles.modalSubHeader}>
            <span className={styles.filePathBadge} title={configFilePath}>
              {configFilePath}
            </span>
          </div>
        }
        footer={
          <div className={styles.modalFooter}>
            {syntaxError ? (
              <div
                className={styles.errorBanner}
                onClick={handleJumpToError}
                role="button"
                tabIndex={0}
                title="点击直接跳转到错误行"
              >
                <Lucide.AlertCircle size={14} aria-hidden />
                <span className={styles.errorBannerText}>
                  第 {syntaxError.line} 行: {syntaxError.message} (点击定位)
                </span>
              </div>
            ) : saveSuccess ? (
              <div className={styles.successIndicator}>
                <Lucide.Check size={14} />
                <span>已保存并生效</span>
              </div>
            ) : (
              <div className={styles.toolbarInfo}>
                共 {lineCount} 行 ⏐ Tab 为 2 空格 ⏐ Ctrl+S 保存
              </div>
            )}

            <div className={styles.footerActions}>
              <Button type="button" variant="ghost" size="sm" onClick={handleRequestClose}>
                取消
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void handleSave()}
                loading={saving}
                disabled={Boolean(syntaxError) || !isDirty || saving}
                icon={<Lucide.Save size={13} aria-hidden />}
              >
                保存并热重载
              </Button>
            </div>
          </div>
        }
      >
        {/* 顶部轻量工具栏 */}
        <div className={styles.editorToolbar}>
          <div className={styles.toolbarLeft}>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => setCode(DEFAULT_MODELS_YAML_TEMPLATE)}
              icon={<Lucide.FileText size={12} aria-hidden />}
            >
              恢复标准模版
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => void loadConfigFile()}
              icon={<Lucide.RefreshCw size={12} aria-hidden />}
            >
              重载磁盘
            </Button>
          </div>
          <div className={styles.toolbarRight}>
            <span className={styles.toolbarInfo}>
              {isDirty ? '已修改' : '已同步'}
            </span>
          </div>
        </div>

        {/* 双层同步编辑器核心舞台 */}
        <div className={styles.editorViewport}>
          {/* 行号栏 Gutter */}
          <div ref={gutterRef} className={styles.gutter} aria-hidden>
            {Array.from({ length: lineCount }).map((_, idx) => {
              const lineNum = idx + 1;
              const isErr = syntaxError?.line === lineNum;
              return (
                <div
                  key={lineNum}
                  className={`${styles.gutterLine} ${isErr ? styles.gutterLineError : ''}`}
                >
                  {lineNum}
                </div>
              );
            })}
          </div>

          {/* 双层重叠区 */}
          <div className={styles.editorStage}>
            {/* 背景语法高亮层 */}
            <pre ref={preRef} className={styles.highlightLayer} aria-hidden>
              <code
                className={styles.highlightCode}
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            </pre>

            {/* 前景文本输入捕获层 */}
            <textarea
              ref={textareaRef}
              className={styles.textareaInput}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onScroll={handleScroll}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              placeholder="请输入 models.yaml 配置..."
              disabled={loading}
            />
          </div>
        </div>
      </Dialog>

      {/* 防丢失确认弹窗 */}
      <ConfirmDialog
        open={showDiscardConfirm}
        title="放弃未保存的修改？"
        description="你对 models.yaml 的修改尚未保存，退出后更改将丢失。"
        confirmLabel="放弃修改退出"
        cancelLabel="继续编辑"
        danger={true}
        onConfirm={() => {
          setShowDiscardConfirm(false);
          setCode(originalCode);
          onClose();
        }}
        onCancel={() => setShowDiscardConfirm(false)}
      />
    </>
  );
};
```

---

### 5.3 `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx`

```tsx
import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 模型：选择服务商、配置密钥，并管理可用模型。
 *
 * Task-F 升级说明：
 * 1. 顶栏升级为 [ 配置文件 (YAML) ▾ ] 组合按钮 (Split Button)；
 * 2. 支持一键打开内置轻量双层代码编辑器弹窗 (YamlConfigEditorModal)；
 * 3. 支持调起外部系统编辑器 (VS Code/Cursor/Zed/记事本等) 与资源管理器定位；
 * 4. 落实审计 1：同厂商自愈降级与置空引导，严禁跨服务商隐式静默切模；
 * 5. 接入 metaTick 响应式驱动，联动 ModelsCascadeSelect 即时重绘。
 */
import React, { useCallback, useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  activateProfileModel,
  clearActiveModelId,
  type ProviderProfile,
} from '../../api/providerProfiles';
import { getModelMeta } from '../../api/modelCatalog';
import {
  listHostOpeners,
  openPathDefault,
  openWithHostOpener,
  type HostOpener,
} from '../../api/hostOpenersApi';
import styles from './ModelsSettingsTab.module.css';
import yamlStyles from './YamlConfigEditorModal.module.css';
import { Button, Menu } from '../ui';
import type { SelectOptionItem } from '../ui';
import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../settings/SettingsUI';
import {
  emptyAddDraft,
  PRESETS,
  useModelProfilesState,
  type PresetProvider,
} from './useModelProfilesState';
import { ModelProfileList, ModelsCascadeSelect } from './ModelProfileList';
import { ModelConfigEditor } from './ModelConfigEditor';
import { YamlConfigEditorModal } from './YamlConfigEditorModal';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

/**
 * 停用模型后的活动模型自愈解析器（落实审计 1，严禁跨厂商静默切换）
 */
function resolveActiveModelAfterMetaChange(
  currentActive: { profileId: string; model: string } | null,
  profiles: readonly ProviderProfile[],
  isModelEnabled: (profileId: string, model: string) => boolean
): { nextActive: { profileId: string; model: string } | null; selfHealed: boolean } {
  if (!currentActive || !currentActive.profileId || !currentActive.model) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 1. 若当前活动模型仍处于启用态，无需自愈
  if (isModelEnabled(currentActive.profileId, currentActive.model)) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 2. 当前活动模型已被停用！仅在【同服务商】内部寻找下一个已启用的模型
  const currentProfile = profiles.find((p) => p.id === currentActive.profileId);
  const sameProviderNext = currentProfile?.models.find((m) => {
    if (m === currentActive.model) return false;
    return isModelEnabled(currentActive.profileId, m);
  });

  if (sameProviderNext) {
    return {
      nextActive: {
        profileId: currentActive.profileId,
        model: sameProviderNext,
      },
      selfHealed: true,
    };
  }

  // 3. 该服务商已无任何可用模型 -> 严禁跨厂商切换！直接置空以引导手动选择
  return { nextActive: null, selfHealed: true };
}

/**
 * 「添加服务商」下拉
 */
export const AddProviderMenu: React.FC<{
  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
  onAddTemplate: (format: 'openai' | 'anthropic') => void;
  onAddPreset: (preset: PresetProvider) => void;
}> = ({ addOpen, setAddOpen, onAddTemplate, onAddPreset }) => {
  const menuOptions: SelectOptionItem[] = [
    {
      id: 'openai',
      label: 'OpenAI 格式',
      onClick: () => onAddTemplate('openai'),
    },
    {
      id: 'anthropic',
      label: 'Anthropic 格式',
      onClick: () => onAddTemplate('anthropic'),
    },
    ...PRESETS.map((pr) => ({
      id: pr.id,
      label: pr.name,
      onClick: () => onAddPreset(pr),
    })),
  ];

  return (
    <Menu
      openState={{ open: addOpen, onOpenChange: setAddOpen }}
      position={{ align: 'end', side: 'bottom', sideOffset: 6 }}
      options={menuOptions}
      panel={{ contentClassName: styles.addProviderMenu }}
      trigger={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={styles.addServiceBtn}
          aria-label="添加服务商"
          icon={<Lucide.Plus size={13} style={{ opacity: 0.75 }} aria-hidden />}
        >
          添加服务商
        </Button>
      }
    >
      <div role="menu" aria-label="添加服务商">
        <div className={styles.addMenuTitle}>接口类型</div>
        <button
          type="button"
          role="menuitem"
          className={styles.addMenuOption}
          onClick={() => onAddTemplate('openai')}
        >
          OpenAI 格式
        </button>
        <button
          type="button"
          role="menuitem"
          className={styles.addMenuOption}
          onClick={() => onAddTemplate('anthropic')}
        >
          Anthropic 格式
        </button>

        <div className={`${styles.addMenuTitle} ${styles.addMenuTitleGap}`}>
          常用服务
        </div>
        {PRESETS.map((pr) => (
          <button
            key={pr.id}
            type="button"
            role="menuitem"
            className={styles.addMenuOption}
            onClick={() => onAddPreset(pr)}
          >
            {pr.name}
          </button>
        ))}
      </div>
    </Menu>
  );
};

export const ModelsSettingsTab: React.FC<Props> = ({ _onBlockingOverlayChange }) => {
  const { showToast: _showToast } = useToast();
  const {
    profiles,
    setProfiles,
    selectedId,
    setSelectedId,
    selected,
    keyDraft,
    setKeyDraft,
    addOpen,
    setAddOpen,
    testBusy,
    scanBusy,
    checkBusy,
    modelFilter,
    setModelFilter,
    configOpenId,
    manualOpen,
    setManualOpen,
    addDraft,
    setAddDraft,
    cfgDraft,
    setCfgDraft,
    editingName,
    setEditingName,
    nameDraft,
    setNameDraft,
    confirmDeleteId,
    setConfirmDeleteId,
    refresh,
    notify,
    saveKey,
    addFromTemplate,
    addFromPreset,
    handleManualAdd,
    openConfigFor,
    closeConfig,
    saveConfig,
    runTest,
    runScan,
    runCheck,
    modelsList,
    modelsCount,
    selectedLabel,
    hasKeySelected,
    activeProfileId,
    globalActiveModelId,
    // 解构 Task-A/Task-C 注入的 metaTick（若尚未装配则安全回落 0）
    metaTick = 0,
  } = useModelProfilesState() as ReturnType<typeof useModelProfilesState> & {
    metaTick?: number;
  };

  // ── YAML 编辑器与打开方式状态 ──────────────────────────────────────────
  const [yamlEditorOpen, setYamlEditorOpen] = useState(false);
  const [yamlMenuOpen, setYamlMenuOpen] = useState(false);
  const [availableOpeners, setAvailableOpeners] = useState<HostOpener[]>([]);
  const configFilePath = '~/.conex/models.yaml';

  // 扫描外部可用编辑器
  useEffect(() => {
    let active = true;
    listHostOpeners()
      .then((openers) => {
        if (!active) return;
        const filtered = openers.filter(
          (o) =>
            o.available &&
            (o.kind === 'editor' ||
              ['vscode', 'cursor', 'zed', 'windsurf', 'trae'].includes(o.id) ||
              o.id.includes('notepad'))
        );
        setAvailableOpeners(filtered);
      })
      .catch(() => {
        /* swallow-ok */
      });
    return () => {
      active = false;
    };
  }, []);

  // ── 审计 1 落实：同厂商自愈降级与置空引导（metaTick 驱动）──────────────
  useEffect(() => {
    if (!activeProfileId || !globalActiveModelId) return;

    const currentActive = {
      profileId: activeProfileId,
      model: globalActiveModelId,
    };

    const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
      currentActive,
      profiles,
      (pId, m) => getModelMeta(pId, m).enabled !== false
    );

    if (selfHealed) {
      if (nextActive) {
        void activateProfileModel(nextActive.profileId, nextActive.model);
        notify(
          true,
          `当前模型已停用，已自动切换至同厂商模型: ${nextActive.model}`
        );
      } else {
        clearActiveModelId();
        notify(false, `当前服务商已无可用模型，请手动选择`);
      }
    }
  }, [metaTick, profiles, activeProfileId, globalActiveModelId, notify]);

  // 调起指定外部编辑器
  const handleOpenExternal = useCallback(
    async (openerId: string) => {
      setYamlMenuOpen(false);
      try {
        await openWithHostOpener(openerId, configFilePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '打开失败';
        notify(false, msg);
      }
    },
    [configFilePath, notify]
  );

  // 调起系统默认程序
  const handleOpenDefault = useCallback(async () => {
    setYamlMenuOpen(false);
    try {
      await openPathDefault(configFilePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '打开失败';
      notify(false, msg);
    }
  }, [configFilePath, notify]);

  // 资源管理器定位
  const handleReveal = useCallback(async () => {
    setYamlMenuOpen(false);
    try {
      await openWithHostOpener('system-file-manager', configFilePath);
    } catch {
      try {
        await openPathDefault(configFilePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '定位失败';
        notify(false, msg);
      }
    }
  }, [configFilePath, notify]);

  // 复制路径
  const handleCopyPath = useCallback(() => {
    setYamlMenuOpen(false);
    try {
      void navigator.clipboard.writeText(configFilePath);
      notify(true, '已复制配置文件绝对路径');
    } catch {
      notify(false, '复制失败');
    }
  }, [configFilePath, notify]);

  // 外部菜单键盘选项定义
  const yamlMenuOptions: SelectOptionItem[] = [
    {
      id: 'builtin',
      label: '内置编辑器打开',
      onClick: () => {
        setYamlMenuOpen(false);
        setYamlEditorOpen(true);
      },
    },
    ...availableOpeners.map((op) => ({
      id: op.id,
      label: op.name,
      onClick: () => void handleOpenExternal(op.id),
    })),
    {
      id: 'default',
      label: '系统默认程序打开',
      onClick: () => void handleOpenDefault(),
    },
    {
      id: 'reveal',
      label: '在文件资源管理器中定位',
      onClick: () => void handleReveal(),
    },
    {
      id: 'copy-path',
      label: '复制绝对路径',
      onClick: handleCopyPath,
    },
  ];

  // ── 顶栏操作区：配置文件 (YAML) 组合按钮 + 添加服务商 ──────────────────
  const headerMeta = (
    <div className={yamlStyles.headerActionGroup}>
      {/* 配置文件 (YAML) 组合 Split Button */}
      <div className={yamlStyles.configButtonCombo}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Lucide.FileCode2 size={13} style={{ opacity: 0.8 }} aria-hidden />}
          onClick={() => setYamlEditorOpen(true)}
          aria-label="在内置编辑器中编辑配置文件 (YAML)"
        >
          配置文件 (YAML)
        </Button>
        <Menu
          openState={{ open: yamlMenuOpen, onOpenChange: setYamlMenuOpen }}
          position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
          options={yamlMenuOptions}
          panel={{ contentClassName: yamlStyles.yamlDropdownMenu }}
          trigger={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={yamlStyles.configMenuTrigger}
              aria-label="配置文件直达与打开方式"
              icon={<Lucide.ChevronDown size={13} aria-hidden />}
            />
          }
        >
          <div role="menu" aria-label="配置文件直达选项">
            <div className={yamlStyles.menuSectionTitle}>配置文件 (models.yaml)</div>
            <button
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={() => {
                setYamlMenuOpen(false);
                setYamlEditorOpen(true);
              }}
            >
              <Lucide.Code size={13} aria-hidden />
              内置编辑器打开
            </button>

            <div className={yamlStyles.menuDivider} />
            <div className={yamlStyles.menuSectionTitle}>外部编辑器调起</div>

            {availableOpeners.map((op) => (
              <button
                key={op.id}
                type="button"
                role="menuitem"
                className={yamlStyles.menuItemBtn}
                onClick={() => void handleOpenExternal(op.id)}
              >
                <Lucide.ExternalLink size={13} aria-hidden />
                {op.name}
              </button>
            ))}

            <button
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={() => void handleOpenDefault()}
            >
              <Lucide.ExternalLink size={13} aria-hidden />
              系统默认程序打开
            </button>

            <div className={yamlStyles.menuDivider} />
            <div className={yamlStyles.menuSectionTitle}>文件操作</div>

            <button
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={() => void handleReveal()}
            >
              <Lucide.FolderOpen size={13} aria-hidden />
              在文件资源管理器中定位
            </button>

            <button
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={handleCopyPath}
            >
              <Lucide.Copy size={13} aria-hidden />
              复制绝对路径
            </button>
          </div>
        </Menu>
      </div>

      {/* 添加服务商 */}
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <AddProviderMenu
          addOpen={addOpen}
          setAddOpen={setAddOpen}
          onAddTemplate={addFromTemplate}
          onAddPreset={addFromPreset}
        />
      </div>
    </div>
  );

  return (
    <SettingsPage title="模型" meta={headerMeta}>
      {/* Default model */}
      <SettingsSection title="默认模型">
        <SettingsCard>
          <SettingsRow
            title="全局默认模型"
            desc="新建对话时使用此模型"
            control={
              <ModelsCascadeSelect
                profiles={profiles}
                activeProfileId={activeProfileId || ''}
                activeModelId={globalActiveModelId || ''}
                metaTick={metaTick}
                onChange={(pId, mId) => {
                  void activateProfileModel(pId, mId);
                }}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* Provider split layout */}
      <div className={`${styles.modelsSplit} models-split`}>
        <ModelProfileList
          profiles={profiles}
          selectedId={selectedId}
          onSelectProfile={setSelectedId}
        />

        <ModelConfigEditor
          providerConfig={{
            selected,
            profiles,
            selectedLabel,
            hasKeySelected,
            editingName,
            nameDraft,
            setNameDraft,
            setEditingName,
            confirmDeleteId,
            setConfirmDeleteId,
            keyDraft,
            setKeyDraft,
            saveKey,
            refresh,
            notify,
            setProfiles,
            setSelectedId,
          }}
          modelConfig={{
            runCheck,
            runScan,
            checkBusy,
            scanBusy,
            modelFilter,
            setModelFilter,
            manualOpen,
            setManualOpen,
            addDraft,
            setAddDraft,
            handleManualAdd,
            emptyAddDraft,
            modelsList,
            modelsCount,
          }}
          capConfig={{
            configOpenId,
            cfgDraft,
            setCfgDraft,
            openConfigFor,
            closeConfig,
            saveConfig,
            runTest,
            testBusy,
          }}
        />
      </div>

      {/* 内置轻量 YAML 编辑器弹窗 */}
      <YamlConfigEditorModal
        open={yamlEditorOpen}
        onClose={() => setYamlEditorOpen(false)}
        configFilePath={configFilePath}
        onSaved={refresh}
      />
    </SettingsPage>
  );
};
```

---

## 六、 立体化工程验证与守门断言

为保障代码在交付后通过全系统门禁，执行 Agent 必须完成以下立体化验证：

### 6.1 静态检查与行数门禁自测

```powershell
# 1. 语法与 TypeScript 类型检查（要求 0 errors）
npm run typecheck

# 2. 全量文件行数门禁检查（要求 1180 个文件 0 违规）
npm run check:line-counts

# 3. 关联单元测试套件跑通
npm test -- apps/crish-desktop/src/components/settings-models/
```

### 6.2 8 项核心功能与极端边界验收断言矩阵

| 断言编号 | 测试维度 | 操作步骤 / 触发输入 | 预期物理表现与契约断言 |
| :---: | :--- | :--- | :--- |
| **AC-F01** | 顶栏按钮外观 | 进入“设置 · 模型”页面 | 顶栏呈现 `[ 配置文件 (YAML) ▾ ]` 与 `[+ 添加服务商 ▾]`，样式整洁，无 2px 高度错位。 |
| **AC-F02** | 内置弹窗秒开 | 点击 `[ 配置文件 (YAML) ]` 主按钮 | 立即弹出 `YamlConfigEditorModal`，代码呈现 highlight.js 彩色语法高亮，光标初始聚焦。 |
| **AC-F03** | 双层滚动同步 | 垂直与水平快速滚动编辑器 | 行号栏、背景 `<pre>` 与前景 `<textarea>` 像素级无缝同步，无文字漂移或抖动。 |
| **AC-F04** | Tab 缩进处理 | 敲击 `Tab` 键 / `Shift + Tab` | 单光标插入 2 个标准空格；多行整体向右/向左缩进 2 空格；**代码中绝对不存在 `\t`**。 |
| **AC-F05** | 语法错误定位 | 输入非法字符（如带有 `\t` 或缺少 `:`） | 行号标红，底栏显示黄色警告横幅；点击横幅，光标自动跳转到错误行并将视口居中。 |
| **AC-F06** | 脏状态防丢 | 修改文本后按 `Esc` 或点遮罩 | 拦截关闭并呼出 `ConfirmDialog`；点“继续编辑”保留改动；点“放弃修改”恢复初始快照。 |
| **AC-F07** | 审计 1 同厂降级 | 停用当前活动模型（同厂商还有其他模型） | `metaTick` 触发自愈，活动模型自动切换到**同服务商**下一个已启用模型，Toast 告知。 |
| **AC-F08** | 审计 1 置空引导 | 停用当前活动模型（该厂商无其他可用模型） | **严禁切换到其他服务商！** 活动模型直接置空，级联菜单呈空态，引导用户手动挑选。 |

---

## 七、 执行 Agent 开工检查单（Ready to Implement）

- [ ] 核对文件域权限：仅限修改/新增上述 3 个指定文件，**绝不修改 `ModelsSettingsTab.module.css`**；
- [ ] 严禁 `git commit` / `git checkout` / `git reset`；
- [ ] 使用 **pwsh7** 执行命令，文件输出使用 **UTF-8 无 BOM**；
- [ ] 实现完成后运行 `npm run typecheck` 验证 0 错误；
- [ ] 向主控 Agent 汇报交付结果。
