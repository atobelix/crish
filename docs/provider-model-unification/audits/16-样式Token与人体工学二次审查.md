# 16 · 样式 Token 与人体工学二次审查

> **文档标识**：`16-样式Token与人体工学二次审查.md`
> **所属战役工作区**：`docs/provider-model-unification/audits/`
> **角色**：UI Tokens & Ergonomics Auditor（只读；禁止改源码）
> **取证日期**：2026-09-08
> **相对上一轮**：`07-样式系统与人体工学合规深度审查.md` 写于 Wave 4 之前。本轮按 **Wave 4 落地后的当前工作区** 重新取证，不以 07 的行号/结论为真。
> **Wave 4 自称**：「原生 Token 样式」。提交 `f98b7f62`（`BATCH-UNIFY-04`）对样式域的真实 diff 为：
>
> | 文件 | 变更 |
> | :--- | :--- |
> | `ModelsSettingsTab.module.css` | **+5 行**（仅 `.mrdCfgFooter` 粘性底栏声明） |
> | `ModelConfigPanel.tsx` | 保存钮改 `variant="primary"` + 去掉内联绿底/`#fff`；智能预填色 fallback `#10b981` → `hsl(160 84% 39%)` |
> | `ModelThinkingEditor.tsx` | 拆掉内嵌 `Switch`；图标色 fallback 同上；`onEnabledChange` 改为未使用 `_onEnabledChange` |
>
> **裁决基准**：`AGENTS.md` §12 Tooltip、§13 焦点、§14 HSLA/token、§19 四态铁律、§20 圆角、§21 零 Emoji。Token SSOT：`apps/crish-desktop/src/styles/tokens.css`。门禁线索：`scripts/check-input-guardrails.mjs`（本轮实测 **exit 0 全绿**，见第八节盲区）。
> **问题同权**：下列条目不分 P0/P1，不按「看起来小」降级。

---

## 一、结论先行

**Wave 4 没有把 07 的样式债清零。** 它修了两件真正的事（保存钮不再挂羊头卖狗肉；思考编辑器内嵌总开关卸掉），再用 **5 行幽灵 token + 魔术 `bottom: -12px` + `backdrop-filter` 冒充 sticky 吸底**。07 点名的魔术间距/奇葩圆角/`#10b981` 裸 fallback **几乎原样还在**；设置中枢大量内联 `style` 继续覆盖原子 `Button`/`Input`；聊天侧模型徽标/档位另有一套 `rgba()` 与硬阴影。

一句话给主控：**「原生 Token 样式」是提交说明，不是现状。**

---

## 二、合规矩阵（Wave 4 后重新判定）

| # | 核查项 | 07 判定 | Wave 4 后判定 | 关键证据 | 说明 |
| :--- | :--- | :---: | :---: | :--- | :--- |
| 1 | 输入框走原子 `Input`（形态 ③） | PASS | **PASS−** | 设置表单主路径均 `import { Input } from '../ui'`；`settings-models/` **0 处**原生 `<input` | `ProfileHeader` 把形态 ③ 内联改成下划线标题框（第五形态）；`ManualAddForm` 用 `#ffffff` 覆盖原子底色 |
| 2 | 浮层搜索形态 ④ | （07 未扫聊天侧） | **PASS** | `ModelBadgePickerMenu.tsx:167` 原生 `<input>` + `ModelBadgePickerMenu.module.css:61-74` 全态 `border/outline/box-shadow: none; background: transparent` | 门禁白名单合法；符合 §19 形态 ④ |
| 3 | 焦点态 ≤10%、无重阴影 | PASS | **PASS**（原子层） / **WARN**（业务覆盖） | `Input.module.css:55-63` 仍是 `color-mix(... 8%)` + `box-shadow: none` | 业务层 `ManualAddForm`/`ProfileHeader` 内联 `style` 绕过原子焦点契约 |
| 4 | §14：无散落 `rgba()` / 裸 HEX | PASS−（仅核心 6 文件） | **FAIL** | 见第三节清单 | 07 只扫 6 文件；扩域后 `ScanResultsModal`/`YamlConfigEditorModal`/`ManualAddForm`/`ModelBadgePickerMenu` 大量 `rgba`/`#fff` |
| 5 | 真正消费 `var(--…)` 而非幽灵 token | （07 未单列） | **FAIL** | `.mrdCfgFooter { background: var(--surface-primary); }`；`.mrdSubSection` 用 `var(--surface-secondary-raw, 220 14% 96%)` | **`tokens.css` 全文 0 处 `--surface-primary` / `--surface-secondary-raw`** |
| 6 | 协议选择器从模型抽屉物理剥离 | PASS | **PASS** | `ModelConfigPanel.tsx` 无 protocol；`ProviderProfileForm.tsx:92-135` 服务商级 `Select` | 维持 |
| 7 | 非思考模型 thinking 编辑器物理卸载 | PASS | **PASS** | `ModelConfigPanel.tsx:212-231` `{cfgDraft.thinkingEnabled && <ModelThinkingEditor />}` | 非 `display:none`。聊天侧 `ComposerFusedTrigger` 同样条件卸载；`ModelBadgePickerMenu` 高级选项里档位轨 **未**按模型能力卸载 |
| 8 | 思考双重开关（内嵌 enable + 档位） | FAIL | **PASS−** | `ModelThinkingEditor.test.tsx:115-125` 断言不再渲染 `role=switch`；内嵌 `Switch` 已删 | 残留 `{enabled && (…)}` 与未使用 `_onEnabledChange`；启闭仍由 `CapEditor`「推理」单源 |
| 9 | 保存按钮不被滚出视口 | WARN | **FAIL**（声称已修、物理未修） | Wave 4 +5 行 sticky；祖先 `.mrdModelList { overflow: hidden }` + 滚动发生在内联 `mrd-model-list-scroll` | sticky 被 overflow 祖先截断；底色 token 不存在 → 透明 |
| 10 | 禁止 `Button variant` + 内联改色 | FAIL | **PASS**（保存钮） / **FAIL**（其余） | 保存钮已是 `variant="primary"` 无 style | `ProfileHeader`/`ModelList`/`ModelThinkingEditor`/`ModelConfigPanel` 智能预填仍内联改 `Button` 高/色 |
| 11 | 魔术 10px / 5px / 26px / 22px | FAIL | **FAIL** | 见第五节；Wave 4 **0 行**动这些值 | 07 §7.3 对照表未落地 |
| 12 | `!important` | PASS | **PASS** | `settings-models/` 0 命中 | 维持 |
| 13 | Tooltip 用项目组件、禁 `title` | （07 未单列） | **PASS** | 模型行/扫描弹窗/Composer 均 `import { Tooltip } from '../ui'`；`ComposerFusedTrigger.test.tsx:61` 断言 `querySelectorAll('[title]').length === 0` | `Dialog`/`SettingsPage`/`ConfirmDialog` 的 `title=` 是组件 API，不是 HTML `title` |
| 14 | §21 零 Emoji | （07 未单列） | **PASS**（UI 面） | 界面文案/按钮/占位符无 Emoji；图标走 Lucide | `ModelProfileList.tsx` 注释里有 `🌟`（不进 UI） |
| 15 | §19 仅四态、禁第五形态 | （07 时尚未成文） | **FAIL** | `ProfileHeader.tsx:79-93` 把 `Input` 改成「无边框 + 底边 1px」 | 形态 ⑤：下划线标题输入 |
| 16 | §20 圆角阶梯 4/6/8/12/16 | （部分） | **FAIL** | `.mrdCurrencyToggle { border-radius: 5px }`；内联 `borderRadius: '5px'`；Composer 胶囊 `14px` | 5px 不在半径阶梯；门禁「奇葩圆角」正则 **不含 5/7/9/14** |
| 17 | 聊天侧徽标/档位硬编码色 | （07 未扫） | **FAIL** | `ModelBadgePickerMenu.module.css` 多处 `rgba()`；`.thinkingPill.activePill` 硬阴影 | Composer 本体较克制，picker 菜单未收敛 |

雷达（仅作阅读索引，**不作为砍项依据**）：

```
Token 真源纯度     ████░░░░░░  幽灵 --surface-* + HEX fallback 未清
§19 四态           ██████░░░░  主表单走 Input；ProfileHeader 第五形态；ManualAdd 白底补丁
§20 圆角           █████░░░░░  5px 货币切换；7px 作为 --button-radius 错误 fallback
保存钮人体工学     ██░░░░░░░░  sticky 写了但物理无效
思考双重开关       ████████░░  Switch 已卸；残留 enabled 短路与聊天侧双入口
聊天侧档位样式     ████░░░░░░  Composer 条件卸载合格；picker 仍有 rgba/硬阴影
Tooltip / Emoji    ██████████  本域合规
门禁覆盖           ████░░░░░░  check-input-guardrails 对本域这些债全绿放行
```

---

## 三、Wave 4 +5 行 CSS 是否实质修复 07？

`f98b7f62` 对 `ModelsSettingsTab.module.css` 的 **全部** 新增（原样）：

```css
/* apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css:438-443 */
.mrdCfgFooter {
  position: sticky;
  bottom: -12px;
  background: var(--surface-primary);
  backdrop-filter: blur(8px);
  z-index: 10;
  /* 以下为旧声明，未改 */
```

对照 07 的四条整改建议：

| 07 建议 | Wave 4 做了什么 | 是否实质修复 |
| :--- | :--- | :---: |
| 7.1 保存钮 `variant="primary"`，去掉内联绿底/`#fff` | **做了**（TSX，不是那 +5 行 CSS） | **是** |
| 7.2 sticky footer | **写了 5 行**，但：① `--surface-primary` 在 `tokens.css` **不存在**（全仓仅此一处引用）；② `bottom: -12px` 是为了抵消父级 `padding: 12px 14px` 的补偿魔术；③ `backdrop-filter: blur(8px)` 是透明底的遮羞布；④ sticky 包含块被 `.mrdModelList { overflow: hidden }`（`ModelsSettingsTab.module.css:280`）截断，真正滚动的是 `ModelConfigEditor.tsx:196-206` 内联 `overflowY: 'auto'` 的 `mrd-model-list-scroll` | **否** |
| 7.3 收敛 10px / 5px / 26px / 22px 到 token | **0 行 CSS 改这些值** | **否** |
| 7.4 去掉思考编辑器内嵌 Switch | **做了**（TSX） | **是**（残留见第六节） |

因此：提交说明里的「原生 Token 样式」= 把 07 建议的 sticky 补丁贴上去，并换了一个 **SSOT 里根本没有的变量名**。这不是对齐 token，是制造幽灵 token。

额外：`.modelsDetail` 在 CSS `ModelsSettingsTab.module.css:134` 写了 `overflow-y: auto`，但 `ModelConfigEditor.tsx:82-88` 内联 `overflow: 'hidden'` **覆盖**之。三段式布局（钉头 + 操作栏 + 列表滚动）靠 TSX 内联 flex，CSS 模块里 **没有** `.mrdPinnedHeader` / `.mrdActionBar` / `.mrdModelListScroll` 规则——`styles.mrdPinnedHeader || ''` 恒为空串。样式真源在 JSX `style={{…}}`，不在 token 表。

CSS 文件头仍写「从 1165 行精简至 ~295 行」（`ModelsSettingsTab.module.css:4`），当前文件 **758 行**。文件头自称与事实不符。

---

## 四、违规清单（文件:行号 + 原样）

### 4.1 幽灵 token / 错误 fallback（声称走 token，实际未接 SSOT）

**`--surface-primary` 不存在于 `tokens.css`。**

```css
/* ModelsSettingsTab.module.css:438-443 */
.mrdCfgFooter {
  position: sticky;
  bottom: -12px;
  background: var(--surface-primary);
  backdrop-filter: blur(8px);
  z-index: 10;
```

计算后 `background` 为无效声明 → 底栏透明。合法底应为 `var(--bg-card)` / `var(--bg-elevated)`。

**`--surface-secondary-raw` 同样不存在。** fallback 色相 `220` 是蓝灰，直接违反 `tokens.css:37-46`「pure neutral greys (no blue/purple tint)」与浅色主题 `hsl(30 2.5% …)` 米黄中性。

```css
/* ModelsSettingsTab.module.css:623-635 */
.mrdSubSection {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  padding: 8px 10px;
  background: hsl(var(--surface-secondary-raw, 220 14% 96%) / 0.35);
  border: 1px solid var(--border-subtle);
  border-radius: var(--button-radius, 6px);
}

:global(html[data-theme='dark']) .mrdSubSection {
  background: hsl(var(--surface-secondary-raw, 220 14% 12%) / 0.4);
}
```

因为变量未定义，**浅色永远吃 `hsl(220 14% 96% / 0.35)`**。多模态/思考/价格三块内嵌卡全部带蓝调。

**同一 `--button-radius`（SSOT = 8px，`tokens.css:26,473`）三套错误 fallback：**

```css
/* ModelsSettingsTab.module.css:198 */
border-radius: var(--button-radius, 7px);
/* :410 modelConfigPanel */
border-radius: var(--button-radius, 7px);
/* :535 addMenuOption / :565 cascadeSelectTrigger 同 7px */
/* :630 mrdSubSection */
border-radius: var(--button-radius, 6px);
```

token 在时算 8px；token 缺时分别掉到 7 或 6——7px 不在 §20 阶梯。

**`--success-color` 不在 `tokens.css`（只有 `--color-success`）：**

```css
/* YamlConfigEditorModal.module.css:299 */
color: var(--success-color, #10b981);
```

**`--bg-surface` 不在 `tokens.css`：**

```css
/* ModelBadgePickerMenu.module.css:211-218 */
.thinkingTrack {
  display: flex;
  align-items: center;
  background: var(--bg-surface, rgba(0, 0, 0, 0.04));
  border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.05));
  border-radius: 8px;
```

**`--brand-primary` 的 fallback 写成蓝色**（token 存在时是 `#10b981`，fallback 仍是 Zero-Blue 禁区）：

```css
/* YamlConfigEditorModal.module.css:89-91 */
.modalTitleIcon {
  color: var(--brand-primary, #0066cc);
}
```

### 4.2 裸 HEX / 旧式 `rgba()`（§14）

设置中枢（Wave 4 未碰这些文件）：

```css
/* ScanResultsModal.module.css:51-87 */
.modelRow:hover {
  background: var(--bg-hover, rgba(128, 128, 128, 0.08));
}
.customCheckbox {
  /* ... */
  background: #ffffff;
}
.customCheckboxChecked {
  background: var(--brand, #10b981);
  border-color: var(--brand, #10b981);
  color: #ffffff;
}
```

`#ffffff` 无 dark 对应 → 深色主题复选框变成白块。

```css
/* YamlConfigEditorModal.module.css:32, 41, 193 */
border-left: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
box-shadow: var(--shadow-lg, 0 10px 25px -5px rgba(0, 0, 0, 0.1));
.gutterLine.gutterLineError {
  background: rgba(239, 68, 68, 0.25);
```

同文件还有 `rgba(0,0,0,0.04/0.06/0.03/0.02)` 共十余处（`:70,75,112,115,128,129,159,171,172`）。错误横幅已用 `hsl(0 84% 60% / 0.1)`（`:274`），gutter 错误行仍用旧 `rgba`——同一弹窗两套语法。

TSX 内联：

```tsx
/* ManualAddForm.tsx:171, 183-192, 251, 262 */
style={{ background: '#ffffff' }}
boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
background: 'var(--bg-card, #ffffff)',
```

三处原子 `Input` 被强制白底，深色模式形态 ③ 的 `color-mix(in srgb, var(--bg-primary) 40%, var(--bg-card))` 被打穿。

```tsx
/* ModelModalitiesEditor.tsx:84 */
style={{ color: 'var(--brand, #10b981)' }}

/* ModelPricingEditor.tsx:57 */
style={{ color: 'var(--brand, #10b981)' }}

/* ManualAddForm.tsx:140 */
style={{ color: 'var(--brand, #10b981)' }}
```

Wave 4 只改了 `ModelConfigPanel.tsx:152` 与 `ModelThinkingEditor.tsx:93` 的 fallback 为 `hsl(160 84% 39%)`，**同构的另外三处未改**。CSS 模块里芯片/货币钮仍是 `#10b981`：

```css
/* ModelsSettingsTab.module.css:703-706, 754-756 */
.mrdModalityChipActive {
  background: color-mix(in srgb, var(--brand, #10b981) 12%, transparent);
  border-color: color-mix(in srgb, var(--brand, #10b981) 40%, transparent);
  color: var(--brand, #10b981);
}
.mrdCurrencyBtnActive {
  background: color-mix(in srgb, var(--brand, #10b981) 15%, transparent);
  color: var(--brand, #10b981);
}
```

```tsx
/* ModelList.tsx:160-169 延迟徽章 */
background: meta.lastTest.ok
  ? 'color-mix(in srgb, var(--accent-green, #10b981) 12%, transparent)'
  : 'color-mix(in srgb, var(--accent-red, #ef4444) 12%, transparent)',
color: /* ... */ 'var(--accent-green, #10b981)'
  /* ... */ 'var(--accent-orange, #f59e0b)'
  /* ... */ 'var(--accent-red, #ef4444)'
```

聊天侧：

```css
/* ComposerFusedTrigger.module.css:66 */
background: var(--border-color, rgba(0, 0, 0, 0.12));

/* ModelBadgePickerMenu.module.css:51, 179, 214-215, 240-244 */
border-bottom: 1px solid var(--sep-divider-color, rgba(0, 0, 0, 0.06));
background: var(--sep-divider-color, rgba(0, 0, 0, 0.06));
background: var(--bg-surface, rgba(0, 0, 0, 0.04));
border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.05));
.thinkingPill.activePill {
  background: var(--bg-elevated, #ffffff);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 1px rgba(0, 0, 0, 0.04);
}
```

`--sep-divider-color` 在 SSOT 里已是 `color-mix`（`tokens.css:215`），这里的 `rgba` 只是 fallback，但仍是 §14 散落旧语法。`activePill` 的双层 `rgba` 阴影是硬编码，未走 `--shadow-sm`。

### 4.3 内联覆盖原子 `Button` / `Input`（打补丁）

保存钮本身已干净：

```tsx
/* ModelConfigPanel.tsx:292-299 — Wave 4 后，合规 */
<Button type="button" variant="primary" size="sm" onClick={saveConfig}>
  保存
</Button>
```

其余仍在改原子控件几何：

```tsx
/* ModelConfigPanel.tsx:143-153 */
<Button
  variant="ghost" size="sm"
  style={{
    height: '20px',          /* 不在 24/28/32/40 阶梯 */
    padding: '0 6px',
    fontSize: '11px',
    color: 'var(--brand, hsl(160 84% 39%))',
  }}
>

/* ModelThinkingEditor.tsx:138-142, 154, 164-168 */
style={{ padding: '0', height: '26px', color: 'var(--text-tertiary)' }}
style={{ fontSize: '11px', height: '22px' }}
style={{ fontSize: '11px', height: '22px', color: 'var(--text-secondary)' }}

/* ModelList.tsx:189-193, 228-234, 250-254 */
style={{ padding: '0 5px', height: '26px', color: 'var(--text-tertiary)' }}

/* ModelListHeader.tsx:44-51 及同构 72-79、112-119 */
style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', ... }}

/* ProfileHeader.tsx:128-151 启用钮：声明 Button 却内联整套边框/底色/圆角 */
style={{
  height: '24px',
  padding: '0 8px',
  fontSize: '12px',
  fontWeight: 500,
  borderRadius: '6px',
  border: selected.enabled !== false
    ? '1px solid color-mix(in srgb, var(--color-active) 30%, transparent)'
    : '1px solid var(--border-subtle)',
  background: /* ... */,
  color: /* ... */,
}}
```

`ProfileHeader.tsx:193-198, 211-216` 确认/取消钮 `borderRadius: '5px'`。

### 4.4 `!important`

`settings-models/`、`ComposerFusedTrigger.module.css`、`ModelBadgePickerMenu.module.css`：**0 处**。此项维持合规。

### 4.5 内联布局硬编码（未进 CSS 模块）

`ModelThinkingEditor.tsx:104-112` 表头仍是 JSX `display:'grid'`（07 已点名，Wave 4 未提炼）：

```tsx
<div
  style={{
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 28px',
    gap: '6px',
    fontSize: '11px',
    color: 'var(--text-tertiary)',
    paddingBottom: '2px',
  }}
>
```

`ManualAddForm.tsx:213-214` 用 `onMouseEnter/Leave` **写 DOM `style.background`**，把 hover 态做进事件处理，而不是 CSS class。

`ModelConfigEditor.tsx:82-88, 99-106, 114-119, 155-160, 198-206` 大段内联 flex/overflow，CSS 类名 `mrdPinnedHeader` 等并不存在。

`ModelProfileList.tsx:244` `styles.cascadeMenuContent`：**CSS 模块中无此 class**（全仓 CSS 0 命中），`contentClassName` 传入 `undefined`。

---

## 五、与 §19 / §20 的冲突

### 5.1 §19 四态铁律

| 位置 | 实际形态 | 判定 |
| :--- | :--- | :--- |
| `ProviderProfileForm` Base URL / API Key | 原子 `Input` size=sm | 形态 ③ **合规** |
| `ModelConfigPanel` 展示名/上下文/max tokens | 原子 `Input` size=sm | 形态 ③ **合规** |
| `ModelThinkingEditor` / `ModelPricingEditor` 映射与四维价格 | 原子 `Input` size=sm | 形态 ③ **合规** |
| `ManualAddForm` 三个 `Input` | 原子组件 + `style={{ background: '#ffffff' }}` | 形态 ③ 被打穿（深色失效） |
| `ModelListHeader` / `ScanResultsModal` `Input variant="search" size="xs"` | 原子 search，仍带 `Input.module.css` 细边框 | 卡片工具栏，走形态 ③ **可接受**（不是侧栏 ①，也不是浮层 ④） |
| `ModelBadgePickerMenu` 原生 `<input className={styles.searchInput}>` | CSS 全态无边框无阴影 | 形态 ④ **合规**（门禁白名单） |
| `ProfileHeader.tsx:79-93` 重命名 | 原子 `Input` 被改成： | **形态 ⑤，违规** |

原样：

```tsx
/* ProfileHeader.tsx:79-93 */
style={{
  border: 'none',
  borderBottom: '1px solid var(--border-color)',
  background: 'transparent',
  padding: '0',
  margin: '0',
  outline: 'none',
  fontSize: '16px',
  fontWeight: 600,
  letterSpacing: '-0.015em',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  height: '28px',
  lineHeight: '28px',
}}
```

这是「下划线标题编辑框」，四态里没有这一档。`outline: 'none'` 且无 3%–10% 边框混入，键盘焦点只剩底边 1px，也不满足 §13。

`YamlConfigEditorModal` 使用 `Textarea bare`（`YamlConfigEditorModal.tsx:455-471`）叠在高亮层上，CSS `.textareaInput`（`:237-258`）`border:none; outline:none; background:transparent; color:transparent`。这是代码编辑器双层舞台，**不是**设置表单输入，不按形态 ③ 定罪；但也不是形态 ④ 的「搜索框」。单独记：`bare` 绕过原子 Textarea 皮肤，焦点环改走 `.editorViewport:focus-within { box-shadow: inset 0 0 0 1px var(--focus-border-color) }`（`YamlConfigEditorModal.module.css:163-165`）。`--focus-border-color` 定义在 `focus-visible.css:14-18`（10% 混入，贴上限）。

### 5.2 §20 圆角

阶梯（`tokens.css:367-375`）：`--radius-xs: 2px` / `sm: 4px` / `md: 6px` / `lg: 8px` / `xl: 12px`。`--button-radius: 8px`。禁止 5px、7px、14px、17px 等野值。

**仍在的野值：**

```css
/* ModelsSettingsTab.module.css:733 */
.mrdCurrencyToggle {
  border-radius: 5px;
}

/* ModelsSettingsTab.module.css:685 — 4px 可用 token 却裸写 */
.mrdModalityChip {
  border-radius: 4px;
}

/* ScanResultsModal.module.css:74 */
.customCheckbox {
  border-radius: 4px;
}

/* ComposerFusedTrigger.module.css:12 */
.capsule {
  border-radius: 14px;
}

/* ModelBadgePickerMenu.module.css:89, 216, 226, 302 */
border-radius: 4px;   /* settingsBtn，可用 --radius-sm */
border-radius: 8px;   /* thinkingTrack，可用 --radius-lg / --button-radius */
border-radius: 6px;   /* thinkingPill / advancedItem，可用 --radius-md */
```

```tsx
/* ProfileHeader.tsx:197, 215 */
borderRadius: '5px',

/* ManualAddForm.tsx:191 */
borderRadius: 'var(--radius-md, 8px)',  /* SSOT --radius-md 是 6px，fallback 写成 8px */
```

`--sep-radius-outer: 14px` 是 SEP 浮层 token（`tokens.css:193`），菜单外壳用它（`.cascadeFlyout`、`.mbMenu`、`.ComposerFusedTrigger .menu`）算消费 SSOT。Composer **外层胶囊** `14px` 则是把 SEP 外壳半径套到 28px 高的触发条上，不是 `--radius-*` 阶梯；§20 对「全局主底栏」允许胶囊，但应走 `--radius-full` / `--sep-pill-radius`，而不是裸 `14px`。

`ScanResultsModal.module.css:32`：`border-radius: var(--radius-md, 8px)`——变量名是 md（6px），fallback 写成 8px，自相矛盾。

### 5.3 07 点名的魔术间距（Wave 4 未动）

间距 token 里其实有 `--space-1_25: 5px`、`--space-1_75: 7px`、`--space-2_5: 10px`（`tokens.css:763-766`）。问题是 **裸像素，不引用 token**。

| 位置 | 原样 | 应对 token |
| :--- | :--- | :--- |
| `ModelsSettingsTab.module.css:408` | `margin-top: 10px;` | `var(--space-2_5)` |
| `:627` `.mrdSubSection` | `padding: 8px 10px;` | `var(--space-2)` / `var(--space-2_5)` |
| `:677` | `gap: 5px;` | `var(--space-1_25)` |
| `:684` `.mrdModalityChip` | `padding: 2px 7px;` | `var(--space-0_5)` / `var(--space-1_75)` |
| `:712` `.mrdThinkingTable` | `gap: 5px;` | `var(--space-1_25)` |
| `:739` `.mrdCurrencyBtn` | `padding: 1px 7px;` | 1px 不在间距阶梯 |
| `:194` `.mrdStatusBtn` | `height: 26px;` | 默认档 `--control-height-sm` 是 28px；26px 只出现在 compact 密度覆写 |
| `ModelThinkingEditor.tsx:140` | `height: '26px'` | `size="sm"`（28）或 `xs`（24） |
| `ModelThinkingEditor.tsx:154,166` | `height: '22px'` | 不在默认阶梯（compact xs 才是 22） |
| `ModelConfigPanel.tsx:149` | `height: '20px'` | **阶梯外** |
| `ModelList.tsx:191,230,252` | `height: '26px'` | 同上 |
| `ModelListHeader.tsx:101` / `ScanResultsModal.tsx:182` | `style={{ width: '150px' }}` | 魔术宽度 |

`.mrdModelRow` `padding: 9px 12px`（`:287`）的 9px 也不在 `--space-*`。

---

## 六、人体工学专项（保存钮 / 思考卸载 / 双重开关 / Emoji / Tooltip）

### 6.1 保存按钮仍会被抽屉滚出视口

滚动链（当前代码，不是 07 的旧测量）：

1. `ModelConfigEditor.tsx:82-88`：`.modelsDetail` **内联** `overflow: hidden; height: 100%; flex column`。
2. 段一凭据钉头 + 段二操作栏 `flexShrink: 0`。
3. 段三 `mrd-model-list-scroll`（`:196-206`）`flex: 1 1 0; minHeight: 0; overflowY: auto` —— **唯一真正滚动口**。
4. 其内 `ModelList` → `.mrdModelList { overflow: hidden }`（CSS `:280`）→ `.mrdModelRow` → `ModelConfigPanel` → `.mrdCfgFooter { position: sticky; bottom: -12px }`。

CSS sticky 的包含块是最近的 overflow ≠ visible 祖先。`.mrdModelList { overflow: hidden }` 把 sticky 锁在「和内容一样高、自己不滚」的盒子里，对用户正在滚的 `mrd-model-list-scroll` **零吸附**。`bottom: -12px` 再往外拽 12px，是给父级 padding 的补偿补丁（§7 禁补丁）。

`ModelConfigPanel.tsx:241` 注释仍写「绝对首屏可见，无需滚动」——与布局事实相反。

思考模型展开后，抽屉内仍是：基础三字段 + 多模态 + 思考表（5 行 Input）+ 四维价格 + CapEditor + 保存。列表滚动口高度 = 右栏减去钉头凭据（Base URL + Key + 协议）再减去搜索栏。笔记本窗口下保存钮在展开思考模型、或展开的不是第一行时，**必须滚**才能点到。Wave 4 的 sticky 没有改变这个物理事实。

### 6.2 非思考模型 thinking 编辑器：设置侧物理卸载

```tsx
/* ModelConfigPanel.tsx:212-231 */
{cfgDraft.thinkingEnabled && (
  <ModelThinkingEditor
    enabled={cfgDraft.thinkingEnabled}
    onEnabledChange={(en) => { /* 仍传入，子组件已改名为 _onEnabledChange 丢弃 */ }}
    ...
  />
)}
```

`thinkingEnabled === false` 时 React 返回 `false`，`ModelThinkingEditor` **Unmount**，不是 CSS `hidden`。`ModelConfigPanel.test.tsx:82-88` 覆盖。此项维持 PASS。

聊天侧：

```tsx
/* ComposerFusedTrigger.tsx:67-71, 105-106 */
const isThinkingModel = Boolean(
  modelMeta?.capabilities?.reasoning ||
  (modelMeta?.thinking && Object.keys(modelMeta.thinking).length > 0) ||
  (efforts?.offered && efforts.offered.length > 0)
);
{isThinkingModel && ( /* 思考档按钮 */ )}
```

非思考模型物理不渲染右槽。合规。

`ModelBadgePickerMenu.tsx:230-275`「高级选项」手风琴内的思考轨 **始终存在**（折叠，不是按 `reasoning` 卸载）。`thinkingLevelOptionsFor(null)` 仍至少渲染「默认」一粒（`thinkingGear.ts:95-107`）。非思考模型打开高级选项仍看到「思考强度」。与 Composer 物理隐身不一致。

### 6.3 思考双重开关

Wave 4 已删除 `ModelThinkingEditor` 头部 `Switch`。测试 `ModelThinkingEditor.test.tsx:115-125`：`queryByRole('switch')` 为 null。自杀式 Unmount（点内部开关导致自身消失）**已不存在**。

残留：

- props `enabled?` / `onEnabledChange?` 仍在；实现里 `enabled = true`，`onEnabledChange: _onEnabledChange` 丢弃。
- `{enabled && (`（`ModelThinkingEditor.tsx:102`）仍包着表格。父级已按 `thinkingEnabled` 决定是否挂载，这段短路在生产路径上恒真，是死分支。
- 启闭单源 = 抽屉底部 `CapEditor` 的「推理」`Switch`（`CapEditor.tsx:21-33`，标签来自 `MODEL_CAPABILITY_OPTIONS`「推理」）。关掉「推理」仍会把整块思考表 Unmount——这是单源，不是双重开关。

聊天侧双重 **入口**（不是双重开关）：Composer 胶囊档位 + Picker 高级选项档位，两处都能写 `defaultThinkingLevel`。样式两套（Composer 无绿光晕；Picker `activePill` 有 `rgba` 硬阴影）。

设置抽屉映射表 UI 文案是英文 TitleCase（`Off/Low/Max`），Composer/Picker 档位是中文（`关闭/低/最大`，`THINKING_LEVEL_LABELS`）。同一「思考档」两套语言。

### 6.4 Emoji（§21）

UI 字符串、按钮、placeholder、Tooltip content：**未检出** Emoji。图标为 Lucide（`BrainCircuit`/`Layers`/`CircleDollarSign`/`Sparkles`/`Check` 等）。`YamlConfigEditorModal` 脏标记是几何字符 `●`（`:329`），不是 Emoji。

`ModelProfileList.tsx:82,104,176,193,307,344` 源码注释含 `🌟`，不进入界面。

### 6.5 Tooltip（§12）

本域交互控件使用项目 `Tooltip`：`ModelList` 配置/删除/连通性/延迟徽章、`ModelListHeader`、`ScanResultsModal` 已存在勾、`ModelThinkingEditor` 删除档位、`ProfileHeader` 重命名/删除、`ComposerFusedTrigger` 思考档、`ModelBadgePicker` 徽标、`ModelBadgePickerMenu` 设置钮。

未发现用 HTML `title` 做主悬停提示的按钮。`ModelsSettingsTab.tsx:434-440` 的 `title=` 是 `SettingsPage`/`SettingsSection`/`SettingsRow` 的标题 prop。

---

## 七、聊天侧模型徽标 / 档位（07 未覆盖，本轮补扫）

### 7.1 `ModelBadgePicker`（`ChatHeaderControls.tsx`）

- 外壳 class `ChatCard.module.css:100-126`：`height: var(--control-height)`、`border: none`、`background: transparent`、hover `var(--bg-hover)`。色走 token。
- 内联只有布局（`cursor`/`ellipsis`），无色值。
- Tooltip 合规。

### 7.2 `ComposerFusedTrigger` 对徽标的穿透补丁

```css
/* ComposerFusedTrigger.module.css:37-54 */
.left :global(button.model-badge-btn),
.left :global(button[data-testid='model-selector-button']),
.left :global(button) {
  height: 24px;
  min-height: 24px;
  padding: 0 2px;
  border: none;
  background: transparent;
  /* ... */
}
```

`.modelBadge` 在 `ChatCard.module.css` 里是 `--control-height`（32px），融进胶囊后又被 `:global(button)` 压成 24px。两套高度 SSOT，靠选择器穿透压服——典型补丁，不是 token 对齐。胶囊本身 `border-radius: 14px`（见 §5.2）。分割线 fallback `rgba(0,0,0,0.12)`。选中勾 `color: var(--brand-deep)`（`:172`）——这次 **没有** HEX fallback，是本域少数干净引用。

禁止品牌绿光晕：源码注释与实现一致，思考钮无 `var(--brand)` 底。

### 7.3 `ModelBadgePickerMenu`

- 形态 ④ 搜索框：合规。
- 勾选色 `var(--brand-deep, #059669)`（`.checkIcon:164`，`.mbCheck:326`）—— `#059669` 是另一颗绿，与 `--brand #10b981` / `--brand-deep hsl(160 84% 30%)` 并列第三颗。
- 思考轨 `activePill` 硬阴影 + `#ffffff` fallback：见 4.2。
- `font-size: 10.5px`（`.groupHeader:113`）、`11.5px`（`.advancedItem:303`）脱离字号 token。
- 非思考模型不卸载思考轨：见 6.2。

`useChatModelPicker.ts` 无样式，不记。

---

## 八、门禁盲区（`check-input-guardrails.mjs` 本轮实测全绿）

```
node scripts/check-input-guardrails.mjs
→ ✅ 全仓输入框四态体系防倒退检查 100% 通过
```

它 **放行** 了本报告全部样式债，原因（源码，不是猜测）：

1. **圆角奇葩表不含 5/7/9/10/14**（脚本 `:1175` 只拦 `17|19|23|27|29|31|37|41|43|47`）。`.mrdCurrencyToggle { border-radius: 5px }` 对门禁不可见。
2. **圆角扫描仅 `isInputTarget`**（`:1145`）。货币切换、芯片、复选框、胶囊不是 input，§20 管不到。
3. **原生 `<input>` 白名单包含 `ModelBadgePickerMenu`**（`:1252`）——形态 ④ 合法，但白名单是路径子串，不是「必须同时满足形态 ④ CSS」。
4. **不扫 TSX `style={{}}`**。`ProfileHeader` 第五形态、`ManualAddForm` `#ffffff`、`height: '20px'|'22px'|'26px'` 全部在门禁外面。
5. **不扫幽灵 CSS 变量**。`--surface-primary` 未定义不会失败。
6. **不扫 `rgba()` / `#10b981` / `#fff`**。§14 无自动化守门。

所以：「门禁绿」≠「对齐 token」。07 若只跑 typecheck + 本脚本，会把 Wave 4 的 5 行幽灵 sticky 判成修好。

---

## 九、给主控的总结

1. **不要把 `BATCH-UNIFY-04` 的「原生 Token 样式」当成已验收。** 样式域真实动作是：保存钮回归 `variant="primary"`、拆掉思考内嵌 Switch、给 `.mrdCfgFooter` 加 5 行无效 sticky。07 的魔术像素、HEX fallback、内联改 Button 几何，**原样还在**。
2. **保存钮视口问题未解决。** sticky 写在错误的包含块上，底色还引用了 `tokens.css` 里不存在的 `--surface-primary`。要修就得动滚动链（拿掉 `.mrdModelList { overflow: hidden }` 对 sticky 的截断，或把 footer 移出列表行、钉在 `mrd-model-list-scroll` 视口底），并用真实 `var(--bg-card)`，而不是再补 `backdrop-filter` / `bottom: -12px`。
3. **Token 纯度：** 删除或替换幽灵 `--surface-primary` / `--surface-secondary-raw`（后者 fallback 还是蓝相 `220`，与中性灰 SSOT 冲突）；`#10b981` / `#fff` / `rgba()` 从 `ScanResultsModal`、`YamlConfigEditorModal`、`ManualAddForm`、`ModelBadgePickerMenu`、芯片/货币激活态清掉，只留 `var(--brand)` / `var(--text-on-accent)` / `hsl(… / a)` / `color-mix`。
4. **§19：** `ProfileHeader` 下划线 `Input` 是第五形态，必须改回形态 ③ 或改为非 Input 的只读标题 + 明确编辑态。`ManualAddForm` 去掉 `#ffffff` 覆盖。
5. **§20：** `border-radius: 5px` 与内联 `5px` 改为 `--radius-sm`/`--radius-md`；`--button-radius` 的 fallback 统一 8px；Composer 胶囊用 `--sep-pill-radius` 或 `--radius-full`，不要裸 14px。
6. **内联 style 覆盖 `Button`：** 智能预填 20px、思考表 22/26px、列表行 26px，改走 `size="xs"|"sm"`，把颜色交给 variant，而不是 `style.color`。
7. **思考：** 设置侧物理卸载与内嵌 Switch 拆除成立。收尾应删掉 `enabled`/`onEnabledChange` 死 props 与 `{enabled &&` 死分支。聊天侧 Picker「高级选项」思考轨应对非思考模型物理不挂，与 Composer 对齐。
8. **Tooltip / Emoji / 原子 Input 主路径 / 协议上移 / `!important`：** 本域达标，不必重做。
9. **门禁：** 现有 `check-input-guardrails.mjs` 罩不住本报告。若要防回潮，至少把「非 input 的 5px 圆角」「TSX 内联 height/background HEX」「未定义 CSS 变量」纳入扫描；在那之前不要用「门禁绿」证明样式收口。

**本轮未做：** Tauri MCP 截图/焦点实操（按任务：源码证据为主）。深浅主题下 `--surface-secondary-raw` 蓝相、`#ffffff` 复选框/输入底，是源码级必然结果，不依赖视觉通道。

---

**审计签发**：UI Tokens & Ergonomics Auditor
**状态**：二次审查完成 / Wave 4 未闭合 07 的样式与吸底问题
**产出路径**：`docs/provider-model-unification/audits/16-样式Token与人体工学二次审查.md`
