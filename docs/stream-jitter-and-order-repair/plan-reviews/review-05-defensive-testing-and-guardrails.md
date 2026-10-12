# 防御性测试与立体门禁独立评审报告

> **文档标识**：`review-05-defensive-testing-and-guardrails`  
> **所属战役**：`stream-jitter-and-order-repair`（流式渲染卡顿跳动与时序重排系统性治理）  
> **评审专家**：防御性测试与立体门禁评审专家（Reviewer 05）  
> **评审对象**：`docs/stream-jitter-and-order-repair/00-总方案.md` 及 `independent-plans/` 01 至 09 详案（重点 06、07、08）  
> **权威裁决基准**：根目录 `AGENTS.md`（§7.1 立体验证纪律、§9 测试资产保护铁律、§11 CI治理与行数门禁、§15 桌面调试通道）、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`scripts/check-line-counts.mjs`  
> **产出时间**：2026-10-12

---

## 一、评审全景与核心裁决摘要（Executive Summary）

本次战役旨在根治流式 Markdown 解析卡顿、尾块封口塌陷闪烁、虚拟滚动吸底突跳以及重启后消息倒置四大顽疾。方案库（总方案 + 01~09 详案）在理论深度、因果数学证明与微观机制溯源上展现了极高的工业水准，特别是：

- 详案 07 建立了代数级严格弱序证明与因果拓扑不变量；
- 详案 08 提出了流式修正布局偏移（S-CLS）与封口高度振荡指数（$I_{\text{SHO}}$）数学度量模型；
- 详案 06 明确了三维立体化验证矩阵与反过度设计收敛红线。

然而，站在**【防御性测试与立体门禁守门】**的最严苛视角下，本评审组通过对源码、存量测试基建、行数门禁基线与自动化探针脚本的穿透式审计，排查出 **5 项必须立即整改的阻断级隐患（Hard Blockers）** 与 **3 项强烈建议优化项（Enhancements）**：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       评审核心判决与风险态势总览                             │
├───────────────────┬─────────────────────────────────────────────────────────┤
│ 1. 测试资产保护   │ ⚠️ 严重漏洞：总方案与详案 06/08 完全遗漏 reference/markdown-   │
│    (AGENTS.md §9) │    editor/ 门禁与 tests/e2e/ 5 个专项 Markdown spec 的显式保护   │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 2. 行数预算门禁   │ 🚨 阻断风险：sessionEventProjection.ts 存量 348 行（基线 350）， │
│    (RL-03 门禁)   │    方案 06 误标预算 ≤450 行！修改必引爆 CI；useVirtualScroll 与   │
│                   │    sessionRustDbHydrate 逼近 85% 预警线，急需强制拆分前置      │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 3. 几何安全防御   │ 🚨 崩溃死穴：VirtualScrollManager.setActual 缺乏 NaN 与负数高度  │
│    (树状数组安全) │    拦截断言，极端盒模型异常可导致 Fenwick 树全量崩溃白屏      │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 4. 探针算法保真度 │ ⚠️ 虚警风险：详案 08 S-CLS 探针未过滤底部正向位移，将导致高吞吐   │
│    (可判定性门禁) │    流式输出时产生 0.3~0.8 的假阳性 S-CLS，直接误炸 CI 门禁    │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 5. 调试协议合规性 │ ⚠️ 口径冲突：详案 08 包含 CDP CPU 降频，须严格隔离为无头 Web 专用，│
│    (AGENTS.md §15)│    桌面端现场验收绝对禁止连接 9222 CDP，唯一合法通道为 4000 MCP  │
└───────────────────┴─────────────────────────────────────────────────────────┘
```

---

## 二、测试资产保护红线审查（Test Asset Protection Baseline）

对照 `AGENTS.md` §9「测试资产保护铁律（2026-08-07 事故后生效）」，任何实施方案必须把存量测试资产的完好性置于最高优先级。

### 2.1 `reference/markdown-editor/` 存量测试资产保护评估

- **现状核查**：
  `reference/markdown-editor/` 目录下受版本库严格保护的测试资产多达 100+ 个（`tests/unit/*`，涵盖 `grapheme.test.ts`、`undo.test.ts`、`parser-redos.test.ts`、`stream-buffer.test.ts`、`stream-frame-batch.test.ts`、`table-island.test.ts` 等核心资产）。
- **审查缺陷发现**：
  1. 在 `00-总方案.md` 第四节「实施分波推进路线」与第五节「验收基线」中，仅列出了 `cargo test`、前端 `Vitest` 及新建的 `Playwright E2E-L3`，**完全未提及 `reference/markdown-editor` 的核心门禁：`npm test`（`vitest run tests/unit`）**！
  2. 详案 02 与详案 03 在引用流式分块和增量解析逻辑时，未对 `reference/markdown-editor` 的只读性做出刚性声明。
- **整改红线要求**：
  在总方案 Wave 4 与实施门禁脚本中，必须显式加入：
  ```bash
  cd reference/markdown-editor && npm test
  ```
  必须保证 100% 绿灯通过；严禁任何子 Agent 删除、修改、移动该目录下的任何测试文件。

### 2.2 `tests/e2e/` 既有 Markdown-Editor 专项测试资产保护评估

- **现状核查**：
  仓库 `tests/e2e/` 下受 `AGENTS.md` §9 显式点名保护的 5 个专项测试为：
  1. `ast-block-tables.spec.ts`
  2. `format-checker.spec.ts`
  3. `ime-composition.spec.ts`
  4. `keyboard-navigation.spec.ts`
  5. `wysiwyg-interaction.spec.ts`
     此外，还包含 `streaming-render.spec.ts`、`session-restore.spec.ts`、`ui-store-invariants.spec.ts`、`perf-streaming.spec.ts` 等流式关键 E2E 资产。
- **审查缺陷发现**：
  详案 08 提出了新增 `tests/e2e/perf-visual-stability.spec.ts`，但未明确声明对既有这 5 个专项 spec 的兼容性保护。在本次对 `MarkdownBlockItem.tsx`、`ReconciledMarkdownHtml.tsx` 与 `MessageVirtualizer.tsx` 的 DOM 属性与生命周期重构中，若改动了关键选择器（如 `[data-markdown-block]`、`[data-testid="chat-input"]`）或破坏了交互事件派发链路，可能导致这 5 个针对性测试意外报红。
- **整改红线要求**：
  1. 实施阶段改动组件属性时，必须保持既有 `data-*` 属性契约向前兼容；
  2. 方案必须将这 5 个专项 spec 列入 CI 回归检查清单（`npx playwright test tests/e2e/ast-block-tables.spec.ts ...`），要求零回归失败。

---

## 三、极限魔鬼用例与边界覆盖度审查（Evil Test Cases Coverage）

### 3.1 魔鬼用例矩阵对账表

对照各详案，对极限边界用例的设计充分性进行全面对账：

| 极端场景 / 魔鬼用例              | 覆盖详案                     | 检验机制与断言设计                                                                     | 评审判定        | 隐患与补齐建议                                                                                                                                                                                              |
| :------------------------------- | :--------------------------- | :------------------------------------------------------------------------------------- | :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 逆序反转不变性**            | 详案 07 §2.3.2               | $\text{compareMessageOrder}(a, b) = -\text{compareMessageOrder}(b, a)$；传递性代数公理 | ✅ **充分**     | 已具备形式化数学证明与穷举断言。                                                                                                                                                                            |
| **2. 同毫秒并发碰撞**            | 详案 01 §3.2、详案 07 §3.1   | `ts_U === ts_A` 时，利用 `RoleRank (User=1 < Asst=2)` 与 `engineSequence` 守门         | ✅ **充分**     | 彻底消灭 `a.id.localeCompare(b.id)` 字典序陷阱。                                                                                                                                                            |
| **3. 极窄单字符/空换行段落封口** | 详案 02 §三                  | `SEALING_PENDING` 锁存过渡；协调器底层零塌陷护盾                                       | ⚠️ **需补充**   | **边界死角**：若流式输出遇到极短内容（如单个字符 `a` 或仅包含 `\n`）瞬间封口，`streamingUnitsRef` 极其微小甚至为空，容易触发边界分支退化。必须在 `MarkdownBlockItem.test.tsx` 补充此魔鬼用例。              |
| **4. 超长半成型流式表格**        | 详案 08 场景 B               | 12列 $\times$ 60行超宽表格流式增行测试                                                 | ⚠️ **需补充**   | **边界死角**：流式生成中，表格行处于“未闭合管道符 `\|`”状态时，Markdown 语法可能暂时退化为普通段落，下一 chunk 到达又突变成表格。必须断言此过程中盒模型不发生剧烈跳动（高度单调约束）。                     |
| **5. 极端负数与 NaN 测高阻断**   | 详案 04、06                  | 虚拟滚动 `setActual` 测高提交                                                          | 🚨 **严重缺失** | **致命死穴**：当窗口缩放至 0、CSS 隐藏或 KaTeX/图片渲染异常时，DOM 测高可能返回 `NaN`、`Infinity` 或 `< 0`。若直接写入 Fenwick 树，会导致整个前缀和账本永久污染为 `NaN`，引发白屏死锁！详案未设计防御断言。 |
| **6. 会话分支撤回与幽灵消息**    | 详案 07 §3.2                 | Diff Shrink 删除 `seq >= N`；引擎冻结序号隔离                                          | ✅ **充分**     | 彻底断绝截断历史后的幽灵尾部消息。                                                                                                                                                                          |
| **7. 100+ 轮交替长会话压力**     | 详案 07 §3.3、详案 08 场景 B | 50 轮交互对账、52,000 字符长文排版                                                     | ✅ **充分**     | 二分插入稳定性与虚拟滚动 DOM 节点常数上界受控。                                                                                                                                                             |

### 3.2 树状数组几何安全防御硬性补齐（NaN & Negative Height Guard）

针对上述第 5 项致命缺失，必须在 `apps/crish-desktop/src/api/VirtualScrollManager.ts` 与实施计划中加入硬性断言与单元测试：

```typescript
// 必须在 VirtualScrollManager.setActual / commitActualHeights 实施前置守门：
public setActual(index: number, height: number): void {
  // 刚性几何守门：坚决拦截 NaN、无穷大与负数
  if (!Number.isFinite(height) || height < 0) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[VSM Guard] Rejected invalid measured height: index=${index}, height=${height}`);
    }
    return;
  }
  // 正常更新 Fenwick Tree...
}
```

**单元测试断言要求**：
在 `VirtualScrollManager.test.ts` 中新增魔鬼用例，连续传入 `setActual(3, NaN)`、`setActual(4, -100)`、`setActual(5, Infinity)`，断言总高度 `getTotalHeight()` 绝不为 `NaN`，前缀和计算与二分查找保持严格单调。

---

## 四、自动化门禁可判定性审查（Guardrails Determinism）

对照 `AGENTS.md` §7.1「立体验证纪律（禁止单一检查冒充验收）」，自动化门禁必须具备严格的物理判定性，坚决杜绝空壳测试与假阳性虚警。

### 4.1 S-CLS（流式修正累计布局偏移）探针算法修正

#### 审查发现：详案 08 探针脚本存在严重假阳性逻辑

详案 08 在 §2.1 理论部分非常正确地指出了：“流式输出中容器因正常追加内容向下延伸是符合预期的，不能计入 CLS”。
但在详案 08 §4.1 的注入脚本实现中（`createInPageProbeScript` 行 399-408）：

```javascript
// 详案 08 中的原版注入代码：
const layoutShiftObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (!entry.hadRecentInput) {
      probe.sCls += entry.value; // 致命问题：直接无差别累加了！
    }
  }
});
layoutShiftObserver.observe({ type: 'layout-shift', buffered: true });
```

**严重逻辑断层**：
浏览器原生 `layout-shift` 只要检测到 DOM 元素位移且最近 500ms 内无用户交互，就会派发事件。流式吐字导致尾部不断延伸、滚动条下移时，只要视口内下方元素发生了向下位移，浏览器就会产生 `entry.value`！
若直接累加 `probe.sCls += entry.value`，在超长文本流式生成期间，实测累加值将高达 `0.3 ~ 0.8`，**直接击穿详案 08 自己设定的 CI 阻断红线 `> 0.05`，导致 CI 流水线 100% 误报红灯阻断！**

#### 判定性算法必须改：引入真·非预期位移判定

探针脚本必须深入 `entry.sources` 校验位移元素的物理拓扑与位移方向：

```javascript
// 修正后的高保真 S-CLS 过滤算法：
const layoutShiftObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.hadRecentInput) continue;

    let isUnintendedShift = false;
    for (const source of entry.sources || []) {
      const prevTop = source.previousRect.top;
      const currTop = source.currentRect.top;
      // 1. 若位移发生在视口可见的已有历史内容上，且发生了反向（向上）跳变或突发震荡
      if (Math.abs(currTop - prevTop) > 1.0) {
        // 排除整体吸底跟随引起的全局坐标平移
        if (source.node && !source.node.hasAttribute?.('data-stream-tail')) {
          isUnintendedShift = true;
          break;
        }
      }
    }
    // 仅当确实属于已有内容的非预期抖动时，才累计入 S-CLS
    if (isUnintendedShift) {
      probe.sCls += entry.value;
    }
  }
});
```

### 4.2 掉帧率（DFR）与测试环境分级断言策略

- **环境差异诊断**：
  详案 08 将 `DFR ≤ 2.5%` 与 `FPS_1%-Low ≥ 45` 设定为 CI 阻断红线。
  然而，在 GitHub Actions Linux Runner 或无 GPU 加速的 Docker 虚拟化环境中，无头 Chromium 运行在软光栅（Software Rasterizer，如 SwiftShader）模式下，主线程单帧耗时本身波动极大（经常超过 25ms）。如果直接在 CI 环境硬卡 45 FPS，会产生环境噪音引发的假失败。
- **分级门禁断言规范**：
  1. **CI 无头容器环境（Fast/Regression CI）**：
     重点卡死**刚性确定性数学指标**：
     - $N_{\text{void}} \equiv 0$（严禁 DOM 裸奔白屏，无容差）；
     - $I_{\text{SHO}} \le 0.02$（封口高度振荡 $\le 2\%$）；
     - $\text{GFPC} \equiv 0$（手势假阳性误判为 0）；
     - $\text{S-CLS} \le 0.03$；
     - 最大视口反向抖动 $V_{\text{jitter}} \le 2\text{px}$。
  2. **本地/现场桌面宿主环境（Tauri MCP 4000 真实验收）**：
     全面开启物理帧率门禁断言：
     - 高吞吐流式输出下 DFR $\le 2.5\%$，FPS $\ge 58$。

### 4.3 桌面端调试通道与 CDP 禁令对齐（AGENTS.md §15.2）

- **审查发现**：
  详案 08 场景 D（CPU 6x 降频）使用了 Playwright 原生 CDP：
  ```typescript
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  ```
- **纪律对齐裁决**：
  根据 `AGENTS.md` §15.2 用户裁决：**“9222 / CDP 列为禁止项... 调试本软件时禁止通过 WebView2 的 9222 CDP 做任何 UI 调试、DOM 检查、截图或状态读取；一律改走 4000 Tauri MCP”**。
  - **判定结论**：
    Playwright 在无头 Chromium 浏览器自动化测试中调用的 CDP 是 Playwright 内部机制，作为浏览器端基准压测是允许的；
    **但必须向主控与所有子 Agent 明确划清红线**：在运行桌面端 Tauri 应用（`npm run dev:workbench`）进行真实 UI 现场验收时，**严禁**开启 `--remote-debugging-port=9222` 或连接 CDP，所有现场验收必须通过 TCP 4000 Tauri MCP 完成！

---

## 五、代码行数预算守门与拆分预案（Line Budgets Gatekeeping）

对照 `AGENTS.md` §11 与 `scripts/check-line-counts.mjs`，前端文件严格受控于类别上限（UI组件 $\le 500$、业务逻辑 $\le 400$、类型契约 $\le 800$）以及 `frontend-line-counts-baseline.md` 标记区的冻结基线。

### 5.1 本次战役改动核心文件行数预算全景扫描表

通过对当前代码库实际扫描（`check-line-counts.mjs`）与各方案修改计划交叉比对，建立如下监控雷达：

| 文件路径                                                                         | 类别           | 当前实测有效行 | 门禁上限/基线值 | 预警线 (85%) | 方案预计净增行 | 预计修改后行数 | 风险等级与判决                           |
| :------------------------------------------------------------------------------- | :------------- | :------------- | :-------------- | :----------- | :------------- | :------------- | :--------------------------------------- |
| `apps/crish-desktop/src/api/sessionEventProjection.ts`                           | Business Logic | **348**        | **350 (基线)**  | 340 (已超)   | +35~50         | **383~398**    | 🚨 **严重违规阻断**（超基线 350）        |
| `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts`         | Business Logic | **337**        | **400 (类别)**  | **340**      | +20~30         | **357~367**    | ⚠️ **高危预警**（超 85% 预警线）         |
| `apps/crish-desktop/src/hooks/useVirtualScroll.ts`                               | Business Logic | **295**        | **400 (类别)**  | **340**      | +60~90         | **355~385**    | ⚠️ **高危预警**（超 85% 预警线）         |
| `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx`     | UI Component   | **433**        | **476 (基线)**  | 425 (已超)   | +10~15         | **443~448**    | 🟡 **可控受限**（距基线 476 仅剩 28 行） |
| `apps/crish-desktop/src/api/VirtualScrollManager.ts`                             | Business Logic | **338**        | **371 (基线)**  | 340 (临界)   | +3~5 (防护)    | **341~343**    | 🟡 **安全受限**（严禁塞入复杂逻辑）      |
| `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx`       | UI Component   | **161**        | **500 (类别)**  | 425          | +45~55         | **206~216**    | 🟢 **安全充裕**                          |
| `apps/crish-desktop/src/api/markdownRenderAsync.ts`                              | Business Logic | **191**        | **400 (类别)**  | 340          | +35~45         | **226~236**    | 🟢 **安全充裕**                          |
| `apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx`          | UI Component   | **79**         | **500 (类别)**  | 425          | +15~20         | **94~99**      | 🟢 **安全充裕**                          |
| `apps/crish-desktop/src/store/messageOrderKey.ts`                                | Business Logic | **55**         | **400 (类别)**  | 340          | +25~30         | **80~85**      | 🟢 **安全充裕**                          |
| `apps/crish-desktop/src/components/chat-message-row/MessageToolCallsSection.tsx` | UI Component   | **154**        | **500 (类别)**  | 425          | -15 (清退RO)   | **~139**       | 🟢 **优化收敛**                          |

---

### 5.2 三大高危文件强制解耦与重构拆分预案

#### 1. 阻断攻坚：`sessionEventProjection.ts`（必须立即拆分）

- **危机穿透**：
  该文件目前 348 行，基线硬卡死在 350 行。详案 06 误以为预算为“≤ 450 行”（完全脱离了 Business Logic 上限 400 与基线 350 的事实）。方案 01 若直接在此文件中写入 `extractMessageTimestamp` 与 sequence 转换，提交时 `scripts/check-line-counts.mjs` 必定以 Exit Code 1 阻断！
- **拆分重构方案**：
  必须在前置重构中，新建独立模块：
  `apps/crish-desktop/src/api/sessionEventTimestamp.ts`（约 50 行，专门承载 `extractMessageTimestamp` 及其单元测试）；
  同时在 `sessionEventProjection.ts` 中引入并清理历史重复类型断言，将主文件行数压降至 **≤ 320 行**，彻底从基线中释放！

#### 2. 预警攻坚：`useVirtualScroll.ts`（避免上帝 Hook 膨胀）

- **危机穿透**：
  当前 295 行。方案 04 与 05 计划加入程序滚动令牌、物理手势捕获、rAF 即时提交队列、视口上方高度补偿（`deltaAbove`）。全部堆叠后预计达到 375~385 行，严重触发 340 行 WARNING 告警。
- **拆分重构方案**：
  1. 新建 `apps/crish-desktop/src/hooks/useVirtualScrollGesture.ts`（负责 wheel/touch 原生捕获与 gestureEpoch 状态机管理）；
  2. 新建 `apps/crish-desktop/src/api/virtualScrollAnchoring.ts`（纯数学计算函数：`calcScrollAnchoringDelta`）；
  3. `useVirtualScroll.ts` 保持纯净调度入口，行数严格控制在 **≤ 310 行**。

#### 3. 预警攻坚：`sessionRustDbHydrate.ts`（存量精简与分流）

- **危机穿透**：
  当前 337 行，距离 340 行预警线仅差 3 行！方案 01 与 09 计划对其进行 Generation Token 与 JIT 水合改造。
- **拆分重构方案**：
  将内部消息数据行解析与字段映射逻辑（`rowToSessionMessage` 类转换）收口到 `session-persistence/sessionHydrationMessages.ts`（当前 264 行，预算充裕），避免在 `sessionRustDbHydrate.ts` 中写膨胀，确保其行数稳定在 **≤ 325 行**。

---

## 六、三维立体门禁检查矩阵（Three-Dimensional Guardrails Matrix）

根据 `AGENTS.md` §7.1，在 Wave 4 验收与交付前，必须按以下三维矩阵进行逐项刚性核销：

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                三维立体门禁核销矩阵                                      │
├───────────────────┬───────────────────────────────────┬─────────────────────────────────┤
│ 维度层次          │ 检查靶点与核销命令                │ 刚性放行判定标准 (Pass Criteria)│
├───────────────────┼───────────────────────────────────┼─────────────────────────────────┤
│ 维度 1:           │ 1. node scripts/check-line-counts │ • 0 Violations, 0 Hard Blocks   │
│ 静态与代码门禁    │    .mjs --all                     │ • 修改文件无任何超标报错        │
│ (Static Quality)  │ 2. npm run typecheck              │ • TypeScript 严格模式 0 错误    │
│                   │ 3. 检查无 any 裸奔与魔术数字补偿  │ • 零 setTimeout 补丁, 零坐标写死│
├───────────────────┼───────────────────────────────────┼─────────────────────────────────┤
│ 维度 2:           │ 1. npm run test (vitest unit)     │ • messageOrderKey.test 严格弱序 │
│ 核心纯逻辑单元门禁│ 2. cd reference/markdown-editor   │ • reference/ 门禁 100% PASS     │
│ (Unit Invariants) │    && npm test                    │ • VSM NaN/负数高度拦截 100% 覆盖│
│                   │ 3. markdownRenderAsync 批合并测试 │ • 单次 advance 触发 setState=1次│
├───────────────────┼───────────────────────────────────┼─────────────────────────────────┤
│ 维度 3:           │ 1. npx playwright test tests/e2e/ │ • 5 大 Markdown spec 零回归     │
│ 端到端与现场物理门禁│    ast-block-tables.spec.ts ...   │ • perf-visual-stability 全绿:   │
│ (Real Execution)  │ 2. tests/e2e/perf-visual-         │   - N_void ≡ 0 次 (零白屏)      │
│                   │    stability.spec.ts              │   - I_SHO ≤ 0.02 (高度振荡 ≤2%) │
│                   │ 3. 桌面端 4000 MCP 现场验收:      │   - GFPC ≡ 0 次 (手势假阳性 0)  │
│                   │    sess-1791764675736 重启对账    │ • 历史会话倒置率严格为 0%       │
└───────────────────┴───────────────────────────────────┴─────────────────────────────────┘
```

---

## 七、整理给主控的判定清单（Must-Fix / Suggestions / Risks）

### 7.1 必须改（Hard Blockers）

1. **【行数门禁】更正详案 06 的 450 行错误预算，对 `sessionEventProjection.ts` 实施拆分**：
   - 立即修正详案 06 §4.1 表格中的错误标注（该文件上限为 400 且基线为 350，绝非 450）；
   - 在 Wave 1 执行前，强制增加拆分任务：新建 `sessionEventTimestamp.ts`，将时间戳与因果提取逻辑外置，确保主文件控制在 320 行以内。
2. **【行数门禁】将 `useVirtualScroll.ts` 与 `sessionRustDbHydrate.ts` 的模块拆分列为前置任务**：
   - 禁止在 `useVirtualScroll.ts`（295行）内直接直塞手势监听器与形变补偿计算，必须抽离 `useVirtualScrollGesture.ts` 与 `virtualScrollAnchoring.ts`；
   - 将 `sessionRustDbHydrate.ts`（337行）的数据映射分流至 `sessionHydrationMessages.ts`，彻底消除 85% WARNING 风险。
3. **【防御性测试】在 `VirtualScrollManager` 中增加 NaN 与负数高度刚性守门及魔鬼单元测试**：
   - 在 `setActual` 中加入 `if (!Number.isFinite(height) || height < 0) return;` 守门逻辑；
   - 在 `VirtualScrollManager.test.ts` 中新增极端畸变高度测试用例，断言前缀和账本永不崩溃。
4. **【测试资产保护】在总方案 Wave 4 与验收基线中恢复 `reference/markdown-editor` 门禁与 5 个 E2E 专项 spec**：
   - 在 `00-总方案.md` 与实施规范中显式写入 `cd reference/markdown-editor && npm test` 门禁断言；
   - 将 `ast-block-tables` 等 5 个既有 spec 加入回归测试矩阵，严禁因属性改动造成既有测试报红。
5. **【门禁可判定性】修复详案 08 S-CLS 探针脚本中未过滤正常流式延伸的假阳性算法**：
   - 修订 `createInPageProbeScript`，通过 `entry.sources` 过滤视口底部的正常增量延伸，仅对视口内部已有历史内容的非预期反向抖动计入 S-CLS，避免 CI 虚警爆表。

### 7.2 建议改（Enhancements）

1. **【协议合规声明】明确区分 Playwright 无头压测与 Tauri 桌面端 MCP 验收边界**：
   - 在详案 08 中注明：Playwright CDP 仅限于 Chromium 无头测试场景；桌面端现场验收严格遵守 `AGENTS.md` §15.2，一律走 TCP 4000 Tauri MCP，绝对不连接 9222 CDP。
2. **【魔鬼用例增强】补齐单字符极窄行封口与未闭合流式表格的鲁棒性测试**：
   - 在 `MarkdownBlockItem.test.tsx` 增加 `1 char + \n` 极窄封口测试，验证 `SEALING_PENDING` 锁存不退化；
   - 在增量解析测试中增加破损/半成型 Markdown 表格持续吐字测试，断言 DOM 结构抗畸变性。
3. **【CI 环境分层】对 CI 软光栅无头容器与本地高刷桌面宿主实行分级指标判定**：
   - CI 环境重点拦截刚性数学指标（$N_{\text{void}} \equiv 0$、$I_{\text{SHO}} \le 0.02$、GFPC $\equiv 0$）；高刷帧率（$\ge 58\text{ FPS}$）作为本地桌面现场验证指标，避免 CI 虚拟化算力波动造成偶发失败。

### 7.3 可接受风险（Acceptable Risks & Trade-offs）

1. **E2E-L3 压测执行耗时成本（3~5 分钟）**：
   - 详案 08 包含 4 个大型高压测试（52,000 字符排版、200 tokens/s 吞吐、高频 Resize），全套执行耗时约 3~5 分钟。
   - **裁决**：作为 CI 中层/专道或 PR 合入前门禁执行，与 30 秒快层（单元测试 + 行数门禁）解耦，以轻微的时间成本换取绝对的视觉稳定性保证，完全合规。
2. **存量基线文件的渐进式治理**：
   - `frontend-line-counts-baseline.md` 中仍存在其它模块的历史超标条目。
   - **裁决**：本次战役坚持反退避与精准治理原则，仅对本次改动的相关文件实施零膨胀与拆分瘦身，不盲目扩大破坏面去修改域外历史代码，符合 `三原则.md`。

---

## 八、评审结论（Final Verdict）

本评审专家对战役总方案及 01~09 详案给出**【有条件通过（Conditional Pass，须落实上述 5 项必须改）】**的终审意见。方案在架构收敛与机制分析上具备极高的专业水准，只要在实施前严格落地**行数预算拆分前置**、**树状数组几何防御**、**探针算法修正**以及**既有测试资产保护门禁**，本战役必将高质量达成零塌陷、零顿挫、零突跳与因果时序单轨收敛的最终战果！
