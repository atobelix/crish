# S6 · 样式 token 与人体工学

> **文档性质**：分维指示文档 / 实现 Agent 任务书。本轮只写方案，不改产品源码。  
> **战役**：`docs/model-config-product-chain/`  
> **维名**：样式 token 与人体工学  
> **依赖**：S2 已闭合（验收必须走真保存面）。可与 S4/S5 并行；与 S3 共享的 Composer/Picker **同文件串行**。  
> **问题全集**：主责 **20、21**；连带闭合思考区卸载残留、门禁盲区、零 Emoji、Tooltip。不接 IPC/出站/计费。  
> **裁决**：`AGENTS.md` §12 Tooltip、§13 焦点、§14 HSLA/token、§19 四态、§20 圆角、§21 零 Emoji；`frontend-review.md` §4.4 幽灵 token。  
> **输入证据**：审计 `07`（Wave 4 前）、`16`（Wave 4 后当前工作区）。本文件锚点按 **当前源码** 复核，不以 07 的过期行号为真。  
> **效果锁一句话**：设置模型抽屉与对话输入区看起来并摸起来符合设计 token 与四态；非思考模型思考区物理消失；保存按钮在抽屉内可达；无 Emoji。**这不是「再加 sticky 5 行」。**

---

## 0. 本维交付的用户可感知增量

用户打开真 Tauri 窗口（4000 MCP，非 `localhost:5174`、非 mock 会话）后，必须同时成立：

1. **设置 → 模型**：展开带思考字典的模型，列表再怎么滚，**保存**都在抽屉滚动口底部可点；点下去走的是 S2 已经接上的 yaml 保存，磁盘出现刚改的字段。
2. **同一抽屉**：表单输入是形态 ③（原子 `Input`，微浅底、细边框、焦点 3%–10% 软灰）；服务商标题编辑不是下划线第五形态；深色主题没有白底输入、白块复选框、蓝相内嵌卡。
3. **非思考模型**：抽屉里 `ModelThinkingEditor` 不在 DOM；Composer 右槽思考档不在 DOM；Picker「高级选项」里的思考轨不在 DOM。不是 `display:none`，不是折叠成一行「默认」。
4. **对话输入区**：Composer 融合触发摸起来是底栏胶囊（形态 ② 的邻接控件），Picker 搜索是形态 ④（全态只有光标）；无原生 `title`、无 Emoji、无品牌绿光晕、无 `rgba` 硬阴影档位药丸。

任一条用「CSS 写了 sticky / 门禁绿 / 单测能找到保存按钮」冒充，视为本维未完成。

---

## 1. 效果与非目标

### 1.1 必须做到

| # | 效果 | 不是什么 |
| --- | --- | --- |
| E1 | 组件只消费 `tokens.css` 里**已经存在**的名字；缺语义时只在 `tokens.css` 补**真实名字**并给深浅两套值 | 在组件里写 `--surface-primary` 这种仓库不存在的变量；把 Material/Radix 的 surface 词塞进本仓 `--bg-*` 体系 |
| E2 | 本域拆除 `#10b981` / `#fff` / `#ffffff` / 散落 `rgba()` / 魔术 `5px 10px 26px 22px 20px`；圆角只走 4/6/8/12（`--radius-sm/md/lg/xl`）或已有胶囊 token | 把 HEX 改成「等价 hsl 字面量」仍当 fallback；圆角写成 5/7/14 野值 |
| E3 | 输入严格四态：① 侧栏搜索、② Composer 胶囊、③ 表单原子 `Input`、④ 浮层搜索。禁止第五形态 | 用 `Input` 再内联改成下划线标题框；用 `#ffffff` 打穿形态 ③ |
| E4 | 保存钮可达：改 **sticky 包含块**（滚动链），不是再贴 5 行 sticky | `bottom: -12px` 补偿 padding；`backdrop-filter` 遮透明底；祖先 `overflow: hidden` 原样留着 |
| E5 | 思考区条件渲染卸载；死 props / 死分支删掉 | 只拆 Switch 却留 `{enabled &&`；Picker 高级选项永远挂思考轨 |
| E6 | 交互控件走项目 `Tooltip`；UI 零 Emoji | 注释里留星标装饰；用 HTML `title` 当悬停 |
| E7 | 验收 = 源码门禁 **且** 真窗口走一遍设置保存 + Composer 档位 | 只截一张图；jsdom `getByRole('保存')` 当「可达」 |

### 1.2 诚实非目标（本维禁止做）

- 改 IPC 命令、DTO、`live_catalog`、出站 dialect、`PricingEngine`、`models.yaml` schema（S1/S4/S5）。
- 改 `useModelConfigSession.saveConfig` 的写盘语义（S2）。本维只保证 **那个按钮能被点到**，并且点到的就是 S2 的 `saveConfig`，不另接一套保存。
- 把 Composer/Picker 的读路径从 LS/`getModelMeta` 迁到 `modelsCatalogStore`（S3）。本维只改显隐与样式；读哪棵树仍由 S3 收口。
- 把 `defaultThinkingLevel` 写入 yaml（问题 18，S2/S3）。
- 全仓清扫 `tokens.css` 里 `--brand: #10b981` 等 **SSOT 定义处** 的 HEX。本维清的是**组件 fallback 与业务 CSS/TSX**。定义处改 HSL 不是本维范围。
- 为「吸底」新造 Portal、第二套固定底栏组件、坐标测距、`scrollIntoView` 补丁。
- 新建设计系统、token 构建器、六段式 CSS 中间件。
- 工期、P0/P1、MVP 砍项。问题 20 与 21 同权，必须都闭合。

### 1.3 对 Wave 4 的定性（实现 Agent 不得再走这条路）

提交 `f98b7f62`（`BATCH-UNIFY-04`）自称「原生 Token 样式」，真实 diff 是：

- `ModelsSettingsTab.module.css` **+5 行**：`.mrdCfgFooter` 增加 `position:sticky; bottom:-12px; background: var(--surface-primary); backdrop-filter; z-index:10`
- 保存钮改为 `variant="primary"`（这件事是对的，保持）
- `ModelThinkingEditor` 拆掉内嵌 `Switch`（这件事是对的，保持）

`tokens.css` **全文 0 处** `--surface-primary`。sticky 的包含块被 `.mrdModelList { overflow: hidden }` 截断。审计 16 的结论本维全盘接受：**那 5 行不是修复，是幽灵 token + 魔术补偿。禁止在其上继续打补丁。**

---

## 2. 当前代码事实（实现对照锚点）

以下行号为方案生成时工作区实况。实现前若漂移，以符号名为准，禁止对着 07 的旧行号改。

### 2.1 幽灵 token 与错误 fallback

| 位置 | 原样 | 事实 |
| --- | --- | --- |
| `ModelsSettingsTab.module.css:438-443` | `background: var(--surface-primary); bottom: -12px; backdrop-filter: blur(8px)` | `--surface-primary` 不存在 → 底栏透明 |
| `ModelsSettingsTab.module.css:623-635` | `hsl(var(--surface-secondary-raw, 220 14% 96%) / 0.35)` | `--surface-secondary-raw` 不存在；fallback 色相 220 违反 `tokens.css:37-46`「pure neutral greys (no blue/purple tint)」与浅色 `hsl(30 2.5% …)` |
| 同文件 `:198 :410 :535 :565` | `var(--button-radius, 7px)` | SSOT `--button-radius` 是 8px（`tokens.css:26,473`）；7px 不在 §20 阶梯 |
| 同文件 `:630` | `var(--button-radius, 6px)` | 同一 token 第三套 fallback |
| `YamlConfigEditorModal.module.css:90` | `var(--brand-primary, #0066cc)` | `--brand-primary` **存在**（`tokens.css:188` = `#10b981`），但 fallback 是 Zero-Blue 禁区蓝 |
| 同文件 `:299` | `var(--success-color, #10b981)` | SSOT 是 `--color-success`（`tokens.css:264`），没有 `--success-color` |
| `ModelBadgePickerMenu.module.css:214` | `var(--bg-surface, rgba(0, 0, 0, 0.04))` | `tokens.css` **0 处** `--bg-surface` |

合法底/表面已经有：`--bg-card`、`--bg-elevated`、`--bg-primary`、`--bg-secondary`、`--bg-tertiary`、`--tint-hover`。面板背景已有现成写法：`.modelConfigPanel`（`:412`）`color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-card))`。

### 2.2 滚动链（sticky 失败的根因，不是「没写 sticky」）

```
.modelsSplit                    overflow: hidden          卡片裁切，在滚动口之外
  .modelsDetail                 CSS overflow-y:auto (:134)
                                TSX 内联 overflow:hidden  (ModelConfigEditor.tsx:82-88)  覆盖 CSS
    .mrdBody                    内联 flex column
      .mrdPinnedHeader          类名在 CSS 模块中不存在；内联 flexShrink:0
      .mrdActionBar             同上
      .mrd-model-list-scroll    内联 overflowY:auto        ★ 唯一真正滚动口
        .mrdModelList           overflow: hidden (:280)    ★ 夹在 sticky 与滚动口之间 → 包含块
          .mrdModelRow
            .modelConfigPanel   padding: 12px 14px (:409)
              .mrdCfgFooter     position:sticky; bottom:-12px
```

CSS sticky 的包含块 = 最近 `overflow ≠ visible` 祖先。`.mrdModelList { overflow: hidden }` 把 sticky 锁在「和内容一样高、自己不滚」的盒子里，对用户正在滚的 `mrd-model-list-scroll` **零吸附**。`bottom: -12px` 是给父级 `padding: 12px` 的补偿（§7 禁补丁）。`ModelConfigPanel.tsx:241` 注释「绝对首屏可见，无需滚动」与布局事实相反。

`styles.mrdPinnedHeader || ''` 恒为空串（`ModelConfigEditor.tsx:113,154,197`）。三段式布局真源在 JSX `style={{…}}`，不在 CSS 模块。

文件头仍写「从 1165 行精简至 ~295 行」（`ModelsSettingsTab.module.css:4`），当前约 **758 行**。自称与事实不符，本维改文件头。

### 2.3 第五输入形态与打穿形态 ③

```tsx
/* ProfileHeader.tsx:79-93 — 形态 ⑤ 下划线标题框 */
style={{
  border: 'none',
  borderBottom: '1px solid var(--border-color)',
  background: 'transparent',
  outline: 'none',
  /* … */
}}
```

四态里没有这一档。`outline: none` 且无 3%–10% 边框混入，不满足 §13。

```tsx
/* ManualAddForm.tsx:171,251,262 */
style={{ background: '#ffffff' }}
```

原子 `Input` 默认底是 `color-mix(in srgb, var(--bg-primary) 40%, var(--bg-card))`（`Input.module.css:33`）。强制白底 → 深色模式形态 ③ 被打穿。

主表单路径（`ProviderProfileForm` Base URL / API Key、`ModelConfigPanel` 三字段、思考映射、四维价格）已经 `import { Input } from '../ui'`，形态 ③ **主路径合规**，不要重做。

`ModelBadgePickerMenu.tsx:167` 原生 `<input>` + `.searchInput` 全态 `border/outline/box-shadow: none; background: transparent`（`.module.css:61-74`）= 形态 ④，**保持**。门禁白名单路径子串合法。

`ModelListHeader.tsx:93-101` / `ScanResultsModal.tsx:174-182` 的 `Input variant="search" size="xs"` 是卡片工具栏，走形态 ③ 可接受（不是侧栏 ①，也不是浮层 ④）。去掉魔术 `style={{ width: '150px' }}`，改 CSS 类。

`YamlConfigEditorModal` 的 `Textarea bare` + 高亮层是代码编辑器双层舞台，**不定**形态 ③/④。本维只清它的 `rgba`/`#fff`/`#0066cc` fallback，不把 yaml 编辑器改成原子 Input。

### 2.4 魔术几何与内联改 Button

| 位置 | 值 | 应对 |
| --- | --- | --- |
| `.modelConfigPanel` `:408` | `margin-top: 10px` | `var(--space-2_5)` |
| `.mrdSubSection` `:627` | `padding: 8px 10px` | `var(--space-2)` / `var(--space-2_5)` |
| `.mrdModalityChips` `:677` | `gap: 5px` | `var(--space-1_25)` |
| `.mrdModalityChip` `:684-685` | `padding: 2px 7px; border-radius: 4px` | `var(--space-0_5)` + `var(--space-2)`；`var(--radius-sm)` |
| `.mrdThinkingTable` `:712` | `gap: 5px` | `var(--space-1_25)` |
| `.mrdCurrencyToggle` `:733` | `border-radius: 5px` | `var(--radius-md)`（6px） |
| `.mrdCurrencyBtn` `:739` | `padding: 1px 7px` | `var(--space-0_5)` + `var(--space-2)`；1px 不在间距阶梯 |
| `.mrdModelRow` `:287` | `padding: 9px 12px` | `var(--space-2)` + `var(--space-3)` |
| `.mrdStatusBtn` `:194` | `height: 26px` | `size="xs"`（24）或 `sm`（28），禁止 26 |
| `ModelConfigPanel.tsx:149` | `height: '20px'` | `size="xs"`，去掉 style.color |
| `ModelThinkingEditor.tsx:140,154,166` | `26px` / `22px` | `size="xs"` |
| `ModelList.tsx:191,230,252` | `height: '26px'` | `size="xs"` |
| `ProfileHeader.tsx:197,215` | `borderRadius: '5px'` | 去掉内联，走 Button 默认 `--button-radius` |
| `ComposerFusedTrigger.module.css:12` | `border-radius: 14px` | 主底栏胶囊例外走 `--sep-pill-radius` 或 `--radius-full`，禁止裸 14px |
| `ManualAddForm.tsx:191` | `var(--radius-md, 8px)` | md 是 6px，fallback 写成 8px；改为 `var(--radius-lg)` 或去掉错误 fallback |

控件高度阶梯（`tokens.css:750-752` + `Button.module.css:93-110`）：xs 24 / sm 28 / md 32 / lg 36。没有 20、22、26。

### 2.5 思考区：设置侧已卸载，聊天侧半截

设置抽屉（合规，保持短路、删残留）：

```tsx
/* ModelConfigPanel.tsx:212-231 */
{cfgDraft.thinkingEnabled && (
  <ModelThinkingEditor enabled={…} onEnabledChange={…} … />
)}
```

`thinkingEnabled === false` 时 Unmount。`ModelConfigPanel.test.tsx:82-88` 已覆盖。

残留：`ModelThinkingEditor` 仍收 `enabled` / `onEnabledChange`，实现里改名为 `_onEnabledChange` 丢弃；`{enabled && (`（`:102`）包着表格——生产路径恒真，死分支。

Composer（合规，保持）：

```tsx
/* ComposerFusedTrigger.tsx:67-71, 106 */
const isThinkingModel = Boolean(
  modelMeta?.capabilities?.reasoning ||
  (modelMeta?.thinking && Object.keys(modelMeta.thinking).length > 0) ||
  (efforts?.offered && efforts.offered.length > 0)
);
{isThinkingModel && ( /* 思考档按钮 */ )}
```

第三条 `efforts?.offered` 会把「描述接口快照有档、yaml 无 thinking」的模型点亮。本维把挂载谓词收成与 yaml 字典同构（见 §6），不在本维改 `thinkingGear.ts` 数据源。

Picker（不合规）：

```tsx
/* ModelBadgePickerMenu.tsx:230-275 */
{showAdvanced ? (
  <div>…思考强度… thinkingLevelOptionsFor(resolveCatalogEfforts(activeModel ?? '')) …</div>
) : null}
```

非思考模型展开「高级选项」仍看到思考轨。`thinkingLevelOptionsFor(null)` 至少渲染「默认」一粒（`thinkingGear.ts:95-107`）。测试 `ModelBadgePickerMenu.test.tsx:282-294` 把「永远看得到思考强度」写成了契约，本维必须改测。

### 2.6 Tooltip / Emoji / `!important`（本域已达标，禁止回潮）

- 交互控件已用项目 `Tooltip`（模型行、扫描弹窗、思考删档、ProfileHeader、Composer、Picker 设置钮）。`Dialog`/`SettingsPage` 的 `title=` 是组件 API，不是 HTML `title`。
- `ComposerFusedTrigger.test.tsx:61` 已断言 `querySelectorAll('[title]').length === 0`。
- UI 文案/按钮/占位符无 Emoji。图标 Lucide。Yaml 脏标记是几何 `●`（`YamlConfigEditorModal.module.css:329`），保留。
- `ModelProfileList.tsx:82,104,176,193,307,344` **注释**含 `🌟`。不进 UI，但 §21 要零 Emoji 字符出现在界面相关源里——本维删掉这些注释装饰，改成无 Emoji 的中文注释。
- `settings-models/`、`ComposerFusedTrigger.module.css`、`ModelBadgePickerMenu.module.css`：`!important` 0 处。保持。

### 2.7 门禁为何放行 5px（必须写进实现认知，否则会再交「门禁绿」）

`node scripts/check-input-guardrails.mjs` 对本域样式债 **exit 0**。原因在脚本本身，不是「5px 合法」：

1. **奇葩圆角正则不含 5/7/9/14**（`check-input-guardrails.mjs:1175` 只拦 `17|19|23|27|29|31|37|41|43|47`）。`.mrdCurrencyToggle { border-radius: 5px }` 对门禁不可见。
2. **圆角扫描仅 `isInputTarget`**（`:1145`）。货币切换、芯片、复选框、胶囊不是 input，§20 管不到。
3. **原生 `<input>` 白名单是路径子串**（`:1252` `ModelBadgePickerMenu`）。形态 ④ 合法，但白名单不验证 CSS 是否仍全态无边框。
4. **不扫 TSX `style={{}}`**。`ProfileHeader` 第五形态、`ManualAddForm` `#ffffff`、`height: '20px'|'22px'|'26px'` 全在门外。
5. **不扫幽灵 CSS 变量**。`--surface-primary` 未定义不会失败。
6. **不扫 `rgba()` / `#10b981` / `#fff`**。§14 无自动化守门。

所以：「`npm run check:input-guard` 绿」≠ 本维完成。Wave 4 就是这样关账的。本维必须补门禁与源码 grep 测（§11），并且真窗口走一遍（§10）。

---

## 3. 与相邻维的接口契约

### 3.1 输入依赖（S2 必须先闭合）

S6 验收的保存钮是 **S2 的真保存面**，不是本维再接一条写路径。

- S2 闭合定义（调度 00）：用户点保存 → `~/.conex/models.yaml` 出现同等字段。
- 当前 `saveConfig` 仍在 `useModelConfigSession.ts:171-191` 走 `applyMetaForModel`（LS 旧轨）。**本维禁止改这个函数。** 若 S2 尚未把 `saveConfig` 改到 `workbench_save_models_yaml` / `modelsCatalogStore.updateModel`，S6 可以改样式与包含块，但 **不得宣称用户侧验收通过**。
- 本维 TSX 里保存钮保持：

```tsx
<Button type="button" variant="primary" size="sm" onClick={saveConfig}>
  保存
</Button>
```

零内联改色（现状 `ModelConfigPanel.tsx:292-299` 已是这样，禁止退回 `variant="secondary" + style.background`）。

### 3.2 与 S3 的文件互斥

| 文件 | S3 职责 | S6 职责 | 并行规则 |
| --- | --- | --- | --- |
| `ComposerFusedTrigger.tsx` | 档位/模型读 `modelsCatalogStore`，订 `models-catalog-changed` | 思考槽物理卸载谓词；禁止改写 settings/LS | **同文件串行**。推荐 S3 先改读路径，S6 再收谓词；若 S6 先做，只动 `isThinkingModel` 与 JSX 短路，不动 `selectLevel` |
| `ComposerFusedTrigger.module.css` | 不碰 | 本维主改（14px、rgba 分割线、穿透高度） | S6 独占 |
| `ModelBadgePickerMenu.tsx` | 列表数据改读镜像 | 高级选项思考轨按模型卸载 | **同文件串行** |
| `ModelBadgePickerMenu.module.css` | 不碰 | 本维主改（rgba、硬阴影、`--bg-surface`） | S6 独占 |
| `thinkingGear.ts` | 数据源 | **禁止动** | — |
| `settings-models/**` | `ModelsSettingsTab.tsx` 水合入口属 S3 | CSS + 抽屉内编辑器样式/卸载残留 | `ModelsSettingsTab.tsx` 若 S3 在改水合，S6 不要改该文件；其余 css/tsx 本维可改 |
| `useModelConfigSession.ts` / `modelsCatalogIpc.ts` / `modelsCatalogStore*` | S2/S3 | **禁止动** | — |

S6 不发明第二套「是否思考模型」表。谓词消费镜像上的 `thinking` 字典（S3 灌入）或抽屉草稿 `thinkingEnabled`（S2 编辑态）。

### 3.3 输出保证（交给 S7 / 防回潮）

S6 闭合后，S7 可以物理删除旧岛，但必须保留本维钉死的：

- 幽灵 token grep 为 0
- 本域 `#10b981` / 业务 `rgba(` 为 0
- `ProfileHeader` 无下划线 Input
- 非思考模型三处 DOM 均为 0（抽屉 / Composer / Picker）
- 保存钮 `variant="primary"` 且包含块正确

S7 重写测试时禁止退回「只断言文档里有个保存按钮」。

### 3.4 本维不输出

- 任何新 IPC
- 任何 yaml 字段
- 任何出站 JSON 形状

---

## 4. Token 纯度：用已有名字，禁止再造幽灵

### 4.1 替换表（实现时逐条勾）

| 禁止（现状） | 改为 | 备注 |
| --- | --- | --- |
| `var(--surface-primary)` | 面板局部变量，见下 | **禁止**在 `tokens.css` 增加 `--surface-primary`。那不是本仓命名 |
| `var(--surface-secondary-raw, 220 14% 96%)` | `color-mix(in srgb, var(--bg-secondary) 55%, var(--bg-card))`（深色同样 mix，不要单独写蓝相 hsl） | 禁止新增 `--surface-*-raw` |
| `var(--bg-surface, rgba(...))` | `var(--bg-tertiary)` 或 `var(--tint-hover)` | 不在 tokens 增加 `--bg-surface`，避免第三套表面词 |
| `var(--success-color, #10b981)` | `var(--color-success)` | 已有 |
| `var(--brand-primary, #0066cc)` | `var(--brand)` | `--brand-primary` 虽存在，本域统一走 `--brand`，去掉蓝 fallback |
| `var(--brand, #10b981)` / `hsl(160 84% 39%)` 字面 fallback | `var(--brand)` | 组件层零 HEX、零「手写 hsl 冒充 token」 |
| `var(--brand-deep, #059669)` | `var(--brand-deep)` | `#059669` 是第三颗绿 |
| `var(--accent-green, #10b981)` 等延迟徽章 | `var(--color-success)` / `var(--accent-red)` / `var(--accent-orange)`，无 HEX fallback | `ModelList.tsx:160-169` |
| `#ffffff` / `#fff` 底或字 | 底 `var(--bg-card)`；强调前景 `var(--text-on-accent)` | 深色主题 `--text-on-accent` 已是深底（`tokens.css:1052`） |
| `rgba(0,0,0,…)` / `rgba(128,…)` / `rgba(239,68,68,0.25)` | `--tint-hover` / `--sep-divider-color` / `--shadow-sm` / `hsl(0 84% 60% / 0.25)` | Yaml 错误横幅已用 `hsl(0 84% 60% / 0.1)`（`:274`），gutter 必须对齐，禁止同一弹窗两套语法 |
| `box-shadow: 0 1px 3px rgba(...)`（`.activePill`） | `var(--shadow-sm)` 或不要阴影、只用 `--tint-hover` 底 | Composer 思考钮无绿光晕、无硬阴影；Picker 对齐 |
| `box-shadow: 0 4px 16px rgba(0,0,0,0.08)`（ManualAdd 建议层） | `var(--sep-shadow)` 或 `var(--shadow-sm)` | 提到 CSS 类，禁止 JS 写 shadow |
| `var(--button-radius, 7px)` / `, 6px)` | `var(--button-radius)` 或 `var(--button-radius, 8px)` | fallback 只能是 SSOT 真值 8px |
| `var(--radius-md, 8px)` | `var(--radius-md)`（6px）或本意是 8 则 `var(--radius-lg)` | `ScanResultsModal.module.css:32` 同错 |
| `z-index: 10`（footer） | `var(--z-sticky)` | `z-index.css:7` 已是 `--z-dock: 10` |

### 4.2 允许在 `tokens.css` 补的「真实名字」

默认 **不新增**。仅当同一语义在本域 ≥3 处且现有 `--bg-*` / `--tint-*` 说不清时，才在 `tokens.css` 的 light **与** dark 各写一次，名字必须落在本仓词表：

- 表面：`--bg-primary|secondary|tertiary|card|elevated`
- 品牌：`--brand` / `--brand-deep` / `--text-on-accent`
- 半径：`--radius-sm|md|lg|xl` / `--button-radius` / `--sep-pill-radius` / `--radius-full`
- 间距：已有 `--space-1_25: 5px`、`--space-1_75: 7px`、`--space-2_5: 10px`（`tokens.css:763-766`）。**5px/10px 不是「没有 token」，是组件裸写像素。** 本维引用 token，不新造 `--space-magic-5`。

禁止新增：`--surface-primary`、`--surface-secondary`、`--surface-secondary-raw`、`--success-color`、`--bg-surface`。

### 4.3 面板底与 sticky 底必须是同一颜色（局部变量，不是全局幽灵）

在 **CSS 模块**里用元素级变量，不要进 `tokens.css`：

```css
.modelConfigPanel {
  --mrd-panel-bg: color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-card));
  background: var(--mrd-panel-bg);
  /* padding 底边收到 footer 上，见 §5 */
}
:global(html[data-theme='dark']) .modelConfigPanel {
  --mrd-panel-bg: color-mix(in srgb, var(--bg-primary) 60%, var(--bg-card));
}
.mrdCfgFooter {
  background: var(--mrd-panel-bg);
}
```

禁止 `backdrop-filter`。那是透明底的遮羞布。

### 4.4 HEX / rgba 拆除范围（本维文件域）

必须清零：

- `apps/crish-desktop/src/components/settings-models/**/*.{css,tsx}`
- `apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.module.css`
- `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css`

不在本维清零（避免借 S6 扫全仓）：`tokens.css` 定义、`ChatCard.module.css` 的 `--bg-surface` fallback、`NotePaperPanel`、`reference/**`。若实现时顺手看到 `ChatCard` 引用 `--bg-surface`，**上报主控**，不擅自扩域。

Lucide 图标颜色：`style={{ color: 'var(--brand)' }}` 可保留为当前色，或改成 CSS 类 `.mrdSubSectionTitle :global(svg) { color: var(--brand); }`。禁止 HEX fallback。

---

## 5. 四态输入（§19）与圆角（§20）

### 5.1 四态对照（本维只允许落在这四格）

| 形态 | 适用（本维相关） | 规则 | 现状 → 目标 |
| --- | --- | --- | --- |
| ① 侧栏搜索 | `SettingsSidebar` / `SidebarNav` | 透明无边框，hover 只在外层 `var(--sidebar-hover)` | **本维不改这些文件**。禁止把模型列表搜索改成 ① |
| ② Composer 胶囊 | `ChatComposer` 发送条；邻接的 `ComposerFusedTrigger` | 大胶囊、无重阴影 | 融合触发是底栏控件，圆角走 `--sep-pill-radius` / `--radius-full`；不要给它加形态 ③ 边框 |
| ③ 表单原子 Input | 凭据、展示名、上下文、思考映射、四维价格、手动添加、ProfileHeader **编辑态**、列表/扫描工具栏搜索 | `import { Input } from '../ui'`；四档尺寸；微浅底；细边框；焦点 8% 混入已在原子层 | 去掉一切 `style` 打穿 background/border/outline |
| ④ 浮层搜索 | `ModelBadgePickerMenu` `.searchInput` | 全态只有光标；`border/outline/box-shadow: none; background: transparent` | **保持**原生 input + 现有 CSS。禁止改成原子 Input（会变成 ③ 边框，破坏 ④） |

**禁止形态 ⑤**：下划线标题框。`ProfileHeader` 编辑态改为无 style 覆盖的 `<Input size="sm" />`（形态 ③）。非编辑态保持 `<h3>`（不是 Input）。不要为了「看起来像标题」去改原子 Input 的边框。

启用/停用钮：不要内联整套边框底色圆角（`ProfileHeader.tsx:128-151`）。用已有 `.mrdStatusBtn.isOn/.isOff`（CSS `:192-213`）或 `Button size="xs"` + 模块 class，颜色走 token。高度 24 = `xs`。

### 5.2 焦点（§13）

- 形态 ③：只靠原子 `Input.module.css:55-63`（8% mix，`box-shadow: none`）。业务层禁止 `outline: 'none'` 且不给替代边框。
- 形态 ④：焦点也无边框（已写 `:focus, :focus-visible`）。禁止给 Picker 搜索加 focus ring。
- 禁止给本域输入加 `box-shadow` 焦点环。
- Yaml 编辑器焦点继续走 `.editorViewport:focus-within` 的 inset 1px `var(--focus-border-color)`（已在上限 10%）。不要改成更重的环。

### 5.3 圆角阶梯

允许：2 / 4 / 6 / 8 / 12 / 胶囊（`--radius-full` / `--sep-pill-radius` / `--radius-switch-track`）。  
禁止：5、7、9、14 **裸像素**（14 只允许作为 `--sep-radius-outer` / `--sep-pill-radius` 的 token 引用，声明里不要写 `, 14px` fallback）。

菜单外壳已是 `var(--sep-radius-outer, 14px)`（Composer `.menu`、Picker `.mbMenu`）：改成 `var(--sep-radius-outer)`，去掉 14px 字面 fallback，以免门禁扩正则后误杀。

芯片/复选框 4px → `var(--radius-sm)`。货币切换 5px → `var(--radius-md)`。思考轨 8px → `var(--radius-lg)` 或 `var(--button-radius)`。思考药丸 6px → `var(--radius-md)`。

---

## 6. sticky 包含块：改滚动链，禁止再贴 5 行

### 6.1 根因（再写一遍，实现不得走错）

失败条件是 **sticky 元素与滚动口之间夹了一个 `overflow: hidden`**。写 `position: sticky` 不能改变包含块。`bottom: -12px`、`backdrop-filter`、幽灵背景都不能改变包含块。

### 6.2 锁定修法（唯一合法路径）

把「钉头 + 操作栏 + 列表滚动」从 TSX 内联提升为 **真实存在的 CSS 模块类**，并保证：

1. **唯一滚动口** = `.mrdModelListScroll`（`overflow-y: auto; min-height: 0; flex: 1 1 0; overscroll-behavior: contain`）。
2. **`.modelsDetail`**：`overflow: hidden`（建立 flex 列，禁止第二根滚动条）。删除 CSS `:134` 的 `overflow-y: auto` 与 TSX 里重复的 flex/overflow 内联。
3. **`.mrdModelList`：删除 `overflow: hidden`**。这是包含块杀手。圆角改由首末行自己画：

```css
.mrdModelList {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: transparent;
  /* 禁止 overflow: hidden / clip / auto */
}
.mrdModelRow:first-child {
  border-top-left-radius: var(--radius-lg);
  border-top-right-radius: var(--radius-lg);
}
.mrdModelRow:last-child {
  border-bottom-left-radius: var(--radius-lg);
  border-bottom-right-radius: var(--radius-lg);
}
```

4. **`.modelConfigPanel`**：左右/上 padding 保留 token 化；**padding-bottom 收到 footer**。这样 footer `bottom: 0` 贴齐面板底边，不需要 `-12px`。
5. **`.mrdCfgFooter`**：

```css
.mrdCfgFooter {
  position: sticky;
  bottom: 0;
  z-index: var(--z-sticky);
  background: var(--mrd-panel-bg);
  padding: var(--space-2) 0 0;
  border-top: 1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent);
  /* 禁止 backdrop-filter；禁止 bottom 负值；禁止 inherit 透明 */
}
```

6. 内联 `onWheel stopPropagation` 可保留（防 Settings 根滚动链穿透），不算样式补丁。

完成后包含块链：

```
.mrdModelListScroll   overflow-y: auto     ← sticky 的滚动口 = 包含块
  .mrdModelList       overflow: visible    ← 不再截断
    .mrdCfgFooter     sticky; bottom: 0
```

展开思考模型、或展开的不是第一行时：footer 贴在列表滚动口底边，内容从它底下滚走。用户不必找保存。

### 6.3 明确禁止的替代

- 再给 `.mrdCfgFooter` 加 5 行 sticky 而不改 `.mrdModelList`。
- 把 footer Portal 到 `document.body`。
- 用 `position: fixed` + 量抽屉 getBoundingClientRect（坐标补丁）。
- 打开抽屉时 `scrollIntoView({ block: 'end' })` 当「可达」。
- 把保存钮复制一份钉在 `.mrdActionBar`（双份保存，假可达）。
- 为圆角保留 `overflow: hidden` 又给 footer `position: sticky`（自相矛盾）。

### 6.4 把内联布局收回 CSS

`ModelConfigEditor.tsx:82-206` 的 flex/overflow/gap 内联，全部变成 `.modelsDetail` / `.mrdBody` / `.mrdPinnedHeader` / `.mrdActionBar` / `.mrdModelListScroll` 的真实规则。TSX 只留 `className` 与 `onWheel`。

`ModelThinkingEditor.tsx:104-112` 表头 grid 内联 → `.mrdThinkingTableHeader`（已有 `.mrdThinkingRow` 同 1fr 1fr 28px，表头应对齐）。

`ManualAddForm.tsx:213-214` `onMouseEnter/Leave` 写 `style.background` → CSS `:hover`。建议层从内联 style 提到模块类（定位仍可用 CSS 变量或已有 portal，颜色/圆角/阴影走 token）。

`ProfileHeader.tsx` 头部 flex 内联 → `.mrdHead` 等模块类（文件里已有 `className="mrd-head"` 全局串，但 CSS 模块没收录——本维收编，避免第三套真源）。

---

## 7. 思考区条件渲染卸载

### 7.1 挂载谓词（三处同一句话）

**思考 UI 挂载 ⇔ 当前模型的 `thinking` 字典非空，或抽屉草稿 `thinkingEnabled === true`。**

- 设置抽屉：继续 `{cfgDraft.thinkingEnabled && <ModelThinkingEditor />}`。启闭单源 = 底部 `CapEditor`「推理」开关（已有，`ModelConfigPanel.tsx:268-276`）。不要把开关加回编辑器头部。
- Composer / Picker：`thinking` 字典非空（镜像字段，S3 灌入前可暂读 `modelMeta.thinking` / `capabilities.reasoning`）。
- **删除** Composer 第三条 `efforts?.offered && efforts.offered.length > 0` 单独点亮。描述接口快照不是 yaml 真源；假阳会让非思考模型冒出档位槽。
- `thinkingLevelOptionsFor(null)` 仍返回「默认」一粒——这是纯函数行为，**调用方**必须先判断模型是否思考再决定是否渲染轨。不要改 `thinkingGear.ts` 去「没 offered 就返回 []」冒充卸载。

### 7.2 删除死代码

`ModelThinkingEditor`：

- 删除 props `enabled` / `onEnabledChange`
- 删除 `{enabled && (` 包层，表格直接渲染（能挂载到树 = 外层已判定思考）
- 父组件不再传这两 props
- 测试不再传入 `enabled={true}`；保持「无 `role=switch`」断言

### 7.3 Picker

`ModelBadgePickerMenu.tsx` 高级选项里，整块 `.thinkingSection`（含标题「思考强度」与 `.thinkingTrack`）用与 Composer 相同的谓词包起来。非思考模型：展开高级选项 **看不到**「思考强度」，DOM 无 `.thinkingTrack`。

测试：

- 思考模型：展开高级选项 → 有思考轨（改写现 `ModelBadgePickerMenu.test.tsx:282-294` 的种子，显式给 thinking 字典）
- 非思考模型：展开高级选项 → `queryByText('思考强度')` 为 null

本维 **不改** `handleSelectThinking` 的 LS 写入（S3）。只决定挂不挂。

### 7.4 文案

设置抽屉映射表 Key 继续 TitleCase（`Off/Low/Max`）。Composer/Picker 现用中文 `THINKING_LEVEL_LABELS`。本维不新造第三套文案表。若 S3 已把选项改成 yaml Key，S6 跟着渲染，不在 CSS 维发明翻译。

---

## 8. Tooltip 与零 Emoji

- 保持所有本域按钮/徽章用 `<Tooltip content={...}>`。新增控件同样。禁止 HTML `title`。
- `ComposerFusedTrigger` 已有无 `title` 测试，保持绿。
- UI 字符串、placeholder、aria-label、Tooltip content：**零 Emoji**。图标只 Lucide。
- 删除 `ModelProfileList.tsx` 注释中的 `🌟`。
- 扫描本域 `[\u{1F300}-\u{1FAFF}]`（实现用脚本或测）为 0。几何 `●`、`⇄` 允许。
- 禁止为「智能预填」等按钮加 Sparkles 以外的表情字符；Lucide `Sparkles` 是矢量，允许。

---

## 9. 任务单元（逻辑序，同权，无工期）

实现按依赖执行，不按「看起来小」跳过。同文件内串行。

### U1 · 包含块与三段式布局收回 CSS

- 文件：`ModelsSettingsTab.module.css`、`ModelConfigEditor.tsx`
- 做：§6.2–6.4。footer sticky 正确包含块。文件头删除「~295 行」谎称。
- 不做：改 `saveConfig`。

### U2 · Token 纯度（CSS 模块）

- 文件：`ModelsSettingsTab.module.css`、`ScanResultsModal.module.css`、`YamlConfigEditorModal.module.css`、`ComposerFusedTrigger.module.css`、`ModelBadgePickerMenu.module.css`
- 做：§4 替换表；魔术间距/圆角；芯片激活态去掉 `#10b981` fallback；复选框浅色底改 `--bg-card`、勾色 `--text-on-accent`；分割线走 `--sep-divider-color` 无 rgba fallback。
- `tokens.css`：默认不改。只有 §4.2 条件满足才补真实名字（本方案预期 0 个新名）。

### U3 · 拆除第五形态与内联打穿

- 文件：`ProfileHeader.tsx`、`ManualAddForm.tsx`、`ModelConfigPanel.tsx`、`ModelThinkingEditor.tsx`、`ModelModalitiesEditor.tsx`、`ModelPricingEditor.tsx`、`ModelList.tsx`、`ModelListHeader.tsx`、`ScanResultsModal.tsx`
- 做：Input 去 style 打穿；Button 去 height 20/22/26 与 style.color；图标色 `var(--brand)`；表头/建议层进 CSS 类；工具栏按钮用 `size="xs"` 代替内联 28×28（`ModelListHeader` 三颗方钮）。
- 保存钮保持 `variant="primary"` 零 style。

### U4 · 思考区卸载收口

- 文件：`ModelThinkingEditor.tsx` + test、`ModelConfigPanel.tsx`、`ComposerFusedTrigger.tsx`、`ModelBadgePickerMenu.tsx` + test
- 做：§7。与 S3 同文件则等 S3 或只改谓词/JSX。

### U5 · Tooltip / Emoji 收口

- 文件：`ModelProfileList.tsx`（删星标注释）；全本域自检无新增 `title=`、无 Emoji。

### U6 · 门禁补洞与源码测

- 文件：`scripts/check-input-guardrails.mjs`（有限扩正则，见 §11）；新建本域源码契约测（建议 `settings-models/modelSettingsStyleGuard.test.ts`，只读源码字符串，不渲染）
- 做：让「再写 `--surface-primary` / `border-radius: 5px` / `#10b981` fallback」在本域变红。
- 不做：把全仓 `tokens.css` 的 `--brand: #10b981` 扫成失败。

### U7 · 真窗口验收（4000 Tauri MCP）

- 不改产品代码。按 §10.2 逐步操作并记录。S2 未闭合则报告「样式链已改、保存面未闭合，本维用户侧未验收」。

---

## 10. 文件域与禁止动

### 10.1 本维可写

```
apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css
apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx
apps/crish-desktop/src/components/settings-models/ModelConfigPanel.tsx
apps/crish-desktop/src/components/settings-models/ModelConfigPanel.test.tsx
apps/crish-desktop/src/components/settings-models/ModelThinkingEditor.tsx
apps/crish-desktop/src/components/settings-models/ModelThinkingEditor.test.tsx
apps/crish-desktop/src/components/settings-models/ModelModalitiesEditor.tsx
apps/crish-desktop/src/components/settings-models/ModelPricingEditor.tsx
apps/crish-desktop/src/components/settings-models/ProfileHeader.tsx
apps/crish-desktop/src/components/settings-models/ManualAddForm.tsx
apps/crish-desktop/src/components/settings-models/ModelList.tsx
apps/crish-desktop/src/components/settings-models/ModelListHeader.tsx
apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx
apps/crish-desktop/src/components/settings-models/ScanResultsModal.tsx
apps/crish-desktop/src/components/settings-models/ScanResultsModal.module.css
apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css
apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.tsx
apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.module.css
apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.test.tsx
apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx
apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css
apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.test.tsx
apps/crish-desktop/src/styles/tokens.css          # 仅当 §4.2 真正缺名；预期不改
scripts/check-input-guardrails.mjs                # §11 有限扩
apps/crish-desktop/src/components/ui/Input/input-three-patterns-guard.test.ts  # 只追加本域断言，不改四态定义
```

`ProviderProfileForm.tsx`：形态 ③ 已合规。仅当实现时发现内联 `fontSize: 11px` 要收进 CSS 才动；**不要**在本维改协议 Select 的选项/IPC。

`YamlConfigEditorModal.tsx`：默认不改逻辑；若 `bare` Textarea 无样式债则只动 CSS 模块。

### 10.2 禁止动（越权即本维失败）

- `useModelConfigSession.ts`、`useModelProfilesState.ts`、`modelsIpcHelpers.ts`、`modelsCatalogStore*`、`modelsCatalogIpc.ts`、`modelsCatalogTypes.ts`
- `crates/**`、`apps/agent-workbench/src-tauri/**`（IPC/出站）
- `thinkingGear.ts`、`engine_provider.rs`、`dialect.rs`、`pricing.rs`
- `ChatComposer.tsx` / `ChatComposer.module.css`（形态 ② 本体不在本维重做；只动融合触发）
- `Input.module.css` / `Button.module.css`（原子层焦点 8% 已合规；不要为了抽屉去改全站 Input）
- 任何 `git commit` / `reset --hard` / `checkout`

---

## 11. 验收断言

分三层写。禁止用 A 冒充 B。

### 11.1 源码形状（可 grep / 单测，必要但不充分）

本域（§4.4 文件集）同时为 0：

```
--surface-primary
--surface-secondary-raw
--success-color
--bg-surface
#10b981
#0066cc
#059669
#ffffff          # 业务 CSS/TSX；不要扫 tokens.css
#fff             # 同上，注意不要误伤 word-wrap 等
rgba(
border-radius:\s*5px
border-radius:\s*7px
borderRadius:\s*'5px'
height:\s*'20px'
height:\s*'22px'
height:\s*'26px'
bottom:\s*-12px
backdrop-filter
```

`.mrdModelList` 不得再声明 `overflow: hidden`（可用测读 CSS 文本）。  
`.mrdCfgFooter` 必须含 `position: sticky`、`bottom: 0`、`background: var(--mrd-panel-bg)` 或与面板相同的 `color-mix`，且 **没有** `--surface-primary`。  
`ModelsSettingsTab.module.css` 必须存在非空的 `.mrdPinnedHeader` / `.mrdActionBar` / `.mrdModelListScroll` 规则。  
`ProfileHeader.tsx` 编辑态 `Input` 的 `style` 不得含 `borderBottom` / `border: 'none'`。  
`ManualAddForm.tsx` 不得出现 `background: '#ffffff'`。  
`ModelThinkingEditor` 源码不得出现 `onEnabledChange` / `enabled?`。  
`ModelBadgePickerMenu.tsx` 思考轨 JSX 必须在思考谓词内部。  
`ComposerFusedTrigger.tsx` 不得再用 `efforts?.offered` 单独点亮右槽。  
本域无 HTML `title="`（组件 API `title={` 的 SettingsPage/Dialog 除外，可用白名单测）。  
本域 TSX/CSS 无 Emoji 图形字符。

**单测（jsdom）必须有、但不得当可达证明：**

- 已有：非思考模型无「思考推理」文案；思考模型有 TitleCase 表；无内嵌 switch；协议控件 0；Composer 无 `title`。
- 新增：非思考模型 Picker 高级选项无「思考强度」；思考模型有。
- 新增：源码契约测（读文件字符串）覆盖本节 grep。
- **禁止**新增「render 面板 → getByRole 保存 → pass」并在报告里写「保存钮可达」。问题 23 那种假绿本维不准再产。

### 11.2 门禁命令（本会话真跑）

```
node scripts/check-input-guardrails.mjs
npx vitest run apps/crish-desktop/src/components/settings-models apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.test.tsx apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.test.tsx apps/crish-desktop/src/components/ui/Input/input-three-patterns-guard.test.ts
```

`check:input-guard` 必须在扩正则后仍绿。若扩正则误伤 `--sep-radius-outer` 的 `, 14px` fallback：先删本域 fallback，再扩。

门禁有限扩（反过度设计：不要写成通用 CSS 编译器）：

1. 奇葩圆角正则加入 `5|7|9`（`check-input-guardrails.mjs:1175`）。
2. 对路径包含 `settings-models` / `ComposerFusedTrigger` / `ModelBadgePickerMenu` 的 CSS，**即使不是 input** 也跑圆角野值扫描。
3. 不在本脚本扫全仓 HEX（误伤 tokens）。HEX/幽灵变量交给 U6 的本域源码测。

### 11.3 真窗口（4000 Tauri MCP，强制）

前提：`npm run dev:workbench` debug 构建；MCP `127.0.0.1:4000`；**禁止** 9222 CDP；**禁止** 只开 `http://localhost:5174`；**禁止** mock 会话（「测试会话 A/B/C」）。操作前用 `query_page` 确认真实工作区 / 真实 LocalStorage 键（如 `crish_session_index_v1`）已水合。

逐步（每步记录 MCP 交互，不是截一张完成图）：

1. **开设置 → 模型**。选一个服务商。确认凭据区 Input 是形态 ③（有细边框、无下划线、无厚阴影）。自定义服务商点标题进入编辑：仍是形态 ③，不是底边 1px。
2. **展开非思考模型**：DOM 无「思考推理」区块；有多模态与四维价格；底部有保存。
3. **展开思考模型**（思考字典非空）：思考表出现。把列表滚到尽头再滚回来——**保存仍钉在列表滚动口底边**，可点击。用 MCP `query_page` 看 footer 与滚动口的几何：footer 底边与滚动口底边重合（允许 1–2px 发丝），不是在视口外。
4. **改一个可见字段（展示名或一档 Wire 值）→ 点保存**。断言磁盘 `~/.conex/models.yaml` 出现该字段（读文件，不是读 UI 文案）。若保存无 yaml 变化：S2 未闭合，本维样式可完成但 **用户侧验收失败**，写进报告，不准改 saveConfig 来「顺便修」。
5. **深色主题**切一次：无白底 Input、无白复选框、内嵌卡无蓝相。
6. **回对话**：非思考模型 Composer 右槽不存在（无「思考档位」按钮，无分割线空槽）。思考模型右槽存在；点开档位菜单；无原生 title 气泡；无 Emoji。
7. **打开模型 Picker**：搜索框形态 ④（打字时无边框高亮）。非思考模型「高级选项」无思考轨；思考模型才有。档位药丸无双层 rgba 硬阴影。

只截图不点保存、不读 yaml、不切深色、不测 Picker，视为未验收。

---

## 12. 防回潮（S6 之后必须钉死的反例）

实现落地后这些反例必须立刻失败：

| 反例 | 钉法 |
| --- | --- |
| 再写 `var(--surface-primary)` | 本域源码测 + grep |
| `.mrdModelList { overflow: hidden }` 配 sticky footer | 源码测：二者不得共存 |
| `bottom: -12px` / `backdrop-filter` 在 footer | 源码测 |
| `ProfileHeader` 下划线 Input | 源码测 `borderBottom` |
| `background: '#ffffff'` 打在 `Input` 上 | 源码测 |
| `border-radius: 5px` 在本域 CSS | 扩后的 input-guard + 本域测 |
| Picker 对非思考模型渲染「思考强度」 | 组件测 |
| Composer 用 `efforts.offered` 单独点亮 | 源码测 |
| 保存钮 `variant="secondary"` + 绿底内联 | 源码测 |
| 本域 UI 字符串出现 Emoji | 源码测 |
| 用 HTML `title` 做模型行悬停 | 已有 Composer 测；本域补 `title="` 扫描（排除 Dialog API） |

S8 轮次报告应能只跑本节 grep/测，不必重读审计 07/16。

---

## 13. 问题全集对应

| 编号 | 题面 | 本维动作 |
| --- | --- | --- |
| 20 | 幽灵 `--surface-primary`；魔术间距；`#10b981` fallback；第五输入形态 | U2+U3+U6 全做。主责闭合 |
| 21 | sticky 被祖先 overflow 截断 | U1 改包含块。主责闭合 |
| （07 残留，无独立编号） | 保存钮 secondary 绿涂 | 已是 primary，U3 保持，测钉死 |
| （07/16） | 思考双重开关 | Switch 已拆；U4 删死 props/死分支 |
| （16） | Picker 思考轨不按能力卸载 | U4 |
| （16） | 聊天侧 rgba / 硬阴影 / 14px / `--bg-surface` | U2 |
| （16） | 门禁放行 5px 与内联 HEX | U6 |
| 23 的「只断言有保存按钮」 | 不在本维重写全套测试（S7），但本维 **禁止再产** 这种测，可达只认 §11.3 |
| 1–19、22、24 | 写路径/读路径/出站/计费/双字段/fallback | **本维不碰** |

问题 20 与 21 **同权**。只修 token 不修包含块 = 未完成；只修包含块不拆第五形态 = 未完成。

---

## 14. 实现 Agent 自检（交工前）

- [ ] 没有新增 `--surface-*` / `--bg-surface` / `--success-color`
- [ ] `tokens.css` 若有 diff：每个新名在 light+dark 都有真实值，且能说清现有 token 为何不够
- [ ] `.mrdModelList` 无 `overflow: hidden`；footer `bottom: 0`；无 `-12px`、无 `backdrop-filter`
- [ ] 本域业务文件 grep `#10b981` / `rgba(` / `#ffffff` 为 0
- [ ] ProfileHeader 无下划线 Input；ManualAddForm 无白底
- [ ] 思考编辑器无 enabled 死 props；Picker/Composer 非思考 Unmount
- [ ] 未改 `saveConfig`、IPC、出站、`thinkingGear.ts`
- [ ] 未用 `--no-verify`；未 commit
- [ ] §11.1 源码测绿、§11.2 命令本会话真跑、§11.3 MCP 逐步记录（或显式写「S2 未闭合，用户侧未验收」）
- [ ] 无工期/P0 叙述；无「先做 sticky 5 行、圆角以后再说」

---

## 15. 给主控的冲突点（不私自改效果）

1. **S2 未闭合时 S6 能否先改 CSS？** 能改文件，不能关用户侧验收。调度允许 S6 在 S2 后启动；若并行错序，主控应挡住「已完成」叙事。
2. **S3 与 S6 同改 `ComposerFusedTrigger.tsx` / `ModelBadgePickerMenu.tsx`。** 必须串行。谓词收口（删 `efforts.offered` 假阳）属 S6；读 store 属 S3。
3. **`--brand` 在 tokens 里仍是 `#10b981`。** 本维不改 SSOT 定义。若审计后续要求 tokens 本体改 HSL，另开任务，不要混进 S6 把全仓品牌定义掀掉。
4. **Composer 胶囊 14px：** 几何上等于 28px 高的半高胶囊。本维走 `--sep-pill-radius` / `--radius-full`（§20 允许主底栏胶囊），不把融合触发改成 8px 方钮。
5. **旧 unification `plans/04` 里的 sticky+backdrop 示例与生产级整文件粘贴。** 本战役作废。实现 Agent 禁止从那份 04 拷 CSS。

---

**产出路径**：`docs/model-config-product-chain/plans/06-样式token与人体工学.md`  
**状态**：分维指示定稿（对照当前源码 + 审计 07/16）。实现轮按任务单元执行；本文件不改产品源码。
