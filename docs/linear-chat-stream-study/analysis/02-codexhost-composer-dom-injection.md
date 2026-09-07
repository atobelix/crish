# CodexHost Composer DOM 注入与交互机制专项分析报告

> **报告编号**：A02  
> **所属战役**：`docs/linear-chat-stream-study/`（线性对话流与极简 AI 界面研究）  
> **研究对象**：`reference/codex-host` 仓库  
> **重点源码文件**：
> - `packages/renderer-extension/src/renderer-composer-dom.ts`
> - `packages/renderer-extension/src/renderer-binding-probe.ts`
> - `packages/renderer-extension/src/renderer-agent-picker.ts`
> - `packages/renderer-extension/src/renderer-model-picker.ts`
> - `packages/renderer-extension/src/renderer-permission-mode-picker.ts`
> - `packages/renderer-extension/src/renderer-trigger-chip-style.ts`
> - `packages/renderer-extension/src/versioned-renderer-adapter.ts`
> - `design-qa.md`

---

## 摘要与核心发现

CodexHost 作为深度接管 Codex Desktop 的渲染层扩展，其在无源码侵入、宿主高频版本迭代的前提下，实现了一套**极度精密、无闪烁、无重流且视觉 100% 原生对齐**的 Composer DOM 注入与拦截系统。其核心技术亮点包括：

1. **精准定位与双重契约寻址**：通过根属性选择器 `[data-codex-composer-root]` 和编辑器模式匹配，首选直属 Portal 标记 (`[data-above-composer-portal]`) 区分 Draft 与 Conversation 线程；在缺失属性的旧版中，穿透深达 120 层的 React 18 Fiber 内部状态机 (`updateQueue.memoCache`) 提取草稿与会话标识，实现 fail-closed 级别的绝对防歧义。
2. **尾部集群锚定与零重流插入（Zero-Reflow Mounting）**：通过向上 3 层回溯识别发送按钮前的同级末尾控制组（如原生语音、听写按钮），将外部 Agent、Model、Permission 控件精准锚定在尾部动作组左侧；在 DOM 插入前严格比对 `parentElement` 与 `nextElementSibling` 拓扑关系，拓扑未变时直接跳过 DOM 操作，彻底消除了 Layout Thrashing。
3. **原生控件的无损压制与动态克隆恢复（Lossless Native Suppression）**：不直接移除（`remove()`）React 托管的 DOM 节点，而是对原生 Model 与 Permission 控件做状态快照（`hidden`, `aria-hidden`），在失焦 (`blur()`) 并关闭展开菜单后温和隐藏；在切换回 Codex 原生时完整回弹恢复，使 React Fiber 树的虚拟 DOM 结构与原生事件分发完好无损。
4. **状态跨宿主无缝平移（Seamless Replacement Transfer）**：通过 `MutationObserver` 捕获由 React 重渲染导致的 Composer 节点销毁与重建，建立 `removedNodes` 与 `addedNodes` 的 1:1 置换映射，在微任务（Microtask）中瞬间平移模型选型、思考档位与草稿状态，完全杜绝了会话创建瞬间的界面闪烁与配置丢失。
5. **事件拦截与输入意图全守卫**：在全局捕获阶段（Capture Phase）对键盘与输入事件进行两级精细分流：`isComposerInputIntent` 精确区分文本键入、输入法合成（IME `Process` 键）、剪切粘贴与无害导航；`isComposerSubmissionKey` 强力过滤 IME 组字态与 Shift 换行；在状态切换或配置校验未就绪时，硬件级截断提交并使能发送按钮锁定。
6. **对齐原生的高保真视觉规约**：基于 `design-qa.md` 的迭代实证，确立了 13px 字体基线、52px 紧凑行高、Quiet Dividers 克制分割、系统 `color-scheme` 原生继承与 `TRIGGER_CHIP_CLASS` 胶囊设计，严禁粗暴黑边与重阴影。

---

## 一、Codex Desktop 输入区域的精准定位与接管机制

CodexHost 运行在与 Codex Desktop WebView2 相同的渲染进程上下文。面对 React 18 驱动的黑盒单页应用，首要难题是如何稳健地寻址输入根节点并判断当前属于新建草稿（Draft）还是已有会话（Conversation）。

### 1.1 核心选择器契约

在 `packages/renderer-extension/src/renderer-composer-dom.ts` 中定义了输入区域的核心选择器：

```typescript
// renderer-composer-dom.ts:56-58
export const CODEX_COMPOSER_SELECTOR = "[data-codex-composer-root]";
export const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';
```

- **`CODEX_COMPOSER_SELECTOR`**：Codex 官方在 Composer 根容器上注入的 DOM 属性 `data-codex-composer-root`。
- **`EDITOR_SELECTOR`**：多形态文本输入框模式，同时兼容传统 `<textarea>`、富文本 `contenteditable="true"` 与 ARIA `role="textbox"`。

### 1.2 会话目标判定：Scoped Portal 与 React Fiber 回退机制

在 `packages/renderer-extension/src/versioned-renderer-adapter.ts` 中，`findComposerModelTarget(composer)` 承担了识别 Composer 到底绑定在哪个会话的核心职责：

```typescript
// versioned-renderer-adapter.ts:728-747
export function findComposerModelTarget(composer: Element): readonly unknown[] | null {
  const draftIds = findComposerDraftIds(composer);
  const domIdentity = findComposerDomIdentity(composer);
  if (domIdentity.kind === "ambiguous") return null;
  if (domIdentity.kind === "conversation") {
    return ["conversation", domIdentity.threadId];
  }
  if (domIdentity.kind === "draft") {
    return draftIds.size === 1 ? ["default", draftIds.values().next().value] : null;
  }

  // Older supported Desktop builds do not expose the scoped portal marker.
  // Retain their reviewed Fiber fallback, including fail-closed ambiguity.
  const conversationThreadId = findComposerConversationThreadId(composer);
  if (conversationThreadId === null) return null;
  if (conversationThreadId !== undefined) return ["conversation", conversationThreadId];

  if (draftIds.size !== 1) return null;
  return ["default", draftIds.values().next().value];
}
```

#### 现代构建（Scoped Portal DOM Marker）
在 `versioned-renderer-adapter.ts:684-701` 的 `findComposerDomIdentity` 中：
- 检索 `composer.children` 下直属的 `[data-above-composer-portal]`；
- 若无此 portal，标记为 `"unsupported"` 回退到 Fiber；
- 若 portal 数量大于 1，直接标记为 `"ambiguous"`（防误绑定，Fail-Closed）；
- 读取属性 `data-above-composer-conversation-id`：
  - 若为 `null`，代表未提交的草稿阶段（`"draft"`）；
  - 若存在，经过 `hostThreadIdSchema.safeParse` 校验后判定为真实会话（`"conversation"`）。

#### 历史与旧版构建（React Fiber Traversal）
当 DOM Portal 不存在时，通过 `findComposerDraftIds`（`versioned-renderer-adapter.ts:703-725`）自 DOM 节点获取 `__reactFiber$` 属性，向上递归多达 120 层：
- 探查 `fiber.updateQueue.memoCache.data`；
- 寻找特征对象 `isCurrentDraftWrapper(value)`（特征匹配：数组长度 7，存在 `modelSettings` 与 `isManuallyChanged`）；
- 提取 `client-new-thread:*` 前缀的临时草稿 ID。

### 1.3 提交按钮的鲁棒识别

Composer 内通常包含多个操作按钮（语音、附件、取消、提交等）。`renderer-composer-dom.ts:130-133` 与 `164-170` 实现了跨语言、跨语义的提交按钮提取：

```typescript
// renderer-composer-dom.ts:130-133
export function isComposerSubmitButton(button: HTMLButtonElement): boolean {
  if (button.type === "submit") return true;
  return /(^|\s)(send|submit|发送|提交)(\s|$)/u.test(buttonText(button));
}

// renderer-composer-dom.ts:164-170
export function sendButtonWithin(root: Element): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      isComposerSubmitButton(button),
    ) ?? null
  );
}
```
`buttonText(button)` 不仅获取按钮文本，还联合提取了 `type`、`aria-label`、`title` 与 `data-testid`，保证中英版本与无文本图标按钮均能精准识别；当无法精确命中正则时，在挂载点回退采用最后一个按钮（`allButtons.at(-1)`）。

---

## 二、零闪烁、零重流的控制选择器挂载体系

在接管原生 Composer 时，CodexHost 需要在原生工具栏中注入：
1. **Agent 选择器** (`RendererAgentPickerControl`)
2. **Model 选择器** (`RendererModelPickerControl`)
3. **权限模式选择器** (`RendererPermissionModePickerControl`)
4. **账号 Credits 标签** 与 **Context Usage 使用量环**

### 2.1 尾部动作集群锚定（Trailing Action Anchor）与层级回溯

在现代 IM/AI 对话输入框中，发送按钮附近常伴生语音听写（Voice/Dictation）或取消（Cancel）按钮。若粗暴地执行 `sendButton.before(element)`，会导致 Agent/Model 控件插在语音按钮与发送按钮之间，造成视觉撕裂。

CodexHost 在 `renderer-composer-dom.ts:135-196` 中设计了**尾部动作回溯寻址算法**：

```typescript
// renderer-composer-dom.ts:135-154
const VOICE_CONTROL_PATTERN =
  /(dictat|microphone|speech(?:[-_\s]?to[-_\s]?text)?|voice[-_\s]?input|(^|\s)voice(\s|$)|composer[-_](?:speech|dictat|mic)|语音|听写|麦克风|pause|暂停|stop recording|stop dictation|停止录音|停止听写|(^|\s)stop(\s|$))/iu;
const CANCEL_CONTROL_PATTERN = /(cancel|discard|close|dismiss|取消|关闭|丢弃)/iu;
const TRAILING_ACTION_WALK_DEPTH = 3;

// renderer-composer-dom.ts:172-196
function leftmostTrailingSibling(container: Element, before: Element): HTMLElement | null {
  for (const child of container.children) {
    if (child === before) break;
    if (typeof (child as HTMLElement).hasAttribute !== "function") continue;
    const element = child as HTMLElement;
    if (isOwnedRendererControl(element) || isComposerCancelButton(element)) continue;
    if (isTrailingActionNode(element)) return element;
  }
  return null;
}

export function trailingActionAnchor(sendButton: HTMLButtonElement): HTMLElement {
  let container: HTMLElement | null = sendButton.parentElement;
  let before: HTMLElement = sendButton;
  for (let depth = 0; container && depth < TRAILING_ACTION_WALK_DEPTH; depth += 1) {
    if (typeof container.matches === "function" && container.matches(CODEX_COMPOSER_SELECTOR)) {
      break;
    }
    const candidate = leftmostTrailingSibling(container, before);
    if (candidate) return candidate;
    before = container;
    container = container.parentElement;
  }
  return sendButton;
}
```

**寻址逻辑图解**：
```
Toolbar Container (Flex Row)
├── [Other Controls...]
├── [Injected Model Picker]     <-- 目标挂载点（Anchor 之前）
├── [Injected Agent Picker]     <-- 目标挂载点（Anchor 之前）
└── Trailing Cluster:
    ├── [Voice / Mic Button]    <-- leftmostTrailingSibling 命中为 Anchor
    └── [Send Submit Button]    <-- 原生发送按钮
```
该算法通过向上递归 3 层检测同级子节点中的 `isTrailingActionNode`（匹配麦克风、语音听写或纯尾部按钮组），将锚点定位为**尾部动作群的最左侧元素**。外部控件注入到该锚点之前，确保了无论宿主布局怎么嵌套，Agent 与 Model 选择器始终稳定位于整个操作集群的左侧。

### 2.2 拓扑差量校验：杜绝 Layout Thrashing

频繁操作 DOM 会触发浏览器的重排（Reflow）与重绘（Repaint）。在每轮扫描、状态同步与会话激活时，CodexHost 在操作 DOM 前执行严格的拓扑校验：

```typescript
// renderer-composer-dom.ts:485-503
function refreshTrailingClusterPlacement(control: ComposerAgentControl): void {
  const sendButton = control.sendButton;
  const modelRoot = control.modelPicker?.root;
  const agentRoot = control.root ?? control.picker?.root;
  if (!sendButton || !modelRoot || !agentRoot) return;
  const anchor = trailingActionAnchor(sendButton);
  const parent = anchor.parentElement;
  if (!parent || typeof parent.insertBefore !== "function") return;

  // 拓扑一致性短路判断：父节点、前后相对兄弟节点完全符合预期时直接退出
  if (
    modelRoot.parentElement === parent &&
    agentRoot.parentElement === parent &&
    modelRoot.nextElementSibling === agentRoot &&
    agentRoot.nextElementSibling === anchor
  ) {
    return;
  }
  parent.insertBefore(modelRoot, anchor);
  parent.insertBefore(agentRoot, anchor);
}
```
只有当节点的 DOM 结构遭到破坏或初次初始化时，才调用两次 `insertBefore`。这一设计确保了 `MutationObserver` 轮询和频繁状态渲染时**零重复 DOM 移动、零计算重排**。

### 2.3 权限模式（Permission Mode）选择器的 Fiber 深度嗅探

原生的权限模式控件是一个带菜单的按钮。为了无缝替代它，CodexHost 首先通过属性和 React Fiber 校验确认原生权限控件的位置：

```typescript
// renderer-composer-dom.ts:268-311
export function isNativePermissionModeControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-codexhost-permission-mode-control") ||
    !element.matches('button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]')
  ) {
    return false;
  }
  const fiberName = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith("__reactFiber$"),
  );
  let fiber = ...;
  let ownsTrigger = false;
  let ownsComposerPermissionState = false;
  for (let depth = 0; fiber && depth < 60; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props)) {
      if (
        props["data-composer-navigation-target"] === "permissions" &&
        props["aria-haspopup"] === "menu"
      ) {
        ownsTrigger = true;
      }
      if (
        typeof props.showPermissionsModeDropdown === "boolean" &&
        typeof props.permissionsHostId === "string" &&
        "permissionsCwdOverride" in props
      ) {
        ownsComposerPermissionState = true;
      }
    }
    fiber = fiber.return;
  }
  return ownsTrigger && ownsComposerPermissionState;
}
```
一旦检测并核实原生权限按钮，CodexHost 直接将自己的 `permissionModePicker.root` 插入到原生按钮的前方：
`permissionParent.insertBefore(control.permissionModePicker.root, nativePermissionModeControl.element)`。

### 2.4 原生控件的无损暂存与安全隐藏（Lossless Suppression）

当激活外部 Agent（如 Claude Code, DeepSeek, Antigravity）时，Codex 原生的模型与权限按钮必须隐藏；而当切回 Codex 时，原生控件必须完好无损地复现。

如果直接对原生节点调用 `remove()`，会导致 React 内部 Fiber 引用断裂，下一次宿主 React 更新就会抛出 `NotFoundError: Failed to execute 'removeChild' on 'Node'` 灾难崩溃。CodexHost 采用了严格的可逆隐蔽机制：

```typescript
// renderer-composer-dom.ts:425-440
function captureNativeControl(element: HTMLElement | null): NativeControlState | null {
  return element
    ? {
        element,
        hidden: element.hidden,
        ariaHidden: element.getAttribute("aria-hidden"),
      }
    : null;
}

function restoreNativeControl(state: NativeControlState | null | undefined): void {
  if (!state) return;
  state.element.hidden = state.hidden;
  if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
  else state.element.setAttribute("aria-hidden", state.ariaHidden);
}

// renderer-composer-dom.ts:555-577
function setNativeControlHidden(
  state: NativeControlState | null | undefined,
  hidden: boolean,
): void {
  if (!state) return;
  if (!hidden) {
    restoreNativeControl(state);
    return;
  }
  if (state.element.hidden && state.element.getAttribute("aria-hidden") === "true") return;
  
  // 安全处理 1：如果隐藏前焦点停留在控件内部，强制主动 blur，防止焦点被销毁导致全局焦点丢失
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (
    active &&
    typeof (active as HTMLElement).blur === "function" &&
    state.element.contains(active)
  ) {
    (active as HTMLElement).blur();
  }
  // 安全处理 2：若隐藏前菜单正处于展开状态，模拟一次点击将其安全收起，防止幽灵弹窗悬浮
  if (state.element.getAttribute("aria-expanded") === "true") state.element.click();
  
  // 安全处理 3：双保险隐藏
  state.element.hidden = true;
  state.element.setAttribute("aria-hidden", "true");
}
```

### 2.5 原生 Context Usage 进度环保护与 Credits 分离

原生 Codex 拥有一个圆环状的上下文使用率指示器。CodexHost 在 `renderer-composer-dom.ts:344-348` 发现其 DOM 特征极其稳定：`span[role="img"][aria-label]` 且内部包含两个 `circle` SVG 节点。

- **不隐藏原生进度**：在 `reconcileComposerNativeControls`（行 596）中显式执行 `setNativeControlHidden(control.nativeContextUsageControl, false)`。外部 Harness 产生的使用量可以直接映射到该指示器；
- **锚点独立解耦**：Credits（账户余额）反映的是账号全局配额，而 Context Usage 反映的是当前线程窗口。行 475-483 与 521-533 将 `Credits` 独立锚定在 `permissionModePicker.root`，从而解除了对 Usage 加载位置的依赖，避免了因 Usage 数据未到达导致余额标签上下跳动的 Bug。

### 2.6 会话切换的 DOM 替换无缝平移（Mutation Replacement Transfer）

在 React 体系中，用户从 Draft 输入第一条消息提交后，React 会销毁 Draft Composer 并挂载真实的 Conversation Composer。为了避免在这个瞬间控件被卸载、闪烁或状态重置，CodexHost 在 `renderer-binding-probe.ts:2418-2454` 实现了**一对一替换检测器**：

```typescript
// renderer-binding-probe.ts:2418-2454
const transferReplacedComposers = (mutations: MutationRecord[]): void => {
  const replacements = new Map<Node, { removed: Set<Element>; added: Set<Element> }>();
  for (const mutation of mutations) {
    if (mutation.type !== "childList") continue;
    ...
    // 收集被移除的已挂载 composer 集合与新加入的 composer 集合
  }
  for (const replacement of replacements.values()) {
    // 精确匹配：父节点下刚好销毁 1 个并新增 1 个 composer
    if (replacement.removed.size !== 1 || replacement.added.size !== 1) continue;
    const source = replacement.removed.values().next().value as Element;
    const target = replacement.added.values().next().value as Element;
    const mounted = mountedByComposer.get(source);
    if (source !== target && mounted) {
      pendingReplacements.set(target, {
        source: mounted,
        sourceModelTarget: mounted.modelTarget,
      });
    }
  }
};
```
在紧随其后的微任务 `scan()`（行 2342-2361）中：
`controller.transfer(replacement.source.composer, target, ...)` 瞬间将上一代输入框中的 Agent 选择、已选模型、思考深度直接迁移至新 DOM，同时重用之前加载的模型目录，达成**绝对平滑、零感知**的会话升级。

---

## 三、输入意图检测与提交拦截状态机

在 Agent 切换（Switching）期间、账号变更中、或所选模型的 Catalog 尚未就绪前，用户在输入框键入内容或敲击回车，必须受到严格、无感的拦截，否则会把消息发送给错误的 Agent 或丢失参数。

### 3.1 键入意图检测（`isComposerInputIntent`）

在 `renderer-composer-dom.ts:202-207` 中，定义了什么样的按键属于“具有内容修改意图”：

```typescript
// renderer-composer-dom.ts:202-207
export function isComposerInputIntent(event: KeyboardEvent): boolean {
  if (event.key === "Backspace" || event.key === "Delete" || event.key === "Enter") return true;
  if (event.key === "Process") return true;
  if ((event.ctrlKey || event.metaKey) && ["v", "x"].includes(event.key.toLowerCase())) return true;
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}
```

**设计精妙点**：
- **IME 国际化支持**：特别检测 `event.key === "Process"`。在 Windows / macOS 上，使用微软拼音、仓颉、或日文输入法进行中文/日文拼写时，按键 key 值为 `"Process"`。如果不包含此判定，中文输入法敲打键盘将被判定为“非输入意图”，导致拦截穿透或逻辑误判。
- **快捷键净化**：允许 `Ctrl+V`（粘贴）与 `Ctrl+X`（剪切）判定为输入意图；而将 `Ctrl+C`（复制）、`Ctrl+A`（全选）、方向键（`ArrowLeft`, `ArrowRight`）等非破坏性按键排除在外。这样即使用户在切换中按方向键移动光标或复制文本，也不会遭到粗暴拦截。

### 3.2 键盘提交拦截判定（`isComposerSubmissionKey`）

```typescript
// renderer-composer-dom.ts:209-211
export function isComposerSubmissionKey(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
```

- **`!event.shiftKey`**：放行 Shift+Enter 换行操作；
- **`!event.isComposing`**：在 IME 组字（拼音选词敲击回车上屏）过程中，`event.isComposing` 为 `true`，严禁触发消息提交。这根除了许多 Web 对话界面在中文输入回车时意外把半截拼音发出去的恶性体验缺陷。

### 3.3 捕获阶段（Capture Phase）立体化拦截网

在 `renderer-binding-probe.ts:2609-2612` 中，全局监听挂载在顶层 Document 的**捕获阶段**（`useCapture = true`）：

```typescript
// renderer-binding-probe.ts:2609-2612
document.addEventListener("beforeinput", onBeforeInput, true);
document.addEventListener("submit", onSubmit, true);
document.addEventListener("keydown", onKeyDown, true);
document.addEventListener("click", onClick, true);
```

当按键触发时，拦截流水线按以下顺序执行（`renderer-binding-probe.ts:2530-2551`）：

```
[keydown Capture]
  │
  ├── 1. isComposerInputIntent(event) ?
  │       ├── 否 ──> 放行 (导航/复制快捷键)
  │       └── 是 ──> 解析目标 Composer
  │
  ├── 2. 检查切换锁定: (codexAccountSwitching || controller.isSwitching(composer)) ?
  │       └── 是 ──> blockEvent(event) 立即终断!
  │
  ├── 3. 检查会话归属权加载状态: isOwnershipSubmissionBlocked ?
  │       └── 是 ──> 若为 isComposerSubmissionKey 则 blockEvent(event)
  │
  ├── 4. 尝试底层预写适配: !applyComposerAgent(composer) ?
  │       └── 失败 ──> blockEvent(event) 阻止错误入库
  │
  └── 5. 检查是否为提交键: isComposerSubmissionKey(event) ?
          ├── 否 ──> 正常键入文本
          └── 是 ──> 执行 prepareComposer(composer):
                      ├── 模型选择中 / 目录加载中 ──> blockEvent(event)
                      └── 配置合法 ──> 标记 pendingSubmission 并 dispatch "codexhost:renderer-submission"
```

同时，在视觉层面，`renderer-composer-dom.ts:713-720` 会自动缓存并切断发送按钮的 disabled 状态：
```typescript
if (submissionBlocked && control.sendDisabledBeforeSwitch === null) {
  control.sendDisabledBeforeSwitch = control.sendButton.disabled;
  control.sendButton.disabled = true;
} else if (!submissionBlocked && control.sendDisabledBeforeSwitch !== null) {
  control.sendButton.disabled = control.sendDisabledBeforeSwitch;
  control.sendDisabledBeforeSwitch = null;
}
```
通过捕获阶段事件截断 + 发送按钮实体禁用的双重保护，构筑了铜墙铁壁般的提交拦截。

---

## 四、弹窗层隔离与防抢焦安全机制

### 4.1 嵌套 Popover 机制（`popover="manual"` vs `auto`）

在 `renderer-model-picker.ts:318-325` 中，Model 选择器的主菜单与子菜单采用了原生 Popover API：
- 若使用 `popover="auto"`，浏览器原生行为会在用户点击子菜单或搜索框时自动关闭（Light Dismiss）父级菜单；
- CodexHost 将模型菜单显式声明为 `menu.setAttribute("popover", "manual")`；
- 通过 `document.addEventListener("pointerdown", onDocumentPointerDown, true)` 与 `onDocumentKeyDown` 自行接管外部点击与 Escape 关闭逻辑；
- 将 `menu` 和 `modelMenu` 直接 Portal 到 `document.body`（`renderer-model-picker.ts:516`），彻底脱离 Composer Toolbar 的 CSS Transform 局部坐标系，解决视口滚动与界面 Zoom 下的坐标偏移。

### 4.2 搜索输入框的 10 项事件静音与防抢焦防线

在注入的模型搜索框（Search Input）中，存在一个极其隐蔽且致命的 React 冲突：
Codex Desktop 的外层容器会全局监听键盘事件，试图在任何未失焦按键时自动把光标吸附回 Composer 输入框（类似 Slack 或 Discord 的快捷键体验）。这会导致用户在 Model 搜索框键入第一个字母时，光标瞬间被抢夺回底下的对话框。

CodexHost 在 `renderer-model-picker.ts:375-412` 实现了精密的**事件静音与焦点防盗网**：

```typescript
// renderer-model-picker.ts:379-395
const silencedEventTypes = [
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "change",
] as const;
const silenceForHarness = (event: Event): void => {
  event.stopPropagation();
};
for (const type of silencedEventTypes) {
  searchInput.addEventListener(type, silenceForHarness);
}

// renderer-model-picker.ts:399-411 防焦点抢夺安全网
const onSearchBlur = (): void => {
  if (!popoverOpen(modelMenu)) return;
  const active = document.activeElement;
  const movedToComposer =
    active === document.body ||
    (active instanceof Element &&
      (active.matches('textarea, [contenteditable="true"], [role="textbox"]') ||
        active.closest('textarea, [contenteditable="true"], [role="textbox"]') !== null));
  if (!movedToComposer) return;
  requestAnimationFrame(() => {
    if (popoverOpen(modelMenu) && searchInput.isConnected) searchInput.focus();
  });
};
searchInput.addEventListener("blur", onSearchBlur);
```
- **10 种事件全部 `stopPropagation`**：阻断一切冒泡，使宿主 React 的顶层合成事件代理（Event Delegation）根本感知不到搜索框的输入；
- **`onSearchBlur` 抢焦侦测**：若失焦后的 `activeElement` 变成了 Composer 编辑器，立刻在下一个动画帧（`requestAnimationFrame`）强行把焦点夺回搜索框。

---

## 五、`design-qa.md` 视觉对齐标准与样式落地

在 `reference/codex-host/design-qa.md` 中，详细记录了研发团队在 1848 × 1432 像素级别（Retina 2x）与 Codex Desktop 原生视觉语言进行毫米级对齐的 QA 实证与迭代历史。

### 5.1 核心视觉指标对齐表

| 视觉维度 | 旧版实现（Prior Implementation） | 最终标准（Final Implementation） | 源码落地证据 |
|---|---|---|---|
| **基础字号** | 14 px | **13 px**（UI 核心字号，副标题 11-12px，标题 18px） | `renderer-agent-picker.ts:362`, `renderer-model-picker.ts:289`, `design-qa.md:29` |
| **行高与行距** | 64 px 列表大行高，间距松散 | **52 px 紧凑行高**，空间利用率提升 23% | `design-qa.md:13, 23` |
| **控件触发器规格** | 尺寸不定，借用宿主 class | **高度 28 px**，Padding `0 6px`~`0 8px`，完全匹配 Codex 胶囊 | `renderer-trigger-chip-style.ts:18-50`, `renderer-model-picker.ts:286` |
| **Agent 触发器规格** | 尺寸过大 | **30 px × 28 px** 紧凑微型方形图标按钮 | `renderer-agent-picker.ts:227-241` |
| **分割线 (Dividers)** | 粗实线、多重边框叠加 | **Quiet Dividers**：`rgba(127, 127, 127, 0.16)` 或 `border-token-border` 极细单线 | `renderer-agent-picker.ts:539`, `renderer-model-picker.ts:590`, `design-qa.md:13` |
| **色彩与主题模式** | 强制 Dark 隔离，割裂浅色模式 | **继承宿主 `color-scheme`**，系统原生 `Canvas` / `CanvasText` 融合 | `renderer-agent-picker.ts:288`, `design-qa.md:21, 38` |
| **阴影与外发光** | 重阴影、高饱和度黑环 | **柔和阴影**：`0 8px 24px rgba(0,0,0,0.28)`，结合 `backdrop-blur-xl` | `renderer-agent-picker.ts:290`, `renderer-model-picker.ts:21` |
| **焦点指示器** | 程序化焦点产生粗蓝色外轮廓 | **关闭程序化聚焦 outline**（`focusVisible: false`），仅保留键盘 Tab 焦点态 | `design-qa.md:24` |

### 5.2 独立宿主的触发器芯片样式（`TRIGGER_CHIP_CLASS`）

在开发初期，CodexHost 曾尝试直接复制 Codex 的混淆 CSS Class 名。但在后续 Desktop 更新中，Codex 官方重命名了类名，导致第三方控件在一夜之间丢失了边框和悬浮状态。

团队在 `renderer-trigger-chip-style.ts` 中总结出了一条铁律：**必须定义宿主无关的独立微型微类**：

```css
/* renderer-trigger-chip-style.ts:25-49 */
.codexhost-trigger-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  color: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.codexhost-trigger-chip:hover:not(:disabled) {
  background: rgba(127, 127, 127, 0.08); /* 极为克制的浅灰 */
}
.codexhost-trigger-chip:active:not(:disabled) {
  background: rgba(127, 127, 127, 0.16);
}
.codexhost-trigger-chip[data-state="open"] {
  background: rgba(127, 127, 127, 0.08);
}
.codexhost-trigger-chip:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
```
**设计哲学**：
- 零边框（`border: 0`）与全圆角胶囊（`border-radius: 9999px`）；
- 常态完全透明，背景通过 `inherit` 穿透宿主底色；
- Hover 态仅使用 8% 纯中性灰（`rgba(127, 127, 127, 0.08)`），在任何 Light 或 Dark 模式下均能柔和呈现；
- **严禁使用纯黑或高对比硬边框**，完全与 Conex 规范《AGENTS.md》第 13 条“焦点对比度上限 10%、常规 3%–6% 混入”高度共鸣。

---

## 六、对 Conex / Crish 桌面端的重构启示与迁移建议

当前 Conex / Crish 桌面端正处于正文对话流与 Composer 架构打磨的关键阶段。CodexHost 的实践为我们提供了大量高价值的架构经验：

### 6.1 建立基于纯逻辑状态机的输入拦截（Refactor Recommendation）

在 Crish 前端中，输入框键盘处理逻辑分散在多个 React 组件的 `onKeyDown` 内部。我们应当借鉴：
1. **抽离独立的纯函数意图探测库**：
   - 建立 `isComposerInputIntent(event)`，严格纳入 `event.key === "Process"`（IME 拼音状态）与剪切粘贴判定；
   - 建立 `isComposerSubmissionKey(event)`，刚性绑定 `!event.isComposing && !event.shiftKey`，彻底消灭输入法中文回车误触发提交问题。
2. **顶层捕获阶段守卫（Capture Guard）**：
   在会话切换、模型加载、或后台任务调度期间，通过状态机在顶层直接短路拦截提交，而不是在业务组件深处抛出 Toast 告警。

### 6.2 采用拓扑比对防重流挂载模式

在 Crish 对话流挂载多工具插件（如 MCP 工具选择器、Thinking 开关、模型档位）时：
- 避免使用大面积条件渲染（如 `{show && <div />}`）导致的频繁 DOM 插入拔出；
- 学习 `refreshTrailingClusterPlacement`，在挂载扩展按钮集群时，先比对父级与相邻兄弟节点拓扑，相同则立即短路跳过，确保 60FPS 丝滑度。

### 6.3 严格贯彻极简视觉体系与无重阴影规约

根据 `design-qa.md` 与 Conex 规范：
- 对话框底部的快捷操作胶囊一律采用 28px 高度、13px 字体、`border-radius: 9999px`；
- 常态背景透明，Hover 态限定使用 `rgba(127, 127, 127, 0.08)` 或 `color-mix` 5% 灰度；
- 弹窗菜单（Model/Agent Picker）抛弃大黑边与多重轮廓线，以 Quiet Dividers（1px、0.16 透明度中性灰）与柔和模糊（`backdrop-blur`）为主。

---

## 结论

CodexHost 在 Composer DOM 注入与交互拦截上的设计堪称“黑盒宿主扩展”的工程典范。它没有依赖脆弱的全局类名，而是穿透到 Scoped Portal、React Fiber 状态机与原生 DOM 事件捕获机制；它没有盲目刷新页面，而是通过拓扑比对、状态克隆平移与原生控件无损暂存实现了极致的零闪烁体验；在视觉上，13px 基准与 52px 紧凑节奏更是为现代 AI 对话界面的高密度、专业感树立了清晰的标准。本报告的分析结果将直接作为 Conex 战役中对话流与 Composer 重构的核心技术输入。
