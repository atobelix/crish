# Conex / Crish 界面视觉重构交叉评审报告 B
# —— 差异面板算法、性能与小元素脱黑完整性审查

> **评审编号**：REVIEW-B-20260830
> **责任领域**：差异面板（Diff Panel）全链路算法与高亮渲染、微小元素脱黑完整性、弹性容器滚动链、跨方案冲突与系统级稳定性
> **被审方案**：
> - [`docs/ui-style-refactor/independent-plans/02-accent-token-and-small-elements-deblack-plan.md`](file:///c:/Software/conex/docs/ui-style-refactor/independent-plans/02-accent-token-and-small-elements-deblack-plan.md)（方案 02）
> - [`docs/ui-style-refactor/independent-plans/03-diff-panel-layout-and-syntax-highlighting-plan.md`](file:///c:/Software/conex/docs/ui-style-refactor/independent-plans/03-diff-panel-layout-and-syntax-highlighting-plan.md)（方案 03）
> - 协同交叉核验：方案 01、方案 04、方案 05 与 [`00-定案-视觉样式与差异面板重构决策.md`](file:///c:/Software/conex/docs/ui-style-refactor/00-%E5%AE%9A%E6%A1%88-%E8%A7%86%E8%A7%89%E6%A0%B7%E5%BC%8F%E4%B8%8E%E5%B7%AE%E5%BC%82%E9%9D%A2%E6%9D%BF%E9%87%8D%E6%9E%84%E5%86%B3%E7%AD%96.md)
> **评审原则**：严格遵照《主控全流程调度 v3》§二.2 规范，零委婉、深挖死角、直击底层逻辑漏洞、防退化与防破坏。严禁执行 git 操作。

---

## 目录索引

1. [评审执行摘要与缺陷严重度矩阵](#一评审执行摘要与缺陷严重度矩阵)
2. [审查重点一：差异面板真实高亮与 Hunk 对偶对齐算法深度审查（方案 03）](#二审查重点一差异面板真实高亮与-hunk-对偶对齐算法深度审查方案-03)
   - 2.1 `renderHighlightedTokens` 分段词法高亮：语法上下文粉碎与高频 GC 性能隐患
   - 2.2 `buildSplitLinePairs` 对偶配对与 `parseDiffText` 算法的完备性漏洞
   - 2.3 `DiffCard` 体系与 `<widget-diff>` 双源分歧：`useDiffData.ts` 漏改盲区
   - 2.4 `DiffCardUnifiedView` 1 行邻近探测对 $N:M$ 多变动块失效
3. [审查重点二：微小元素脱黑覆盖完整性与潜在破坏性审查（方案 02）](#三审查重点二微小元素脱黑覆盖完整性与潜在破坏性审查方案-02)
   - 3.1 方案 02 脱黑遗漏盲区（`FirstRunWizard`、`Dialog`、`tabDragGhost` 等）
   - 3.2 `Button` 默认变体由 `primary` 改为 `ghost` 的破坏性风险（Breaking Change）
   - 3.3 `Button.test.tsx` 现有单测红灯盲区
4. [审查重点三：弹性高度（44~520px）与滚轮链解绑的影响评估](#四审查重点三弹性高度44520px与滚轮链解绑的影响评估)
   - 4.1 弹性高度伸缩对手风琴外层布局与虚拟列表（Virtual Scroll）的冲击
   - 4.2 `VirtualPlainCodeViewer` 误遭 `520px` 锁死问题
   - 4.3 解除 `overscroll-behavior: contain` 后的多层手风琴滚轮连带效应
5. [审查重点四：跨方案冲突、时序重叠与执行隐患](#五审查重点四跨方案冲突时序重叠与执行隐患)
   - 5.1 `Menu.module.css` 方案 02 与方案 04 的正面设计冲突
   - 5.2 `tokens.css` 跨 5 个方案的并发修改竞争
   - 5.3 `DiffCard.module.css` 大规模删除死代码对方案 04/05 的行号基准冲击
6. [综合整改建议与落地行动清单](#六综合整改建议与落地行动清单)

---

## 一、评审执行摘要与缺陷严重度矩阵

经过对 5 份独立方案与工程全仓源码的严苛交叉比对，评审组肯定了方案 02 对翡翠绿活态签名与微小元素脱黑的方向把控，以及方案 03 清理 300+ 行死代码、废除 380px 固定高度的决心。然而，**在算法完备性、高亮语法上下文保持、漏网发黑控件、组件默认值破坏性变更及跨方案修改协同上，存在多处 CRITICAL / HIGH 级别的设计缺陷与执行隐患**，必须在进入阶段 0/1 实施前予以彻底修复。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          方案 02 / 03 交叉评审缺陷严重度全景矩阵                        │
├──────────┬─────────────────────────────┬──────────┬────────────────────────────────────┤
│ 缺陷编号 │ 缺陷模块与核心现象          │ 严重级别 │ 潜在后果与技术风险                 │
├──────────┼─────────────────────────────┼──────────┼────────────────────────────────────┤
│ BUG-B01  │ `renderHighlightedTokens`   │ CRITICAL │ 语法片段独立高亮粉碎 Lexical 语义，│
│          │ 碎片化高亮破坏语法上下文    │          │ 引号/JSX/注释错乱，滚动每帧 300+ 次│
│          │                             │          │ hljs 调用引发严重掉帧与内存抖动    │
├──────────┼─────────────────────────────┼──────────┼────────────────────────────────────┤
│ BUG-B02  │ `useDiffData.ts` 分栏漏改   │ CRITICAL │ 方案 03 仅修复了 WidgetDiff，但核心│
│          │ 主 DiffCard 仍沿用错位逻辑  │          │ 主面板 getSplitPairs 依旧 1 探测错位│
├──────────┼─────────────────────────────┼──────────┼────────────────────────────────────┤
│ BUG-B03  │ `Button` 默认切 `ghost`     │ HIGH     │ 破坏全仓 ~350 处 Button 调用语义， │
│          │ 导致无声明 Primary 按钮消失 │          │ Button.test.tsx 单测必报红灯中断 CI│
├──────────┼─────────────────────────────┼──────────┼────────────────────────────────────┤
│ BUG-B04  │ `FirstRunWizard` 与         │ HIGH     │ 遗漏 3 处纯黑背景（Logo/步骤/按钮），│
│          │ `Dialog` 脱黑遗漏盲区       │          │ Dialog 写死 #ffffff 导致暗色全白屏 │
├──────────┼─────────────────────────────┼──────────┼────────────────────────────────────┤
│ BUG-B05  │ `VirtualPlainCodeViewer`    │ HIGH     │ 复用 .scrollParent 导致查看全量源码│
│          │ 误遭 520px 弹性高度截断     │          │ 时被强制压扁在 520px，无法撑满视口 │
├──────────┼─────────────────────────────┼──────────┼────────────────────────────────────┤
│ BUG-B06  │ `Menu.module.css` 跨方案    │ MEDIUM   │ 方案 02 写入 dark 手动覆写，与方案 │
│          │ 代码冲突（方案 02 vs 04）   │          │ 04 清除 55 处 dark 覆写铁律正面对撞 │
├──────────┼─────────────────────────────┼──────────┼────────────────────────────────────┤
│ BUG-B07  │ `parseDiffText` 解析缺陷    │ MEDIUM   │ `---`/`+++` 头部误判为增删行；     │
│          │ 遇标准 Unified Diff 头崩溃  │          │ `\ No newline` 导致行号计数漂移    │
├──────────┼─────────────────────────────┼──────────┼────────────────────────────────────┤
│ BUG-B08  │ `DiffCardUnifiedView` 对    │ MEDIUM   │ 仅检查前后 1 行，在多行删除紧接多行│
│          │ $N:M$ 连续变动配对丢失      │          │ 新增时词法高亮丢失，未复用 HunkEngine│
└──────────┴─────────────────────────────┴──────────┴────────────────────────────────────┘
```

---

## 二、审查重点一：差异面板真实高亮与 Hunk 对偶对齐算法深度审查（方案 03）

### 2.1 `renderHighlightedTokens` 分段词法高亮：语法上下文粉碎与高频 GC 性能隐患

#### 1. 语法上下文粉碎（Lexical Context Destruction）
在方案 03 契约 2 与契约 3 中，词法级高亮合成器实现如下：
```tsx
function renderTokens(tokens: DiffWordToken[], targetType: 'added' | 'removed', fallbackText: string, lang: string) {
  // ...
  return (
    <>
      {tokens.map((tok, i) => {
        const isTarget = tok.type === targetType;
        const highlightedHtml = highlightCode(tok.text, lang); // ❌ 致命缺陷：碎片化调用
        // ...
      })}
    </>
  );
}
```
`highlight.js` 的所有语言解析器（`typescript`, `rust`, `python`, `xml` 等）均是**具备内部状态机的流式分词器**。当将单行代码被 `tokenizeLine` 拆散后的单个片段（如 `"const "`、`"foo"`、`" = \"hello "`、`"world\";"`）单独传入 `highlightCode(tok.text, lang)` 时：
1. **字符串与正则表达式跨 Token 撕裂**：字符串 `"hello world"` 中间修改为 `"hello new world"` 时，分词结果为 `["\"hello "]`, `["new "]`, `["world\""]`。单独传入 `"\"hello "` 会被 highlight.js 识别为**未闭合的非法字符串**，导致后半段代码高亮完全失效；
2. **JSX / HTML 标签破坏**：`<div className="btn">` 被拆分后，`<div` 会被识别为非法 XML 标记，无法正确着色为 tag/attribute；
3. **类型标注与泛型**：`Record<string, Promise<T>>` 被拆开后，`>` 无法与 `<` 匹配，退化为普通比较运算符；
4. **多行注释与单行注释**：`// 注释内容` 拆开后，后半截文字被当做普通变量。

#### 2. CPU 性能暴跌与内存高频抖动（GC Thrashing）
- **高频重复调用**：在虚拟滚动视图中，每次滚动触发渲染包含约 30 行可见代码。若每行平均包含 10 个词法 Token，单次渲染帧需要执行 **300 次 `hljs.highlight()` 调用**！
- **LRU 缓存击穿与碎片化**：每个 Token 片段（如 `typescript:"`、`typescript: `、`typescript:foo`）均会在 `highlightCache` 中生成一条微型缓存，迅速填满 `HIGHLIGHT_CACHE_ENTRIES` 预算，导致真正需要缓存的完整代码行被挤出缓存池，CPU 使用率激增，滚轮出现肉眼可见的卡顿掉帧。

#### 💡 架构重构建议（工业级正确解法）：
严禁对单个 Token 碎片调用 `highlightCode`！应当采用 **“整行一次性语法高亮 + 字符偏移区间（Range Masking）背景覆盖”** 模式：
1. 先对整行纯文本执行一次 `highlightCode(fullLineText, lang)`，生成完整的合法 HTML 结构；
2. 基于 `computeIntralinePair` 计算出的字符索引区间 `[startOffset, endOffset]`，在底层渲染绝对定位的高亮背景块（Background Spans），或通过 HTML 标记注入器进行无损切片包裹；
3. 或者直接在 DOM 结构上分离：一层作为语法着色文字层（纯文本高亮），一层作为增删背景高亮层（CSS 变色背景）。

---

### 2.2 `buildSplitLinePairs` 对偶配对与 `parseDiffText` 算法的完备性漏洞

#### 1. `parseDiffText` 无法正确解析标准 Unified Diff 头部
在方案 03 契约 5（`WidgetDiff.tsx`）中，`parseDiffText` 逻辑如下：
```typescript
    if (line.startsWith('+')) {
      result.push({ type: 'add', text: line.slice(1), newNum: newLine++ });
    } else if (line.startsWith('-')) {
      result.push({ type: 'delete', text: line.slice(1), oldNum: oldLine++ });
    }
```
- **Unified Diff 头部误杀**：标准补丁文件以 `--- a/src/index.ts` 和 `+++ b/src/index.ts` 开头。由于 `---` 以 `-` 开头，`+++` 以 `+` 开头，`parseDiffText` 会将其错误识别为**删除了一行 `-- a/src/index.ts` 并新增了一行 `++ b/src/index.ts`**，且将 `oldLine` 和 `newLine` 从第一行开始消耗！
- **`\ No newline at end of file` 脏行漂移**：遇到 Git 差异末尾的 `\ No newline...` 提示时，代码进入 `else` 分支，将其作为上下文行处理并自增 `oldLine++` 和 `newLine++`，造成后续行号与实际文件严重错位；
- **末尾换行产生假空行**：`rawText.split('\n')` 在文本以换行结尾时会产生一个空字符串 `""`，被错误推入 `result` 作为上下文空行。

#### 2. Hunk Header（`@@`）在 Split 视图中被降级为双栏重复行
当遇到 `@@ -1,5 +1,5 @@` 时，`buildSplitLinePairs` 推入 `{ left: cur, right: cur }`，导致在分栏视图中左右两侧各自渲染一个独立的 `@@ ... @@` 单元格，破坏了业界通用的“跨两栏全宽居中 Hunk 提示条”视觉规范。

---

### 2.3 `DiffCard` 体系与 `<widget-diff>` 双源分歧：`useDiffData.ts` 漏改盲区

这是方案 03 最严重的**架构脱节与漏项**：
- 方案 03 在 §3.2 和契约 5 中大篇幅重构了 `WidgetDiff.tsx` 的 `buildSplitLinePairs` 对偶配对算法；
- **但是，主工作区生产力核心 `DiffCard` 根本不走 `WidgetDiff.tsx`**！`DiffCard` 的分栏数据来源于 [`apps/crish-desktop/src/components/diff/useDiffData.ts:55-89`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/useDiffData.ts#L55-L89) 中的 `getSplitPairs` 函数！
- 审查 `useDiffData.ts` 源码发现，`getSplitPairs` 依然是陈旧且错误的单步贪心算法：
```typescript
    if (item.change.type === 'deletion') {
      const nx = lines[i + 1];
      if (nx?.change.type === 'addition') {
        pairs.push({ left: item, right: nx });
        i += 2;
      } else {
        pairs.push({ left: item, right: undefined });
        i++;
      }
    }
```
**严重后果**：若存在 2 行连续删除紧随 2 行新增（`del1, del2, add1, add2`）：
- `del1` 的下一行是 `del2`（非 addition），所以 `del1` 被与 `undefined` 配对；
- `del2` 的下一行是 `add1`（是 addition），所以 `del2` 被与 `add1` 配对；
- `add2` 被与 `undefined` 配对。
最终呈现：
- 左侧：`del1` $\rightarrow$ `del2` $\rightarrow$ 空
- 右侧：空 $\rightarrow$ `add1` $\rightarrow$ `add2`
原本应当平行的 `del1 ↔ add1`、`del2 ↔ add2` 发生了严重的纵向错位漂移！**方案 03 遗漏了对 `useDiffData.ts` 的改造，导致主差异卡片分栏错位 BUG 依然存活**。

---

### 2.4 `DiffCardUnifiedView` 1 行邻近探测对 $N:M$ 多变动块失效

在方案 03 契约 2（`DiffCardUnifiedView.tsx:558-591`）中：
- 当渲染 `addition` 行时，仅检查 `globalIdx - 1` 是否为 `deletion`；
- 当渲染 `deletion` 行时，仅检查 `globalIdx + 1` 是否为 `addition`。
对于连续的 3 行删除紧跟 3 行新增：
- 前 2 行删除由于 `nextItem` 仍是删除，**不会触发 intraline diff**；
- 只有第 3 行删除会与第 1 行新增进行配对；
- 第 2、3 行新增因 `prevItem` 是新增，**同样不会触发 intraline diff**！
工程中其实已经在 [`intralineDiff.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/intralineDiff.ts#L205) 中实现了专门处理连续块的 `computeContinuousHunkDiff`，但方案 03 未在 `DiffCardUnifiedView` 中接入，导致 Unified 模式下大部分连续变更行的行内字词高亮彻底失效。

---

## 三、审查重点二：微小元素脱黑覆盖完整性与潜在破坏性审查（方案 02）

### 3.1 方案 02 脱黑遗漏盲区（Gaps & Blind Spots）

审查组通过对全仓样式文件进行 AST 与正则深扫，发现方案 02 遗漏了以下关键发黑组件：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        方案 02 遗漏发黑与样式违规清单 (Gaps)                           │
├────────────────────────────────────────┬───────┬───────────────────────────────────────┤
│ 涉及文件及行号                         │ 类别  │ 具体遗漏的违规代码与视觉病灶          │
├────────────────────────────────────────┼───────┼───────────────────────────────────────┤
│ `overlay/FirstRunWizard.module.css:36` │ 死黑  │ `.firstRunLogo { background:          │
│                                        │       │   var(--text-primary); }` (纯黑图标块)│
├────────────────────────────────────────┼───────┼───────────────────────────────────────┤
│ `overlay/FirstRunWizard.module.css:93` │ 死黑  │ `.firstRunStep.isActive               │
│                                        │       │   .firstRunStepNum { background:      │
│                                        │       │   var(--text-primary); }` (纯黑序号点)│
├────────────────────────────────────────┼───────┼───────────────────────────────────────┤
│ `overlay/FirstRunWizard.module.css:219`│ 死黑  │ `.firstRunBtn.primary { background:   │
│                                        │       │   var(--text-primary); }` (纯黑主按钮)│
├────────────────────────────────────────┼───────┼───────────────────────────────────────┤
│ `ui/Dialog/Dialog.module.css:31`       │ 硬编码│ `.dialog { background: #ffffff; }`    │
│                                        │ 白底  │ 暗色模式下无 Token，导致全仓弹窗全白屏│
├────────────────────────────────────────┼───────┼───────────────────────────────────────┤
│ `workspace/RuntimePanel.module.css:273`│ 死黑  │ `.spinner { border: 1.5px solid       │
│                                        │ 边框  │   var(--accent-color); }` (旧15%死黑) │
├────────────────────────────────────────┼───────┼───────────────────────────────────────┤
│ `hooks/tab-drag/tabDragGhost.ts:110`   │ 超标  │ `border: 1.5px solid color-mix(...,   │
│                                        │ 边框  │   var(--accent-color) 35%, ...)` (35%)│
└────────────────────────────────────────┴───────┴───────────────────────────────────────┘
```

1. **`FirstRunWizard.module.css`**：冷启动首次运行向导是用户接触产品的第一界面。此处 3 处直接硬写 `background: var(--text-primary)`（Logo 底块、激活步骤数字、主操作按钮），在浅色模式下呈现为极其突兀的 `#111111` 纯黑煤球；
2. **`Dialog.module.css:31` 硬编码 `#ffffff`**：这是全仓对话框基座组件（包含 `ConfirmDialog`、`CheatsheetModal` 等）。直接写死 `background: #ffffff;` 且未提供暗色 Token 继承，导致在 Dark 模式下弹窗背景大面积刺眼闪白，属于极高危的视觉缺陷。

---

### 3.2 `Button` 默认变体由 `primary` 改为 `ghost` 的破坏性风险（Breaking Change）

方案 02 将 `Button.tsx:56` 的默认变体从 `variant = 'primary'` 强行改为 `variant = 'ghost'`。

#### 潜在风险分析：
- 全仓存在 **300 多处** `<Button>` 标签调用。虽然此举解决了部分开发者写 `<IconButton>` 或辅助按钮时意外被渲染为纯黑大砖的问题，但同时也存在**“合法主操作按钮因未显式声明 `variant='primary'` 而意外退化为透明幽灵按钮”**的风险；
- 例如某些业务卡片底部的“保存”、“确定”、“创建”按钮，若此前依赖默认值渲染为 Primary 实体样式，修改后将直接变成无底色、无边框的幽灵文字，严重削弱用户操作行动点（CTA）。

#### 💡 规避与防护方案：
1. **显式补齐规范**：在实施修改前，必须对全仓未声明 `variant` 的 `<Button>` 进行扫描，对具有明确“提交/确认/新建”语义的按钮，显式补充 `variant="primary"`；
2. **区分原子组件默认值**：建议将 `Button.tsx` 的默认变体设为 `secondary`（带微柔和边框与背景），而仅将 `IconButton.tsx` 内部默认变体设为 `ghost`。这样既杜绝了 IconButton 变黑砖，又不会让普通文字按钮沦为完全透明。

---

### 3.3 `Button.test.tsx` 现有单测红灯盲区

方案 02 在第 8 节虽然设计了防回归测试 `tests/style/small-elements-anti-darkening.test.ts`，却**完全忽略了现有单元测试文件的断言更新**：
- 在 [`apps/crish-desktop/src/components/ui/Button/Button.test.tsx:13-24`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.test.tsx#L13-L24) 中，首个测试用例即为：
```typescript
  it('渲染默认 primary/md 形态并透传属性', () => {
    render(<Button data-testid="btn">确定</Button>);
    const btn = screen.getByTestId('btn');
    expect(btn.className).toContain(styles.buttonPrimary);
    expect(btn).toHaveAttribute('data-variant', 'primary');
  });
```
若仅修改 `Button.tsx` 而未同步重构 `Button.test.tsx`，执行 `npm run test` 或 `npx vitest run` 时将立即报错，导致流水线门禁直接中断。

---

## 四、审查重点三：弹性高度（44~520px）与滚轮链解绑的影响评估

### 4.1 弹性高度伸缩对手风琴外层布局与虚拟列表（Virtual Scroll）的冲击

#### 1. 手风琴展开与滚动条跳跃（Scroll Bouncing）
- 方案 03 废除了 `height: 380px`，引入 `min-height: 44px; max-height: min(520px, 60vh);`；
- 当手风琴列表中某个文件仅有 1~2 行差异时，面板高度为 44px；
- 用户点击展开内嵌折叠块或切换至长文件时，容器瞬间膨胀至 520px。由于外层 `.fileList` 自身具备 `overflow-y: auto`，容器高度的剧烈突变会造成外层列表滚动条 thumb 长度瞬间缩短并发生视口偏移，引发视觉跳动；
- **建议**：为 `.scrollParent` 的高度变化配置平滑过渡 `transition: max-height var(--transition-normal, 180ms) cubic-bezier(0.2, 0, 0, 1)`，并配合 `overflow-anchor: auto` 锁定锚点。

#### 2. `useVirtualScroll` 首次渲染高估（Over-render Glitch）
- `useVirtualScroll` 初始状态将 `viewportHeight` 硬编码为 `600`（`useState(600)`）；
- 在首帧挂载时（`ResizeObserver` 回调前），虚拟滚动器会误以为视口为 600px，从而一次性实例化 40+ 个 DOM 节点；
- 紧接着 RO 测量出实际高度为 44px，立即触发二次渲染将节点缩减至 2 个。这在低端机型或大量 Diff 展开时会造成首帧多余的 DOM 构造开销。

---

### 4.2 `VirtualPlainCodeViewer` 误遭 `520px` 锁死问题

在方案 03 契约 4（`VirtualPlainCodeViewer.tsx`）中：
```tsx
<div
  ref={containerRef}
  className={styles.scrollParent}
  onScroll={onScroll}
  style={{
    height: '100%',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--diff-bg-pane)',
  }}
>
```
- 该组件直接复用了 `DiffCard.module.css` 中的 `.scrollParent` 类；
- `.scrollParent` 在 CSS 中声明了 `max-height: min(520px, 60vh);`；
- 虽然 TSX 行内样式写入了 `height: '100%'`，但 CSS 的 `max-height` 拥有绝对约束力！
- **后果**：当用户在差异面板中切换为“查看源码全文（Plain Code Mode）”时，即使显示器高度为 1440px、面板可用高度为 1000px，源码查看器也会被死死限制在最多 520px 高度内，底部出现大片空白或多重滚动条！
- **修复契约**：纯源码模式必须使用独立的 `.plainScrollParent` 类，声明 `max-height: none; height: 100%;`。

---

### 4.3 解除 `overscroll-behavior: contain` 后的多层手风琴滚轮连带效应

- 方案 03 在 DEL-17 中将 `.fileList` 与 `.scrollParent` 的 `overscroll-behavior: contain` 彻底删除；
- **正向收益**：彻底治愈了鼠标移入代码区后滚轮“卡死”无法滚出手风琴列表的历史恶疾；
- **潜在连带边界**：当用户快速滚动手风琴列表穿过多个代码卡片时，若鼠标指针掠过某个具有内部滚动条的长 Diff，滚轮事件可能短暂在该 Diff 内部产生微量位移后迅速穿透到底部。经评估，该行为与 VS Code / Chrome 原生行为一致，属于健康的设计纠偏，但需确保各容器滚动条样式（`scrollbar-width: thin`）保持轻量，避免滚动条频繁闪烁。

---

## 五、审查重点四：跨方案冲突、时序重叠与执行隐患

### 5.1 `Menu.module.css` 方案 02 与方案 04 的正面设计冲突

这是两套独立方案之间最典型的**规范对抗冲突**：

```diff
--- 方案 02 (02-accent-token... §4.6) ---
+:global(html[data-theme='dark']) .menuContent {
+  background: var(--sep-bg-panel, rgba(24, 23, 21, 0.96));
+  border-color: var(--border-color, #2b2926);
+  box-shadow: var(--shadow-lg);
+}

--- 方案 04 (04-cascading-isolation... §2.3) ---
-彻底删除 Menu.module.css 中 4 处 :global(html[data-theme='dark']) 手动覆写！
-统一收敛为 CSS Tokens 自动适配，严禁局部抬高特异性！
```

- **冲突裁决**：方案 04 遵循单一真源架构（SSOT），是唯一正确的方向；方案 02 的契约代码未与方案 04 对齐，仍残留了 `:global(html[data-theme='dark'])` 手动覆写。
- **强制要求**：方案 02 必须删除对 `Menu.module.css` 的暗色手动选择器修改，完全交由方案 04 统一收敛至 Token 驱动。

---

### 5.2 `tokens.css` 跨 5 个方案的并发修改竞争

`tokens.css` 作为全系统真源，在各个方案中均有改动：
- 方案 01 修改 `:root` 主题对齐与 `--bg-primary`；
- 方案 02 修改 `--accent-color`、Markdown 排版与思考链变量；
- 方案 03 修改 `--diff-*` 增删色阶并删除 `--diff-gutter-width`；
- 方案 05 顶层抽取 `--breakpoint-*` 并收敛 `--focus-ring-*`（8%）与 `--filetree-badge-*`。

**隐患**：若 5 个方案并行无序向 `tokens.css` 提交代码，必将引发惨烈的 Git 冲突与行号错位。
**调度要求**：必须严格遵循定案决策的 DAG 拓扑，在阶段 0 由单 Agent 独占执行 `tokens.css` 的基座变量治理，阶段 1 统一注入语义色，后续方案仅消费而不随意篡改结构。

---

### 5.3 `DiffCard.module.css` 大规模删除死代码对方案 04/05 的行号基准冲击

- 方案 03 在 DEL-20 中将物理删除 `DiffCard.module.css` 中 300+ 行废弃死代码；
- 方案 04 在清单中引用了 `DiffCard.module.css:379`（`border-top: none !important;`）；
- 方案 05 在清单中引用了 `DiffCard.module.css:430`（`--shadow-xs`）；
- 若方案 03 先行删除了 300 行代码，方案 04 和 05 依据旧行号进行自动化替换将全部失效定位。
- **规避方案**：方案 04 与 05 必须采用精确选择器与属性正则匹配定位，严禁硬编码行号。

---

## 六、综合整改建议与落地行动清单

为了确保《界面视觉修复与差异面板重构》战役一次性高质量全绿交付，针对本评审报告揭露的所有问题，下达以下**五项硬性整改指令（Directive Action Items）**：

### 📋 行动指令 1：重构语法高亮与词法分段合成器（纠正 BUG-B01）
- 废黜 `renderHighlightedTokens` 中针对每个 Token 碎片调用 `highlightCode` 的做法；
- 改造为：对整行执行单次合法语法高亮，通过背景色标记层（Background Range Markers）无损渲染 intraline 增删背景，彻底保护 TypeScript/Rust/JSX 语法树完整性并消除 CPU 掉帧。

### 📋 行动指令 2：打通 `useDiffData.ts` 与 `<widget-diff>` 对偶配对真源（纠正 BUG-B02）
- 将 `buildSplitLinePairs` 算法抽取为全局通用工具函数（`src/api/diffPairMatcher.ts`）；
- 同时重构 `useDiffData.ts` 中的 `getSplitPairs` 与 `WidgetDiff.tsx`，彻底根除主工作区差异面板的 1 探测错位漏洞；
- 完善 `parseDiffText`：过滤 `diff --git`、`index`、`---`、`+++` 与 `\ No newline` 等元数据行，正确解析标准补丁。

### 📋 行动指令 3：补齐发黑控件与全仓弹窗暗色适配（纠正 BUG-B04）
- 立即将 `FirstRunWizard.module.css` 的 3 处纯黑背景纳入方案 02 删除面，改用 `--brand-deep` 与 `--bg-secondary`；
- 立即将 `Dialog.module.css:31` 的硬编码 `background: #ffffff;` 纠偏为 `background: var(--bg-card, #ffffff);`，为全仓弹窗补齐暗色模式能力。

### 📋 行动指令 4：解耦 `Button` 默认值变更风险与同步单测（纠正 BUG-B03）
- 保持 `Button.tsx` 默认 `variant = 'secondary'`（安全中性），仅将 `IconButton.tsx` 默认绑定 `variant = 'ghost'`；
- 同步更新 `apps/crish-desktop/src/components/ui/Button/Button.test.tsx` 中的断言契约，确保单测 100% 绿灯。

### 📋 行动指令 5：解绑 `VirtualPlainCodeViewer` 视口高度限制（纠正 BUG-B05）
- 在 `DiffCard.module.css` 中为纯源码模式新增 `.plainScrollParent` 契约，设定 `max-height: none; height: 100%; flex: 1;`，使查看大文件源码时能够完美自适应撑满整个工作区窗格。

---
_评审报告编制完成 · 归档于 `docs/ui-style-refactor/plan-reviews/02-ui-style-plans-cross-review-b.md`_
