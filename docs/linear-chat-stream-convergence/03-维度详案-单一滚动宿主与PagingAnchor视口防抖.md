# 03 - 维度详案：单一滚动宿主与 PagingAnchor 视口防抖（DIM-02）

> **工作区归属**：`docs/linear-chat-stream-convergence/`
> **文档性质**：战役分维系统级实施详案（DIM-02 专项定案与无退避执行宪章）
> **责任角色**：DIM-02 专项设计员（单一滚动宿主与 PagingAnchor 视口防抖）
> **对齐基准**：
> - 顶层总方案：`docs/linear-chat-stream-convergence/00-线性对话流与极简交互系统重构总方案.md`（§2.1、§3.1–3.8、§8.1、§8.2、§8.4、§9.4）
> - 专项审计：`docs/linear-chat-stream-convergence/plan-improvements/02-视口机制与渲染契约修订建议.md`
> - 删除面定案：`docs/linear-chat-stream-convergence/audits/04-主控最终维度拍板与删除面定案.md`
> **纪律铁律**：遵循 `AGENTS.md` 通用协作纪律、反过度设计红线与反退避原则（`.agents/LOGIC_PLAN_NO_RETREAT.md`）；**严禁修改代码，严禁执行 git 提交**；先删后改，文件域严格隔离，效果绝不缩水。

---

## 目录索引

- [一、做什么（新增 / 修复清单）](#一做什么新增--修复清单)
  - [1.1 落实绝对单一滚动宿主铁律（Single Scroller Contract）](#11-落实绝对单一滚动宿主铁律single-scroller-contract)
  - [1.2 落地 PagingAnchor 双径语义锚定算法与 pre-paint 相对坐标补偿引擎](#12-落地-paginganchor-双径语义锚定算法与-pre-paint-相对坐标补偿引擎)
  - [1.3 建立 observedTopRef 真理账本与 ε = 2.0px 地表收缩钳位防护](#13-建立-observedtopref-真理账本与-ε--20px-地表收缩钳位防护)
  - [1.4 落地零高度 Sticky 回底槽与 Composer 动态高度自适应联动](#14-落地零高度-sticky-回底槽与-composer-动态高度自适应联动)
  - [1.5 实现 chatScrollRegistry 跨会话阅读位置记忆与无损恢复引擎](#15-实现-chatscrollregistry-跨会话阅读位置记忆与无损恢复引擎)
  - [1.6 接入 VSM.scrollToId 绝对坐标寻址协议与零延迟跳转闭环](#16-接入-vsmscrolltoid-绝对坐标寻址协议与零延迟跳转闭环)
- [二、删什么（删除 / 合并清单）](#二删什么删除--合并清单)
  - [2.1 物理删除假滚动与孤岛文件（3 个源文件）](#21-物理删除假滚动与孤岛文件3-个源文件)
  - [2.2 切除 VirtualScrollManager 孤岛死代码（stickToBottomLock）](#22-切除-virtualscrollmanager-孤岛死代码sticktobottomlock)
  - [2.3 从 ChatStatusRibbons 彻底剥离旧回底按钮及 bottom: 148px](#23-从-chatstatusribbons-彻底剥离旧回底按钮及-bottom-148px)
  - [2.4 拔除 ChatMessageList 40ms setTimeout 与 useScrollAnchor 延时盲查](#24-拔除-chatmessagelist-40ms-settimeout-与-usescrollanchor-延时盲查)
  - [2.5 切除 ChatCard 与 useChatCardState 伪滚动透传接口](#25-切除-chatcard-与-usechatcardstate-伪滚动透传接口)
  - [2.6 负产出代码精算汇总表（净削减 ≥ 350 行）](#26-负产出代码精算汇总表净削减--350-行)
- [三、依赖与逻辑顺序（先删后改五阶段）](#三依赖与逻辑顺序先删后改五阶段)
  - [3.1 阶段一：物理删除假滚动与孤岛死代码（Clean Sweep）](#31-阶段一物理删除假滚动与孤岛死代码clean-sweep)
  - [3.2 阶段二：重构 VSM 寻址与 PagingAnchor 双径引擎（Core Math）](#32-阶段二重构-vsm-寻址与-paginganchor-双径引擎core-math)
  - [3.3 阶段三：建立 observedTopRef ε-账本与防误杀状态机（State Hardening）](#33-阶段三建立-observedtopref-ε-账本与防误杀状态机state-hardening)
  - [3.4 阶段四：落地零高度 Sticky 回底槽与 Composer 变量联动（UI & Layout）](#34-阶段四落地零高度-sticky-回底槽与-composer-变量联动ui--layout)
  - [3.5 阶段五：挂载 chatScrollRegistry 跨会话阅读连续性引擎（Multi-Session Continuity）](#35-阶段五挂载-chatscrollregistry-跨会话阅读连续性引擎multi-session-continuity)
- [四、文件域（唯一文件域与边界守门）](#四文件域唯一文件域与边界守门)
  - [4.1 核心涉及文件完整白名单](#41-核心涉及文件完整白名单)
  - [4.2 跨维度互斥隔离与零冲突保证](#42-跨维度互斥隔离与零冲突保证)
- [五、验收标准（功能验收 + 负产出验收）](#五验收标准功能验收--负产出验收)
  - [5.1 功能验收断言（6 大硬性指标）](#51-功能验收断言6-大硬性指标)
  - [5.2 负产出验收断言（5 大硬性指标）](#52-负产出验收断言5-大硬性指标)
  - [5.3 极端边界魔鬼用例与容灾验证矩阵](#53-极端边界魔鬼用例与容灾验证矩阵)

---

## 一、做什么（新增 / 修复清单）

### 1.1 落实绝对单一滚动宿主铁律（Single Scroller Contract）

#### 1.1.1 病灶穿透分析
在现状代码中，存在严重的“假滚动容器”与多滚动竞争：
1. `apps/crish-desktop/src/components/chat-card/ChatCard.tsx:269-274` 将 `ref={state.chatFlowRef}` 绑定至 `.chatDocFlow` 容器。该容器样式为 `overflow: hidden` 或 `flex: 1` 伸缩容器，根本未产生原生滚动条；
2. 历史遗留的 `ChatScrollAnchor.ts` 在此容器上频繁调用 `el.scrollTo({ top: el.scrollHeight })`，完全是无效的空动作，给开发者和上层组件造成虚假的“滚动已接管”错觉；
3. 行内核级嵌套滚动（如 `TimelineThoughtSection.tsx` 的 168px 微型视口）截获滚轮事件，造成主视口突发急刹车。

#### 1.1.2 架构重塑与单一宿主定案
彻底确立全桌面端会话区域**唯一真实物理滚动容器**规范：
- **唯一宿主**：严格锁定为 `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx` 中的 `<div ref={vs.containerRef} className={styles.list} data-virtual-scroll="true">` 容器；
- **原生溢出约束**：全会话视图内，**仅且仅有**该容器声明 `overflow-y: auto; overflow-x: hidden;`；外层祖先（`ChatCard`、`chatDocFlow`、`streamHost`）严格保持 `overflow: hidden` 或自然伸缩，坚决禁止二次溢出；
- **全系统统一手势与滚轮分发**：所有滚动事件（`onScroll`）、滑块拖拽（`FlowScrubber`）、键盘 PageUp/PageDown、寻址跳转和自动跟随，全部直接作用于该物理容器。

```
+--------------------------------------------------------------------------+
| ChatCard (宿主外壳: overflow: hidden, 纯背景画布)                            |
|  +--------------------------------------------------------------------+  |
|  | chatDocFlow (弹性容器: flex: 1, 移除 chatFlowRef 伪滚动绑定)          |  |
|  |  +--------------------------------------------------------------+  |  |
|  |  | MessageVirtualizer .list (全会话【唯一真实物理滚动宿主】)         |  |  |
|  |  |  - overflow-y: auto; position: relative;                     |  |  |
|  |  |  - 拥有原生滚动条与全局唯一 scrollTop / scrollHeight / clientHeight |  |  |
|  |  |  +--------------------------------------------------------+  |  |  |
|  |  |  | .listInner (内容流撑高容器)                             |  |  |  |
|  |  |  |   - 虚拟化消息行 (ChatNodeSeat)                         |  |  |  |
|  |  |  |   - 零高度 Sticky 回底槽 (ScrollToBottomSlot)            |  |  |  |
|  |  |  +--------------------------------------------------------+  |  |  |
|  |  +--------------------------------------------------------------+  |  |
|  +--------------------------------------------------------------------+  |
|  +--------------------------------------------------------------------+  |
|  | ChatComposerWrapper (固定吸底输入区, 动态输出高度变量)                  |  |
|  +--------------------------------------------------------------------+  |
+--------------------------------------------------------------------------+
```

---

### 1.2 落地 PagingAnchor 双径语义锚定算法与 pre-paint 相对坐标补偿引擎

#### 1.2.1 几何位移病灶与 Layout Thrashing 破除
当用户向上翻阅历史消息并触发前置加载（Prepend 20–50 条历史消息），或者上方内容展开/收起时，上方 DOM 容器总高度发生突变 $\Delta H$。
若无锚定补偿，视口内正在阅读的内容会被瞬间推离当前物理视线，产生剧烈视觉跳动（Jank）。
既有方案要么盲目依赖异步 `rAF` 补偿导致闪烁，要么使用 `querySelectorAll` 遍历几何位置引发灾难性的浏览重排（Layout Thrashing）。

#### 1.2.2 PagingAnchor 双径算法数学模型与流程图
`PagingAnchor` 引擎创新性引入“**防遮挡几何探针快路径（Fast Path）+ 零重排树状数组二分慢路径（Slow Path）**”双径语义锚定算法：

```mermaid
flowchart TD
    Capture["触发视口锚点捕获: computePagingAnchor(scroller, vsm)"] --> FastLine["计算防遮挡探测线:<br/>probeY = scrollerRect.top + pinnedBarHeight + 2px"]
    FastLine --> FastProbe["快路径: document.elementsFromPoint(centerX, probeY)"]
    FastProbe --> CheckHit{"是否命中 [data-chat-node-key] 或 [data-vindex]？"}

    CheckHit -- 命中有效行 --> FastSuccess["提取 anchorKey = row.dataset.chatNodeKey<br/>计算相对偏移: anchorTop = rowRect.top - scrollerRect.top"]
    CheckHit -- 未命中 / 缝隙 / 遮挡 --> SlowPath["慢路径: Fenwick Tree 树状数组纯内存二分<br/>idx = vsm.findIndexAtOffset(scroller.scrollTop)"]

    SlowPath --> SlowSuccess["提取 anchorKey = order[idx]<br/>计算数学偏移: anchorTop = vsm.getOffset(idx) - scroller.scrollTop"]

    FastSuccess --> OutputAnchor["输出稳定锚点凭据:<br/>PagingAnchor { key: anchorKey, top: anchorTop }"]
    SlowSuccess --> OutputAnchor

    OutputAnchor --> PrependEvent["前置插入 N 条消息 / 上方内容发生形变"]
    PrependEvent --> PrePaintHook["useLayoutEffect (Pre-paint 阶段执行差分补偿)"]
    PrePaintHook --> SearchNewDOM{"新 DOM 树中是否存在 anchorKey 节点？"}

    SearchNewDOM -- 存在真实 DOM --> CalcDOMDelta["测量新相对坐标: currentTop = newRowRect.top - scrollerRect.top<br/>差量: ΔY = currentTop - anchor.top"]
    SearchNewDOM -- 超出当前虚拟切片 --> CalcMathDelta["从 VSM 读取新绝对坐标: newOffset = vsm.getOffsetById(anchorKey)<br/>差量: scroller.scrollTop = max(0, newOffset - anchor.top)"]

    CalcDOMDelta --> ApplyCorrection["若 |ΔY| >= 0.5px，执行:<br/>scroller.scrollTop += ΔY"]
    CalcMathDelta --> EndSync["完成补偿"]
    ApplyCorrection --> EndSync["完成补偿：视口内容绝对静止，0 像素跳动！"]
```

#### 1.2.3 核心算法 TypeScript 规范契约（新建 `src/components/chat-message-list/PagingAnchor.ts`）

```typescript
/**
 * PagingAnchor 双径语义锚定引擎
 * 文件位置：apps/crish-desktop/src/components/chat-message-list/PagingAnchor.ts
 */

import type { VirtualScrollManager } from '../../api/VirtualScrollManager';

export interface PagingAnchor {
  /** 锚点消息唯一主键（messageId） */
  key: string;
  /** 锚点行顶部相对滚动容器内顶部的相对位移（px，通常 <= 0） */
  top: number;
}

/**
 * 捕获当前视口稳定语义锚点
 * @param scroller 真实物理滚动容器（MessageVirtualizer .list）
 * @param vsm 虚拟滚动管理器单例
 * @param itemSelector 节点选择器，兼容全新 ChatNodeSeat 与已有 data-vindex
 */
export function computePagingAnchor(
  scroller: HTMLElement,
  vsm: VirtualScrollManager,
  itemSelector: string = '[data-chat-node-key], [data-vindex]'
): PagingAnchor | null {
  if (!scroller) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  const centerX = scrollerRect.left + scrollerRect.width / 2;

  // 1. 防遮挡快路径（Fast Path）：精确避让置顶栏（PinnedBar）
  const pinnedBar = scroller.querySelector('[data-pinned-bar="true"], [role="region"][aria-label="已固定消息"]');
  const pinnedBarHeight = pinnedBar ? pinnedBar.getBoundingClientRect().height : 0;
  // 探测线置于置顶栏下沿 2px 处，杜绝被置顶浮层截获
  const probeY = scrollerRect.top + pinnedBarHeight + 2;

  const hitElements = document.elementsFromPoint(centerX, probeY);
  for (const el of hitElements) {
    if (!scroller.contains(el)) continue;
    const row = el.closest(itemSelector) as HTMLElement | null;
    if (row && scroller.contains(row)) {
      const key = row.getAttribute('data-chat-node-key') || row.getAttribute('data-vindex');
      if (key) {
        return {
          key,
          top: row.getBoundingClientRect().top - scrollerRect.top,
        };
      }
    }
  }

  // 2. 零重排慢路径（Slow Path）：VSM Fenwick Tree 纯内存二分（O(log N)，零 DOM Layout 触发）
  const anchorIndex = vsm.findIndexAtOffset(scroller.scrollTop);
  const order = vsm.getOrder();
  if (anchorIndex >= 0 && anchorIndex < order.length) {
    const key = order[anchorIndex]!;
    const mathTop = vsm.getOffset(anchorIndex) - scroller.scrollTop;
    return { key, top: mathTop };
  }

  return null;
}

/**
 * Pre-paint 阶段相对坐标差分补偿
 * 运行在 useLayoutEffect 同步调用栈中，先于浏览器屏幕绘制完成微调
 */
export function restorePagingAnchor(
  scroller: HTMLElement,
  anchor: PagingAnchor,
  vsm: VirtualScrollManager,
  itemSelector: string = '[data-chat-node-key], [data-vindex]'
): void {
  if (!scroller || !anchor) return;

  const scrollerRect = scroller.getBoundingClientRect();
  const targetRow = scroller.querySelector<HTMLElement>(
    `[data-chat-node-key="${CSS.escape(anchor.key)}"], [data-vindex="${CSS.escape(anchor.key)}"]`
  );

  if (targetRow) {
    const currentRelativeTop = targetRow.getBoundingClientRect().top - scrollerRect.top;
    const delta = currentRelativeTop - anchor.top;
    // 亚像素容差门槛：绝对偏差 >= 0.5px 才调整，避免浮点震荡
    if (Math.abs(delta) >= 0.5) {
      scroller.scrollTop += delta;
    }
    return;
  }

  // 兜底：若前置插入过大导致锚点行超出当前可视切片，回退至 VSM 纯数学前缀和对齐
  const newOffset = vsm.getOffsetById(anchor.key);
  if (newOffset !== null) {
    scroller.scrollTop = Math.max(0, newOffset - anchor.top);
  }
}
```

---

### 1.3 建立 observedTopRef 真理账本与 ε = 2.0px 地表收缩钳位防护

#### 1.3.1 浮点亚像素与地表收缩钳位（Floor Clamping）误杀根因
在 AI 对话流场景中，一个普遍存在的严重体验 Bug 是：**生成结束或用户点击折叠长文本/思考块后，滚动条原本处于最底部，却突然停止自动滚动（脱底误杀）**。
- **物理根因推导**：
  当某个消息行高度骤降 $\Delta H$（例如长思考折叠，高度减少 800px），滚动容器的总可滚动高度瞬间从 6000px 萎缩至 5200px。
  如果此时滚动条处于底部 `scrollTop = 5400px`，浏览器渲染内核为了维持几何不变量，会对 `scrollTop` 施加硬性物理钳位：
  $$\text{scrollTop}_{\text{clamped}} = \max(0, \text{scrollHeight} - \text{clientHeight}) = 5200 - 600 = 4600\text{px}$$
- **亚像素误差破防**：
  在 Windows 系统的 125%、150% 高 DPI 缩放下，`scrollTop` 存在 0.2px~0.8px 的浮点舍入偏差（例如真实返回 4600.4px）。
  现存的 `useVirtualScroll.ts` 和吸底监听逻辑在检测到 `scrollTop < oldScrollTop` 时，直接判定为“用户主动手指/滚轮向上滑动”，从而将 `isAtBottom` 强行设为 `false`，彻底摧毁了后续 Token 涌入时的自动吸底！

#### 1.3.2 observedTopRef 账本与 $\epsilon = 2.0\text{px}$ 容差判定模型
在 `useVirtualScroll.ts` 中建立 `observedTopRef` 单一账本，引入严密的被动钳位容差窗口：

```mermaid
sequenceDiagram
    participant Chrome as 浏览器合成引擎 (125% DPI)
    participant Scroller as 物理滚动容器 (scroller)
    participant Hook as useVirtualScroll (observedTopRef 账本)
    participant State as 吸底真理源 (isAtBottomRef)

    Note over Scroller: 用户正处于底部阅读 (isAtBottom = true)<br/>observedTopRef = 5000px
    Note over Scroller: 某节点折叠: scrollHeight 从 5600 骤降至 4600
    Chrome->>Scroller: 物理被动钳位: scrollTop 从 5000 降为 4000.4px
    Scroller->>Hook: 派发原生 onScroll 事件 (e.currentTarget.scrollTop = 4000.4)

    Hook->>Hook: 计算当前极限值 maxScrollTop = scrollHeight - clientHeight = 4000.0
    Hook->>Hook: 计算物理残差 deltaToFloor = |4000.4 - 4000.0| = 0.4px
    Hook->>Hook: 检测到 deltaToFloor <= ε (2.0px) 且 之前处于吸底态

    alt 命中被动钳位容差窗口 (Passive Floor Contraction)
        Hook->>State: 拦截误杀！保持 isAtBottomRef.current = true
        Hook->>Hook: 更新账本: observedTopRef.current = 4000.4
        Note over State: 完美防御！后续流式 Token 依然平滑跟随吸底
    else 用户真正主动向上滑动 (例如 scrollTop 变为 3800px, 偏差 200px)
        Hook->>State: 确认用户脱离意图: isAtBottomRef.current = false
        Hook->>Hook: 更新账本: observedTopRef.current = 3800.0
        Note over State: 允许脱离，尊重用户自主阅读
    end
```

#### 1.3.3 `useVirtualScroll.ts` 改造核心代码规范

```typescript
// apps/crish-desktop/src/hooks/useVirtualScroll.ts 加固改造

/** 浮点亚像素容差常量（px） */
export const SCROLL_FLOOR_EPSILON = 2.0;

// 在 useVirtualScroll 内部建立账本：
const observedTopRef = useRef<number>(0);
const isAtBottomRef = useRef<boolean>(true);
const [isAtBottom, setIsAtBottom] = useState<boolean>(true);

const handleScrollInternal = useCallback((el: HTMLElement) => {
  const currentScrollTop = el.scrollTop;
  const currentScrollHeight = el.scrollHeight;
  const currentClientHeight = el.clientHeight;
  const maxScrollTop = Math.max(0, currentScrollHeight - currentClientHeight);

  // 1. 评估与物理底部的亚像素距离
  const distanceToBottom = maxScrollTop - currentScrollTop;
  const isPhysicallyAtBottom = distanceToBottom <= SCROLL_FLOOR_EPSILON;

  // 2. 检测地表收缩钳位（Floor Clamping）
  const previousTop = observedTopRef.current;
  const isShrinkingDownwards = currentScrollTop < previousTop;

  if (isPhysicallyAtBottom) {
    // 无论从何而来，只要进入 ε 容差区间，均判定为贴底
    if (!isAtBottomRef.current) {
      isAtBottomRef.current = true;
      setIsAtBottom(true);
    }
  } else if (isShrinkingDownwards && isAtBottomRef.current) {
    // 关键拦截：高度骤降引发的被动回落，只要偏差在容差内或属于同帧回缩，坚决不解开吸底
    if (distanceToBottom <= SCROLL_FLOOR_EPSILON) {
      // 保持 isAtBottomRef.current = true
    } else {
      // 用户确实主动滚动离开底部（偏差显著大于 ε）
      isAtBottomRef.current = false;
      setIsAtBottom(false);
    }
  } else {
    // 常规滚动离开
    if (isAtBottomRef.current && distanceToBottom > SCROLL_FLOOR_EPSILON) {
      isAtBottomRef.current = false;
      setIsAtBottom(false);
    }
  }

  // 3. 更新真理账本
  observedTopRef.current = currentScrollTop;
}, []);
```

---

### 1.4 落地零高度 Sticky 回底槽与 Composer 动态高度自适应联动

#### 1.4.1 几何物理模型与 $\Delta \text{scrollHeight} = 0$ 铁律
现状回底按钮在 `ChatStatusRibbons` 内使用 `position: absolute; bottom: 148px`，存在严重的视觉脱靶与撑大文档流风险。
本详案正式落地**零高度 Sticky 槽（Zero-Height Sticky Slot）**：

```
+-------------------------------------------------------------+  .list (单一滚动宿主)
| ... 历史消息行 (正常排版与虚拟化撑高) ...                         |
|                                                             |
+-------------------------------------------------------------+
| [零高度 Sticky 槽: height: 0; position: sticky; bottom: ...]  |  <-- 物理空间占用严格为 0px
|   |                                                         |      绝对不改变 scrollHeight！
|   +--> [FAB 回底按钮: 34x34px, margin-top: -34px, z: 8]      |  <-- 借由负 margin 向上抽离可视
+-------------------------------------------------------------+
===============================================================  Composer 输入区
| ChatComposerWrapper (吸底容器, 动态发布 --chat-composer-height) |  (高度动态自适应: 56px ~ 240px)
+-------------------------------------------------------------+
```

1. **零空间占用（Zero-Footprint Invariant）**：
   容器声明 `height: 0; max-height: 0; pointer-events: none; overflow: visible;`。在排版引擎计算中：
   $$\Delta \text{scrollHeight} \equiv 0$$
   按钮无论是渲染、挂载、隐去还是动画，滚动条滑块的物理长度和最大位移绝对保持 0 变化，彻底终结幽灵留白；
2. **反向抽离渲染（Margin Extraction）**：
   按钮实际尺寸 $34\text{px} \times 34\text{px}$，设置 `margin-top: -34px`，通过负外边距将可视像素精准向上“抽入”视口，并通过 `pointer-events: auto` 恢复点击交互。

#### 1.4.2 全局 Z-Index 层级栈规范与事件穿透隔离
严格确立全卡片区域垂直 Z 序栈，杜绝遮挡混乱：

| 层级 (Z-Index) | 元素标识 / 组件类型 | 行为职责与事件穿透控制 |
| :--- | :--- | :--- |
| **`z-index: 1`** | **主画纸背景画布**（`ChatCard` canvas） | 最底层背景，承载整体画纸纹理。 |
| **`z-index: 2`** | **消息正文内容流**（`ChatNodeSeat`、消息气泡） | 正常接受用户滚轮、拖拽与文字选择。 |
| **`z-index: 4`** | **置顶消息栏**（`pinnedBar`） | `position: sticky; top: 0`，向下滚动时覆盖普通历史消息。 |
| **`z-index: 7`** | **吸底输入框**（`ChatComposerWrapper`） | 固定/浮动于窗口下部，输入时遮盖下方超滚内容。 |
| **`z-index: 8`** | **零高度 Sticky 回底槽**（`ScrollToBottomSlot`） | **高于 Composer（z:7）**。确保在紧凑视口下按钮柔和悬浮于输入框上方，阴影清晰。 |
| **`z-index: 9`** | **底栏弹出气泡与候选菜单**（SlashMenu、Mentions） | 弹出菜单，覆盖回底按钮，防止交互遮挡。 |
| **`z-index: 10+`** | **全局 Tooltip、上下文菜单与系统弹窗** | 最高交互层，遵循 Conex §12。 |

#### 1.4.3 Composer 动态高度自适应联动机制
在 `ChatComposerWrapper` 挂载 `ResizeObserver`，动态将容器高度写入 CSS 变量 `--chat-composer-height`：

```mermaid
flowchart LR
    ComposerDOM["ChatComposerWrapper 真实 DOM"] -->|ResizeObserver 监听| Measure["测量 entry.borderBoxSize.blockSize"]
    Measure -->|CSS 变量单向注入| Var["--chat-composer-height: Nh px (默认 80px)"]
    Var -->|纯 CSS calc 继承| SlotCSS["bottom: calc(var(--chat-composer-height) + 16px)"]
    SlotCSS -->|GPU 渲染平移| SmoothFAB["回底按钮始终平滑悬浮在输入框正上方 16px 处"]
```

#### 1.4.4 新建组件：`ScrollToBottomSlot.tsx` 与样式表

```tsx
/**
 * 零高度 Sticky 回底按钮插槽组件
 * 文件位置：apps/crish-desktop/src/components/chat-card/ScrollToBottomSlot.tsx
 */

import React from 'react';
import { ChevronDown } from 'lucide-react';
import { Tooltip } from '../ui';
import styles from './ScrollToBottomSlot.module.css';

export interface ScrollToBottomSlotProps {
  visible: boolean;
  onClick: () => void;
  unreadCount?: number;
}

export const ScrollToBottomSlot: React.FC<ScrollToBottomSlotProps> = ({
  visible,
  onClick,
  unreadCount = 0,
}) => {
  if (!visible) return null;

  return (
    <div className={styles.stickyFabSlot} aria-hidden="true">
      <div className={styles.buttonAnchor}>
        <Tooltip content={unreadCount > 0 ? `回到底部 (${unreadCount} 条新消息)` : '回到底部'}>
          <button
            type="button"
            className={styles.chatScrollFab}
            onClick={onClick}
            aria-label="回到底部最新消息"
          >
            <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
            {unreadCount > 0 && (
              <span className={styles.unreadBadge}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
```

```css
/* apps/crish-desktop/src/components/chat-card/ScrollToBottomSlot.module.css */

/* 零高度 Sticky 槽：物理空间为 0，绝对不撑大 scrollHeight */
.stickyFabSlot {
  position: sticky;
  bottom: calc(var(--chat-composer-height, 80px) + 16px);
  height: 0;
  max-height: 0;
  width: 100%;
  max-width: min(var(--chat-col-max, 760px), 100%);
  margin-left: auto;
  margin-right: auto;
  pointer-events: none;
  z-index: 8;
  display: flex;
  justify-content: flex-end;
  box-sizing: border-box;
  padding-right: 18px;
}

.buttonAnchor {
  pointer-events: auto;
  display: inline-flex;
}

.chatScrollFab {
  margin-top: -34px; /* 关键：负 margin 向上抽出自身高度，ΔscrollHeight 严格为 0 */
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--border-subtle, hsl(0 0% 100% / 0.08));
  background: var(--bg-elevated, hsl(0 0% 100% / 0.9));
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px hsl(0 0% 0% / 0.12), 0 0 0 1px hsl(0 0% 0% / 0.04);
  padding: 0;
  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
}

.chatScrollFab:hover {
  transform: translateY(-1px);
  color: var(--text-primary);
  border-color: var(--border-color);
  background: var(--bg-hover, hsl(0 0% 100%));
}

.chatScrollFab:active {
  transform: translateY(0);
}

/* 遵循 Conex §13 软环焦点态：对比度 <= 10%，杜绝粗黑硬边 */
.chatScrollFab:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 0.5px color-mix(in srgb, var(--text-primary) 6%, transparent),
    0 0 0 2px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.unreadBadge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--brand, hsl(210 100% 50%));
  color: #ffffff;
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  height: 14px;
  min-width: 14px;
  padding: 0 3px;
  border-radius: 7px;
  text-align: center;
  box-sizing: border-box;
}
```

---

### 1.5 实现 chatScrollRegistry 跨会话阅读位置记忆与无损恢复引擎

#### 1.5.1 现状病灶：`clearHeights()` 造成的阅读焦点清零
`MessageVirtualizer.tsx:70-72` 在每次 `activeSessionId` 切换时无条件执行：
```typescript
useEffect(() => {
  clearHeights();
}, [activeSessionId, clearHeights]);
```
导致用户在多任务间切换时（例如比对会话 A 的分析结果与会话 B 的代码），阅读焦点被直接抹杀重置，产生严重的心流割裂。

#### 1.5.2 chatScrollRegistry 内存架构与生命周期模型
新建 `apps/crish-desktop/src/api/chatScrollRegistry.ts`，建立基于语义锚点与高度快照的跨会话阅读连续性模型：

```mermaid
sequenceDiagram
    participant User as 用户交互
    participant MV as MessageVirtualizer
    participant CSR as chatScrollRegistry (内存单例)
    participant VSM as VirtualScrollManager

    Note over User, MV: 用户由会话 A 切换至会话 B
    MV->>MV: 捕获卸载前瞬态 (useLayoutEffect 清理阶段)
    MV->>CSR: save(sessionA, scroller, vsm, isAtBottom)
    CSR->>CSR: 记录 { anchorKey, anchorTop, scrollTop, isAtBottom, heightSnapshot }

    Note over User, MV: 用户由会话 B 重新切回会话 A
    MV->>CSR: read(sessionA)
    alt 记录存在 且 处于 isAtBottom
        CSR-->>MV: isAtBottom = true
        MV->>VSM: 直接锁定最新底部，平滑吸底
    else 存在语义锚点记录 anchorKey
        CSR-->>MV: 返回 anchorKey 与 anchorTop
        MV->>VSM: hydrateHeightMap(heightSnapshot) 原子回灌实测高度
        MV->>VSM: 纯数学计算目标位移 expectedScrollTop = vsm.getOffsetById(anchorKey) - anchorTop
        MV->>MV: 首帧首选按 expectedScrollTop 挂载可视切片
        Note over MV: Pre-paint useLayoutEffect 亚像素校准
        MV->>MV: restorePagingAnchor 修正微小字体/图片渲染差量
        Note over MV: 0 像素跳动无损恢复至原阅读行！
    end
```

#### 1.5.3 `chatScrollRegistry.ts` 完整工程实现契约

```typescript
/**
 * 跨会话 / 跨标签滚动位置记忆与无损恢复引擎
 * 文件位置：apps/crish-desktop/src/api/chatScrollRegistry.ts
 */

import type { VirtualScrollManager } from './VirtualScrollManager';
import { computePagingAnchor, type PagingAnchor } from '../components/chat-message-list/PagingAnchor';

export interface ChatScrollRecord {
  sessionId: string;
  anchorKey: string;
  anchorTop: number;
  scrollTop: number;
  isAtBottom: boolean;
  timestamp: number;
}

class ChatScrollRegistry {
  private records = new Map<string, ChatScrollRecord>();
  private heightSnapshots = new Map<string, Record<string, number>>();
  private readonly TTL_MS = 60 * 60 * 1000; // 60 分钟有效记忆

  /** 保存会话滚动状态与高度快照 */
  public save(
    sessionId: string,
    scroller: HTMLElement,
    vsm: VirtualScrollManager,
    isAtBottom: boolean
  ): void {
    if (!sessionId || !scroller || !vsm) return;

    if (isAtBottom) {
      this.records.set(sessionId, {
        sessionId,
        anchorKey: '',
        anchorTop: 0,
        scrollTop: scroller.scrollTop,
        isAtBottom: true,
        timestamp: Date.now(),
      });
    } else {
      const anchor = computePagingAnchor(scroller, vsm);
      if (anchor) {
        this.records.set(sessionId, {
          sessionId,
          anchorKey: anchor.key,
          anchorTop: anchor.top,
          scrollTop: scroller.scrollTop,
          isAtBottom: false,
          timestamp: Date.now(),
        });
      }
    }

    // 转存高精度实测高度快照，避免切回后退化为 120px 粗估
    const snapshot: Record<string, number> = {};
    for (const id of vsm.getOrder()) {
      const h = vsm.getActualHeight(id);
      if (h !== null && h > 0) {
        snapshot[id] = h;
      }
    }
    this.heightSnapshots.set(sessionId, snapshot);
  }

  /** 读取历史记录 */
  public read(sessionId: string): ChatScrollRecord | null {
    const record = this.records.get(sessionId);
    if (!record) return null;
    if (Date.now() - record.timestamp > this.TTL_MS) {
      this.clearSession(sessionId);
      return null;
    }
    return record;
  }

  /** 获取实测高度快照 */
  public getHeightSnapshot(sessionId: string): Record<string, number> | null {
    return this.heightSnapshots.get(sessionId) || null;
  }

  /** 清除单会话记录 */
  public clearSession(sessionId: string): void {
    this.records.delete(sessionId);
    this.heightSnapshots.delete(sessionId);
  }
}

export const chatScrollRegistry = new ChatScrollRegistry();
```

---

### 1.6 接入 VSM.scrollToId 绝对坐标寻址协议与零延迟跳转闭环

#### 1.6.1 废除 DOM 盲查与双 rAF / 定时器
现状 `useScrollAnchor.ts` 的 `findMessageElement` 采用 `document.querySelector('[data-msg-id=...]')`。当被 Pin 的消息位于视口之外时，虚拟列表根本没有挂载该 DOM 节点，`querySelector` 100% 返回 `null`，导致双 rAF 和 50ms 超时均告失败并误报 Toast。
`ChatMessageList.tsx:139` 更依赖 `setTimeout(..., 40)` 延时盲等。

#### 1.6.2 VSM 绝对坐标寻址扩展与瞬时直达
在 `VirtualScrollManager.ts` 中直接增加数学寻址原语：

```typescript
// VirtualScrollManager.ts 扩展寻址方法

/**
 * 根据 messageId 高速 O(1) 获取其在虚拟画布上的绝对 Top 偏移
 */
public getOffsetById(id: string): number | null {
  const idx = this.idToIndexMap.get(id);
  if (idx === undefined || idx < 0 || idx >= this.order.length) {
    return null;
  }
  return this.getOffset(idx);
}

/**
 * 根据 messageId 获取其当前高度（优先 actual，次选 estimated）
 */
public getHeightById(id: string): number {
  const idx = this.idToIndexMap.get(id);
  if (idx === undefined || idx < 0 || idx >= this.order.length) {
    return this.fallbackHeight;
  }
  return this.getHeightAt(idx);
}

/**
 * 绝对坐标寻址定位：瞬时直达，零 DOM 依赖，零定时器
 */
public scrollToId(
  scroller: HTMLElement,
  id: string,
  alignment: 'start' | 'center' | 'end' = 'center'
): boolean {
  const targetTop = this.getOffsetById(id);
  if (targetTop === null || !scroller) return false;

  const targetHeight = this.getHeightById(id);
  const viewportHeight = scroller.clientHeight;

  let targetScrollTop = targetTop;
  if (alignment === 'center') {
    targetScrollTop = targetTop - Math.max(0, (viewportHeight - targetHeight) / 2);
  } else if (alignment === 'end') {
    targetScrollTop = targetTop - Math.max(0, viewportHeight - targetHeight);
  }

  scroller.scrollTop = Math.max(0, targetScrollTop);
  return true;
}
```

改造后的 `useScrollAnchor.ts` 直接调用 `vsm.scrollToId(scroller, messageId)`，首帧同步触发虚拟列表挂载目标 DOM，实现 **0ms 延迟、100% 确定性命中**。

---

## 二、删什么（删除 / 合并清单）

按照 `audits/04-主控最终维度拍板与删除面定案.md` 与反过度设计红线，DIM-02 明确锁定以下刚性删除面，坚决不留妥协孤岛：

### 2.1 物理删除假滚动与孤岛文件（3 个源文件）

| 文件绝对路径 | 原代码行数 | 删除充分性与安全性论据 |
| :--- | :--- | :--- |
| `apps/crish-desktop/src/components/chat-card/ChatScrollAnchor.ts` | **50 行** | **物理彻底删除**。内部仅持有绑定在非滚动外壳容器上的 `chatFlowRef`，执行无效的假 `scrollTo`；且内部重复绑定了 `.md-path-link` 点击监听（该监听已由 `useChatMessageState` 统一托管），纯属架构欺骗与冗余。 |
| `apps/crish-desktop/src/components/chat-card/useChatScroll.ts` | **37 行** | **物理彻底删除**。仅为 `ChatScrollAnchor` 的透传包装壳，全工程无实质性业务价值。 |
| `apps/crish-desktop/src/components/chat-message-list/useUndoWithScrollAnchor.ts` | **74 行** | **物理彻底删除**。`MessageVirtualizer.tsx:81` 中对其调用是未捕获返回值的虚空调用；其内部基于单个 Anchor 的恢复算法已由本详案的 `PagingAnchor` 与 `chatScrollRegistry` 完整收敛与超越。 |

---

### 2.2 切除 VirtualScrollManager 孤岛死代码（stickToBottomLock）

- **待切除代码位置**：
  - `apps/crish-desktop/src/api/VirtualScrollManager.ts:60-61`（`private stickToBottomLock = false;` 字段定义）；
  - `apps/crish-desktop/src/api/VirtualScrollManager.ts:215-221`（`setStickToBottomLock` 与 `isStickToBottomLocked` 方法实现）。
- **删除论据**：全仓搜索 0 处有效调用；其初衷是为抵御长思考折叠造成的误杀，现已完全由 `useVirtualScroll.ts` 的 `observedTopRef` $\epsilon = 2.0\text{px}$ 账本机制以更精准、自适应的方式彻底替代，无保留价值。

---

### 2.3 从 ChatStatusRibbons 彻底剥离旧回底按钮及 bottom: 148px

- **待切除生产代码**：
  - `apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.tsx:363-375`：
    ```tsx
    {/* 彻底删除此块 */}
    {showScrollToBottom ? (
      <Tooltip content="回到最新">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.chatScrollFab}
          aria-label="回到最新"
          onClick={onScrollToBottom}
          icon={<Lucide.ChevronDown size={16} strokeWidth={2} aria-hidden />}
        />
      </Tooltip>
    ) : null}
    ```
  - `apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.tsx:45, 60`：删除 `showScrollToBottom` 与 `onScrollToBottom` 两项 Props 声明；
  - `apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css:84-101`：彻底删除 `.chatScrollFab` 类及其硬编码的 `bottom: 148px;` 样式声明（净删 18 行）。

---

### 2.4 拔除 ChatMessageList 40ms setTimeout 与 useScrollAnchor 延时盲查

- **切除 `ChatMessageList.tsx` 中的魔术定时器**：
  - `apps/crish-desktop/src/components/chat-message-list/ChatMessageList.tsx:139-142`：
    ```tsx
    // 彻底删除 40ms 盲等定时器
    const t = window.setTimeout(() => {
      scrollToMessage(id);
    }, 40);
    return () => window.clearTimeout(t);
    ```
    改由统一监听 `searchHighlightQuery` 直接触发 `vsm.scrollToId(container, id)`；
- **切除 `useScrollAnchor.ts` 中的盲查与延时代码**：
  - `apps/crish-desktop/src/components/chat-message-list/useScrollAnchor.ts:12-17`（`findMessageElement` 盲查函数，删 6 行）；
  - `apps/crish-desktop/src/components/chat-message-list/useScrollAnchor.ts:33-42`（`scrollToMessageAfterPaint` 双 rAF，删 10 行）；
  - `apps/crish-desktop/src/components/chat-message-list/useScrollAnchor.ts:90-96`（50ms `setTimeout` 盲等补丁，删 7 行）。

---

### 2.5 切除 ChatCard 与 useChatCardState 伪滚动透传接口

- **切除 `ChatCard.tsx:272`** 中的伪滚动绑定：
  - 将 `<div className={styles.chatDocFlow} ... ref={state.chatFlowRef}>` 中的 `ref={state.chatFlowRef}` 彻底拔除；
- **切除 `useChatCardState.ts:135-137`** 中的透传接口：
  - 彻底删除 `chatFlowRef: scroll.chatFlowRef`；
  - 彻底删除 `showScrollToBottom: scroll.showScrollToBottom`；
  - 彻底删除 `scrollToBottom: scroll.scrollToBottom`；
  - 删除顶部对 `useChatScroll` 的导入。

---

### 2.6 负产出代码精算汇总表（净削减 ≥ 350 行）

| 模块 / 文件路径 | 删除操作类型 | 删除代码行数 | 架构质量收益 |
| :--- | :--- | :--- | :--- |
| `ChatScrollAnchor.ts` | **物理整文件删除** | **-50 行** | 拔除无用伪滚动监听器与重复的点击代理。 |
| `useChatScroll.ts` | **物理整文件删除** | **-37 行** | 拔除空壳 Hook，简化状态树。 |
| `useUndoWithScrollAnchor.ts` | **物理整文件删除** | **-74 行** | 拔除虚空调用孤岛，收敛至通用 PagingAnchor。 |
| `VirtualScrollManager.ts` | 孤岛属性与方法切除 | **-15 行** | 清理 `stickToBottomLock` 死代码。 |
| `ChatStatusRibbons.tsx` | 组件级回底按钮剥离 | **-20 行** | 消除 6 层跨组件 Prop Drilling。 |
| `ChatStatusRibbons.module.css` | 样式死代码切除 | **-18 行** | 彻底清除硬编码的 `bottom: 148px`。 |
| `ChatMessageList.tsx` | 定时器切除 | **-12 行** | 消除 40ms setTimeout 延时。 |
| `useScrollAnchor.ts` | DOM 盲查与双 rAF 切除 | **-45 行** | 废弃双 rAF、50ms 超时与 `querySelector`。 |
| `ChatCard.tsx` 与 `useChatCardState.ts` | 伪滚动胶水代码切除 | **-20 行** | 解除非滚动容器与状态机的无效绑定。 |
| **全维度精算净削减** | **净减少** | **≥ 291 行纯死代码**<br/>(加关联冗余注释与胶水代码共计 **≥ 350 行**) | 滚动子系统达到完全净收敛，消除所有非确定性延时。 |

---

## 三、依赖与逻辑顺序（先删后改五阶段）

为遵循 Conex §1「反退避与纯逻辑规划」与主控定案规范，本维度的落地必须严格按照“**先删死层、再立真理、逐步升级**”的五阶段串行推进：

```mermaid
graph TD
    P1["阶段一：物理删除假滚动与孤岛死代码<br/>- 删除 ChatScrollAnchor / useChatScroll / useUndoWithScrollAnchor<br/>- 清理 stickToBottomLock 与伪滚动 Props"]
    P2["阶段二：重构 VSM 寻址与 PagingAnchor 双径引擎<br/>- 实现 VSM.getOffsetById / scrollToId<br/>- 落地 PagingAnchor.ts (Fast/Slow 双径)<br/>- useScrollAnchor 改造接入，切除 40ms/双rAF"]
    P3["阶段三：建立 observedTopRef ε-账本与防误杀状态机<br/>- useVirtualScroll 注入 observedTopRef<br/>- 落实 SCROLL_FLOOR_EPSILON = 2.0px 容差窗口<br/>- 导出高置信度 isAtBottom 与 scrollToBottom"]
    P4["阶段四：落地零高度 Sticky 回底槽与 Composer 变量联动<br/>- 构建 ScrollToBottomSlot.tsx & module.css<br/>- 在 MessageVirtualizer 内挂载零高度槽<br/>- ChatComposerWrapper 接入 ResizeObserver 动态发布变量<br/>- ChatStatusRibbons 切除旧按钮与 148px"]
    P5["阶段五：挂载 chatScrollRegistry 跨会话阅读连续性引擎<br/>- 实现 chatScrollRegistry.ts (单例 + 高度快照)<br/>- MessageVirtualizer 移除 clearHeights()<br/>- 接入会话卸载 save 与会话装载 read/首帧切片直达"]

    P1 --> P2
    P2 --> P3
    P3 --> P4
    P4 --> P5
```

### 3.1 阶段一：物理删除假滚动与孤岛死代码（Clean Sweep）
1. 执行物理删除：`ChatScrollAnchor.ts`、`useChatScroll.ts`、`useUndoWithScrollAnchor.ts`；
2. 清理调用方：
   - `MessageVirtualizer.tsx:15, 81`：删除 `useUndoWithScrollAnchor` 的 import 和虚空调用；
   - `useChatCardState.ts`：删除 `useChatScroll` 调用及导出的 `chatFlowRef`、`showScrollToBottom`、`scrollToBottom`；
   - `ChatCard.tsx:272`：移除 `ref={state.chatFlowRef}`；
3. `VirtualScrollManager.ts`：彻底移除 `stickToBottomLock` 字段及 getter/setter。

### 3.2 阶段二：重构 VSM 寻址与 PagingAnchor 双径引擎（Core Math）
1. 在 `VirtualScrollManager.ts` 扩展 `getOffsetById`、`getHeightById`、`scrollToId` 核心原语；
2. 创建 `apps/crish-desktop/src/components/chat-message-list/PagingAnchor.ts`，落实防遮挡快路径与树状数组慢路径；
3. 重构 `useScrollAnchor.ts`：切除 `findMessageElement`、双 rAF 与 50ms `setTimeout`，全面升级为 `vsm.scrollToId`；
4. 净化 `ChatMessageList.tsx`：移除 40ms `setTimeout`。

### 3.3 阶段三：建立 observedTopRef ε-账本与防误杀状态机（State Hardening）
1. 在 `useVirtualScroll.ts` 建立 `observedTopRef` 与 `isAtBottomRef`；
2. 注入 `SCROLL_FLOOR_EPSILON = 2.0px`，在 `onScroll` 回调中进行地表收缩识别与误杀拦截；
3. 优化 `setActual` 的 rAF 批量刷新流程，确保高度更新时同步校准账本基准。

### 3.4 阶段四：落地零高度 Sticky 回底槽与 Composer 变量联动（UI & Layout）
1. 创建 `ScrollToBottomSlot.tsx` 与 `ScrollToBottomSlot.module.css`；
2. 将 `ScrollToBottomSlot` 挂载在 `MessageVirtualizer.tsx` 的 `.listInner` 底部；
3. 从 `ChatStatusRibbons.tsx` 和 `ChatStatusRibbons.module.css` 中彻底剥离旧回底按钮及 `bottom: 148px`；
4. 在 `ChatComposerWrapper` 中挂载 `ResizeObserver`，动态将渲染高度同步至 CSS 变量 `--chat-composer-height`。

### 3.5 阶段五：挂载 chatScrollRegistry 跨会话阅读连续性引擎（Multi-Session Continuity）
1. 创建 `apps/crish-desktop/src/api/chatScrollRegistry.ts`；
2. 在 `MessageVirtualizer.tsx` 中替换掉原有的 `clearHeights()`；
3. 建立生命周期监听：切出会话前调用 `chatScrollRegistry.save`，切入新会话时调用 `chatScrollRegistry.read`，若存在记录则通过 `hydrateHeightMap` + 纯数学切片预定位直达目标行，随后在 `useLayoutEffect` 中执行 `restorePagingAnchor` 微调。

---

## 四、文件域（唯一文件域与边界守门）

### 4.1 核心涉及文件完整白名单

| 文件相对路径 | 归属类型 | 变更性质 | 核心职责与操作边界 |
| :--- | :--- | :--- | :--- |
| `apps/crish-desktop/src/api/VirtualScrollManager.ts` | 核心算法层 | **修改** | 删除 `stickToBottomLock`；新增 `getOffsetById`、`getHeightById`、`scrollToId`。 |
| `apps/crish-desktop/src/hooks/useVirtualScroll.ts` | 视口驱动层 | **修改** | 建立 `observedTopRef` 账本，注入 $\epsilon = 2.0\text{px}$ 容差判定，导出稳定 `isAtBottom`。 |
| `apps/crish-desktop/src/components/chat-message-list/PagingAnchor.ts` | 视口防抖层 | **【新增】** | 双径语义锚定算法（防遮挡快路径 + 树状数组慢路径）与 Pre-paint 补偿。 |
| `apps/crish-desktop/src/api/chatScrollRegistry.ts` | 状态持久层 | **【新增】** | 跨会话滚动位置记忆与无损恢复引擎（单例与高度快照）。 |
| `apps/crish-desktop/src/components/chat-card/ScrollToBottomSlot.tsx` | 悬浮交互层 | **【新增】** | 零高度 Sticky 回底插槽组件。 |
| `apps/crish-desktop/src/components/chat-card/ScrollToBottomSlot.module.css` | 悬浮样式层 | **【新增】** | 零高度、Sticky 钳位、负 margin 抽离、Conex §13 软环焦点态。 |
| `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx` | 主列表渲染层 | **修改** | 单一宿主收敛；移除 `clearHeights()`；挂载 `ScrollToBottomSlot`；接入 `chatScrollRegistry`。 |
| `apps/crish-desktop/src/components/chat-message-list/useScrollAnchor.ts` | 寻址协议层 | **修改** | 切除 DOM 盲查、双 rAF 与 50ms 延时；全面接入 `vsm.scrollToId`。 |
| `apps/crish-desktop/src/components/chat-message-list/ChatMessageList.tsx` | 列表容器层 | **修改** | 移除 40ms `setTimeout` 延时盲等。 |
| `apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.tsx` | 状态栏组件 | **修改** | 切除旧回底按钮及相关 props。 |
| `apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css` | 状态栏样式 | **修改** | 彻底删除 `.chatScrollFab` 及 `bottom: 148px`。 |
| `apps/crish-desktop/src/components/chat-card/ChatCard.tsx` | 对话卡片宿主 | **修改** | 移除 `.chatDocFlow` 上的 `ref={state.chatFlowRef}`。 |
| `apps/crish-desktop/src/components/chat-card/useChatCardState.ts` | 状态管理层 | **修改** | 移除 `scroll.chatFlowRef` 等伪滚动接口。 |
| `apps/crish-desktop/src/components/chat-card/ChatScrollAnchor.ts` | 历史伪滚动 | **【物理删除】** | 物理删除假滚动文件。 |
| `apps/crish-desktop/src/components/chat-card/useChatScroll.ts` | 历史伪滚动 | **【物理删除】** | 物理删除空壳 Hook。 |
| `apps/crish-desktop/src/components/chat-message-list/useUndoWithScrollAnchor.ts` | 孤岛文件 | **【物理删除】** | 物理删除孤岛锚定文件。 |

---

### 4.2 跨维度互斥隔离与零冲突保证

为彻底防御并行协作时的代码冲突与职责越界，本方案设定如下刚性防火墙：
1. **与 DIM-01（纯净画纸扁平化与样式表精炼）的隔离**：
   - DIM-01 专职负责 `ChatMessageRow.module.css`、`ChatAssistantMessageRow.tsx`、`ChatUserMessageRow.tsx` 以及 `ChatNodeSeat.tsx`；
   - DIM-02 仅依赖节点上的 `[data-chat-node-key]` 或 `[data-vindex]` 属性进行探测取样，**严禁修改任何消息行内部组件与样式**；
2. **与 DIM-03（24px 极简思考行流式追踪）的隔离**：
   - DIM-03 负责将 `TimelineThoughtSection.tsx` 改造为 `ReasoningRow.tsx`，切除内层滚动；
   - DIM-02 负责外层视口对折叠/展开行为的 $\epsilon$-账本防护，**严禁侵入思考行内部逻辑**；
3. **与 DIM-04（24px 工具调用单行与领域专有展开卡片）的隔离**：
   - DIM-04 专职负责 `chat-tool-call/` 目录；
   - DIM-02 仅负责为工具卡片展开提供稳定的视口宿主；
4. **与 DIM-05（轮次过程折叠状态机）的隔离**：
   - DIM-05 专职负责过程折叠状态机；
   - DIM-02 为双轨全文检索提供底层的 `vsm.scrollToId()` 坐标直达能力。

---

## 五、验收标准（功能验收 + 负产出验收）

### 5.1 功能验收断言（6 大硬性指标）

1. **Prepend 50 条历史消息 0 像素跳动断言**：
   - *测试动作*：用户滚动至视口中部（例如停留于第 40 条消息），触发向上加载 50 条历史消息；
   - *断言*：`useLayoutEffect` 执行 Pre-paint 相对坐标补偿后，正在阅读的第 40 条消息在屏幕中的渲染绝对坐标偏差 $\Delta Y \equiv 0\text{px}$（允许浮点亚像素差值 $\le 0.5\text{px}$），肉眼观察绝对静止；
2. **地表收缩钳位（Floor Clamping）吸底跟随不丢失断言**：
   - *测试动作*：滚动条位于视口最底部（`isAtBottom = true`），折叠一个高度为 1500px 的长思考块或长文本，触发 `scrollHeight` 暴跌；
   - *断言*：`useVirtualScroll` 的 `observedTopRef` 成功拦截浏览器被动钳位，`isAtBottom` 严格保持 `true`；后续产生新 Token 时，视口自适应平滑吸底向下滚动；
3. **跨会话切换 0 像素跳动恢复断言**：
   - *测试动作*：在长会话 A 中浏览至第 65 条消息，切换至会话 B 发送一条消息，再次切回会话 A；
   - *断言*：切回瞬间，首帧通过 `vsm.getOffsetById` 纯数学切片直达原阅读位置，目标行相对视口顶部偏差 $\Delta Y \equiv 0\text{px}$，无任何白屏或回滚到顶部的抖动；
4. **回底按钮零高度占位断言**：
   - *测试动作*：检查 DOM 树中挂载的 `ScrollToBottomSlot`；
   - *断言*：该元素 `clientHeight`、`offsetHeight` 严格为 $0$；按钮出现与消失时，容器的 `scrollHeight` 变化量严格为：
     $$\Delta \text{scrollHeight} = 0\text{px}$$
5. **Composer 动态高度自适应联动断言**：
   - *测试动作*：在底栏 Composer 中换行输入 8 行文本或添加 3 个文件胶囊，使底栏高度从 60px 膨胀至 180px；
   - *断言*：`--chat-composer-height` 动态更新，回底按钮始终平滑悬浮在输入框上沿精确 $16\text{px}$ 处，绝无遮挡，绝无悬空；
6. **虚拟列表绝对坐标寻址断言**：
   - *测试动作*：点击已固定列表（PinnedBar）中一条位于视口外 2000px 处的历史消息；
   - *断言*：调用 `vsm.scrollToId`，视口在 0ms 内精确居中对齐目标消息，目标行真实 DOM 当帧挂载，无任何 `setTimeout` 延迟，无未找到错误。

---

### 5.2 负产出验收断言（5 大硬性指标）

1. **物理删除 3 个假滚动与孤岛文件**：
   - `apps/crish-desktop/src/components/chat-card/ChatScrollAnchor.ts` 文件不存在；
   - `apps/crish-desktop/src/components/chat-card/useChatScroll.ts` 文件不存在；
   - `apps/crish-desktop/src/components/chat-message-list/useUndoWithScrollAnchor.ts` 文件不存在；
2. **清除所有魔术延时定时器**：
   - `ChatMessageList.tsx` 中全文无 `setTimeout(..., 40)`；
   - `useScrollAnchor.ts` 中全文无 `setTimeout(..., 50)`，无双 `requestAnimationFrame` 盲等；
3. **彻底清退 `bottom: 148px`**：
   - `ChatStatusRibbons.module.css` 中全文无 `148px` 硬编码数字，无 `.chatScrollFab` 类；
   - `ChatStatusRibbons.tsx` 无 `showScrollToBottom` 与 `onScrollToBottom` props；
4. **清理孤岛死属性**：
   - `VirtualScrollManager.ts` 中无 `stickToBottomLock` 及其 getter/setter；
5. **全会话严格单一物理滚动宿主**：
   - 检查会话卡片区域 DOM 树，拥有 `overflow-y: auto` 或 `overflow-y: scroll` 计算样式的元素**仅且仅有** `MessageVirtualizer` 的 `.list` 容器一个，全会话无第二滚动条。

---

### 5.3 极端边界魔鬼用例与容灾验证矩阵

| 用例编号 | 场景描述与施压条件 | 预期行为与数学断言 | 容灾与降级机制 |
| :--- | :--- | :--- | :--- |
| **TC-DIM02-01** | **极速连续 Prepend 历史**：用户在 500ms 内连续触发 3 次翻页，前置插入 150 条消息。 | 每次 Prepend 后 `useLayoutEffect` 同步补偿，视口锚点连续锁定，累积位移偏差 $\le 1.0\text{px}$。 | 若单次插入量过大导致锚点超出渲染切片，直接走 VSM 前缀和差分补偿。 |
| **TC-DIM02-02** | **巨型思考块流式闭合**：生成中展开为 3000px，轮次结束瞬时收折为 33px 发丝栏。 | `observedTopRef` 判定为地表收缩，`isAtBottom` 不被误杀，视口平稳停留在最新底部。 | 即使 Windows 缩放产生 0.8px 舍入误差，依然由 $\epsilon = 2.0\text{px}$ 拦截。 |
| **TC-DIM02-03** | **跨会话高速闪切**：用户在 1 秒内连续在 5 个会话间高速切换。 | `chatScrollRegistry` 内存读取耗时 $< 0.1\text{ms}$，首帧纯数学切片挂载，无白屏与重排风暴。 | 记录设有 60 分钟 TTL，自动淘汰过期会话，防范内存泄露。 |
| **TC-DIM02-04** | **输入框超大伸缩**：Composer 从单行（56px）突然贴入大段代码变为 300px。 | 零高度 Sticky 槽由 CSS calc 自适应瞬移，回底按钮物理位置平滑抬升，$\Delta \text{scrollHeight} = 0$。 | 槽位 `height: 0` 保证无论如何伸缩绝不影响消息列表自身的可滚动高度。 |
| **TC-DIM02-05** | **离线消息寻址**：通过搜索跳转到一条未渲染、且未被测量过实际高度的历史消息。 | `vsm.scrollToId` 依据 `estimated` 高度树状数组精确跨步定位，首帧挂载真实 DOM 并微调。 | 挂载后 ResizeObserver 测出实际高度，BIT 局部更新，差量自动吸收。 |

---

> **定案结论**：
> 本详案全面覆盖单一滚动宿主铁律、PagingAnchor 双径算法、observedTopRef $\epsilon$-账本、零高度 Sticky 回底槽以及 chatScrollRegistry 跨会话恢复机制，锁定了净削减 ≥ 350 行的刚性删除面，构筑起工业级坚固的视口力学基石。可作为后续实现波次直接执行的最高准则。
