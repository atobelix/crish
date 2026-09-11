# 06 · 统一滚动条测试契约重塑与负向刚性门禁实现详案（gate-ratchet）

> **规范编号**：`SCROLLBAR-PLAN-GATE-RATCHET-06`
> **战役工作区**：`docs/unified-scrollbar-system/`（统一滚动条体系与 ScrollArea 高频组件战役）
> **归档落盘路径**：`docs/unified-scrollbar-system/detailed-plans/06-plan-gate-ratchet.md`
> **角色定位**：战役方案修订专家（Revision Architect 4：Plan 06 修订专员）
> **评审修订基准**：经 Reviewer A（架构治理与执行时序主审）与 Reviewer C（跨平台与魔鬼边界主审，指令 M01）联合严审全面纠偏
> **总调度主控**：Antigravity Main Agent
> **版本状态**：`v2.0-revised`（工业级可执行落盘定案版）
> **修订基准时间**：2026-09-02
> **遵循基准**：
> - `docs/unified-scrollbar-system/00-master-plan.md`（统一滚动条体系总纲 §3.6 维度 6）
> - `docs/unified-scrollbar-system/plan-reviews/01-review-architecture.md`（Reviewer A 架构与时序死锁破解报告）
> - `docs/unified-scrollbar-system/plan-reviews/03-review-crossplatform.md`（Reviewer C 跨平台魔鬼审计与 M01 刚性指令）
> - `AGENTS.md`（§1 逻辑规划与反退避、§7 严禁补丁与绕过、§7.1 立体验证纪律、§11 CI 治理）
> - `ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计红线）
> - 用户最高定案铁律：二元灰度绝对死锁（8.2% vs 20.2%，差值死锁 12.0%，严禁第三态）、彻底去白名单化（物理删除 `SCROLLBAR_WHITELIST`）、零裸像素 Token 体系、先删后改收敛优先、「解绑前置」打破 CI 时序死锁。

---

## 目录

- [一、架构定位与设计哲学（Architecture & Paradigm Shift）](#一架构定位与设计哲学architecture--paradigm-shift)
  - [1.1 历史门禁沦为死层保护伞的深度复盘](#11-历史门禁沦为死层保护伞的深度复盘)
  - [1.2 范式跃迁：从“白名单妥协豁免”到“零容忍负向刚性门禁”](#12-范式跃迁从白名单妥协豁免到零容忍负向刚性门禁)
  - [1.3 Blink 内核互斥自毁机理与“双属性齐禁（Dual Property Lockout）”](#13-blink-内核互斥自毁机理与双属性齐禁dual-property-lockout)
  - [1.4 跨 Package 零死角治理架构（消除 `packages/block-paper` 扫描盲区）](#14-跨-package-零死角治理架构消除-packagesblock-paper-扫描盲区)
  - [1.5 门禁棘轮（Ratchet）不可逆单调递紧原则](#15-门禁棘轮ratchet不可逆单调递紧原则)
- [二、本方案要删掉什么 / 收敛什么（删除面与解耦面 Deletions Surface）](#二本方案要删掉什么--收敛什么删除面与解耦面-deletions-surface)
  - [2.1 彻底删除 `SCROLLBAR_WHITELIST` 白名单集合（Lines 304-317）](#21-彻底删除-scrollbar_whitelist-白名单集合lines-304-317)
  - [2.2 彻底删除保护私有伪元素的反向死断言（`style-contract.test.ts:284-295`）](#22-彻底删除保护私有伪元素的反向死断言style-contracttestts284-295)
  - [2.3 彻底删除脆弱子串模糊匹配类名断言（Lines 258-276）](#23-彻底删除脆弱子串模糊匹配类名断言lines-258-276)
  - [2.4 彻底删除 `display: none` 按钮抑制与端点自杀断言](#24-彻底删除-display-none-按钮抑制与端点自杀断言)
  - [2.5 彻底清除全仓临时测试跳过（`it.skip` / `test.todo`）与豁免注释](#25-彻底清除全仓临时测试跳过itskip--testtodo与豁免注释)
  - [2.6 外部测试解耦方案：彻底清洗 `SettingsShortcutsTab.test.ts:119-122` 反向死断言](#26-外部测试解耦方案彻底清洗-settingsshortcutstabtestts119-122-反向死断言)
  - [2.7 删除面与解耦面清单及代码净收敛核算表](#27-删除面与解耦面清单及代码净收敛核算表)
- [三、五大刚性门禁与契约断言深度设计（Core Ratchet Specifications）](#三五大刚性门禁与契约断言深度设计core-ratchet-specifications)
  - [3.1 门禁一：全仓跨包 CSS 禁 thin 与非 auto scrollbar-color 双属性齐禁门禁](#31-门禁一全仓跨包-css-禁-thin-与非-auto-scrollbar-color-双属性齐禁门禁)
  - [3.2 门禁二：全仓跨包 CSS 零私有 `::-webkit-scrollbar` 负向刚性门禁（去白名单化）](#32-门禁二全仓跨包-css-零私有--webkit-scrollbar-负向刚性门禁去白名单化)
  - [3.3 门禁三：二元灰度绝对死锁与 12.0% 差值增量刚性断言（健壮光学物理提取算法）](#33-门禁三二元灰度绝对死锁与-120-差值增量刚性断言健壮光学物理提取算法)
  - [3.4 门禁四：滚动条维度零裸像素（Zero Naked Pixels）静态正则扫描门禁](#34-门禁四滚动条维度零裸像素zero-naked-pixels静态正则扫描门禁)
  - [3.5 门禁五：Mode 2 实用类矩阵与端点安全护栏规范守卫](#35-门禁五mode-2-实用类矩阵与端点安全护栏规范守卫)
- [四、测试套件重塑与解耦源码详案（Ready-to-Implement Code Spec）](#四测试套件重塑与解耦源码详案ready-to-implement-code-spec)
  - [4.1 `style-contract.test.ts` 重塑测试套件完整 TypeScript 代码实现](#41-style-contracttestts-重塑测试套件完整-typescript-代码实现)
  - [4.2 `SettingsShortcutsTab.test.ts` 外部解耦完整落地代码实现](#42-settingsshortcutstabtestts-外部解耦完整落地代码实现)
  - [4.3 错误诊断信息设计（DX Friendly Error Reporting）](#43-错误诊断信息设计dx-friendly-error-reporting)
- [五、先删后改依赖拓扑与「解绑前置」执行时序（Execution Sequencing & Staging）](#五先删后改依赖拓扑与解绑前置执行时序execution-sequencing--staging)
  - [5.1 战役 6 大维度强逻辑依赖拓扑](#51-战役-6-大维度强逻辑依赖拓扑)
  - [5.2 破除 CI 死锁的「解绑前置（Uncouple First）」执行节拍](#52-破除-ci-死锁的解绑前置uncouple-first执行节拍)
  - [5.3 CI 快层（`ci.yml`）与本地门禁（`npm run check:desktop`）集成点](#53-ci-快层ciyml与本地门禁npm-run-checkdesktop集成点)
- [六、立体验证断言与魔鬼用例反脆弱性测试（Multi-Dimensional Verification）](#六立体验证断言与魔鬼用例反脆弱性测试multi-dimensional-verification)
  - [6.1 单元测试断言矩阵（V1-V14）](#61-单元测试断言矩阵v1-v14)
  - [6.2 负向试毒实验（Poison Injection Tests）设计与预期拦截](#62-负向试毒实验poison-injection-tests设计与预期拦截)
  - [6.3 运行性能与扫描开销约束（$\le 80\text{ms}$ 压测标准）](#63-运行性能与扫描开销约束le-80textms-压测标准)
- [七、实施风险评估与防御性兜底措施](#七实施风险评估与防御性兜底措施)
- [八、主控签发确认与下一步行动](#八主控签发确认与下一步行动)

---

## 一、架构定位与设计哲学（Architecture & Paradigm Shift）

### 1.1 历史门禁沦为死层保护伞的深度复盘

在桌面端样式的持续演进中，测试本应是捍卫系统架构纯洁度的最终防线。然而，在通读 `apps/crish-desktop/src/styles/style-contract.test.ts:243-331` 以及相关组件测试源码后，发现了触目惊心的**“门禁异化与死锁绑架”**事实：

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   历史测试契约如何沦为技术债务保护伞                                │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 1. SCROLLBAR_WHITELIST (304-317 行)                                              │
│    └─ 设立了包含 11 个业务组件的白名单，为私自编写 ::-webkit-scrollbar 开绿灯。        │
│    └─ 导致 ModelBadgePickerMenu、Menu 等组件割据一方，私自维护重复且劣质的滚动样式。       │
│                                                                                  │
│ 2. 反向断言绑架架构 (style-contract.test.ts:284-295)                              │
│    └─ 测试公然断言 Menu.module.css 等必须包含 ::-webkit-scrollbar-button 与           │
│       --tint-scrollbar-thumb，逼迫业务组件保留私有按钮伪元素，诱发 CI 串行死锁！         │
│                                                                                  │
│ 3. 外部测试耦合地雷 (SettingsShortcutsTab.test.ts:119-122)                        │
│    └─ 外部测试直接断言 overlay-scrollbar.css 必须包含 coverContent、navScroll、      │
│       dialogBody 与 --tint-scrollbar-thumb，导致出口样式无法解耦重构！             │
│                                                                                  │
│ 4. 脆弱的模糊匹配绑定 (258-267 行) 与 display: none 截断端点护栏                  │
│    └─ 强制全局出口 overlay-scrollbar.css 包含业务类名，且强行断言 display: none，把    │
│       Blink 内核级 TrackRect 护栏切除逻辑写死在门禁中，导致滑块越界截断无法修复。      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**结论**：现存的测试门禁非但没有阻止滚动条腐化，反而通过“反向死断言”、“豁免白名单”以及“外部测试深耦合”，将临时补丁与技术死层升格成了不可触碰的“契约”，彻底违背了 `AGENTS.md §7` 严禁补丁与绕过的铁律。

### 1.2 范式跃迁：从“白名单妥协豁免”到“零容忍负向刚性门禁”

本维度（维度 6：gate-ratchet）是整场战役的**“落锁与卡扣”**。我们要推行的不是局部的修正，而是一场**测试哲学范式跃迁（Paradigm Shift）**：

1. **绝对去白名单化（Zero Exemption）**：
   - 彻底废除 `SCROLLBAR_WHITELIST`。全仓除唯一合法出口 `overlay-scrollbar.css` 外，任何 `.css` 文件只要出现私有 `::-webkit-scrollbar`，测试直接硬性报错阻断！
2. **全域负向刚性阻断（Negative Rigid Gate）**：
   - 不仅检查“有没有做对”，更要以穷举姿态扫描“绝对不准出现什么”。
   - 凡命中 `scrollbar-width: thin` 或任何非 auto 的 `scrollbar-color`，即刻爆红阻断。
3. **二元灰度绝对死锁（Binary Gray Level Ratchet）**：
   - 用户最高裁决：“滚动条就是两种灰度，别给我整成三种的，就是激活和未激活，没有激活分成 hover 和 active 两种的。”
   - 门禁对 Design Token 进行光学物理级精确验算：
     - 未激活（Idle）：屏幕实测物理暗度 $8.2\% \pm 0.3\%$；
     - 激活（Active = Hover + Drag）：屏幕实测物理暗度 $20.2\% \pm 0.3\%$；
     - 差值绝对死锁在 $12.0\% \pm 0.5\%$；
     - 严禁出现第三种 Hover 灰阶变量，`:hover` 与 `:active` 选择器必须消费同一个 Token！
4. **零硬编码裸像素扫描（Zero Naked Pixels）**：
   - 滚动条宽度必须且只能从四级 Token 体系（`--scrollbar-width-xs: 4px`、`sm: 5px`、`md: 7px`、`lg: 9px`）中消费，全仓严禁直接裸写像素数字。

### 1.3 Blink 内核互斥自毁机理与“双属性齐禁（Dual Property Lockout）”

根据 Chromium Blink 渲染引擎核心源码（`third_party/blink/renderer/core/paint/paint_layer_scrollable_area.cc`）：
只要元素计算样式中解析出 **`scrollbar-width != auto`** 或 **`scrollbar-color != auto`**，Blink 将强制激活 `CSSScrollbarTheme` 并将 `UsesCustomScrollbarStyle()` 内部标志位置为 `false`。

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      Chromium Blink 内核互斥自毁逻辑穿透                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   CSS 样式声明 ───> 解析 scrollbar-width != auto  ──┐                           │
│                     或 scrollbar-color != auto ───┴─> UsesCustomScrollbarStyle()│
│                                                           = FALSE               │
│                                                              │                  │
│   ┌──────────────────────────────────────────────────────────┘                  │
│   ▼                                                                             │
│   【物理断路】：注销 ::-webkit-scrollbar* 所有伪元素树                          │
│   【强制降级】：Windows WebView2 强行回退至 Win32/UWP 17px 原生灰粗条与生硬箭头   │
│   【样式吞噬】：全套二元灰度色彩、圆角、内联 SVG 三角全部静默失效！             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**整改铁律**：门禁必须确立**“双属性齐禁（Dual Property Lockout）”**：全仓 CSS 既严禁 `scrollbar-width: thin`，也绝对禁止任何非 auto 的 `scrollbar-color` 声明！

### 1.4 跨 Package 零死角治理架构（消除 `packages/block-paper` 扫描盲区）

历史测试套件中的 `walkSrc()` 仅扫描了 `apps/crish-desktop/src/`，导致 monorepo 架构下的共享包 `packages/block-paper/` 成为 CI 监控盲区：
- `packages/block-paper/src/list/paperList.css:58-60` 曾公然声明 `scrollbar-width: thin;` 与 `scrollbar-color: ...;`；
- 若门禁仅扫桌面端私有源码目录，共享包的代码漂移将完全绕过 CI 门禁，直接在真实渲染中炸毁 WebKit 滚动条！

**整改铁律**：重构测试工具扫描器为 `walkAllCss()`，将扫描根路径扩展至同时覆盖 `apps/crish-desktop/src/` 与 `packages/`（特别是 `packages/block-paper/`），实现全仓无死角覆盖。

### 1.5 门禁棘轮（Ratchet）不可逆单调递紧原则

依据工程防腐化原则，刚性门禁必须作为单向棘轮运行：
- **单调递紧（Monotonically Tightening）**：白名单一旦清除，永不许复活；违规计数基线一旦清零（严格为 0），任何 PR 只要引入哪怕 1 处违规，CI 门禁立即硬性阻断，绝无商量余地。
- **无静默放行（No Silent Bypassing）**：杜绝 `--no-verify`，杜绝在测试内使用 `/* vitest-disable */` 或 `it.skip`。

---

## 二、本方案要删掉什么 / 收敛什么（删除面与解耦面 Deletions Surface）

> **反退避铁律与反过度设计红线**：推进单位是「领域概念」，同一概念收敛为唯一主路径。收敛先于增强，必须详列物理删除清单！

### 2.1 彻底删除 `SCROLLBAR_WHITELIST` 白名单集合（Lines 304-317）

在 `apps/crish-desktop/src/styles/style-contract.test.ts` 中，存在以下庇护私有样式的白名单，**必须 100% 物理删除**：

```typescript
// ❌ 必须从 style-contract.test.ts 物理删除的白名单代码块 (Lines 304-317)
  const SCROLLBAR_WHITELIST = new Set([
    SCROLLBAR_EXPORT,
    'LeafToolTabStrip.module.css',
    'ChatComposer.module.css',
    'ModelBadgePickerMenu.module.css',
    'FontSelectField.module.css',
    'ModelsSettingsTab.module.css',
    'SmartExpandablePanel.module.css',
    'SmartPanel.module.css',
    'SelectContent.module.css',
    'Menu.module.css',
    'PermissionModeMenu.module.css',
    'Select.module.css',
  ]);
```

**收敛结果**：彻底删除该 Set 对象及其在测试用例中的查询逻辑（`if (SCROLLBAR_WHITELIST.has(base)) continue;`）。私有 WebKit 伪元素例外数直接从 12 骤降并**绝对清零**（除 `overlay-scrollbar.css` 本身）。

### 2.2 彻底删除保护私有伪元素的反向死断言（`style-contract.test.ts:284-295`）

现存测试用例中强迫业务组件保留私有按钮伪元素和旧 Token 的反向断言，**必须 100% 物理删除**：

```typescript
// ❌ 必须从 style-contract.test.ts 物理删除的反向死断言 (Lines 284-295)
  it('浮层组件与 Menu 严禁声明 scrollbar-width（走 webkit 细条，无三角箭头）', () => {
    const floatingPanels = [
      'src/components/ui/Menu/Menu.module.css',
      'src/components/ui/SmartPanel/SmartPanel.module.css',
      'src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css',
    ] as const;
    for (const rel of floatingPanels) {
      const css = readFile(rel);
      expect(css, rel).not.toMatch(/scrollbar-width\s*:/);
      expect(css, rel).toContain('--tint-scrollbar-thumb');  // ❌ 强行要求私有代码块引用旧 token
      expect(css, rel).toContain('::-webkit-scrollbar-button'); // ❌ 强行要求业务组件写私有 button
    }
    // ...
```

**时序关键判定（解绑前置）**：
该断言不能拖到维度 6 才改！在维度 2（purge-debts）清理 `Menu.module.css` 等 3 个组件的私有 WebKit 块时，**必须伴随原子性地将本测试删除**，否则维度 2 提交时 `npm test` 必爆红，诱发流水线瘫痪死锁（详见 §5.2）。

### 2.3 彻底删除脆弱子串模糊匹配类名断言（Lines 258-276）

现存测试强行断言全局出口 `overlay-scrollbar.css` 必须包含各业务模块的特定类名：

```typescript
// ❌ 必须从 style-contract.test.ts 物理删除的脆弱类名断言 (Lines 261-265)
    expect(css).toContain('sidebarScroll');
    expect(css).toContain('menuContent');
    expect(css).toContain('coverContent');
    expect(css).toContain('navScroll');
    expect(css).toContain('dialogBody');
```

**收敛理由**：维度 3（engine-core）已将全局出口从针对特定业务类名的脆弱模糊匹配选择器（`[class*='sidebarScroll']` 等），重构为解耦的 Mode 2 零 DOM 实用类矩阵（`.scrollArea`, `.scrollAreaSm` 等）。测试收敛为断言 Mode 2 实用类契约。

### 2.4 彻底删除 `display: none` 按钮抑制与端点自杀断言

现存测试对滚动条按钮 `display: none` 进行强制断言：

```typescript
// ❌ 必须从 style-contract.test.ts 物理删除的自杀断言 (Line 267)
    expect(css).toMatch(/display:\s*none/);
```

**收敛理由**：用户明确要求上下圆角三角箭头充当端点安全护栏、物理防滑块越界截断。维度 3 恢复了 `::-webkit-scrollbar-button` 的尺寸以激活 Blink 内核级 `TrackRect` 护栏。门禁逆转为：**严禁写 `display: none` 抹杀端点护栏**。

### 2.5 彻底清除全仓临时测试跳过（`it.skip` / `test.todo`）与豁免注释

检查全仓所有测试与注释，彻底清除以下妥协产物：
1. 彻底删除任何针对滚动条样式的 `it.skip` 或 `test.skip`；
2. 彻底删除 `packages/block-paper/src/list/paperList.css:51` 的遗留死注释（`* - 滚动条：scrollbar-width:thin + gutter stable；**禁** ::-webkit-scrollbar 私有块`）；
3. 彻底删除 `style-contract.test.ts` 中关于旧批次临时豁免的模糊注释。

### 2.6 外部测试解耦方案：彻底清洗 `SettingsShortcutsTab.test.ts:119-122` 反向死断言

在 `apps/crish-desktop/src/components/settings/SettingsShortcutsTab.test.ts:110-128` 中，存在历史残留的外部反向死断言：

```typescript
// ❌ 现存生产代码 SettingsShortcutsTab.test.ts:110-128 中的致命死断言 (Lines 119-122)
  it('设置 cover/nav/Dialog 吃 overlay 细条：入口引入 + 无三角 + cover 不写 scrollbar-width', () => {
    const overlay = readSrc('styles/overlay-scrollbar.css');
    const indexCss = readSrc('index.css');
    const panel = readSrc('components/settings/SettingsPanel.module.css');
    const uiCss = readSrc('components/settings/SettingsUI.module.css');
    expect(indexCss).toContain("@import './styles/overlay-scrollbar.css'");
    expect(indexCss).not.toContain('shell-scrollbar.css');
    expect(overlay).toContain('::-webkit-scrollbar');
    expect(overlay).toContain('::-webkit-scrollbar-button');
    expect(overlay).toContain('coverContent');          // ❌ 强行断言全局出口含业务类名
    expect(overlay).toContain('navScroll');             // ❌ 强行断言全局出口含业务类名
    expect(overlay).toContain('dialogBody');            // ❌ 强行断言全局出口含业务类名
    expect(overlay).toContain('--tint-scrollbar-thumb');// ❌ 强行断言全局出口引用旧 Token
    expect(overlay).not.toMatch(/(?:^|\n)\*\s*\{[^}]*scrollbar-width/);
    expect(panel).not.toMatch(/scrollbar-width\s*:/);
    expect(panel).toContain('.coverContent');
    expect(uiCss).toContain('var(--button-radius, 7px)');
    expect(uiCss).toContain('appearance: none');
  });
```

**解耦方案与时序绑定**：
1. 维度 3 重构 `overlay-scrollbar.css` 时，删除了 `coverContent`、`navScroll`、`dialogBody` 以及 `--tint-scrollbar-thumb`；
2. 若不同步解耦该外部测试，维度 3 改动落盘后运行 `npm test`，`SettingsShortcutsTab.test.ts` 将瞬间报错阻断流水线；
3. 必须在维度 3 执行的同时，伴随修改 `SettingsShortcutsTab.test.ts:119-122`：删除这 4 行死断言，替换为断言统一出口契约（`var(--scrollbar-thumb-bg)` 与 `.scrollArea`）。具体代码见 §4.2。

### 2.7 删除面与解耦面清单及代码净收敛核算表

| 序号 | 目标文件 | 原代码行号 | 删除/解耦内容 | 关联维度与时序 |
| :--- | :--- | :--- | :--- | :--- |
| **D1** | `style-contract.test.ts` | 304–317 | `SCROLLBAR_WHITELIST` 白名单集合（12 个条目） | 维度 6 终态落锁删除 |
| **D2** | `style-contract.test.ts` | 324 | `if (SCROLLBAR_WHITELIST.has(base)) continue;` | 维度 6 终态落锁删除 |
| **D3** | `style-contract.test.ts` | 284–295 | 强制 Menu 等包含私有 button/thumb 的反向死断言 | **维度 2 伴随解绑原子删除（前置）** |
| **D4** | `style-contract.test.ts` | 261–265 | 强制 `overlay-scrollbar.css` 包含 5 处业务类名 | 维度 3 伴随出口重构删除 |
| **D5** | `style-contract.test.ts` | 267 | `expect(css).toMatch(/display:\s*none/);` | 维度 3 伴随护栏恢复删除 |
| **D6** | `style-contract.test.ts` | 260 | `expect(css).toContain('--tint-scrollbar-thumb');` | 维度 3 伴随 Token 升级删除 |
| **D7** | `SettingsShortcutsTab.test.ts`| 119–122 | 断言 overlay 包含 cover/nav/dialog/--tint-thumb | **维度 3 伴随出口重写同步解耦** |

**全仓净代码收敛核算**：
- 测试文件物理删除废弃断言与白名单共约 49 行，新增严密负向门禁代码约 85 行；
- 业务代码净删除达 351 行（维度 2 净删 208 行 + 维度 5 净删 60 行 + 维度 1/3 收敛）；
- 计入新增 `<ScrollArea>` 原子资产（~320 行），全仓存量业务死层彻底收敛，达成全战役净删除 $\ge 200$ 行的铁律。

---

## 三、五大刚性门禁与契约断言深度设计（Core Ratchet Specifications）

### 3.1 门禁一：全仓跨包 CSS 禁 thin 与非 auto scrollbar-color 双属性齐禁门禁

#### 1. 物理机理与危害
根据 Chromium Blink 内核机制，只要在元素样式中声明了 `scrollbar-width: thin` 或非 auto 的 `scrollbar-color`，Blink 会立即将 `UsesCustomScrollbarStyle()` 判定为 `false`，彻底摧毁 WebKit 伪元素渲染树，降级露出 Win32 原生 17px 粗条与尖锐箭头。

#### 2. 门禁规则定义
- **扫描范围**：`walkAllCss()`，同时覆盖 `apps/crish-desktop/src/` 与 `packages/`（含 `packages/block-paper/src/`）；
- **匹配正则**：
  - `thinRe = /scrollbar-width\s*:\s*thin/i`；
  - `colorRe = /scrollbar-color\s*:\s*(?!auto\b)[^;]+/i`；
- **容忍度**：**全仓严格为 0**，零白名单，零例外；
- **豁免说明**：`scrollbar-width: none` 用于纯无痕隐藏滚动（如 Tab 栏），`scrollbar-color: auto` 属于默认重置，两者放行；但任何形式的 `thin` 或着色声明绝对禁止。

#### 3. 契约测试用例设计
```typescript
  it('全仓跨包全量 CSS 严格禁止 scrollbar-width: thin 与非 auto scrollbar-color（双属性齐禁刚性门禁）', () => {
    const cssFiles = walkAllCss();
    const violations: string[] = [];
    const thinRe = /scrollbar-width\s*:\s*thin/i;
    const colorRe = /scrollbar-color\s*:\s*(?!auto\b)[^;]+/i;

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (thinRe.test(line)) {
          violations.push(`${file}:${i + 1} -> [scrollbar-width: thin] ${line.trim()}`);
        }
        if (colorRe.test(line)) {
          violations.push(`${file}:${i + 1} -> [scrollbar-color (非 auto)] ${line.trim()}`);
        }
      }
    }

    expect(
      violations,
      `发现 ${violations.length} 处违规声明 scrollbar-width: thin 或非 auto scrollbar-color！\n` +
      `【Blink 双属性互斥自毁机理】：\n` +
      `根据 Chromium 源码，scrollbar-width != auto 或 scrollbar-color != auto 会将\n` +
      `UsesCustomScrollbarStyle() 置为 false，强行断路 ::-webkit-scrollbar 样式流水线并露出 17px 系统丑陋粗条。\n` +
      `请移除该声明，改用 <ScrollArea> 组件或 Mode 2 工具类（如 .scrollAreaSm）：\n` +
      violations.join('\n')
    ).toEqual([]);
  });
```

---

### 3.2 门禁二：全仓跨包 CSS 零私有 `::-webkit-scrollbar` 负向刚性门禁（去白名单化）

#### 1. 架构原则
- **单一真理源（SSOT）**：全工程有且仅有一个合法出口允许编写 `::-webkit-scrollbar*` 伪元素规则，即 `apps/crish-desktop/src/styles/overlay-scrollbar.css`。
- **跨包全域监控**：包含共享包 `packages/block-paper/`，严禁任何业务组件或子包私写伪元素。

#### 2. 契约测试用例设计
```typescript
  it('全仓除 overlay-scrollbar.css 外，严格禁止任何私有 ::-webkit-scrollbar 规则（零白名单）', () => {
    const cssFiles = walkAllCss();
    const EXPORT_FILE_NAME = 'overlay-scrollbar.css';
    const violations: string[] = [];

    for (const file of cssFiles) {
      const normalizedPath = file.replace(/\\/g, '/');
      if (normalizedPath.endsWith(`/styles/${EXPORT_FILE_NAME}`)) {
        continue; // 全局唯一出口放行
      }

      const content = readFileSync(file, 'utf8');
      const match = content.match(/::-webkit-scrollbar/g);
      if (match && match.length > 0) {
        violations.push(`${file} (包含 ${match.length} 处私有 webkit 伪元素规则)`);
      }
    }

    expect(
      violations,
      `发现 ${violations.length} 个组件私自编写了 ::-webkit-scrollbar！\n` +
      `【SSOT 架构红线】：已彻底删除 SCROLLBAR_WHITELIST 白名单，组件不得就地割据。\n` +
      `请接入 <ScrollArea> 组件或挂载 .scrollArea 工具类。\n` +
      `违规文件清单：\n${violations.join('\n')}`
    ).toEqual([]);
  });
```

---

### 3.3 门禁三：二元灰度绝对死锁与 12.0% 差值增量刚性断言（健壮光学物理提取算法）

#### 1. Reviewer C M01 缺陷复盘与物理模型重塑
历史详案中使用的正则：
```typescript
// ❌ 历史致命 Bug：盲目匹配第一个百分比
const pct = parseFloat(mixMatch![0].match(/(\d+(?:\.\d+)?)%/)?.[1] ?? '0');
```
在真实的 Token 定义下：
```css
--scrollbar-thumb-bg: color-mix(
  in srgb,
  var(--accent-orange, hsl(38 92% 50%)) 8%,
  hsl(35 8% 91.8%)
);
--scrollbar-thumb-active: color-mix(
  in srgb,
  var(--accent-orange, hsl(38 92% 50%)) 16%,
  hsl(35 12% 79.5%) /* 或 79.8% */
);
```
- 该正则碰到的第一个百分比是 `hsl(38 92% 50%)` 中的 **`92%`**！导致 `expect(92).toBeLessThanOrEqual(8.5)` 瞬间爆红崩塌；
- 即使去掉 fallback，抓到的也是混合权重 `8%` 或 `16%`，而激活态要求 $\ge 19.9\%$，依然 100% 报错！
- **物理本质**：物理灰度（暗度 $D$）来源于基底色的明度反转（$D_{\text{idle}} = 100\% - 91.8\% = 8.2\%$ 与 $D_{\text{active}} = 100\% - 79.8\% = 20.2\%$）。`color-mix` 中的权重是色度学微调比例，绝非灰度值本身！

#### 2. 健壮光学物理暗度提取算法（M01 核心修复）
重塑算法：穿透 `color-mix` 语法结构，**精准锁定第二个参数中的基底 HSL 颜色**，提取其第三个数值分量 Lightness 并求补反转为暗度；同时独立提取混合权重，双重校验配方正确性。

```typescript
    /**
     * 光学物理暗度提取算法（M01 修复版）
     * 准确解析纯 hsl(...) 或 color-mix(in srgb, ..., hsl(...)) 中的基底色彩明度
     */
    const parseDarkness = (tokenName: string): number => {
      const tokenMatch = lightBlock.match(new RegExp(`${tokenName}\\s*:\\s*([\\s\\S]*?);`));
      expect(tokenMatch, `Light 模式中未找到 token ${tokenName} 的声明`).toBeTruthy();
      const rawDecl = tokenMatch![1].trim();

      // 分支 A：直接 HSL 声明（如 hsl(35 8% 91.8%)）
      const pureHslMatch = rawDecl.match(/^hsl\(\s*[\d.]+\s*(?:deg)?\s*,?\s*[\d.]+%?\s*,?\s*([\d.]+)%\s*\)$/i);
      if (pureHslMatch) {
        return +(100 - parseFloat(pureHslMatch[1])).toFixed(2);
      }

      // 分支 B：color-mix 声明
      // 精确锁定逗号之后作为基底承载的第二个 HSL 参数，提取其明度值
      if (rawDecl.startsWith('color-mix')) {
        const baseHslMatch = rawDecl.match(/,\s*hsl\(\s*[\d.]+\s*(?:deg)?\s*,?\s*[\d.]+%?\s*,?\s*([\d.]+)%\s*\)\s*\)?$/i);
        expect(
          baseHslMatch,
          `Token ${tokenName} 的 color-mix 声明未匹配到合规的基底 HSL 参数: ${rawDecl}`
        ).toBeTruthy();

        const baseLightness = parseFloat(baseHslMatch![1]);
        return +(100 - baseLightness).toFixed(2);
      }

      throw new Error(`无法识别的色彩 Token 声明格式: ${rawDecl}`);
    };
```

#### 3. 契约测试用例设计
```typescript
  describe('二元灰度绝对死锁与 12.0% 差值增量契约', () => {
    it('tokens.css 中二元灰度 Token 物理暗度死锁（未激活 8.2% vs 激活 20.2%，差值 12.0%）', () => {
      const tokensCss = readFile('src/styles/tokens.css');
      const lightBlock = tokensCss.match(LIGHT_BLOCK_RE)?.[0] ?? '';
      const darkBlock = tokensCss.match(DARK_BLOCK_RE)?.[0] ?? '';

      expect(lightBlock, 'Light 模式必须定义 --scrollbar-thumb-bg').toContain('--scrollbar-thumb-bg:');
      expect(lightBlock, 'Light 模式必须定义 --scrollbar-thumb-active').toContain('--scrollbar-thumb-active:');
      expect(darkBlock, 'Dark 模式必须定义 --scrollbar-thumb-bg').toContain('--scrollbar-thumb-bg:');
      expect(darkBlock, 'Dark 模式必须定义 --scrollbar-thumb-active').toContain('--scrollbar-thumb-active:');

      // 绝对禁止第三种 hover token
      expect(tokensCss, '绝对禁止定义独立的 hover 滚动条色阶 token').not.toMatch(/--scrollbar-thumb-hover\b/);

      const idleDarkness = parseDarkness('--scrollbar-thumb-bg');
      const activeDarkness = parseDarkness('--scrollbar-thumb-active');
      const delta = +(activeDarkness - idleDarkness).toFixed(2);

      // 断言未激活灰度 8.2% ± 0.3% (7.9% ~ 8.5%)
      expect(idleDarkness, `未激活物理灰度 ${idleDarkness}% 偏离 8.2% 基准`).toBeGreaterThanOrEqual(7.9);
      expect(idleDarkness, `未激活物理灰度 ${idleDarkness}% 偏离 8.2% 基准`).toBeLessThanOrEqual(8.5);

      // 断言激活灰度 20.2% ± 0.3% (宽容度覆盖 79.5% 与 79.8% 基底：19.9% ~ 20.5%)
      expect(activeDarkness, `激活物理灰度 ${activeDarkness}% 偏离 20.2% 基准`).toBeGreaterThanOrEqual(19.9);
      expect(activeDarkness, `激活物理灰度 ${activeDarkness}% 偏离 20.2% 基准`).toBeLessThanOrEqual(20.5);

      // 断言差值严格死锁在 12.0% 档位 (区间 [11.5%, 12.5%])
      expect(delta, `二元灰度差值 ${delta}% 未死锁在 12.0% 档位（用户定案铁律）`).toBeGreaterThanOrEqual(11.5);
      expect(delta, `二元灰度差值 ${delta}% 未死锁在 12.0% 档位（用户定案铁律）`).toBeLessThanOrEqual(12.5);

      // 验证混合配方中的暖橙比例 (未激活 8%, 激活 16%)
      const parseWeight = (tokenName: string): number => {
        const raw = lightBlock.match(new RegExp(`${tokenName}\\s*:\\s*([\\s\\S]*?);`))?.[1] ?? '';
        const m = raw.match(/var\([^)]+\)\s*(\d+(?:\.\d+)?)%\s*,/);
        return m ? parseFloat(m[1]) : 0;
      };
      expect(parseWeight('--scrollbar-thumb-bg'), '未激活态橙色混合权重应为 8%').toBe(8);
      expect(parseWeight('--scrollbar-thumb-active'), '激活态橙色混合权重应为 16%').toBe(16);
    });

    it('overlay-scrollbar.css 中 hover 与 active 选择器同源同色，严禁第三态', () => {
      const css = readFile('src/styles/overlay-scrollbar.css');

      // 默认态走 --scrollbar-thumb-bg
      expect(css).toMatch(/::-webkit-scrollbar-thumb\s*\{[\s\S]*?var\(--scrollbar-thumb-bg\)/);

      // hover 与 active 必须合流且消费同一个 --scrollbar-thumb-active
      const activeRuleMatch = css.match(/::-webkit-scrollbar-thumb:hover[\s\S]*?\{[\s\S]*?\}/);
      expect(activeRuleMatch, '必须包含 hover/active 伪类规则').toBeTruthy();
      const ruleBody = activeRuleMatch![0];

      expect(ruleBody, 'hover 与 active 必须在同一选择器中声明').toContain(':active');
      expect(ruleBody, '激活态必须消费 --scrollbar-thumb-active').toContain('var(--scrollbar-thumb-active)');
      expect(ruleBody, '严禁在激活态引入独立的 hover 变量').not.toContain('--scrollbar-thumb-hover');
      expect(ruleBody, '严禁引用脏色 --tint-overlay').not.toContain('--tint-overlay');
    });
  });
```

---

### 3.4 门禁四：滚动条维度零裸像素（Zero Naked Pixels）静态正则扫描门禁

#### 1. 架构原则
全仓 CSS（除 `tokens.css` 自身定义行）和组件代码中，严禁出现滚动条相关的裸写像素尺寸。必须统一消费四级宽度 Token：
- `--scrollbar-width-xs: 4px`；
- `--scrollbar-width-sm: 5px`；
- `--scrollbar-width-md: 7px`；
- `--scrollbar-width-lg: 9px`。

#### 2. 契约测试用例设计
```typescript
  it('滚动条相关属性零硬编码裸像素（必须消费四级 Token 体系）', () => {
    const cssFiles = walkAllCss();
    const violations: string[] = [];
    const bareScrollbarPxRe = /--(?:scrollbar-thumb-width|scrollbar-width|scrollbar-size)\s*:\s*\d+px/i;

    for (const file of cssFiles) {
      const base = file.split(/[\\/]/).pop() ?? '';
      if (base === 'tokens.css') continue; // 定义源放行

      const content = readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (bareScrollbarPxRe.test(lines[i])) {
          violations.push(`${file}:${i + 1} -> ${lines[i].trim()}`);
        }
      }
    }

    expect(
      violations,
      `发现 ${violations.length} 处滚动条裸像素硬编码！\n` +
      `必须使用四级 Token 体系（--scrollbar-width-xs/sm/md/lg）：\n` +
      violations.join('\n')
    ).toEqual([]);
  });
```

---

### 3.5 门禁五：Mode 2 实用类矩阵与端点安全护栏规范守卫

#### 1. 架构原则
- **Mode 2 实用类矩阵完整性**：全局出口 `overlay-scrollbar.css` 必须完整导出 7 个零 DOM 实用类；
- **端点护栏绝对恢复**：严禁在 `overlay-scrollbar.css` 中写 `::-webkit-scrollbar-button { display: none }`，必须声明有效高度以激活 Blink 的 `TrackRect` 物理护栏。

#### 2. 契约测试用例设计
```typescript
  describe('Mode 2 实用类矩阵与端点安全护栏守卫', () => {
    it('overlay-scrollbar.css 必须完整导出 Mode 2 零 DOM 实用类矩阵', () => {
      const css = readFile('src/styles/overlay-scrollbar.css');
      const requiredClasses = [
        '.scrollArea',
        '.scrollAreaXs',
        '.scrollAreaSm',
        '.scrollAreaMd',
        '.scrollAreaLg',
        '.hideScrollbar',
        '.scrollAreaWithButtons',
      ];
      for (const cls of requiredClasses) {
        expect(css, `overlay-scrollbar.css 必须导出工具类 ${cls}`).toContain(cls);
      }
    });

    it('overlay-scrollbar.css 恢复按钮端点护栏（严禁全局 display: none 截断）', () => {
      const css = readFile('src/styles/overlay-scrollbar.css');
      expect(css).toContain('::-webkit-scrollbar-button');
      const buttonBlock = css.match(/::-webkit-scrollbar-button[\s\S]*?\{[\s\S]*?\}/)?.[0] ?? '';
      expect(buttonBlock, '按钮规则块不得直接 display: none 杀死护栏').not.toMatch(/display:\s*none/);
      expect(buttonBlock, '按钮必须具备高度以维持 TrackRect 护栏').toMatch(/height:\s*(?:var\(--scrollbar-button-size|8px)/);
    });

    it('index.css 必须正确引入 overlay-scrollbar.css 且禁名 shell-scrollbar 不得复活', () => {
      const indexCss = readFile('src/index.css');
      expect(indexCss).toContain("@import './styles/overlay-scrollbar.css'");
      expect(indexCss).not.toContain('shell-scrollbar.css');

      const bannedFiles = walkAllCss().filter((p) => p.replace(/\\/g, '/').endsWith('/shell-scrollbar.css'));
      expect(bannedFiles, '历史禁名 shell-scrollbar.css 严禁复活').toEqual([]);
    });
  });
```

---

## 四、测试套件重塑与解耦源码详案（Ready-to-Implement Code Spec）

### 4.1 `style-contract.test.ts` 重塑测试套件完整 TypeScript 代码实现

以下为 `apps/crish-desktop/src/styles/style-contract.test.ts` 中针对滚动条契约与负向门禁测试套件的**完整就绪替换源码**：

```typescript
// ============================================================================
// 统一滚动条体系与 ScrollArea 战役 · 刚性契约与负向门禁测试套件
// 权威对应：docs/unified-scrollbar-system/detailed-plans/06-plan-gate-ratchet.md
// 修订说明：涵盖 M01 健壮暗度提取算法、跨包 walkAllCss 扫描、双属性齐禁
// ============================================================================

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 辅助：读取 desktop 内相对源码文件 */
function readFile(relPath: string): string {
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

/**
 * 跨包全量生产 CSS 遍历器（覆盖 apps/crish-desktop/src/ 与 packages/block-paper/src/ 等）
 * 彻底消除 monorepo 包间扫描盲区，确保共享包的 thin 地雷、scrollbar-color 与私有伪元素被 100% 负向阻断。
 */
function walkAllCss(): string[] {
  const anchorDesktop = fileURLToPath(new URL('../../tokens.css', import.meta.url));
  const desktopSrc = anchorDesktop.replace(/[\\/]tokens\.css$/, '');

  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const packagesRoot = join(repoRoot, 'packages');

  const rootsToScan = [desktopSrc, packagesRoot];
  const out: string[] = [];

  const walk = (dir: string): void => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', 'coverage', '.turbo'].includes(entry.name)) continue;
          walk(p);
        } else if (p.endsWith('.css')) {
          out.push(p);
        }
      }
    } catch {
      // 路径不存在时容错
    }
  };

  for (const root of rootsToScan) {
    walk(root);
  }
  return out;
}

const LIGHT_BLOCK_RE = /:root\s*\{[\s\S]*?\}/;
const DARK_BLOCK_RE = /html\[data-theme=['"]dark['"]\]\s*\{[\s\S]*?\}/;

describe('统一滚动条体系刚性契约与负向门禁（gate-ratchet）', () => {
  const SCROLLBAR_EXPORT = 'overlay-scrollbar.css';
  const SCROLLBAR_BANNED = 'shell-scrollbar.css';
  const SCROLLBAR_EXPORT_MIN_BLOCKS = 5;

  // --------------------------------------------------------------------------
  // 1. 出口文件与禁名防复活断言
  // --------------------------------------------------------------------------
  it(`禁名 ${SCROLLBAR_BANNED} 不得复活`, () => {
    const hits = walkAllCss().filter((p) =>
      p.replace(/\\/g, '/').endsWith(`/${SCROLLBAR_BANNED}`)
    );
    expect(hits, `历史禁名复活：${hits.join(', ')}`).toEqual([]);
  });

  it(`index.css 引入出口 ${SCROLLBAR_EXPORT} 且不引禁名`, () => {
    const indexCss = readFile('src/index.css');
    expect(indexCss).toContain(`@import './styles/${SCROLLBAR_EXPORT}'`);
    expect(indexCss).not.toContain(SCROLLBAR_BANNED);
  });

  // --------------------------------------------------------------------------
  // 2. 门禁一：全仓跨包 CSS 禁 thin 与非 auto scrollbar-color（双属性齐禁）
  // --------------------------------------------------------------------------
  it('全仓跨包全量 CSS 严格禁止 scrollbar-width: thin 与非 auto scrollbar-color（双属性齐禁刚性门禁）', () => {
    const cssFiles = walkAllCss();
    const violations: string[] = [];
    const thinRe = /scrollbar-width\s*:\s*thin/i;
    const colorRe = /scrollbar-color\s*:\s*(?!auto\b)[^;]+/i;

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (thinRe.test(line)) {
          violations.push(`${file}:${i + 1} -> [scrollbar-width: thin] ${line.trim()}`);
        }
        if (colorRe.test(line)) {
          violations.push(`${file}:${i + 1} -> [scrollbar-color (非 auto)] ${line.trim()}`);
        }
      }
    }

    expect(
      violations,
      `发现 ${violations.length} 处违规声明 scrollbar-width: thin 或非 auto scrollbar-color！\n` +
      `【Blink 双属性互斥自毁机理】：\n` +
      `根据 Chromium 源码，scrollbar-width != auto 或 scrollbar-color != auto 会将\n` +
      `UsesCustomScrollbarStyle() 置为 false，强行断路 ::-webkit-scrollbar 样式流水线并露出 17px 系统丑陋粗条。\n` +
      `请移除该声明，改用 <ScrollArea> 组件或 Mode 2 工具类（如 .scrollAreaSm）：\n` +
      violations.join('\n')
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 3. 门禁二：全仓跨包 CSS 禁私有 ::-webkit-scrollbar（彻底去白名单化）
  // --------------------------------------------------------------------------
  it(`全仓除 ${SCROLLBAR_EXPORT} 外，严格禁止任何私有 ::-webkit-scrollbar 规则（零白名单）`, () => {
    const cssFiles = walkAllCss();
    const violations: string[] = [];

    for (const file of cssFiles) {
      const normalizedPath = file.replace(/\\/g, '/');
      if (normalizedPath.endsWith(`/styles/${SCROLLBAR_EXPORT}`)) {
        continue; // 全局唯一出口放行
      }

      const content = readFileSync(file, 'utf8');
      const match = content.match(/::-webkit-scrollbar/g);
      if (match && match.length > 0) {
        violations.push(`${file} (包含 ${match.length} 处私有 webkit 伪元素规则)`);
      }
    }

    expect(
      violations,
      `发现 ${violations.length} 个组件私自编写了 ::-webkit-scrollbar！\n` +
      `【SSOT 架构红线】：已彻底删除 SCROLLBAR_WHITELIST 白名单，组件不得就地割据。\n` +
      `请接入 <ScrollArea> 组件或挂载 .scrollArea 工具类。\n` +
      `违规文件清单：\n${violations.join('\n')}`
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 4. 门禁三：二元灰度绝对死锁与 12.0% 差值增量刚性断言（健壮光学提取）
  // --------------------------------------------------------------------------
  describe('二元灰度绝对死锁与 12.0% 差值增量契约', () => {
    it('tokens.css 中二元灰度 Token 物理暗度死锁（未激活 8.2% vs 激活 20.2%，差值 12.0%）', () => {
      const tokensCss = readFile('src/styles/tokens.css');
      const lightBlock = tokensCss.match(LIGHT_BLOCK_RE)?.[0] ?? '';
      const darkBlock = tokensCss.match(DARK_BLOCK_RE)?.[0] ?? '';

      expect(lightBlock, 'Light 模式必须定义 --scrollbar-thumb-bg').toContain('--scrollbar-thumb-bg:');
      expect(lightBlock, 'Light 模式必须定义 --scrollbar-thumb-active').toContain('--scrollbar-thumb-active:');
      expect(darkBlock, 'Dark 模式必须定义 --scrollbar-thumb-bg').toContain('--scrollbar-thumb-bg:');
      expect(darkBlock, 'Dark 模式必须定义 --scrollbar-thumb-active').toContain('--scrollbar-thumb-active:');

      // 绝对禁止第三种 hover token
      expect(tokensCss, '绝对禁止定义独立的 hover 滚动条色阶 token').not.toMatch(/--scrollbar-thumb-hover\b/);

      /**
       * 光学物理暗度提取算法（Reviewer C M01 修复版）
       * 穿透 color-mix 语法结构，精准锁定作为基底承载的第二个 HSL 颜色，
       * 提取其 Lightness 并反转为物理暗度 D = 100 - L。
       */
      const parseDarkness = (tokenName: string): number => {
        const tokenMatch = lightBlock.match(new RegExp(`${tokenName}\\s*:\\s*([\\s\\S]*?);`));
        expect(tokenMatch, `Light 模式中未找到 token ${tokenName} 的声明`).toBeTruthy();
        const rawDecl = tokenMatch![1].trim();

        // 分支 A：直接 HSL 声明（如 hsl(35 8% 91.8%)）
        const pureHslMatch = rawDecl.match(/^hsl\(\s*[\d.]+\s*(?:deg)?\s*,?\s*[\d.]+%?\s*,?\s*([\d.]+)%\s*\)$/i);
        if (pureHslMatch) {
          return +(100 - parseFloat(pureHslMatch[1])).toFixed(2);
        }

        // 分支 B：color-mix 声明，精确匹配第二个基底 HSL 参数
        if (rawDecl.startsWith('color-mix')) {
          const baseHslMatch = rawDecl.match(/,\s*hsl\(\s*[\d.]+\s*(?:deg)?\s*,?\s*[\d.]+%?\s*,?\s*([\d.]+)%\s*\)\s*\)?$/i);
          expect(
            baseHslMatch,
            `Token ${tokenName} 的 color-mix 声明未匹配到合规的基底 HSL 参数: ${rawDecl}`
          ).toBeTruthy();

          const baseLightness = parseFloat(baseHslMatch![1]);
          return +(100 - baseLightness).toFixed(2);
        }

        throw new Error(`无法识别的色彩 Token 声明格式: ${rawDecl}`);
      };

      const idleDarkness = parseDarkness('--scrollbar-thumb-bg');
      const activeDarkness = parseDarkness('--scrollbar-thumb-active');
      const delta = +(activeDarkness - idleDarkness).toFixed(2);

      // 断言未激活灰度 8.2% ± 0.3%
      expect(idleDarkness, `未激活物理灰度 ${idleDarkness}% 偏离 8.2% 基准`).toBeGreaterThanOrEqual(7.9);
      expect(idleDarkness, `未激活物理灰度 ${idleDarkness}% 偏离 8.2% 基准`).toBeLessThanOrEqual(8.5);

      // 断言激活灰度 20.2% ± 0.3%
      expect(activeDarkness, `激活物理灰度 ${activeDarkness}% 偏离 20.2% 基准`).toBeGreaterThanOrEqual(19.9);
      expect(activeDarkness, `激活物理灰度 ${activeDarkness}% 偏离 20.2% 基准`).toBeLessThanOrEqual(20.5);

      // 断言差值严格死锁在 12.0% 档位 (区间 [11.5%, 12.5%])
      expect(delta, `二元灰度差值 ${delta}% 未死锁在 12.0% 档位（用户定案铁律）`).toBeGreaterThanOrEqual(11.5);
      expect(delta, `二元灰度差值 ${delta}% 未死锁在 12.0% 档位（用户定案铁律）`).toBeLessThanOrEqual(12.5);

      // 校验暖橙混入比例
      const parseWeight = (tokenName: string): number => {
        const raw = lightBlock.match(new RegExp(`${tokenName}\\s*:\\s*([\\s\\S]*?);`))?.[1] ?? '';
        const m = raw.match(/var\([^)]+\)\s*(\d+(?:\.\d+)?)%\s*,/);
        return m ? parseFloat(m[1]) : 0;
      };
      expect(parseWeight('--scrollbar-thumb-bg'), '未激活态橙色混入比例应为 8%').toBe(8);
      expect(parseWeight('--scrollbar-thumb-active'), '激活态橙色混入比例应为 16%').toBe(16);
    });

    it('overlay-scrollbar.css 中 hover 与 active 选择器同源同色，严禁第三态', () => {
      const css = readFile(`src/styles/${SCROLLBAR_EXPORT}`);

      expect(css).toMatch(/::-webkit-scrollbar-thumb\s*\{[\s\S]*?var\(--scrollbar-thumb-bg\)/);

      const activeRuleMatch = css.match(/::-webkit-scrollbar-thumb:hover[\s\S]*?\{[\s\S]*?\}/);
      expect(activeRuleMatch, '必须包含 hover/active 伪类规则').toBeTruthy();
      const ruleBody = activeRuleMatch![0];

      expect(ruleBody, 'hover 与 active 必须在同一选择器中声明').toContain(':active');
      expect(ruleBody, '激活态必须消费 --scrollbar-thumb-active').toContain('var(--scrollbar-thumb-active)');
      expect(ruleBody, '严禁在激活态引入独立的 hover 变量').not.toContain('--scrollbar-thumb-hover');
      expect(ruleBody, '严禁引用脏色 --tint-overlay').not.toContain('--tint-overlay');
    });
  });

  // --------------------------------------------------------------------------
  // 5. 门禁四：零硬编码裸像素静态扫描
  // --------------------------------------------------------------------------
  it('滚动条相关属性零硬编码裸像素（必须消费四级 Token 体系）', () => {
    const cssFiles = walkAllCss();
    const violations: string[] = [];
    const bareScrollbarPxRe = /--(?:scrollbar-thumb-width|scrollbar-width|scrollbar-size)\s*:\s*\d+px/i;

    for (const file of cssFiles) {
      const base = file.split(/[\\/]/).pop() ?? '';
      if (base === 'tokens.css') continue;

      const content = readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (bareScrollbarPxRe.test(lines[i])) {
          violations.push(`${file}:${i + 1} -> ${lines[i].trim()}`);
        }
      }
    }

    expect(
      violations,
      `发现 ${violations.length} 处滚动条裸像素硬编码！\n` +
      `必须使用四级 Token 体系（--scrollbar-width-xs/sm/md/lg）：\n` +
      violations.join('\n')
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 6. 门禁五：Mode 2 实用类矩阵与端点安全护栏契约
  // --------------------------------------------------------------------------
  it(`${SCROLLBAR_EXPORT} 完整导出 Mode 2 实用类矩阵且保持端点护栏`, () => {
    const css = readFile(`src/styles/${SCROLLBAR_EXPORT}`);

    const webkit = css.match(/::-webkit-scrollbar/g) ?? [];
    expect(
      webkit.length,
      `${SCROLLBAR_EXPORT} webkit 块数 ${webkit.length} < ${SCROLLBAR_EXPORT_MIN_BLOCKS}`
    ).toBeGreaterThanOrEqual(SCROLLBAR_EXPORT_MIN_BLOCKS);

    const requiredClasses = [
      '.scrollArea',
      '.scrollAreaXs',
      '.scrollAreaSm',
      '.scrollAreaMd',
      '.scrollAreaLg',
      '.hideScrollbar',
      '.scrollAreaWithButtons',
    ];
    for (const cls of requiredClasses) {
      expect(css, `必须导出工具类 ${cls}`).toContain(cls);
    }

    expect(css).toContain('::-webkit-scrollbar-button');
    const buttonBlock = css.match(/::-webkit-scrollbar-button[\s\S]*?\{[\s\S]*?\}/)?.[0] ?? '';
    expect(buttonBlock, '按钮规则块不得直接 display: none 杀死护栏').not.toMatch(/display:\s*none/);
    expect(buttonBlock, '按钮必须具备高度以维持 TrackRect 护栏').toMatch(/height:\s*(?:var\(--scrollbar-button-size|8px)/);

    const starBlock = css.match(/(?:^|\n)\*\s*\{[^}]*\}/)?.[0] ?? '';
    expect(starBlock).not.toContain('scrollbar-width');
  });
});
```

---

### 4.2 `SettingsShortcutsTab.test.ts` 外部解耦完整落地代码实现

在 `apps/crish-desktop/src/components/settings/SettingsShortcutsTab.test.ts` 中，对第 110-129 行进行**精准解耦替换**：

```diff
--- a/apps/crish-desktop/src/components/settings/SettingsShortcutsTab.test.ts
+++ b/apps/crish-desktop/src/components/settings/SettingsShortcutsTab.test.ts
@@ -116,10 +116,10 @@ describe('SettingsShortcutsTab', () => {
     expect(indexCss).not.toContain('shell-scrollbar.css');
     expect(overlay).toContain('::-webkit-scrollbar');
     expect(overlay).toContain('::-webkit-scrollbar-button');
-    expect(overlay).toContain('coverContent');
-    expect(overlay).toContain('navScroll');
-    expect(overlay).toContain('dialogBody');
-    expect(overlay).toContain('--tint-scrollbar-thumb');
+    // 解耦：彻底移除已废弃的业务子串与旧 Token 断言，转为断言统一二元色彩与 Mode 2 契约
+    expect(overlay).toContain('var(--scrollbar-thumb-bg)');
+    expect(overlay).toContain('.scrollArea');
     expect(overlay).not.toMatch(/(?:^|\n)\*\s*\{[^}]*scrollbar-width/);
     expect(panel).not.toMatch(/scrollbar-width\s*:/);
     expect(panel).toContain('.coverContent');
```

**解耦收益**：彻底断开设置面板测试对全局样式私有类名的逆向绑架，使其无缝适配维度 3 导出的纯净 `overlay-scrollbar.css`。

---

### 4.3 错误诊断信息设计（DX Friendly Error Reporting）

当后续开发者不慎违规时，测试断言将输出直击病根的诊断信息：

```text
FAIL apps/crish-desktop/src/styles/style-contract.test.ts > 统一滚动条体系刚性契约与负向门禁（gate-ratchet） > 全仓跨包全量 CSS 严格禁止 scrollbar-width: thin 与非 auto scrollbar-color（双属性齐禁刚性门禁）
AssertionError: 发现 1 处违规声明 scrollbar-width: thin 或非 auto scrollbar-color！
【Blink 双属性互斥自毁机理】：
根据 Chromium 源码，scrollbar-width != auto 或 scrollbar-color != auto 会将
UsesCustomScrollbarStyle() 置为 false，强行断路 ::-webkit-scrollbar 样式流水线并露出 17px 系统丑陋粗条。
请移除该声明，改用 <ScrollArea> 组件或 Mode 2 工具类（如 .scrollAreaSm）：
packages/block-paper/src/list/paperList.css:58 -> [scrollbar-width: thin] scrollbar-width: thin;
```

---

## 五、先删后改依赖拓扑与「解绑前置」执行时序（Execution Sequencing & Staging）

### 5.1 战役 6 大维度强逻辑依赖拓扑

战役执行遵循以下强因果链条：

$$\text{D1 (Tokens)} \longrightarrow \text{D2 (Purge + 解绑前置)} \longrightarrow \text{D3 (Engine + 外部解耦)} \parallel \text{D4 (ScrollArea)} \longrightarrow \text{D5 (Migrate)} \longrightarrow \text{D6 (Gate Lock 闭合死锁)}$$

---

### 5.2 破除 CI 死锁的「解绑前置（Uncouple First）」执行节拍

#### 1. 历史死锁成因透视（Reviewer A 审查结论）
- 维度 2 的核心任务是物理清除 `Menu.module.css`、`SmartPanel.module.css`、`SmartExpandablePanel.module.css` 的私有 WebKit 块；
- 但现存 `style-contract.test.ts:284-295` 却反向断言这 3 个文件必须包含 `--tint-scrollbar-thumb` 与 `::-webkit-scrollbar-button`；
- 若严格串行，维度 2 删除了私有代码后运行 `npm test` 门禁必崩，导致无法合规提交，整场战役在第 2 步彻底卡死！

#### 2. 「解绑前置」三阶执行调度矩阵
主控在调度推进时，必须严格执行以下原子解绑节拍：

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        统一滚动条战役「解绑前置」执行波次矩阵                            │
├────────────┬─────────────────────┬─────────────────────────────────────────────────────┤
│ 执行阶段   │ 目标执行维度        │ 原子操作与伴随解绑任务书                            │
├────────────┼─────────────────────┼─────────────────────────────────────────────────────┤
│ 阶段一     │ 维度 1: token-system│ 在 tokens.css 中注入二元色彩与四级宽度 Token。      │
│            │                     │ 【验签】：npm test 保持全绿通过。                   │
├────────────┼─────────────────────┼─────────────────────────────────────────────────────┤
│ 阶段二     │ 维度 2: purge-debts │ 【解绑前置原子伴随操作】：                          │
│            │ (死层清剿)          │ 1. 同步物理删除 style-contract.test.ts:284-295 反向 │
│            │                     │    死断言（解除 Menu 等私有 button 保护伞）；       │
│            │                     │ 2. 保持 SCROLLBAR_WHITELIST 暂不删除（维持白名单）；│
│            │                     │ 3. 物理清除全仓 18 处 thin 与 11 处私有 WebKit 块。 │
│            │                     │ 【验签】：npm test 100% 绿灯，主控提交 D2 改动！   │
├────────────┼─────────────────────┼─────────────────────────────────────────────────────┤
│ 阶段三     │ 维度 3: engine-core │ 【外部解耦伴随操作】：                              │
│            │ (全局出口重塑)      │ 1. 重构 overlay-scrollbar.css，导出 Mode 2 实用类； │
│            │                     │ 2. 同步修改 SettingsShortcutsTab.test.ts:119-122， │
│            │                     │    解耦废弃业务类名与旧 Token；                     │
│            │                     │ 3. 同步删除 style-contract 261-267 行模糊匹配断言。 │
│            │                     │ 【验签】：npm test 100% 绿灯，主控提交 D3 改动！   │
├────────────┼─────────────────────┼─────────────────────────────────────────────────────┤
│ 阶段四     │ 维度 4: scroll-area │ 封装并导出 <ScrollArea> 原子组件与微调脉冲引擎。    │
│            │ 维度 5: migrate     │ 全量业务视口大换装（Tier A 接组件 / Tier B 挂类名）。│
│            │                     │ 【验签】：组件单元测试与页面渲染全绿。              │
├────────────┼─────────────────────┼─────────────────────────────────────────────────────┤
│ 阶段五     │ 维度 6: gate-ratchet│ 【终态落锁闭合死锁】：                              │
│            │ (全量落锁闭合)      │ 1. 物理删除 SCROLLBAR_WHITELIST 白名单（304-317行）；│
│            │                     │ 2. 完整实装 walkAllCss、双属性齐禁、健壮暗度提取等   │
│            │                     │    5 大负向刚性门禁；                               │
│            │                     │ 【验签】：全仓门禁与快层 CI 永久单向单调递紧！      │
└────────────┴─────────────────────┴─────────────────────────────────────────────────────┘
```

---

### 5.3 CI 快层（`ci.yml`）与本地门禁（`npm run check:desktop`）集成点

`style-contract.test.ts` 已深度接入桌面端自动化流水线：
1. **本地开发门禁**：
   - `npm run check:desktop`（类型检查 + 行数扫描 + 契约测试）；
   - `npx vitest run src/styles/style-contract.test.ts` 瞬时执行；
2. **CI 门禁流水线（`ci.yml`）**：
   - 作为 `test-unit` Job 的前置阻断关卡，违规 PR 将在 30 秒内被拦截。

---

## 六、立体验证断言与魔鬼用例反脆弱性测试（Multi-Dimensional Verification）

### 6.1 单元测试断言矩阵（V1-V14）

| 序号 | 校验维度 | 校验对象 | 断言表达式与期望值 | 违规阻断阈值 |
| :--- | :--- | :--- | :--- | :--- |
| **V1** | 禁名复活 | `walkAllCss()` | `hits.length === 0` | $> 0$ 立即阻断 |
| **V2** | 禁 thin | 全仓跨包生产 CSS | 命中数严格为 0 | $> 0$ 立即阻断 |
| **V3** | 禁 non-auto color | 全仓跨包生产 CSS | 命中数严格为 0 | $> 0$ 立即阻断 |
| **V4** | 禁私有 WebKit | 全仓跨包生产 CSS (除出口) | 命中数严格为 0 | $> 0$ 立即阻断 |
| **V5** | 白名单清除 | `style-contract.test.ts` | 源码不含 `SCROLLBAR_WHITELIST` | 存在即阻断 |
| **V6** | 未激活灰度 | `tokens.css:--scrollbar-thumb-bg` | $D \in [7.9\%,\ 8.5\%]$ | 超出即阻断 |
| **V7** | 激活灰度 | `tokens.css:--scrollbar-thumb-active` | $D \in [19.9\%,\ 20.5\%]$ | 超出即阻断 |
| **V8** | 二元差值死锁 | Active - Idle 灰度差 | $\Delta D \in [11.5\%,\ 12.5\%]$ | 超出即阻断 |
| **V9** | 混入比例锁定 | color-mix 暖橙权重 | Idle 8%, Active 16% | 不符即阻断 |
| **V10**| 严禁第三态 | 全仓 CSS 变量与规则 | 不含 `--scrollbar-thumb-hover` | 命中即阻断 |
| **V11**| 同源同色 | `overlay-scrollbar.css` | `:hover` 与 `:active` 在同规则内消费同 Token | 不符即阻断 |
| **V12**| 零裸像素 | 全仓跨包生产 CSS | 滚动条属性不含裸数字 px | $> 0$ 立即阻断 |
| **V13**| Mode 2 矩阵 | `overlay-scrollbar.css` | 7 个工具类 100% 存在 | 缺失即阻断 |
| **V14**| 外部测试解耦 | `SettingsShortcutsTab.test.ts` | 源码不含废弃业务类名与旧 Token | 命中即阻断 |

---

### 6.2 负向试毒实验（Poison Injection Tests）设计与预期拦截

为验证门禁系统的**“反脆弱性（Anti-fragility）”**，在门禁上线后执行以下 6 项试毒实验：

#### 实验 1：跨包共享库注入 `scrollbar-width: thin`
- **操作**：在 `packages/block-paper/src/list/paperList.css` 注入 `scrollbar-width: thin;`；
- **预期反应**：`style-contract.test.ts` 门禁一爆红，精确指出 `packages/block-paper/...` 违规行号，证明跨包扫描生效。

#### 实验 2：注入非 auto `scrollbar-color`
- **操作**：在 `apps/crish-desktop/src/components/sidebar/Sidebar.module.css` 注入 `scrollbar-color: red transparent;`；
- **预期反应**：`style-contract.test.ts` 门禁一爆红，提示 Blink 双属性互斥自毁机理警告。

#### 实验 3：注入私有 `::-webkit-scrollbar`
- **操作**：在 `apps/crish-desktop/src/components/ui/Button/Button.module.css` 注入 `.btn::-webkit-scrollbar { width: 4px; }`；
- **预期反应**：`style-contract.test.ts` 门禁二爆红，报错提示组件严禁就地割据私有滚动条。

#### 实验 4：注入第三态 Hover 灰阶
- **操作**：在 `tokens.css` 注入 `--scrollbar-thumb-hover: hsl(35 10% 85%);`，并在 `overlay-scrollbar.css` 中将 hover 与 active 拆开；
- **预期反应**：`style-contract.test.ts` 门禁三爆红，提示“绝对禁止定义独立的 hover 滚动条色阶 token”。

#### 实验 5：篡改二元灰度差值
- **操作**：将 `--scrollbar-thumb-active` 明度改为 `70%`（物理暗度 30%，差值 21.8%）；
- **预期反应**：`style-contract.test.ts` 门禁三爆红，提示“二元灰度差值 21.8% 未死锁在 12.0%”。

#### 实验 6：注入裸像素宽度
- **操作**：在某 module.css 注入 `--scrollbar-thumb-width: 6px;`；
- **预期反应**：`style-contract.test.ts` 门禁四爆红，提示“发现滚动条裸像素硬编码，必须消费四级 Token 体系”。

---

### 6.3 运行性能与扫描开销约束（$\le 80\text{ms}$ 压测标准）

1. **多根遍历复用**：`walkAllCss()` 仅在测试套件启动时执行一次，内存缓存文件路径列表（全工程约 130 个 CSS 文件）；
2. **单遍正则匹配**：采用经过预编译的高性能正则，避免 AST 解析的沉重开销；
3. **压测达标**：在标准开发机上，整套 5 大门禁运行耗时稳定在 **$\le 80\text{ms}$**，在快速测试层（`npm test`）中近乎零感知。

---

## 七、实施风险评估与防御性兜底措施

| 潜在风险点 | 严重等级 | 触发机理 | 防御性规避与兜底措施 |
| :--- | :---: | :--- | :--- |
| **步骤倒置导致 CI 阻断死锁** | **高** | 若未在维度 2 伴随删除反向断言，直接清代码会导致 CI 阻断无法提交。 | **严格执行「解绑前置」**：主控在调度 D2 时，将 `style-contract.test.ts:284-295` 的删除作为同批次原子操作提交。 |
| **外部测试遗漏导致 D3 报错** | **高** | 重构全局出口后，`SettingsShortcutsTab.test.ts` 因断言业务类名而断裂。 | **严格执行伴随解耦**：在执行 D3 时，同步修改 `SettingsShortcutsTab.test.ts:119-122`，转为断言统一契约。 |
| **Windows CRLF 破坏多行正则** | **中** | Windows 检出包含 `\r\n`，跨行匹配可能吞掉后续规则。 | 逐行扫描统一采用 `.split(/\r?\n/)`，全文正则采用非贪婪限制符并容错换行。 |
| **Monorepo 包间扫描盲区** | **中** | 若仅扫描 desktop 目录，`packages/block-paper` 重新引入 thin 将无法感知。 | 部署 `walkAllCss()`，将扫描根路径扩展至全工作区 `packages/`，消除盲区。 |

---

## 八、主控签发确认与下一步行动

本修订版详案（`06-plan-gate-ratchet.md v2.0-revised`）已完整贯彻：
1. **重塑 parseDarkness 正则算法（M01 纠偏）**：根除因误抓 color-mix fallback 中的 92% 导致断言必爆的致命 Bug，编写了健壮的光学物理暗度提取与差值断言算法；
2. **跨包扫描全量覆盖**：扩展为 `walkAllCss()`，将 `packages/block-paper/` 纳入监控，确保共享包的 thin 与私有伪元素 100% 负向阻断；
3. **补充禁止非 auto scrollbar-color 负向门禁**：确立“双属性齐禁（Dual Property Lockout）”，封死 Blink 内核自毁退避路径；
4. **纳入 SettingsShortcutsTab.test.ts:119-122 外部解耦方案**：彻底拔除外部测试对全局出口的逆向绑架；
5. **明确「解绑前置」执行时序**：确立维度 2 伴随原子解绑、维度 3 伴随解耦、维度 6 终态闭合死锁的三阶调度节拍，彻底打破 CI 流水线死锁。

本详案已编制完成并物理落盘于：
`c:\Software\conex\docs\unified-scrollbar-system\detailed-plans\06-plan-gate-ratchet.md`

下一步请总调度主控 Antigravity Main Agent 依据本方案下达代码执行波次！
