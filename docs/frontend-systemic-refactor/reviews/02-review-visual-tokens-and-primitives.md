# Conex / Crish 前端系统性重构第二轮独立评审报告：视觉基准、Tokens 与 UI 原语

> **评审编号**：`reviews/02-review-visual-tokens-and-primitives.md`  
> **评审专家**：Reviewer R02（视觉基准、Tokens 与 UI 原语独立评审专家）  
> **评审对象**：  
> - P02 Design Tokens 与色彩系统详案：[`docs/frontend-systemic-refactor/plans/02-design-tokens-and-color-ssot.md`](file:///c:/Software/conex/docs/frontend-systemic-refactor/plans/02-design-tokens-and-color-ssot.md)  
> - P03 视觉层级与字阶排版详案：[`docs/frontend-systemic-refactor/plans/03-visual-hierarchy-and-typography.md`](file:///c:/Software/conex/docs/frontend-systemic-refactor/plans/03-visual-hierarchy-and-typography.md)  
> - P05 UI 原子基座与 Headless 原语详案：[`docs/frontend-systemic-refactor/plans/05-ui-primitives-and-headless-refactor.md`](file:///c:/Software/conex/docs/frontend-systemic-refactor/plans/05-ui-primitives-and-headless-refactor.md)  
> **基准对照**：`docs/frontend-comprehensive-audit/` 对应审计报告与全仓现存源码  
> **遵循铁律**：`AGENTS.md` 协作指令、`.agents/LOGIC_PLAN_NO_RETREAT.md` 反退避全文、`ANTI_OVERENGINEERING_GUARDRAILS.md` 反过度设计红线  

---

## 目录索引

1. [评审总览与综合裁定（Executive Summary & Verdict）](#1-评审总览与综合裁定executive-summary--verdict)
2. [核心命门穿透挑刺与实证剖析（Critical Findings & Code-Level Evidence）](#2-核心命门穿透挑刺与实证剖析critical-findings--code-level-evidence)
   - 2.1 [【致命架构撕裂 · Blocker】P02 与 P03 针对排版角色与语义墨色（`--type-*` / `--ink-*`）的生死决断完全冲突](#21-致命架构撕裂--blockerp02-与-p03-针对排版角色与语义墨色--type----ink--的生死决断完全冲突)
   - 2.2 [【严重布局破坏 · Blocker】P05 对 `Button bare` 的清退方案引发全仓 73 处业务节点毁灭性样式坍塌与 G-01 门禁 AST 碰撞](#22-严重布局破坏--blockerp05-对-button-bare-的清退方案引发全仓-73-处业务节点毁灭性样式坍塌与-g-01-门禁-ast-碰撞)
   - 2.3 [【高危无障碍失防与动效瞬灭 · Blocker】P05 的手写 FocusTrap 存在多层弹窗失防，Dialog 重构导致退场动效瞬间蒸发](#23-高危无障碍失防与动效瞬灭--blockerp05-的手写-focustrap-存在多层弹窗失防dialog-重构导致退场动效瞬间蒸发)
   - 2.4 [【动效防御破防与虚假核销 · Blocker】P05 宣称的 112 处过渡接入弹簧与节能档/无障碍 100% 静音存在代码脱节](#24-动效防御破防与虚假核销--blockerp05-宣称的-112-处过渡接入弹簧与节能档无障碍-100-静音存在代码脱节)
   - 2.5 [【单行扫描器误杀陷阱 · Warning】P02 在 ColorPicker 的物理图元豁免注解踩入跨行格式化漏洞](#25-单行扫描器误杀陷阱--warningp02-在-colorpicker-的物理图元豁免注解踩入跨行格式化漏洞)
   - 2.6 [【违背零双轨原则 · Warning】P02 在 16 处悬空未定义治理中擅自制造 4 处全局代理别名死 Token](#26-违背零双轨原则--warningp02-在-16-处悬空未定义治理中擅自制造-4-处全局代理别名死-token)
   - 2.7 [【边界封锁致断裂 · Warning】P05 对 `internal/` 的 16 处外部穿透封锁缺乏替代公共契约](#27-边界封锁致断裂--warningp05-对-internal-的-16-处外部穿透封锁缺乏替代公共契约)
   - 2.8 [【清退死角漏网 · Suggestion】P03 的 13px 清退 Codemod 遗漏了 TSX 行内样式与非 CSS 源码](#28-清退死角漏网--suggestionp03-的-13px-清退-codemod-遗漏了-tsx-行内样式与非-css-源码)
3. [跨方案架构冲突判决与对齐矩阵（Cross-Plan Alignment Matrix）](#3-跨方案架构冲突判决与对齐矩阵cross-plan-alignment-matrix)
4. [第三轮就地修改操作指引（Actionable Amendments for Round 3）](#4-第三轮就地修改操作指引actionable-amendments-for-round-3)
   - 4.1 [针对 P02 方案的就地修订任务单](#41-针对-p02-方案的就地修订任务单)
   - 4.2 [针对 P03 方案的就地修订任务单](#42-针对-p03-方案的就地修订任务单)
   - 4.3 [针对 P05 方案的就地修订任务单](#43-针对-p05-方案的就地修订任务单)
5. [永久免疫门禁与立体化验收红线（Permanent Immunity & Verification Gates）](#5-永久免疫门禁与立体化验收红线permanent-immunity--verification-gates)

---

## 1. 评审总览与综合裁定（Executive Summary & Verdict）

作为 Conex / Crish 前端系统性重构战役的【视觉基准、Tokens 与 UI 原语独立评审专家】（Reviewer R02），本专家全面穿透审查了 **P02（Design Tokens 与色彩）**、**P03（视觉层级与字阶排版）** 和 **P05（UI 原子基座与 Headless 原语）** 三份实施详案，并与仓库现场代码（CSS 模块、TypeScript AST、门禁扫描脚本、CI 流水线契约）进行了逐行对账与对抗性验算。

### 综合评审结论：【有条件通过，必须实施 4 项阻断级（Blocker）就地修正】

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            评审综合评分板 (R02 终审)                         │
├──────────────────┬──────────┬──────────┬────────────────────────────────────┤
│ 详案代号与名称   │ 规范合规 │ 落地深度 │ 裁决结论                           │
├──────────────────┼──────────┼──────────┼────────────────────────────────────┤
│ P02 色彩与Tokens │ 92 / 100 │ 90 / 100 │ CONDITIONAL PASS (需修正别名与扫描) │
│ P03 排版与字阶   │ 84 / 100 │ 86 / 100 │ CONDITIONAL PASS (需砍掉复合角色层) │
│ P05 UI原子基座   │ 78 / 100 │ 82 / 100 │ BLOCKED (需重写Button与FocusTrap)  │
└──────────────────┴──────────┴──────────┴────────────────────────────────────┘
```

#### 总体评述：
- **可嘉之处**：三份方案展现出极高的架构雄心，对历史技术债务（101 处色彩违规、70 处死 Token、286 处层级倾倒、248 处深层穿透、`removeChild` 原生劫持）的摸排翔实确凿，整体方向坚决贯彻“零打补丁、零硬编码、不搞双轨、负代码产出”的军令要求。
- **命门所在**：三个方案各自为政，在方案交叉带爆发了**直接的真理源撕裂**（P02 宣判物理死刑的变量被 P03 封为核心契约）；P05 试图通过过度简化的手写胶水与粗暴的 Codemod 替换规避根本矛盾，导致业务层面临 73 处布局破坏与 WAI-ARIA 规范失守；P05 对 CSS 原生 `@starting-style` 的物理理解产生严重断层，使得弹窗退出动效在 React 协调机制下完全失效。

---

## 2. 核心命门穿透挑刺与实证剖析（Critical Findings & Code-Level Evidence）

---

### 2.1 【致命架构撕裂 · Blocker】P02 与 P03 针对排版角色与语义墨色（`--type-*` / `--ink-*`）的生死决断完全冲突

#### 1. 冲突现场实证
- **P02 详案定性与处置（P02 §4.2 Cat-B）**：
  > “Cat-B：过度设计的复合排版与墨色角色死层（16 项 · 物理删除）。涉及变量：`tokens-type.css:85-102` 中的 `--type-prose`, `--type-process`, `--type-label`...（共 9 项）与 `tokens-text.css:32-40` 中的 `--ink-prose`, `--ink-process`...（共 7 项）。处置：全仓组件 100% 消费原子字阶与原子行高，这套 `font:` 简写与配对墨色纯属纸面过度设计，从两文件中直接物理删除。”
- **P03 详案定性与规划（P03 §3.4 与 §5.2）**：
  > “3.4 8 大核心排版角色（`--type-*`）与语义墨色（`--ink-*`）复合契约：在业务组件中，倡导直接消费复合 `font: var(--type-*)` 与 `color: var(--ink-*)`，实现排版字号、字重、行高与字体栈的原子化封装……并在 §5.2 设计全仓接入 Codemod，在 §6.3 列为 Phase 3 核心战果。”

#### 2. 物理代码对账（真理检验）
运行 `node scripts/check-token-consistency.mjs --list`：
```text
=== dead_tokens 全量清单（65）===
  --ink-caption  @apps/crish-desktop/src/styles/tokens-text.css:36
  --ink-card-title  @apps/crish-desktop/src/styles/tokens-text.css:37
  --ink-code  @apps/crish-desktop/src/styles/tokens-text.css:40
  --ink-meta  @apps/crish-desktop/src/styles/tokens-text.css:35
  --ink-process  @apps/crish-desktop/src/styles/tokens-text.css:33
  --ink-prose  @apps/crish-desktop/src/styles/tokens-text.css:32
  --ink-title  @apps/crish-desktop/src/styles/tokens-text.css:39
  --type-caption  @apps/crish-desktop/src/styles/tokens-type.css:93
  --type-card-title  @apps/crish-desktop/src/styles/tokens-type.css:95
  --type-code  @apps/crish-desktop/src/styles/tokens-type.css:101
  --type-heading  @apps/crish-desktop/src/styles/tokens-type.css:97
  --type-label  @apps/crish-desktop/src/styles/tokens-type.css:89
  --type-meta  @apps/crish-desktop/src/styles/tokens-type.css:91
  --type-process  @apps/crish-desktop/src/styles/tokens-type.css:87
  --type-prose  @apps/crish-desktop/src/styles/tokens-type.css:85
  --type-title  @apps/crish-desktop/src/styles/tokens-type.css:99
```
当前全仓 200 个 CSS 模块与 2,575 个代码文件中，对 `--type-*` 与 `--ink-*` 的实际消费量为 **严格的 0 处**！

#### 3. 架构危害深度剖析
1. **违背《反过度设计红线》（`ANTI_OVERENGINEERING_GUARDRAILS.md`）**：
   全仓早已成熟收敛至原子字阶 `--font-size-*` 与原子行高 `--lh-*`，以及标准语义文字色 `--text-primary / secondary / tertiary / quiet`。在这些真理源之上强行搭建一层“复合排版角色”与“语义墨色角色”，属于典型的概念重复造轮子。
2. **CSS `font:` 简写属性的致命副作用**：
   CSS 规范中，`font:` 简写会强制重置未显式声明的 `font-style`、`font-variant`、`letter-spacing`。一旦组件消费 `font: var(--type-prose)`，局部的字距微调或特殊样式将被瞬间抹除；且当组件只想微调 `line-height` 时，将因简写属性的特异性无法单独覆盖，迫使开发者书写 `!important`，彻底恶化 CSS 可维护性。
3. **流水线死锁**：若 P02 物理删除了该 16 个变量，而 P03 还在通过 Codemod 引入它们，则 `check:token-consistency` 会在 P03 落地瞬间因 16 处 `undefined_refs` 直接爆表退出！

#### 4. 评审专家终局裁定
- **裁决**：**支持 P02，否决 P03！**
- **执行要求**：彻底物理删除 `--type-*`（9 项）与 `--ink-*`（7 项）。P03 必须修改其详案，全面废止在业务组件中推行复合 `font: var(--type-*)` 的妄想，全仓组件 100% 消费原子属性：
  ```css
  font-size: var(--font-size-body);
  line-height: var(--lh-prose);
  font-weight: var(--fw-regular);
  color: var(--text-primary);
  ```

---

### 2.2 【严重布局破坏 · Blocker】P05 对 `Button bare` 的清退方案引发全仓 73 处业务节点毁灭性样式坍塌与 G-01 门禁 AST 碰撞

#### 1. 冲突现场实证
- **P05 宣称方案（P05 §5.2 与 §5.3）**：
  P05 宣称通过引入 `<Button asChild>`（Slot 模式）清退 `bare` 参数，并在 §5.3 提供了如下自动化 Codemod 脚本：
  ```javascript
  // scripts/codemods/migrate-button-bare.mjs (P05 §5.3)
  const barePattern = /<Button\b([^>]*?)\bbare\b([^>]*?)>/g;
  if (barePattern.test(content)) {
    content = content.replace(barePattern, (match, p1, p2) => {
      return `<Button${p1}variant="unstyled"${p2}>`;
    });
  }
  ```

#### 2. 深度穿透与物理代码碰撞（双重灾难）
审查发现 P05 的方案存在两处灾难性逻辑漏洞：

##### 漏洞 A：与 G-01 门禁 AST 检查器的直接死锁碰撞
查看门禁脚本 [`scripts/check-frontend-convergence.mjs:113-139`](file:///c:/Software/conex/scripts/check-frontend-convergence.mjs#L113-L139)：
```typescript
const FORBIDDEN_TAGS = new Set(['button', 'input', 'textarea', 'select']);
function visit(node) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    const tagName = node.tagName.getText(sf);
    if (FORBIDDEN_TAGS.has(tagName)) {
      report(1, 'G-01', file, line, `发现业务层裸原生交互标签 <${tagName}>，必须替换为 @/components/ui 标准原子组件！`);
    }
  }
}
```
- G-01 门禁使用 TypeScript 编译器 AST 遍历，只要在非 `components/ui/` 文件的 JSX 中发现 `<button>` 标签，立刻阻断报错！
- 如果业务层按照 Slot 模式书写：
  ```tsx
  <Button asChild className={styles.itemRow}>
    <button onClick={...}>整行内容</button>
  </Button>
  ```
  AST 访问器会直接抓出内部的 `<button>` 标签，**直接引爆 G-01 阻断拦截**！P05 完全没有设计对 G-01 规则的 AST 感知豁免，此路径在现有 CI 下物理不可走通！

##### 漏洞 B：Codemod 粗暴替换引发 73 处业务界面毁灭性布局坍塌
P05 的 Codemod 根本没有生成 `asChild`，而是将所有 `bare` 替换为了 `variant="unstyled"`。  
查看 [`apps/crish-desktop/src/components/ui/Button/Button.tsx:103-114`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.tsx#L103-L114) 与 [`Button.module.css:7-46`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L7-46)：
```css
.button {
  --btn-h: 32px;
  --btn-px: 12px;
  height: var(--btn-h);           /* 32px 强制高度！ */
  padding: 0 var(--btn-px);       /* 12px 强制内边距！ */
  display: inline-flex;          /* inline-flex 强制内联！ */
  align-items: center;
  justify-content: center;
  white-space: nowrap;           /* 强制禁止换行！ */
  border-radius: var(--btn-radius);
  ...
}
.button::before {                /* 物理微光交互层伪元素！ */
  content: '';
  position: absolute;
  inset: 0;
  background-color: var(--btn-hover-overlay);
}
```
全仓 73 处消费 `<Button bare ...>` 的业务节点包括：
- `components/settings`: 设置项列表行（整行自定义高度、内含多行排版与复合控件）；
- `components/settings-models`: 模型卡片容器（需要 100% 宽度、卡片自适应内边距）；
- `components/sidebar`: 历史会话树折叠箭头 twisty（16×16 微型图标交互槽）；
- `components/chat-composer`: 附件删除角标、权限模式条目。

**一旦套上 `variant="unstyled"` 并继承 `.button` 类**：
1. 会话列表整行与模型卡片会被暴力锁死在 `height: 32px; white-space: nowrap; display: inline-flex;`，多行文字溢出裁切，整行卡片布局全部扭曲坍塌！
2. 树状折叠箭头被注入 12px 左右 padding，导致图标被严重推挤错位！
3. `.button::before` 伪元素会在无边框整行容器上触发奇怪的胶囊状暗色微光悬浮层！

#### 3. 评审专家终局裁定
- **裁决**：**严重阻塞（Blocker）！严禁推行 P05 §5.3 的盲目 Codemod！**
- **执行要求**：
  1. 在 `Button.tsx` 中为 `variant="unstyled"` 开辟独立的样式路径：**不挂载 `styles.button` 基础类**，而是挂载纯净的 `styles.buttonUnstyled`（仅包含 `appearance: none; background: transparent; border: 0; padding: 0; margin: 0; font: inherit; color: inherit; text-align: inherit; outline: none;`，并继承标准的 `:focus-visible` 柔和聚焦环）。
  2. 针对微型图标操作（twisty 折叠箭头、附件删除、窗口微按钮等约 25 处），**禁止转为 `Button variant="unstyled"`**，必须在 Codemod 中精确迁移至专职的 `<IconButton variant="ghost" size="xs" />`！
  3. 修改 `check-frontend-convergence.mjs` G-01 规则：如果未来引入 `<Button asChild>`，AST 访问器需判断其父级是否为携带 `asChild` 的 UI 组件，放行语义子节点。

---

### 2.3 【高危无障碍失防与动效瞬灭 · Blocker】P05 的手写 FocusTrap 存在多层弹窗失防，Dialog 重构导致退场动效瞬间蒸发

#### 1. FocusTrap 改造漏洞：多层模态弹窗（Nested Modals）完全失防
P05 §5.1 声称废除了 35+ 选择器白名单，改用对 `#root` 施加单点 `inert`：
```typescript
// P05 §5.1 手写 focusTrap.tsx
function acquireRootInert(): void {
  modalStackCount++;
  if (modalStackCount === 1) {
    const appRoot = document.getElementById('root');
    if (appRoot) appRoot.setAttribute('inert', '');
  }
}
```
**致命现场**：
- 当用户在“设置”弹窗（Level 1）中点击“重置规则”，触发二次确认弹窗（ConfirmDialog / Level 2）时：
- 两级弹窗均挂载在 Portal 根容器 `#dialog-root` 下，互为兄弟节点；
- `modalStackCount` 从 1 递增至 2，`acquireRootInert` 判定 `modalStackCount === 1` 不成立，**什么都不做**！
- **严重后果**：Level 1 设置弹窗没有任何节点被施加 `inert`！当键盘用户按 `Tab` 键虽然被哨兵拦在 Level 2 弹窗内，但当用户使用**鼠标直接点击**底层 Level 1 弹窗中的输入框或开关，或者**屏幕阅读器**通过无障碍树漫游时，完全可以穿透操作底层设置项！严重破坏模态弹窗排他性原则与 WAI-ARIA 1.2 规范。

#### 2. Dialog 重构漏洞：CSS 原生 `@starting-style` 无法对抗 React 同步 Unmount，退场动效瞬间蒸发
P05 §5.5 与 §6.2 宣称清退手写的 `useAnimatedPresence`，改走 CSS 原生 `@starting-style`：
```typescript
// P05 §5.5 Dialog.tsx
export function DialogRoot({ open, children, ... }) {
  ...
  if (!open) return null; // ❌ 物理断层：React 同步卸载！
  return <DialogPortal>{children}</DialogPortal>;
}
```
**物理渲染机理穿透**：
- `@starting-style` 是 CSS 的新规范，作用仅仅是**元素首次在渲染树建立布局上下文时（入场）提供一个初始状态**；
- 当业务状态 `open: false` 时，React 协调器执行 `DialogRoot`，检测到 `if (!open) return null`，在 commit 阶段直接将 DOM 节点从 DOM 树物理拔除（`removeChild`）！
- 浏览器在当前渲染帧根本无法为已经脱离文档树的节点执行任何 CSS 退场过渡（Exit Transition）！
- **现场表现**：入场时有弹簧缩放，**点击关闭或按 Esc 时，弹窗没有 400ms 的平滑淡出，而是瞬间突兀白光闪烁式消失**！用户交互感知断崖式下跌。

#### 3. 评审专家终局裁定
- **裁决**：**严重阻塞（Blocker）！**
- **执行要求**：
  1. **关于 FocusTrap**：必须在弹窗挂载栈中维护真实的层级上下文。当 Level $N$ 模态弹窗挂载时，不仅 `#root` 必须 `inert`，栈内所有处于底层（$0 \sim N-1$）的弹窗容器必须同步挂上 `inert` 属性，出栈时按栈顺序逆向释放。
  2. **关于退场动效**：在第四阶段完全引入 Base UI 之前，**严禁使用粗暴的 `if (!open) return null`**！必须保留轻量级的退场状态机，通过监听原生 `transitionend` 事件延迟卸载，或者使用带 `keepMounted` + `transition-behavior: allow-discrete` 的现代原生隐藏方案，绝不可让退场动画瞬间蒸发。

---

### 2.4 【动效防御破防与虚假核销 · Blocker】P05 宣称的 112 处过渡接入弹簧与节能档/无障碍 100% 静音存在代码脱节

#### 1. 虚假核销实证
P05 在摘要与使命中宣称：
> “将 37 点高精物理弹簧缓动接线至全仓并清剿 112 处裸硬编码过渡；在 eco 节能档与 prefers-reduced-motion 下 100% 确定性静音。”

核查 P05 §6.3 的替换对照表：
- 112 处硬编码中，实际只有 14 处（`0.3s cubic-bezier`）被规划接入 `--transition-spring-smooth`；
- 其余 98 处均被映射为 `--transition-fast`（38处）、`--transition-micro`（26处）、`--transition-snappy`（24处）、`--transition-normal`（10处）。方案正文与使命描述严重不符。

#### 2. 防御破防现场证据
P05 §6.4 宣称：
> “在 `tokens-base.css:117-148` 与 `styles/reduced-motion.css` 中，所有过渡变量在 eco 档位下自动归零”。

**调阅当前仓库源码真相**：
查看 [`apps/crish-desktop/src/styles/reduced-motion.css:26-33`](file:///c:/Software/conex/apps/crish-desktop/src/styles/reduced-motion.css#L26-L33)：
```css
:root, html[data-theme='default'], html[data-theme='light'], html[data-theme='dark'] {
  --transition-micro: 0ms !important;
  --transition-fast: 0ms !important;
  --transition-normal: 0ms !important;
  --transition-popover-enter: 0ms !important;
  --transition-popover-exit: 0ms !important;
  --transition-modal-enter: 0ms !important;
  --transition-accordion: 0ms !important;
  --transition-chevron: 0ms !important;
}
```
查看 [`apps/crish-desktop/src/styles/tokens-base.css:117-127`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-base.css#L117-L127)：
```css
html[data-perf-tier='eco'] {
  --duration-snappy: 0ms;
  --transition-micro: 0ms;
  --transition-snappy: 0ms;
  --transition-fast: 0ms;
  --transition-normal: 0ms;
  --transition-smooth: 0ms;
  --transition-popover-enter: 0ms;
  --transition-popover-exit: 0ms;
  --transition-modal-enter: 0ms;
  --duration-accordion: 0ms;
}
```
**严重事实漏洞**：
无论是 `reduced-motion.css` 还是 `tokens-base.css` 的 `eco` 块中，**完全不存在 `--transition-spring-snappy`、`--transition-spring-smooth`、`--transition-spring-morph` 以及 `--duration-spring-*` 的任何归零声明**！
P05 根本没有在方案中提交针对这两个基础样式文件的补齐 Diff，就虚构断言其“已自动归零”。一旦按照 P05 将 Dialog 或 Tooltip 接入 `--transition-spring-smooth`，在用户开启减弱动效或系统进入 `eco` 节能档时，**弹簧动效依然会毫发无损地运行 400ms**，导致节能拦截率跌落，直接违反项目立体验证纪律！

#### 3. 评审专家终局裁定
- **裁决**：**严重阻塞（Blocker）！**
- **执行要求**：P05 必须在方案中补充具体的代码级变更，在 `tokens-base.css` 与 `reduced-motion.css` 中补齐全部 5 个弹簧相关变量的 `0ms !important` 声明，确保端到端测试真实验收合格。

---

### 2.5 【单行扫描器误杀陷阱 · Warning】P02 在 ColorPicker 的物理图元豁免注解踩入跨行格式化漏洞

#### 1. 现场实证
P02 §3.2 在 `ColorPicker.module.css` 中为 2D 光谱黑白投影底板和滑块阴影添加了规约注解：
```css
/* ColorPicker.module.css (P02 §3.2) */
/* ssot-color-ignore: ColorPicker 物理取色板 2D 光谱黑白投影底板 */
background:
  linear-gradient(to top, #000, transparent),
  linear-gradient(to right, #fff, transparent), var(--picker-hue);
```

#### 2. 门禁源码漏洞穿透
核查门禁脚本 [`scripts/check-color-ssot.mjs:147-156`](file:///c:/Software/conex/scripts/check-color-ssot.mjs#L147-L156)：
```javascript
let ignoreNextLine = false;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('ssot-color-ignore')) {
    ignoreNextLine = true;
    continue;
  }
  if (ignoreNextLine) {
    ignoreNextLine = false;
    continue;
  }
  // 逐行检测 cleanLine 是否含有裸色
}
```
**漏洞机理**：
- `ignoreNextLine` 在遇到 `/* ssot-color-ignore */` 后的第一行触发，**随后立即重置为 `false`**！
- 在 Prettier 格式化下，`background:` 自成一行（被 ignore 掉）；
- 但紧随其后的第 2 行 `linear-gradient(to top, #000, transparent),` 与第 3 行 `linear-gradient(to right, #fff, transparent)` **将不再受保护**！
- 门禁脚本的逐行正则会精准命中第 2、3 行的 `#000` 与 `#fff`，立即判定为“硬编码颜色违规”，直接引爆 CI 报错！

#### 3. 评审专家裁决
- **裁决**：**警告项（Warning）！**
- **执行要求**：
  必须升级 `scripts/check-color-ssot.mjs`，将其改造为**基于声明语句块（直至分号 `;` 结束）**或**块级作用域**的忽略判定，杜绝单行脆弱标记；或者在 CSS 中要求将多行物理渐变压缩在紧随注解后的单行内。

---

### 2.6 【违背零双轨原则 · Warning】P02 在 16 处悬空未定义治理中擅自制造 4 处全局代理别名死 Token

#### 1. 现场实证
P02 §4.1 清单中，第 7、8、11 项：
- `--composer-shell-bg`：仅在 `AgentCard.module.css:587` 出现 1 处；P02 处置为“在 `tokens-surface.css:root` 补齐 `--composer-shell-bg: var(--composer-bg);`”。
- `--composer-shell-bg-focus`：仅在 `AgentCard.module.css:595` 出现 1 处；P02 处置为“在 `tokens-surface.css:root` 补齐 `--composer-shell-bg-focus: var(--surface-raised);`”。
- `--edge-divider`：在 `ComposerEmbeddedNotice.module.css` 出现 6 处；P02 处置为“在 `tokens-radius.css:root` 补入 `--edge-divider: var(--border-subtle);`”。

#### 2. 架构危害
- **自相矛盾**：P02 刚刚在 §1.3 确立“零双轨妥协、绝不保留过渡别名”的原则，转头为了平抑局部组件的几处引用，往全局核心 Token 表中注入了 3 个组件专属的非标代理别名（Alias Tokens）。
- **职责错位**：将用于描述分隔线的 `--edge-divider` 写入 `tokens-radius.css`（圆角标尺规范文件），严重破坏了 Token 文件按物理属性分模块的架构整洁度。

#### 3. 评审专家裁决
- **裁决**：**警告项（Warning）！**
- **执行要求**：
  坚决禁止新增 `--composer-shell-bg`、`--composer-shell-bg-focus` 与 `--edge-divider`。直接就地修改 `AgentCard.module.css` 消费既有的 `var(--composer-bg)` 与 `var(--surface-raised)`，直接修改 `ComposerEmbeddedNotice.module.css` 消费既有的 `var(--border-subtle)`。清退必须一步到位，零新增别名！

---

### 2.7 【边界封锁致断裂 · Warning】P05 对 `internal/` 的 16 处外部穿透封锁缺乏替代公共契约

#### 1. 现场实证
P05 §3.4 的 Codemod 脚本中：
```javascript
// 3. 告警对 internal/ 的非法引用
if (/ui\/internal\//.test(content)) {
  console.warn(`[WARN - ILLEGAL INTERNAL ACCESS]: ${toPosix(file)} 仍引用了 internal/ 私有模块，需手动解除耦合！`);
}
```
并在 §3.5 中配置了 ESLint 刚性阻断规则：外部凡引用 `/internal/` 一律报错。

#### 2. 架构脱节分析
全仓非 UI 模块对 `ui/internal/` 的依赖并非无理取闹，而是存在关键的业务协作场景：
1. `apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx:13` 与 `nativeBrowserGeometry.ts:27`：必须感知全局是否有模态弹窗打开（`useLayerStackModalActive`），以便在 WebView2 浏览器上方覆盖磨砂占位板（Airspace 避让态）；
2. `apps/crish-desktop/src/components/shell/windowSnapOverlay.ts:25`：拖拽吸附时需判断是否有浮层激活；
3. `apps/crish-desktop/src/components/settings-models/ModelsCascadeSelect.tsx:36`：级联选择器需要 `SafeTriangleTracker` 计算鼠标安全角。

P05 仅用一句 `console.warn` 敷衍了事，没有在 `@/components/ui` 出口提供任何合法的替代 API。一旦开启 ESLint 拦截，构建立即崩溃！

#### 3. 评审专家裁决
- **裁决**：**警告项（Warning）！**
- **执行要求**：
  P05 必须在 `src/components/ui/index.ts` 中正式导出公共 Hook：`useIsModalActive()` 与 `useFloatingActive()`，在内部封装对浮层状态的观察；级联菜单若需要安全角，必须由 UI 基座提升为公共工具或由 Base UI 原生处理，彻底闭环解耦。

---

### 2.8 【清退死角漏网 · Suggestion】P03 的 13px 清退 Codemod 遗漏了 TSX 行内样式与非 CSS 源码

#### 1. 现场实证
P03 §5.1 的 `scripts/codemod-typography-ssot.mjs` 仅扫描了 `.module.css` 文件。  
但在代码检索中发现，以下 TSX 文件中存在裸 13px：
- `apps/crish-desktop/src/entry-core.tsx:441`：`style="...font-size:13px;font-weight:500;..."`；
- `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx:280`：`fontSize: 'var(--font-size-sm, 13px)'`。

#### 2. 评审专家裁决
- **裁决**：**建议项（Suggestion）！**
- **执行要求**：
  扩展 Codemod 扫描范围至全仓 `.tsx` / `.ts` 文件，或在第三轮就地修复时对上述两处 TSX 实施手工收口，确保运行时计算值零 13px 残留。

---

## 3. 跨方案架构冲突判决与对齐矩阵（Cross-Plan Alignment Matrix）

为了确保第三轮就地修改时三方步调完全一致，特制定跨方案冲突统一仲裁矩阵：

| 争议架构领域 | P02 方案主张 | P03 方案主张 | P05 方案主张 | R02 最终仲裁裁决 | 落实责任专员 |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **`--type-*` 复合排版角色** | 判定为过度设计死代码，**物理彻底删除** | 判定为 8 大核心契约，**全仓推广** | 未涉及 | **采纳 P02，彻底物理删除**！全仓组件严格消费原子字阶、行高与字重。 | P03 |
| **`--ink-*` 语义墨色角色** | 判定为冗余死层，**物理彻底删除** | 倡导与排版角色配对消费 | 未涉及 | **采纳 P02，彻底物理删除**！统一使用既有标准 `--text-*` 体系。 | P03 |
| **`Button bare` 清退路径** | 未涉及 | 未涉及 | 暴力替换为 `variant="unstyled"` | **否决 P05 粗暴替换**！为 `unstyled` 剥离 `.button` 尺寸类，微型图标改走 `IconButton`。 | P05 |
| **FocusTrap 模态隔离机制** | 未涉及 | 未涉及 | 仅对 `#root` 单点施加 `inert` | **补充多层弹窗防线**！Level $N$ 激活时，底层所有弹窗同步施加 `inert`。 | P05 |
| **Dialog 退场动效实现** | 未涉及 | 未涉及 | 用 `@starting-style` 代替，直接 `if (!open) return null` | **否决直接 return null**！保留原生 `transitionend` 退场状态机，直到接入 Base UI。 | P05 |
| **动效变量 eco 归零** | 未涉及 | 未涉及 | 声称已自动归零，但未提交样式补丁 | **刚性补齐代码**！在 `tokens-base.css` 与 `reduced-motion.css` 补齐弹簧变量归零。 | P05 |
| **悬空 Token 清理方式** | 在全局补入 4 处代理别名 Token | 未涉及 | 未涉及 | **禁止新增全局别名**！直接修改 3 个调用方 CSS 消费真源 Token。 | P02 |
| **Windows 字重两档化 (400/700)** | 协同遵循 | 强力主导推行，消除 DirectWrite 锯齿 | 协同遵循 | **完全支持 P03**！全仓坚决执行 400/700 两档化，严防伪粗体毛刺。 | 全员 |

---

## 4. 第三轮就地修改操作指引（Actionable Amendments for Round 3）

在进入第三轮方案就地完善阶段，各架构专员必须严格按照以下操作指引就地修订对应方案文档：

### 4.1 针对 P02 方案的就地修订任务单
1. **撤销新增别名，改为消费端直改**：
   - 从 P02 §4.1 表格中剔除向 `tokens-surface.css` 与 `tokens-radius.css` 注入 `--composer-shell-bg`、`--composer-shell-bg-focus` 与 `--edge-divider` 的方案；
   - 补充直接修改 `AgentCard.module.css:587, 595`（改为 `var(--composer-bg)` 与 `var(--surface-raised)`）和 `ComposerEmbeddedNotice.module.css`（改为 `var(--border-subtle)`）的具体 Diff。
2. **升级门禁扫描器支持多行忽略**：
   - 在 P02 §5 或 §6 中补充对 `scripts/check-color-ssot.mjs` 的升级说明，支持跳过完整的声明语句块（直到分号 `;`），彻底消除 `ColorPicker` 多行渐变引起的假阳性阻断。

### 4.2 针对 P03 方案的就地修订任务单
1. **彻底清退复合排版与墨色角色**：
   - 物理删除 P03 §3.4 节（“8 大核心排版角色与语义墨色复合契约”）；
   - 从 P03 §5.2 的 Codemod 脚本中剔除引入 `--type-*` 的逻辑，改为将字体字重、字号、行高分别标准化为原子 Token；
   - 在 P03 §5.5 中，将 `--type-*`（9项）与 `--ink-*`（7项）列入与 P02 完全协同的物理删除清单。
2. **清除嵌套 fallback 陋习**：
   - 修正 P03 §4.3 中对 `ProjectManageModal.module.css` 的补丁，将 `var(--edge-rim, transparent)` 改为 `var(--edge-rim)`，将 `var(--edge-control, var(--edge-rim))` 改为纯粹的 `var(--edge-control)`，贯彻零假兜底宪法。
3. **补充 TSX 13px 清洗说明**：
   - 在 P03 §5.1 或 §8.2 中明确收敛 `entry-core.tsx` 与 `ModelBadgePickerMenu.tsx` 中的行内 13px。

### 4.3 针对 P05 方案的就地修订任务单
1. **重塑 Button `variant="unstyled"` 物理实现**：
   - 修改 P05 §5.2 与 §5.3：在 `Button.tsx` 中增加逻辑，当 `variant === 'unstyled'` 时，**绝不拼接 `styles.button` 类**，改用纯净的 `styles.buttonUnstyled`，确保零高度、零内边距、零 flex 污染；
   - 细化 Codemod 迁移规则：将微型操作（twisty 展开、关闭微标）迁移至专职 `<IconButton>`，大卡片与列表行迁移至 `<Button variant="unstyled">`。
2. **修补 FocusTrap 多层模态隔离**：
   - 修改 P05 §5.1：引入 `modalStack: HTMLElement[]` 栈结构，当新弹窗打开时，栈内之前的弹窗节点全部同步追加 `inert` 属性，出栈时逐层恢复。
3. **修复 Dialog 退场动效与生命周期**：
   - 修改 P05 §5.5：删除粗暴的 `if (!open) return null`。在阶段二手写版中引入 `isExiting` 状态与原生 `onTransitionEnd` 监听，保证 400ms 退场弹簧完全播放后再卸载 DOM。
4. **补齐动效静音与节能防御代码**：
   - 修改 P05 §6.4：正式给出对 `tokens-base.css` 与 `reduced-motion.css` 的修改 Diff，将 `--transition-spring-*` 与 `--duration-spring-*` 显式写入归零声明中。
5. **提供 `internal/` 替代公共接口**：
   - 修改 P05 §3.1：在 `src/components/ui/index.ts` 中显式导出 `useIsModalActive()` 与 `useFloatingActive()`，彻底解决外部模块非法穿透引用的后顾之忧。

---

## 5. 永久免疫门禁与立体化验收红线（Permanent Immunity & Verification Gates）

第三轮方案修改完成并交付实施后，必须刚性通过以下六重立体化验收门禁（零报警、零违规、零妥协）：

```bash
# 1. 色彩 SSOT 宪法门禁（断言：101 处假兜底与裸色违规严格为 0）
node scripts/check-color-ssot.mjs

# 2. Token 一致性刚性门禁（断言：undefined_refs=0, nofallback_refs=0, dead_tokens=0）
node scripts/check-token-consistency.mjs

# 3. 视觉层级与字阶 SSOT 门禁（断言：全仓 9 大覆盖域实测值 <= 锁定基线，最终达成 strict-zero）
node scripts/check-hierarchy-ssot.mjs

# 4. Markdown 样式规范门禁（断言：递归解析 845 个 Token，假阳性彻底清零）
node scripts/check-markdown-style-compliance.mjs

# 5. UI 边界与反向穿透门禁（断言：双向穿透违规数严格为 0，零 DOM Monkey-patching）
node scripts/check-ui-layer.mjs

# 6. 动效 Token 绑定门禁（断言：裸硬编码 transition 严格为 0，eco 档位下计算时长严格为 0s）
node scripts/check-transition-ssot.mjs
```

---

> **评审结论签发**：  
> 本独立评审报告所指出的 4 项阻断级缺陷与 4 项警告/建议项均具备确凿的代码级证据。方案编制专员（P02、P03、P05）必须摒弃侥幸心理与局部修补思维，在第三轮中坚决按照本报告指引就地彻底重构，确保 Conex / Crish 前端基座在设计真理源（SSOT）、物理字形对齐与无障碍交互原语上达成真正的架构净收敛！
