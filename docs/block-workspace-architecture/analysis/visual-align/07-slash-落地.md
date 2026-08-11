# 07 · Slash 可见皮落地记录

| 字段       | 内容                                                                      |
| ---------- | ------------------------------------------------------------------------- |
| **日期**   | 2026-08-12                                                                |
| **角色**   | 美学设计 Agent（DomHost catalog DOM + chrome.css group/item 状态）        |
| **文件域** | `packages/block-paper/src/chrome/**` + note-paper 挂载测窄断言            |
| **参考**   | visual-align `04` S1+S2；`05` 宿主最小皮；`06` React 挂载清单；主壳 token |
| **边界**   | **≠ 关 EL-01 / A-BLK-02**；**≠** slash 产品 e2e / `/` 触发全路径          |

---

## 0. 路径选择（读盘结论）

| 层                               | DomHost                      | 本波动作                                                  |
| -------------------------------- | ---------------------------- | --------------------------------------------------------- |
| `BlockChromeDomHost`             | ✅                           | **投影 catalog 最小 DOM**（group / item / empty）         |
| `blockChrome.css`                | ✅                           | **加深 group/item 状态**（hover / active / desc / empty） |
| note-paper `BlockChromeDomMount` | ✅ 已挂（Skeleton + Strict） | 不改挂载逻辑；**测**断言 open 后 catalog 节点             |
| note-paper React 内容行          | 另轨内容投影                 | 不扩第二套 slash React 菜单                               |

> note-paper **已**经 `BlockChromeDomMount` 挂 DomHost 并注入 `slash={slashMenu}` → 可见皮走 **DomHost 投影 + chrome.css**，无需再在 Panel 手写第二套 menu DOM。

---

## 1. 改了什么

### 1.1 DomHost · slash catalog 最小结构

`BlockChromeDomHost.syncSlashHost` 在 `SlashMenuModel.isOpen()` 时：

| DOM      | class / data-*                                                               | 语义                     |
| -------- | ---------------------------------------------------------------------------- | ------------------------ |
| 宿主     | `.bp-slash-host` · `data-bp-slash-host` · `data-slash-open` · `role=listbox` | elevated 浮层容器        |
| 分组     | `.bp-slash-group-label` · `data-bp-slash-group`                              | catalog `group` 字段分段 |
| 项       | `.bp-slash-item` · `data-bp-slash-item` · `data-item-id` · `role=option`     | title + 可选 description |
| 高亮     | `data-active` / `aria-selected` + `aria-activedescendant`                    | 对齐 `activeIndex`       |
| 图标占位 | `.bp-slash-item-icon`                                                        | 标题首字；真 icon 后置   |
| 空态     | `.bp-slash-empty` · `data-bp-slash-empty`                                    | 过滤无结果               |
| 关闭     | `replaceChildren()` + hidden                                                 | 不占布局                 |

**诚实**：项点击 **不** 产 `slash_insert` Intent——宿主仍是呈现投影；确认仍走 `SlashMenuModel.select*` → `submitIntent` → collab sink。

### 1.2 CSS · group / item 状态加深

`blockChrome.css` slash 段（token 全走主壳）：

| 状态             | token / 规则                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- |
| 宿主表面         | `--bg-elevated` + `--shadow-lg` + hairline + `--radius-lg` + flex column + `--dropdown-gap` |
| 分组             | xs + `--text-tertiary`；非首段顶 hairline 分隔                                              |
| 项 hover         | `--bg-hover` / `--tint-hover`（**禁止** accent-blue 整行）                                  |
| 项 active        | `--bg-active` / `--tint-active`（略强于 hover）                                             |
| 项 focus-visible | `--focus-ring`                                                                              |
| 标题 / 描述      | title medium primary；desc xs secondary；ellipsis                                           |
| 图标             | secondary 底 + hairline；active 时边/字略抬                                                 |
| 空态             | 居中 tertiary 提示                                                                          |
| eco              | item / icon `transition: none`                                                              |

### 1.3 导出与测

- `@crish/block-paper`：`BP_SLASH_ITEM` / `BP_SLASH_GROUP` / `BP_SLASH_EMPTY`
- 包测：`w3f_dom_slash_catalog` · `w3f_dom_slash_empty`
- 桌面测：`BlockChromeDomMount` open 后断言 group/item/`data-active`

---

## 2. 未改 / 非目标

| 不做                               | 原因                                |
| ---------------------------------- | ----------------------------------- |
| `/` 键触发、IME 全路径、产品 e2e   | 模型 + A-IME 另轨；**≠ A-BLK-02**   |
| 项点击 → selectItem 接线           | 呈现层禁止旁路 Intent；产品适配后置 |
| 关 EL-01 / 宣称 Notion chrome 完成 | 纪律 R2；视觉皮 ≠ EL                |
| 删除 chrome / note-paper 测试      | 测试资产铁律                        |

---

## 3. 验收对照（`04` S1+S2）

| 验收                                         | 状态                                |
| -------------------------------------------- | ----------------------------------- |
| elevated + shadow-lg 浮层，无 affine 色板    | ✅ CSS token                        |
| open=0 不占布局                              | ✅ `[hidden]` / `data-slash-open=0` |
| 项 hover / active 中性 tint                  | ✅ CSS                              |
| group 标签 + item 密度跟 dropdown/item token | ✅                                  |
| DomHost open → 可见 catalog DOM              | ✅ `w3f_dom_slash_catalog`          |
| note-paper 挂载 open → group/item            | ✅ `BlockChromeDomMount` 测         |
| 过滤无结果空态                               | ✅ `w3f_dom_slash_empty`            |
| **≠** A-BLK-02 / EL 关闭                     | ✅ 明示                             |

---

## 4. 测试（实测）

```text
npx vitest run --config vitest.config.ts packages/block-paper/src/chrome
# → 8 files / 74 tests passed

npx vitest run --config vitest.config.ts apps/crish-desktop/src/components/note-paper
# → 8 files / 42 tests passed
```

---

## 5. 与 EL / 双轨关系

| 可宣称                                             | 不可宣称                           |
| -------------------------------------------------- | ---------------------------------- |
| slash **可见皮**（宿主 + catalog 结构 + token 态） | EL-01 / A-BLK-02 关闭              |
| W3-F DOM 余量加深（catalog 投影）                  | 「slash 产品完成 / Notion 级浮层」 |
| note-paper DomHost 挂载下 open 即见 group/item     | 真 `/` 触发 + 确认写盘全链完成     |

---

## 6. 文件清单

| 路径                                                     | 变更                       |
| -------------------------------------------------------- | -------------------------- |
| `packages/block-paper/src/chrome/BlockChromeDomHost.ts`  | catalog 投影 + data-* 常量 |
| `packages/block-paper/src/chrome/blockChrome.css`        | group/item/empty 状态加深  |
| `packages/block-paper/src/chrome/chrome.w3f_dom.test.ts` | catalog / empty 契约       |
| `packages/block-paper/src/index.ts`                      | 导出 BP_SLASH_*            |
| `apps/crish-desktop/.../BlockChromeDomMount.test.tsx`    | open 后 catalog 断言       |
| `docs/.../analysis/visual-align/07-slash-落地.md`        | 本记录                     |

---

## 7. 修订

| 日期       | 说明                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| 2026-08-12 | 初版：DomHost slash catalog 最小 DOM + CSS group/item 状态；note-paper 已挂 DomHost；≠ 关 EL |
