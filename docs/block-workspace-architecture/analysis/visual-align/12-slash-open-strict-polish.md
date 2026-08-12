# 12 · Slash 打开路径 × Strict 纸面 · 美学 polish 落地

| 字段       | 内容                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| **日期**   | 2026-08-12                                                                                 |
| **角色**   | 美学设计 Agent（§4.2 呈现轮；**不占** ②/③）                                                |
| **配方源** | `08` slash/纸面 token · `09` 双轨落地 · `11` list 同温；主壳 `tokens.css` / `z-index.css`  |
| **对象**   | **slash 打开路径**（React `SlashMenuOverlay`）+ **Strict 纸面**顶栏写模式 chip             |
| **边界**   | **≠ 关 EL-01 / A-BLK-02 / A-SIL**；不做整壳 redesign；禁假关 EL；class / `data-*` 契约不破 |

---

## 0. 纪律钉

| #   | 钉                                                                                        |
| --- | ----------------------------------------------------------------------------------------- |
| R1  | 色/间距/字阶/影 **100% 主壳 token**；竞品只借节奏                                         |
| R2  | 视觉 polish **≠** EL / 真 `/` 全链 e2e 关闭                                               |
| R3  | 块 slash **保留** `--shadow-lg`（域差：chat slash **无影**，禁止互搬）                    |
| R4  | React overlay 与 DomHost `.bp-slash-*` **同公式**；禁止第三套魔法 hex / 裸 `z-index:9999` |
| R5  | 只读 banner 诚实可见；**禁止** disabled 仍 hover 成「可点」假写观感                       |
| R6  | 与 ② 同文件冲突时 **只动 CSS**；不改 TS 业务逻辑                                          |

---

## 1. 本波对齐点（小 polish）

| #      | 点                                     | Token / 公式                                                             | 落点                                     |
| ------ | -------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| **S1** | 浮层滚动条与 `.body` / list 同温       | `scrollbar-width: thin` + `scrollbar-color: --tint-strong transparent`   | `.bp-slash-host`                         |
| **S2** | 只读 banner ≠ 空过滤居中态             | pad `1_5×2`；xs + medium；`--color-info-bg/border/info`；`pe:none`       | `[data-slash-readonly=1]`                |
| **S3** | 只读/pending 项禁点观感                | opacity 0.55；`cursor: not-allowed`；hover/active **透明底**（不染可点） | `:disabled` / `data-slash-item-disabled` |
| **S4** | React 浮层 eco 过渡                    | `data-perf-tier=eco` 时裸 `.bp-slash-host/item` `transition:none`        | 补：不依赖 `.bp-chrome-root` 祖先        |
| **S5** | 阅读列锚点不溢出                       | `max-width: calc(100% - space-2)`；top/left 仍 space-2 / space-6         | module `.slashOverlay`                   |
| **S6** | Strict 顶栏 `slash=readonly\|writable` | readonly → info soft chip；writable → control-soft 次级字                | `.badge[data-slash-write-mode]`          |

**未改（已够好 / 归 08–09）**

- elevated + hairline + `radius-lg` + **`shadow-lg`** + `z-popover` + 宽 min(280,100%)
- 项 pad=`--item-padding`、图标盒=`--control-height-sm`、hover 中性 tint
- 纸面静默 L0 / 标题级差 / PaperList 三轨（11）

---

## 2. 改了什么（文件清单）

| 路径                                                                     | 变更摘要                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/block-paper/src/chrome/blockChrome.css`                        | slash scrollbar-color；只读 banner；disabled 项；eco 裸 `.bp-slash-*` |
| `apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css` | `.slashOverlay` max-width；Strict 写模式 badge 色；slash 开纸面不抬噪 |
| `docs/.../visual-align/12-slash-open-strict-polish.md`                   | 本记录                                                                |

**未改**：`SlashMenuOverlay.tsx` / Strict Panel TS / class 名 / `data-testid` / `data-slash-*` 契约。

---

## 3. 验收句（观感 · 可点）

| #   | 场景                       | 期望                                                                     | ≠ 关 EL        |
| --- | -------------------------- | ------------------------------------------------------------------------ | -------------- |
| V1  | Strict 打开 `/` 可写       | elevated 浮层 + shadow-lg；项中性 hover；宽约 280；z=popover             | ≠ A-BLK-02     |
| V2  | Strict 打开 `/` **只读**   | 顶栏 compact **info** banner；项半透 + 禁点；**无** hover 染；关后零残留 | ≠ 假写产品完成 |
| V3  | 顶栏 `slash=readonly` chip | 与 banner 同族 info soft；writable 为中性 soft                           | 否             |
| V4  | 默认纸（slash 关）         | 仍干净 L0；**不**因本波回退把手/flavour                                  | ≠ A-SIL e2e    |
| V5  | density / eco / dark       | 全 token；eco 无 slash 过渡抖；dark 无写死 hex                           | 否             |

---

## 4. DOM 契约（不破）

| 契约                                              | 说明                    |
| ------------------------------------------------- | ----------------------- |
| `.bp-slash-host` / `.bp-slash-item` / empty/group | 类名不变；皮增强仅 CSS  |
| `data-slash-open` / `data-slash-ui=react`         | 面板与浮层既有          |
| `data-slash-write-mode=readonly\|writable`        | host + 顶栏 badge       |
| `data-slash-readonly=1` + `*-readonly-banner`     | 只读 banner testid 不变 |
| `data-slash-item-disabled=1`                      | disabled 皮选择器识别   |
| module `.slashOverlay`                            | 仍作 className 锚点偏移 |

---

## 5. 可宣称 / 不可宣称

| 可宣称                                                         | 不可宣称                                   |
| -------------------------------------------------------------- | ------------------------------------------ |
| slash 打开路径皮与主壳 elevated 浮层一体；只读 banner 诚实可辨 | EL-01 / A-BLK-02 / A-SIL 产品 e2e 关闭     |
| Strict 顶栏 write-mode chip 与浮层同信息色语言                 | Notion 级 slash 产品完成 / 真 `/` IME 全链 |
| disabled 不假可点；eco 覆盖 React 裸浮层                       | 本波「关」任何 EL 或 CONN-B 业务已满交付   |
| 小 diff 仅 CSS；契约 class/data-* 保留                         | 视觉 polish = W5-B Strict 产品默认已切     |

---

## 6. 与 08–11 关系

| 文档      | 关系                                                               |
| --------- | ------------------------------------------------------------------ |
| `08`      | token 真源；本波补 **只读/打开路径** 观感缝（08 未单列 banner 皮） |
| `09`      | slash 基础皮已落；本波不回退 shadow-lg / z-popover                 |
| `10`/`11` | PaperList 嵌壳；slash 仍 z-popover，列表根不抬 z                   |
| `00`      | 索引挂 **七期** slash-open / Strict polish                         |

---

## 7. 测试

```text
npx vitest run --config vitest.config.ts \
  packages/block-paper/src/chrome \
  apps/crish-desktop/src/components/note-paper
# 期望：SlashMenuOverlay / Strict w5b / chrome.w3f_* 绿
# 本波仅 CSS；无 snapshot 改契约
```

---

## 8. 修订

| 日期       | 说明                                                                |
| ---------- | ------------------------------------------------------------------- |
| 2026-08-12 | 初版：slash 打开路径 + Strict 只读 banner/chip/disabled 皮；≠ 关 EL |
