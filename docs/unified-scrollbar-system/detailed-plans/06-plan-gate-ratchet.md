# 06 · 统一滚动条测试契约重塑与负向刚性门禁实现详案（gate-ratchet）

> **规范编号**：`SCROLLBAR-PLAN-GATE-RATCHET-06`  
> **战役工作区**：`docs/unified-scrollbar-system/`（统一滚动条体系与 ScrollArea 高频组件战役）  
> **归档落盘路径**：`docs/unified-scrollbar-system/detailed-plans/06-plan-gate-ratchet.md`  
> **角色定位**：战役方案编制专家（Plan Architect 6：测试契约重塑与负向刚性门禁）  
> **总调度主控**：Antigravity Main Agent  
> **编制基准时间**：2026-09-02  
> **遵循基准**：
> - `docs/unified-scrollbar-system/00-master-plan.md`（统一滚动条体系总纲 §3.6 维度 6）
> - `AGENTS.md`（§1 逻辑规划与反退避、§7 严禁补丁与绕过、§7.1 立体验证纪律、§11 CI 治理）
> - `ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计红线）
> - 用户最高定案铁律：二元灰度绝对死锁（8.2% vs 20.2%，差值死锁 12.0%，严禁第三态）、彻底去白名单化（物理删除 `SCROLLBAR_WHITELIST`）、零裸像素 Token 体系、先删后改收敛优先。

---

## 目录

- [一、架构定位与设计哲学（Architecture & Paradigm Shift）](#一架构定位与设计哲学architecture--paradigm-shift)
  - [1.1 历史门禁沦为死层保护伞的深度复盘](#11-历史门禁沦为死层保护伞的深度复盘)
  - [1.2 范式跃迁：从“白名单妥协豁免”到“零容忍负向刚性门禁”](#12-范式跃迁从白名单妥协豁免到零容忍负向刚性门禁)
  - [1.3 门禁棘轮（Ratchet）不可逆单调递紧原则](#13-门禁棘轮ratchet不可逆单调递紧原则)
- [二、本方案要删掉什么 / 收敛什么（删除面 Deletions Surface）](#二本方案要删掉什么--收敛什么删除面-deletions-surface)
  - [2.1 彻底删除 `SCROLLBAR_WHITELIST` 白名单集合（Lines 304-317）](#21-彻底删除-scrollbar_whitelist-白名单集合lines-304-317)
  - [2.2 彻底删除保护私有伪元素的反向死断言（Lines 284-295）](#22-彻底删除保护私有伪元素的反向死断言lines-284-295)
  - [2.3 彻底删除脆弱子串模糊匹配类名断言（Lines 258-276）](#23-彻底删除脆弱子串模糊匹配类名断言lines-258-276)
  - [2.4 彻底删除 `display: none` 按钮抑制与端点自杀断言](#24-彻底删除-display-none-按钮抑制与端点自杀断言)
  - [2.5 彻底清除全仓临时测试跳过（`it.skip` / `test.todo`）与豁免注释](#25-彻底清除全仓临时测试跳过itskip--testtodo与豁免注释)
  - [2.6 删除面清单与代码净收敛核算表](#26-删除面清单与代码净收敛核算表)
- [三、五大刚性门禁与契约断言深度设计（Core Ratchet Specifications）](#三五大刚性门禁与契约断言深度设计core-ratchet-specifications)
  - [3.1 门禁一：全仓全量 CSS 禁 `scrollbar-width: thin` 负向刚性门禁](#31-门禁一全仓全量-css-禁-scrollbar-width-thin-负向刚性门禁)
  - [3.2 门禁二：全仓全量 CSS 零私有 `::-webkit-scrollbar` 负向刚性门禁](#32-门禁二全仓全量-css-零私有--webkit-scrollbar-负向刚性门禁)
  - [3.3 门禁三：二元灰度绝对死锁与 12.0% 差值增量刚性断言](#33-门禁三二元灰度绝对死锁与-120-差值增量刚性断言)
  - [3.4 门禁四：滚动条维度零裸像素（Zero Naked Pixels）静态正则扫描门禁](#34-门禁四滚动条维度零裸像素zero-naked-pixels静态正则扫描门禁)
  - [3.5 门禁五：Mode 2 实用类矩阵与端点安全护栏规范守卫](#35-门禁五mode-2-实用类矩阵与端点安全护栏规范守卫)
- [四、`style-contract.test.ts` 重塑源码详案（Ready-to-Implement Code Spec）](#四style-contracttestts-重塑源码详案ready-to-implement-code-spec)
  - [4.1 重塑后测试套件完整 TypeScript 代码实现](#41-重塑后测试套件完整-typescript-代码实现)
  - [4.2 错误诊断信息设计（DX Friendly Error Reporting）](#42-错误诊断信息设计dx-friendly-error-reporting)
- [五、先删后改依赖拓扑与执行波次调度（Execution Sequencing & Staging）](#五先删后改依赖拓扑与执行波次调度execution-sequencing--staging)
  - [5.1 战役 6 大维度强逻辑依赖图](#51-战役-6-大维度强逻辑依赖图)
  - [5.2 实施三步法（解绑 $\to$ 改造 $\to$ 闭合死锁）](#52-实施三步法解绑-to-改造-to-闭合死锁)
  - [5.3 CI 快层（`ci.yml`）与本地门禁（`npm run check:desktop`）集成点](#53-ci-快层ciyml与本地门禁npm-run-checkdesktop集成点)
- [六、立体验证断言与魔鬼用例反脆弱性测试（Multi-Dimensional Verification）](#六立体验证断言与魔鬼用例反脆弱性测试multi-dimensional-verification)
  - [6.1 单元测试断言矩阵](#61-单元测试断言矩阵)
  - [6.2 负向试毒实验（Poison Injection Tests）设计与预期拦截](#62-负向试毒实验poison-injection-tests设计与预期拦截)
  - [6.3 运行性能与扫描开销约束（$\le 80\text{ms}$ 压测标准）](#63-运行性能与扫描开销约束le-80textms-压测标准)
- [七、实施风险评估与防御性兜底措施](#七实施风险评估与防御性兜底措施)

---

## 一、架构定位与设计哲学（Architecture & Paradigm Shift）

### 1.1 历史门禁沦为死层保护伞的深度复盘

在桌面端样式的持续演进中，测试本应是捍卫系统架构纯洁度的最终防线。然而，在通读 `apps/crish-desktop/src/styles/style-contract.test.ts:243-331` 源码后，发现了触目惊心的**“门禁异化”**事实：

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   历史测试契约如何沦为技术债务保护伞                                │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 1. SCROLLBAR_WHITELIST (304-317 行)                                              │
│    └─ 设立了包含 11 个业务组件的白名单，为私自编写 ::-webkit-scrollbar 开绿灯。        │
│    └─ 导致 ModelBadgePickerMenu、Menu 等组件割据一方，私自维护重复且劣质的滚动样式。       │
│                                                                                  │
│ 2. 反向断言绑架架构 (284-295 行)                                                  │
│    └─ 测试公然断言 Menu.module.css 等必须包含 ::-webkit-scrollbar-button 与           │
│       --tint-scrollbar-thumb，逼迫业务组件保留私有按钮伪元素，阻碍统一出口演进！       │
│                                                                                  │
│ 3. 脆弱的模糊匹配绑定 (258-267 行)                                                │
│    └─ 强制全局出口 overlay-scrollbar.css 包含 sidebarScroll、menuContent、           │
│       coverContent 等 5 处子串，使全局样式与业务组件类名产生深耦合。                  │
│                                                                                  │
│ 4. 强制 display: none 截断端点护栏 (267 行)                                       │
│    └─ 测试断言 overlay-scrollbar.css 必须存在 display: none，把 Blink 内核级         │
│       TrackRect 护栏切除逻辑写死在门禁中，导致滑块越界截断问题无法在架构层面修复。     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**结论**：现存的测试门禁非但没有阻止滚动条腐化，反而通过“反向断言”和“豁免白名单”，将临时补丁与技术死层升格成了不可触碰的“契约”，彻底违背了 `AGENTS.md §7` 严禁补丁与绕过的铁律。

### 1.2 范式跃迁：从“白名单妥协豁免”到“零容忍负向刚性门禁”

本维度（维度 6：gate-ratchet）是整场战役的**“落锁与卡扣”**。
我们要推行的不是局部的修正，而是一场**测试哲学范式跃迁（Paradigm Shift）**：

1. **绝对去白名单化（Zero Exemption）**：
   - 彻底废除 `SCROLLBAR_WHITELIST`。全仓除唯一合法出口 `overlay-scrollbar.css` 外，任何 `.css` 文件只要出现私有 `::-webkit-scrollbar`，测试直接硬性报错阻断！
2. **全域负向刚性阻断（Negative Rigid Gate）**：
   - 不仅检查“有没有做对”，更要以穷举姿态扫描“绝对不准出现什么”。
   - 全仓全量 `.css` 扫描，凡命中 `scrollbar-width: thin` 即刻爆红阻断。彻底终结 Chromium 121+ 下 Blink 引擎杀死 WebKit 样式的系统性风险。
3. **二元灰度绝对死锁（Binary Gray Level Ratchet）**：
   - 用户最高裁决：“滚动条就是两种灰度，别给我整成三种的，就是激活和未激活，没有激活分成 hover 和 active 两种的。”
   - 门禁直接对 Design Token 与 CSS 规则进行数学级验算：
     - 未激活（Idle）：屏幕实测物理灰度 $8.2\% \pm 0.3\%$；
     - 激活（Active = Hover + Drag）：屏幕实测物理灰度 $20.2\% \pm 0.3\%$；
     - 差值绝对死锁在 $12.0\% \pm 0.5\%$；
     - 严禁出现第三种 Hover 灰阶变量，`:hover` 与 `:active` 选择器必须消费同一个 Token！
4. **零硬编码裸像素扫描（Zero Naked Pixels）**：
   - 滚动条宽度必须且只能从四级 Token 体系（`--scrollbar-width-xs: 4px`、`sm: 5px`、`md: 7px`、`lg: 9px`）中消费，全仓严禁直接裸写像素数字。

### 1.3 门禁棘轮（Ratchet）不可逆单调递紧原则

依据工程防腐化原则，刚性门禁必须作为单向棘轮运行：
- **单调递紧（Monotonically Tightening）**：白名单一旦清除，永不许复活；违规计数基线一旦清零（严格为 0），任何 PR 只要引入哪怕 1 处违规，CI 门禁立即硬性阻断，绝无商量余地。
- **无静默放行（No Silent Bypassing）**：杜绝 `--no-verify`，杜绝在测试内使用 `/* vitest-disable */` 或 `it.skip`。

---

## 二、本方案要删掉什么 / 收敛什么（删除面 Deletions Surface）

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

### 2.2 彻底删除保护私有伪元素的反向死断言（Lines 284-295）

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

**收敛理由**：
1. 这些浮层组件在维度 2（purge-debts）中已被彻底拔除私有 `::-webkit-scrollbar` 块，并将在维度 5（migrate-views）统一接入 `<ScrollArea>` 或 Mode 2 工具类；
2. 继续断言其包含 `--tint-scrollbar-thumb` 与 `::-webkit-scrollbar-button` 会直接导致重构后的纯净代码测试报错，是典型的“死层保护断言”。

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

**收敛理由**：
1. 维度 3（engine-core）已将全局出口从针对特定业务类名的脆弱模糊匹配选择器（`[class*='sidebarScroll']` 等），重构成解耦的 Mode 2 零 DOM 实用类矩阵（`.scrollArea`, `.scrollAreaSm` 等）；
2. 测试不得将全局引擎与特定业务组件的私有类名绑死，收敛为断言 Mode 2 实用类契约。

### 2.4 彻底删除 `display: none` 按钮抑制与端点自杀断言

现存测试对滚动条按钮 `display: none` 进行强制断言：

```typescript
// ❌ 必须从 style-contract.test.ts 物理删除的自杀断言 (Line 267)
    expect(css).toMatch(/display:\s*none/);
```

**收敛理由**：
1. 用户明确要求：“上下圆角三角箭头充当端点安全护栏、物理防滑块越界截断”；
2. 维度 3（engine-core）恢复了 `::-webkit-scrollbar-button` 的尺寸（`height: var(--scrollbar-button-size, 8px)`）以激活 Blink 内核级 `TrackRect` 护栏；
3. 测试断言必须逆转：**严禁在全局出口粗暴写 `display: none` 抹杀端点护栏**，转而断言护栏高度与矢量三角箭头的存在性。

### 2.5 彻底清除全仓临时测试跳过（`it.skip` / `test.todo`）与豁免注释

检查全仓所有测试与注释，彻底清除以下妥协产物：
1. 彻底删除任何针对滚动条样式的 `it.skip` 或 `test.skip`；
2. 彻底删除 `packages/block-paper/src/list/paperList.css:51` 的遗留死注释（`* - 滚动条：scrollbar-width:thin + gutter stable；**禁** ::-webkit-scrollbar 私有块`，该文件在维度 2 中已彻底拔除 thin）；
3. 彻底删除 `style-contract.test.ts` 中关于旧批次临时豁免的模糊注释。

### 2.6 删除面清单与代码净收敛核算表

| 序号 | 目标文件 | 原代码行号 | 删除/收敛内容 | 理由与收益 |
| :--- | :--- | :--- | :--- | :--- |
| **D1** | `style-contract.test.ts` | 304–317 | `SCROLLBAR_WHITELIST` 白名单集合（12 个条目） | 拔除 11 个组件的免死金牌，确立零容忍门禁 |
| **D2** | `style-contract.test.ts` | 324 | `if (SCROLLBAR_WHITELIST.has(base)) continue;` | 阻断任何跳过扫描分支，违规直接报错 |
| **D3** | `style-contract.test.ts` | 284–295 | 强制 Menu 等包含私有 button 和 thumb 的反向测试 | 解除对私有死层的保护，允许业务组件纯净化 |
| **D4** | `style-contract.test.ts` | 261–265 | 强制 `overlay-scrollbar.css` 包含 5 个业务类名的断言 | 解耦全局出口与业务模块，收敛为 Mode 2 契约 |
| **D5** | `style-contract.test.ts` | 267 | `expect(css).toMatch(/display:\s*none/);` | 允许端点安全护栏复活，根治滑块越界圆角截断 |
| **D6** | `style-contract.test.ts` | 260 | `expect(css).toContain('--tint-scrollbar-thumb');` | 删除废弃的旧 Token 引用断言，转向二元灰度 Token |

**净代码收敛核算**：
- `style-contract.test.ts` 原相关测试约 88 行（243-331 行）；
- 删除废弃测试与白名单约 45 行；
- 新增负向刚性门禁与二元灰度死锁测试约 75 行；
- 配合维度 2 拔除 11 处组件私有块（净删约 190 行）与 18 处 thin（净删 18 行），全战役代码净删除 $\ge 230$ 行，架构大幅收敛。

---

## 三、五大刚性门禁与契约断言深度设计（Core Ratchet Specifications）

### 3.1 门禁一：全仓全量 CSS 禁 `scrollbar-width: thin` 负向刚性门禁

#### 1. 物理机理与危害穿透
在 Chromium 121+ / Windows WebView2 环境下，当元素或其祖先声明了 `scrollbar-width: thin` 时，Blink 渲染引擎将强制走 W3C 标准滚动条路径，直接在底层注销该元素的 `::-webkit-scrollbar*` 伪元素树。导致：
1. 开发者精心设计的 8.2% / 20.2% 二元灰度滑块全部失效；
2. 端点矢量三角按钮被生硬替换为 Windows 系统高反差灰度大箭头；
3. 滑块圆角（Full Radius）丢失，退化为硬直角。

#### 2. 门禁规则定义
- **扫描范围**：`walkSrc().filter(p => p.endsWith('.css'))`（全仓 `apps/crish-desktop/src/` 下所有生产 CSS，包括组件 Module CSS 与全局 CSS）；
- **匹配正则**：`/scrollbar-width\s*:\s*thin/i`；
- **容忍度**：**严格为 0**。没有任何例外，没有任何白名单！
- **豁免说明**：`scrollbar-width: none` 用于纯无痕隐藏滚动（如 Tab 栏、静默滚动条），不受此规则限制；但 `thin` 属于绝对禁忌。

#### 3. 契约测试用例设计
```typescript
  it('全仓全量生产 CSS 严格禁止 scrollbar-width: thin（零容忍负向门禁）', () => {
    const cssFiles = walkSrc().filter((p) => p.endsWith('.css'));
    const violations: string[] = [];
    const thinRe = /scrollbar-width\s*:\s*thin/i;

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (thinRe.test(lines[i])) {
          violations.push(`${file}:${i + 1} -> ${lines[i].trim()}`);
        }
      }
    }

    expect(
      violations,
      `发现 ${violations.length} 处违规声明 scrollbar-width: thin！\n` +
      `【Chromium 互斥警告】：scrollbar-width: thin 会彻底杀死 ::-webkit-scrollbar 样式，\n` +
      `请移除该声明，改用 <ScrollArea> 组件或 Mode 2 工具类（如 .scrollAreaSm）：\n` +
      violations.join('\n')
    ).toEqual([]);
  });
```

---

### 3.2 门禁二：全仓全量 CSS 零私有 `::-webkit-scrollbar` 负向刚性门禁

#### 1. 架构原则
- **单一真理源（SSOT）**：全系统有且仅有一个合法出口允许编写 `::-webkit-scrollbar*` 伪元素规则，即 `apps/crish-desktop/src/styles/overlay-scrollbar.css`。
- **杜绝私有割据**：组件必须通过复用 `<ScrollArea>` 或消费 Mode 2 实用类继承滚动条样式，严禁在 `*.module.css` 中就地私写伪元素。

#### 2. 门禁规则定义
- **扫描范围**：`walkSrc().filter(p => p.endsWith('.css'))`；
- **合法白名单**：有且仅有 `src/styles/overlay-scrollbar.css` 自身；
- **匹配正则**：`/::-webkit-scrollbar/`；
- **容忍度**：全仓其余文件匹配数**严格为 0**。

#### 3. 契约测试用例设计
```typescript
  it('全仓除 overlay-scrollbar.css 外，严格禁止任何私有 ::-webkit-scrollbar 规则', () => {
    const cssFiles = walkSrc().filter((p) => p.endsWith('.css'));
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
      `【SSOT 架构红线】：严禁组件就地割据私有滚动条规则，必须收敛至全局唯一出口。\n` +
      `违规文件清单：\n${violations.join('\n')}`
    ).toEqual([]);
  });
```

---

### 3.3 门禁三：二元灰度绝对死锁与 12.0% 差值增量刚性断言

#### 1. 用户最高裁决与物理色度学推导
用户最高定案铁律：
> “滚动条就是两种灰度，别给我整成三种的，就是激活和未激活，没有激活分成 hover 和 active 两种的。”

根据 CIE 色度学转换与暖纸温底板物理模型（见 `SCROLLBAR-TOKEN-ARCH-03` 与 `00-master-plan.md`）：
- **纸温底板**：$L_{\text{base}} = 95.2\%$，固有暗度 $D_{\text{base}} = 4.8\%$；
- **未激活态（Idle / Inactive）**：
  - 屏幕拾色器物理暗度实测严格死锁在 **$8.2\% \pm 0.3\%$**；
  - 混入 8% `--accent-orange`（品牌暖橙底韵），呈现微温微橘的道林纸质感；
  - 对应 Token：`--scrollbar-thumb-bg: hsl(35 8% 91.8%)`（Light）与对应 Dark Token。
- **激活态（Active，Hover 与 Active 统统同色）**：
  - 屏幕拾色器物理暗度实测从历史 31.4% 彻底下调死锁在 **$20.2\% \pm 0.3\%$**；
  - 混入 16% `--accent-orange`；
  - 对应 Token：`--scrollbar-thumb-active: hsl(35 12% 79.8%)`（Light）与对应 Dark Token。
- **差值死锁增量**：
  $$\Delta D = 20.2\% - 8.2\% = \mathbf{12.0\%} \quad (\text{刚性误差区间: } [11.5\%,\ 12.5\%])$$
- **绝对禁止第三态**：
  - 严禁出现 `--scrollbar-thumb-hover`；
  - 严禁在 `:hover` 与 `:active` 之间配置不同的色阶。

#### 2. 门禁规则定义
1. **Token 定义面断言（`tokens.css`）**：
   - 验证 Light 和 Dark 块均完整定义了 `--scrollbar-thumb-bg` 与 `--scrollbar-thumb-active`；
   - 验证不存在任何命名中包含 `--scrollbar-thumb-hover` 的第三态 Token；
   - 提取 Light 模式下的明度值（Lightness $L$），计算暗度 $D = 100 - L$：
     - 断言 $D_{\text{idle}} \in [7.9\%,\ 8.5\%]$；
     - 断言 $D_{\text{active}} \in [19.7\%,\ 20.7\%]$；
     - 断言 $\Delta D = |D_{\text{active}} - D_{\text{idle}}| \in [11.5\%,\ 12.5\%]$（死锁 12.0%）。
2. **样式消费面断言（`overlay-scrollbar.css`）**：
   - 验证 `::-webkit-scrollbar-thumb` 默认消费 `var(--scrollbar-thumb-bg)`；
   - 验证 `::-webkit-scrollbar-thumb:hover` 与 `::-webkit-scrollbar-thumb:active` **合并为同一选择器**，且共同消费 `var(--scrollbar-thumb-active)`；
   - 扫描 `overlay-scrollbar.css` 全文，断言绝对不含第三种悬停灰阶变量。

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

      // 严禁存在第三种 hover token
      expect(tokensCss, '绝对禁止定义独立的 hover 滚动条色阶 token').not.toMatch(/--scrollbar-thumb-hover\b/);

      // 解析 Light 模式下的 HSL 明度并校验物理差值
      const parseDarkness = (tokenName: string): number => {
        const m = lightBlock.match(new RegExp(`${tokenName}:\\s*hsl\\([^)]*?(\\d+(?:\\.\\d+)?)%\\)`));
        if (!m) {
          // 若采用 color-mix 定义，计算混合有效明度
          const mixMatch = lightBlock.match(new RegExp(`${tokenName}:[\\s\\S]*?color-mix\\([^;]*?\\);`));
          expect(mixMatch, `无法解析 token ${tokenName} 的颜色定义`).toBeTruthy();
          // 解析 color-mix 中的百分比
          const pct = parseFloat(mixMatch![0].match(/(\d+(?:\.\d+)?)%/)?.[1] ?? '0');
          return pct;
        }
        const lightness = parseFloat(m[1]);
        return +(100 - lightness).toFixed(2);
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

      // 断言差值严格死锁在 12.0% ± 0.5%
      expect(delta, `二元灰度差值 ${delta}% 未死锁在 12.0%（用户定案铁律）`).toBeGreaterThanOrEqual(11.5);
      expect(delta, `二元灰度差值 ${delta}% 未死锁在 12.0%（用户定案铁律）`).toBeLessThanOrEqual(12.5);
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
- **四级宽度 Token 体系**：
  - `--scrollbar-width-xs: 4px`（超细：模型菜单、补全浮层）
  - `--scrollbar-width-sm: 5px`（紧凑：侧边栏、二级下拉、抽屉）
  - `--scrollbar-width-md: 7px`（标准默认：聊天流、编辑器、设置）
  - `--scrollbar-width-lg: 9px`（宽屏大视口：DiffCard、海量日志）
- **零硬编码原则（No-Hardcoding）**：
  全仓 CSS（除了 `tokens.css` 自身定义行）和 TSX 中，严禁出现直接写死的滚动条像素尺寸（如 `width: 4px;`、`width: 5px;`、`width: 7px;` 在滚动条上下文中）。必须引用 Token。

#### 2. 门禁规则定义
- **扫描范围**：`walkSrc().filter(p => p.endsWith('.css'))`；
- **排除文件**：`src/styles/tokens.css`（Token 定义行）；
- **检查内容**：
  1. 在 `overlay-scrollbar.css` 中：
     - 滚动条宽度必须使用 `var(--scrollbar-thumb-width, var(--scrollbar-width-md))` 或对应的 Token 档位；
     - 按钮尺寸必须使用 `var(--scrollbar-button-size, 8px)`；
  2. 在全仓各业务组件 CSS 中：
     - 扫描是否出现任何 `scrollbar-` 相关的裸像素赋值（如 `scrollbar-width: 4px`、`--scrollbar-thumb-width: 5px` 等裸数字声明）；
     - 强制消费 `--scrollbar-width-*` 规范 Token。

#### 3. 契约测试用例设计
```typescript
  it('滚动条相关属性零硬编码裸像素（必须消费四级 Token 体系）', () => {
    const cssFiles = walkSrc().filter((p) => p.endsWith('.css'));
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
在维度 3 中，`overlay-scrollbar.css` 演进为 Mode 2 零 DOM 工具类矩阵，并恢复了 `::-webkit-scrollbar-button` 的物理尺寸。门禁必须对此确立不可逆断言：
1. **Mode 2 类名矩阵完整性**：必须完整导出 `.scrollArea`, `.scrollAreaXs`, `.scrollAreaSm`, `.scrollAreaMd`, `.scrollAreaLg`, `.hideScrollbar`, `.scrollAreaWithButtons`；
2. **端点护栏绝对恢复**：严禁在 `overlay-scrollbar.css` 中写 `::-webkit-scrollbar-button { display: none }`，必须声明有效高度以激活 Blink 的 `TrackRect` 护栏；
3. **矢量箭头 SVG 规范**：按钮必须内联无毛刺圆角等腰三角形 SVG，严禁退化为原生尖锐三角。

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
      // 严禁存在针对 ::-webkit-scrollbar-button 的 display: none
      const buttonBlock = css.match(/::-webkit-scrollbar-button[\s\S]*?\{[\s\S]*?\}/)?.[0] ?? '';
      expect(buttonBlock, '按钮规则块不得直接 display: none 杀死护栏').not.toMatch(/display:\s*none/);
      expect(buttonBlock, '按钮必须具备高度以维持 TrackRect 护栏').toMatch(/height:\s*(?:var\(--scrollbar-button-size|8px)/);
    });

    it('index.css 必须正确引入 overlay-scrollbar.css 且禁名 shell-scrollbar 不得复活', () => {
      const indexCss = readFile('src/index.css');
      expect(indexCss).toContain("@import './styles/overlay-scrollbar.css'");
      expect(indexCss).not.toContain('shell-scrollbar.css');

      const bannedFiles = walkSrc().filter((p) => p.replace(/\\/g, '/').endsWith('/shell-scrollbar.css'));
      expect(bannedFiles, '历史禁名 shell-scrollbar.css 严禁复活').toEqual([]);
    });
  });
```

---

## 四、`style-contract.test.ts` 重塑源码详案（Ready-to-Implement Code Spec）

### 4.1 重塑后测试套件完整 TypeScript 代码实现

以下为 `apps/crish-desktop/src/styles/style-contract.test.ts` 中针对滚动条契约测试套件（即原 `describe('批次 2 · ④ scrollbar 块 ratchet', ...)`）的**完整替换源码方案**：

```typescript
// ============================================================================
// 统一滚动条体系与 ScrollArea 战役 · 刚性契约与负向门禁测试套件
// 权威对应：docs/unified-scrollbar-system/detailed-plans/06-plan-gate-ratchet.md
// ============================================================================

describe('统一滚动条体系刚性契约与负向门禁（gate-ratchet）', () => {
  const SCROLLBAR_EXPORT = 'overlay-scrollbar.css';
  const SCROLLBAR_BANNED = 'shell-scrollbar.css';
  const SCROLLBAR_EXPORT_MIN_BLOCKS = 5; // 本体 / track / thumb / hover&active / button

  // --------------------------------------------------------------------------
  // 1. 出口文件与禁名防复活断言
  // --------------------------------------------------------------------------
  it(`禁名 ${SCROLLBAR_BANNED} 不得复活`, () => {
    const hits = walkSrc().filter((p) =>
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
  // 2. 门禁一：全仓全量 CSS 禁 thin 负向刚性门禁
  // --------------------------------------------------------------------------
  it('全仓全量生产 CSS 严格禁止 scrollbar-width: thin（零容忍负向刚性门禁）', () => {
    const cssFiles = walkSrc().filter((p) => p.endsWith('.css'));
    const violations: string[] = [];
    const thinRe = /scrollbar-width\s*:\s*thin/i;

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (thinRe.test(lines[i])) {
          violations.push(`${file}:${i + 1} -> ${lines[i].trim()}`);
        }
      }
    }

    expect(
      violations,
      `发现 ${violations.length} 处违规声明 scrollbar-width: thin！\n` +
      `【Chromium 互斥警告】：scrollbar-width: thin 会彻底杀死 ::-webkit-scrollbar 样式，\n` +
      `请移除该声明，改用 <ScrollArea> 组件或 Mode 2 工具类（如 .scrollAreaSm）：\n` +
      violations.join('\n')
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 3. 门禁二：全仓全量 CSS 禁私有 ::-webkit-scrollbar（彻底去白名单化）
  // --------------------------------------------------------------------------
  it(`全仓除 ${SCROLLBAR_EXPORT} 外，严格禁止任何私有 ::-webkit-scrollbar 规则（零白名单）`, () => {
    const cssFiles = walkSrc().filter((p) => p.endsWith('.css'));
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
  // 4. 门禁三：二元灰度绝对死锁与 12.0% 差值增量刚性断言
  // --------------------------------------------------------------------------
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

    // 计算物理暗度
    const parseDarkness = (tokenName: string): number => {
      const m = lightBlock.match(new RegExp(`${tokenName}:\\s*hsl\\([^)]*?(\\d+(?:\\.\\d+)?)%\\)`));
      if (m) {
        return +(100 - parseFloat(m[1])).toFixed(2);
      }
      const mixMatch = lightBlock.match(new RegExp(`${tokenName}:[\\s\\S]*?color-mix\\([^;]*?\\);`));
      expect(mixMatch, `无法解析 token ${tokenName} 的颜色定义`).toBeTruthy();
      return parseFloat(mixMatch![0].match(/(\d+(?:\.\d+)?)%/)?.[1] ?? '0');
    };

    const idleDarkness = parseDarkness('--scrollbar-thumb-bg');
    const activeDarkness = parseDarkness('--scrollbar-thumb-active');
    const delta = +(activeDarkness - idleDarkness).toFixed(2);

    expect(idleDarkness, `未激活物理灰度 ${idleDarkness}% 偏离 8.2% 基准`).toBeGreaterThanOrEqual(7.9);
    expect(idleDarkness, `未激活物理灰度 ${idleDarkness}% 偏离 8.2% 基准`).toBeLessThanOrEqual(8.5);

    expect(activeDarkness, `激活物理灰度 ${activeDarkness}% 偏离 20.2% 基准`).toBeGreaterThanOrEqual(19.9);
    expect(activeDarkness, `激活物理灰度 ${activeDarkness}% 偏离 20.2% 基准`).toBeLessThanOrEqual(20.5);

    expect(delta, `二元灰度差值 ${delta}% 未死锁在 12.0%（用户定案铁律）`).toBeGreaterThanOrEqual(11.5);
    expect(delta, `二元灰度差值 ${delta}% 未死锁在 12.0%（用户定案铁律）`).toBeLessThanOrEqual(12.5);
  });

  it('overlay-scrollbar.css 中 hover 与 active 选择器同源同色，严禁第三态', () => {
    const css = readFile(`src/styles/${SCROLLBAR_EXPORT}`);

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

  // --------------------------------------------------------------------------
  // 5. 门禁四：零硬编码裸像素静态扫描
  // --------------------------------------------------------------------------
  it('滚动条相关属性零硬编码裸像素（必须消费四级 Token 体系）', () => {
    const cssFiles = walkSrc().filter((p) => p.endsWith('.css'));
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

    // 保底 webkit 规则块
    const webkit = css.match(/::-webkit-scrollbar/g) ?? [];
    expect(
      webkit.length,
      `${SCROLLBAR_EXPORT} webkit 块数 ${webkit.length} < ${SCROLLBAR_EXPORT_MIN_BLOCKS}`
    ).toBeGreaterThanOrEqual(SCROLLBAR_EXPORT_MIN_BLOCKS);

    // 导出的 Mode 2 实用类矩阵
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

    // 恢复端点护栏，严禁全局 display: none
    expect(css).toContain('::-webkit-scrollbar-button');
    const buttonBlock = css.match(/::-webkit-scrollbar-button[\s\S]*?\{[\s\S]*?\}/)?.[0] ?? '';
    expect(buttonBlock, '按钮规则块不得直接 display: none 杀死护栏').not.toMatch(/display:\s*none/);
    expect(buttonBlock, '按钮必须具备高度以维持 TrackRect 护栏').toMatch(/height:\s*(?:var\(--scrollbar-button-size|8px)/);

    // 全局 * 不得设 scrollbar-width
    const starBlock = css.match(/(?:^|\n)\*\s*\{[^}]*\}/)?.[0] ?? '';
    expect(starBlock).not.toContain('scrollbar-width');
  });
});
```

### 4.2 错误诊断信息设计（DX Friendly Error Reporting）

当开发者在后续开发中不慎触发门禁时，测试断言将输出极具指导意义的诊断日志（DX Friendly Diagnostic Messages）：

```text
FAIL src/styles/style-contract.test.ts > 统一滚动条体系刚性契约与负向门禁（gate-ratchet） > 全仓全量生产 CSS 严格禁止 scrollbar-width: thin（零容忍负向刚性门禁）
AssertionError: 发现 1 处违规声明 scrollbar-width: thin！
【Chromium 互斥警告】：scrollbar-width: thin 会彻底杀死 ::-webkit-scrollbar 样式，
请移除该声明，改用 <ScrollArea> 组件或 Mode 2 工具类（如 .scrollAreaSm）：
src/components/chat-composer/ChatComposer.module.css:1115 -> scrollbar-width: thin;
```

```text
FAIL src/styles/style-contract.test.ts > 统一滚动条体系刚性契约与负向门禁（gate-ratchet） > 全仓除 overlay-scrollbar.css 外，严格禁止任何私有 ::-webkit-scrollbar 规则（零白名单）
AssertionError: 发现 1 个组件私自编写了 ::-webkit-scrollbar！
【SSOT 架构红线】：已彻底删除 SCROLLBAR_WHITELIST 白名单，组件不得就地割据。
请接入 <ScrollArea> 组件或挂载 .scrollArea 工具类。
违规文件清单：
src/components/provider/ModelBadgePickerMenu.module.css (包含 4 处私有 webkit 伪元素规则)
```

这种直接指明**物理病因、架构红线与替代方案**的报错输出，能够彻底杜绝后续新人的退避与乱打补丁行为。

---

## 五、先删后改依赖拓扑与执行波次调度（Execution Sequencing & Staging）

### 5.1 战役 6 大维度强逻辑依赖图

依据《主 Agent 全流程调度提示词 v3》§0.2 铁律与反退避原则，全战役各维度之间存在严格的不可逆因果锁链：

```
┌────────────────────────────────────────────────────────────────────────┐
│ 步骤 1: 维度 1 (token-system) 基础底板落地                               │
│ 落地 --scrollbar-thumb-bg (8.2%) / --scrollbar-thumb-active (20.2%)   │
│ 落地四级宽度 Token (--scrollbar-width-xs/sm/md/lg)                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 步骤 2: 维度 6 阶段一 (gate-ratchet 解绑)                              │
│ 【先删后改】：先从 style-contract.test.ts 物理删除反向断言 (284-295 行) │
│ 解除对 Menu 等组件私有 button/thumb 的死锁绑定，防止清洗代码时测试报错   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 步骤 3: 维度 2 (purge-debts) 历史死层清剿                              │
│ 拔除全仓 18 处 thin 地雷，拔除 11 处组件私有 ::-webkit-scrollbar 块      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 步骤 4: 维度 3 (engine-core) 全局唯一出口重塑                           │
│ 重写 overlay-scrollbar.css，恢复 8px 按钮端点护栏，发布 Mode 2 工具类矩阵 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 步骤 5: 维度 4 (scroll-area) UI 原子层落地                             │
│ 封装 <ScrollArea> React 原子组件，落地 20Hz 脉冲微调与三段式物理防夹护栏  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 步骤 6: 维度 5 (migrate-views) 全量业务视口分级改造                     │
│ Tier A 接 ScrollArea / Tier B 挂 Mode 2 类 / Tier C 挂 hideScrollbar   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 步骤 7: 维度 6 阶段二 (gate-ratchet 闭合死锁)                          │
│ 彻底删除 SCROLLBAR_WHITELIST，全面实装 5 大刚性门禁，永久扣死防腐棘轮     │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.2 实施三步法（解绑 $\to$ 改造 $\to$ 闭合死锁）

为了确保整个重构过程零 CI 阵痛与确定性平滑演进，维度 6 采用**“两阶段收敛、三步法推进”**策略：

#### 【第 1 步：契约松绑（先删反向死断言）】
- **执行时机**：在开始大规模修改业务组件 CSS 之前；
- **具体操作**：
  - 立即从 `style-contract.test.ts` 中删除 284-295 行关于 Menu 等组件必须包含 `--tint-scrollbar-thumb` 与 `::-webkit-scrollbar-button` 的死断言；
  - 删除 261-265 行关于 `overlay-scrollbar.css` 必须包含特定业务类名的模糊匹配断言；
  - 删除 267 行强制 `display: none` 断言。
- **验收**：运行测试，现有白名单和出口断言依然保持绿色，但不再阻碍后续维度的删代码工作。

#### 【第 2 步：业务清洗与架构重构（维度 1-5 全量落地）】
- 各维度 Architect 并行执行：维度 1 注入 Token，维度 2 清除 18 处 thin 与 11 处私有伪元素，维度 3 重塑出口，维度 4 产出组件，维度 5 完成视口迁移。

#### 【第 3 步：卡扣闭合（全面落锁去白名单）】
- **执行时机**：维度 1-5 全部改动合并落盘后；
- **具体操作**：
  - 彻底将 `SCROLLBAR_WHITELIST` 连根拔起并从测试中删除；
  - 注入全仓禁 thin 门禁、全仓禁私有 WebKit 门禁、二元灰度差值死锁断言与零裸像素扫描；
  - 运行 `npx vitest run src/styles/style-contract.test.ts` 全绿放行。

### 5.3 CI 快层（`ci.yml`）与本地门禁（`npm run check:desktop`）集成点

`style-contract.test.ts` 本身已通过 `vitest.unit.config.ts` 接入桌面端全套自动化 CI 流水线：
1. **本地开发门禁**：
   - `npm run check:desktop`（包含类型检查、行数扫描与契约测试）；
   - `npm run test:fast` 或 `npx vitest run src/styles/style-contract.test.ts` 瞬时执行；
2. **CI 门禁流水线（`ci.yml`）**：
   - 在 `lint` 与 `test-unit` Job 中作为前置阻断关卡；
   - 任何 PR 只要违规引入 `scrollbar-width: thin` 或私有 WebKit 块，将在 30 秒内被快速门禁精确拦截。

---

## 六、立体验证断言与魔鬼用例反脆弱性测试（Multi-Dimensional Verification）

遵循 `AGENTS.md §7.1` 立体验证纪律，本方案绝不仅靠“测试跑通”作为唯一依据，而是建立立体的穷举与试毒验证体系。

### 6.1 单元测试断言矩阵

| 序号 | 校验维度 | 校验对象 | 断言表达式与期望值 | 违规阻断阈值 |
| :--- | :--- | :--- | :--- | :--- |
| **V1** | 禁名复活 | `walkSrc()` | `hits.length === 0` | $> 0$ 立即阻断 |
| **V2** | 禁 thin | 全仓生产 CSS | `violations.length === 0` | $> 0$ 立即阻断 |
| **V3** | 禁私有 WebKit | 全仓生产 CSS (除 export) | `violations.length === 0` | $> 0$ 立即阻断 |
| **V4** | 白名单清除 | `style-contract.test.ts` | 源码不含 `SCROLLBAR_WHITELIST` | 存在即阻断 |
| **V5** | 未激活灰度 | `tokens.css:--scrollbar-thumb-bg` | $D \in [7.9\%,\ 8.5\%]$ | 超出即阻断 |
| **V6** | 激活灰度 | `tokens.css:--scrollbar-thumb-active` | $D \in [19.9\%,\ 20.5\%]$ | 超出即阻断 |
| **V7** | 二元差值死锁 | Active - Idle 灰度差 | $\Delta D \in [11.5\%,\ 12.5\%]$ | 超出即阻断 |
| **V8** | 严禁第三态 | 全仓 CSS 变量与规则 | 不含 `--scrollbar-thumb-hover` | 命中即阻断 |
| **V9** | 同源同色 | `overlay-scrollbar.css` | `:hover` 与 `:active` 在同规则内消费同 Token | 不符即阻断 |
| **V10**| 零裸像素 | 全仓生产 CSS | 滚动条属性不含裸数字 px | $> 0$ 立即阻断 |
| **V11**| Mode 2 矩阵 | `overlay-scrollbar.css` | 7 个工具类 100% 存在 | 缺失即阻断 |
| **V12**| 端点护栏 | `overlay-scrollbar.css` | 按钮规则不含 `display: none`，含高度 | 不符即阻断 |

### 6.2 负向试毒实验（Poison Injection Tests）设计与预期拦截

为验证门禁系统的**“反脆弱性（Anti-fragility）”**，在门禁上线后执行以下 5 项故意注入毒点的试毒实验：

#### 实验 1：注入 `scrollbar-width: thin`
- **操作**：在 `apps/crish-desktop/src/components/sidebar/Sidebar.module.css` 注入 `scrollbar-width: thin;`；
- **预期反应**：`style-contract.test.ts` 门禁一爆红，精确指出 `Sidebar.module.css` 违规行号，阻断构建。

#### 实验 2：注入私有 `::-webkit-scrollbar`
- **操作**：在 `apps/crish-desktop/src/components/ui/Button/Button.module.css` 注入 `.btn::-webkit-scrollbar { width: 4px; }`；
- **预期反应**：`style-contract.test.ts` 门禁二爆红，报错提示组件严禁就地割据私有滚动条。

#### 实验 3：注入第三态 Hover 灰阶
- **操作**：在 `tokens.css` 注入 `--scrollbar-thumb-hover: hsl(35 10% 85%);`，并在 `overlay-scrollbar.css` 中将 hover 与 active 拆开；
- **预期反应**：`style-contract.test.ts` 门禁三爆红，报错提示“绝对禁止定义独立的 hover 滚动条色阶 token”。

#### 实验 4：篡改二元灰度差值
- **操作**：将 `--scrollbar-thumb-active` 明度改为 `70%`（物理暗度 30%，差值 21.8%）；
- **预期反应**：`style-contract.test.ts` 门禁三爆红，提示“二元灰度差值 21.8% 未死锁在 12.0%”。

#### 实验 5：注入裸像素宽度
- **操作**：在某 module.css 注入 `--scrollbar-thumb-width: 6px;`；
- **预期反应**：`style-contract.test.ts` 门禁四爆红，提示“发现滚动条裸像素硬编码，必须消费四级 Token 体系”。

### 6.3 运行性能与扫描开销约束（$\le 80\text{ms}$ 压测标准）

由于本门禁需要遍历全仓 `src/` 下的所有 CSS 文件，必须保证扫描算法轻量高效，绝不拖慢本地开发反馈循环：
1. **文件遍历复用**：`walkSrc()` 执行一次，返回文件列表后在内存中过滤 `.css` 文件（全仓约 120 个 CSS 文件）；
2. **正则流式匹配**：避免构建沉重的 AST 语法树，直接采用经过预编译的高性能正则进行单遍正则匹配；
3. **性能基准**：在标准开发机上，整套 5 大门禁运行耗时必须稳定在 **$\le 80\text{ms}$**，在快速测试层（`npm test`）中近乎零感知。

---

## 七、实施风险评估与防御性兜底措施

| 潜在风险点 | 严重等级 | 触发机理 | 防御性规避与兜底措施 |
| :--- | :---: | :--- | :--- |
| **步骤倒置导致 CI 大面积爆红** | **高** | 若未完成维度 2 清除私有伪元素，便提前合入去白名单门禁，将瞬间导致 11 个组件测试失败。 | **严格执行三步法**：调度主控必须先下发维度 6 第 1 步（解绑反向断言），待维度 1-5 全部合入且工作区纯净后，才下发第 2 步（去白名单闭合死锁）。 |
| **Windows CRLF 换行符破坏正则匹配** | **中** | Windows 平台检出的代码可能包含 `\r\n`，若正则中包含跨行匹配 `[\s\S]*?`，可能因贪婪匹配吞掉后续规则。 | 匹配前统一采用 `.split(/\r?\n/)` 逐行扫描，或在全文正则中规范化行尾；明确指定非贪婪限制符。 |
| **第三方库/外部引入的 CSS 误伤** | **低** | 未来若在 `src/` 下引入第三方样式库（如 node_modules 符号链接或 vendor 文件），可能误触禁 thin 门禁。 | `walkSrc()` 严格过滤 `node_modules` 与构建产物目录；若确需引入第三方独立包，必须封装在 `packages/` 外部或通过构建工具隔离。 |
| **Monorepo 中 packages 范围漂移** | **中** | 当前 `style-contract.test.ts` 仅扫描 `apps/crish-desktop/src/`，若 `packages/block-paper` 漏扫可能潜藏毒点。 | 维度 2 中已明确将 `block-paper` 的 2 处 thin 物理清除；在 packages 治理成熟后，可将 `walkSrc` 扩展为工作区全量扫描工具。 |

---

## 八、主控签发确认与下一步行动

本独立详案（`06-plan-gate-ratchet.md`）已完整贯彻：
1. **用户最高裁决绝对落地**：二元灰度绝对死锁（8.2% vs 20.2%，差值 12.0%，Hover 与 Active 同色同源，严禁第三态）；
2. **彻底去白名单化**：物理拔除 `SCROLLBAR_WHITELIST`（304-317 行），全仓禁私有 WebKit 伪元素；
3. **全仓禁 thin 负向刚性门禁**：彻底终结 Chromium 121+ Blink 引擎杀死 WebKit 样式的系统性隐患；
4. **滚动条零裸像素门禁**：刚性守卫四级 Token 体系；
5. **详尽列出删除面清单**：先删后改，删除反向死断言与模糊匹配死层，实现架构净收敛。

本详案已编制完成并物理落盘于：
`c:\Software\conex\docs\unified-scrollbar-system\detailed-plans\06-plan-gate-ratchet.md`

下一步请主控 Agent 推进多 Agent 交叉评审或批次执行！
