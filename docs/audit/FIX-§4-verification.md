# §4 修复抽查 · FIX-§4-verification

> 核查人：code-audit · 2026-09-08（America/New_York）  
> 标准：`QUALITY-GATE.md` 可证伪  
> 对照：`FIX-PROGRESS-§4.md` · 前置 §3 有条件通过  
> 修订：同日追加核验 `check:blocked-executable-ssot` 正式挂名

## 总裁定：**§4 通过（门禁具名项已齐）**

| 小节 | 标记 | 说明 |
|------|:----:|------|
| §4.1 Preview origin / targetOrigin / 同源策略 | `[x]` | 无 `postMessage(..., '*')` |
| §4.2 骨架 drag-region 单层 | `[x]` | 仅 `#skel-app` |
| §4.3 可执行后缀前后端 SSOT | `[x]` | 门禁 PASS |
| R3-1 File.path 转发 | `[x]` | `pathBatch` → `handlePathsSelected` |
| check:no-nonvision-dataurl 正式挂名 | `[x]` | 已进 `check:desktop` |
| check:blocked-executable-ssot 正式挂名 | `[x]` | **本轮升格**（见下） |

可进入 / 已在进 §5。R4-1（`Sec-Fetch-Site: none` 策略权衡）仍为非阻断备注。

---

## 追加 · blocked-executable 具名接线 `[x]`

**可证伪**

- `package.json`：`check:blocked-executable-ssot` = `node scripts/check-blocked-executable-ssot.mjs`
- `check:desktop` 链含该脚本，且位于 `check:no-pseudo-dispatch` **之后**
- `check-no-pseudo-dispatch.mjs`：注释写明 §4.3 不再双扫；无 `check-blocked-executable-ssot` 嵌入调用（`BES_EMBED_GONE` 语义成立）
- 活跑：`check-blocked-executable-ssot.mjs` PASS；`check-no-pseudo-dispatch.mjs` PASS（sec4.1/4.2）

---

## §4.1–4.3 / R3-1（沿用前轮，未回退）

- origin 白名单 + 明确 `targetOrigin`；`sameOriginRequest` 单轨  
- 骨架仅外层 drag-region  
- 前后端可执行后缀同表 + 打开前拦截  
- `handleFilesSelected` → `pathBatch` → `handlePathsSelected`  
- `check:no-nonvision-dataurl` 已在 desktop  

**R4-1 `[~]`（不阻断）**：无 Origin 时接受 `Sec-Fetch-Site: none`——策略权衡，非双轨回潮。

---

## QUALITY-GATE 对照

1–4、6 — 过；5 门禁可执行且具名齐全 — **过**（本轮补齐 bes）。

## 结论

- **§4 闭合通过**（原「有条件」中唯一具名 `[~]` 已消除）。  
- §5 可继续；无需因本项回滚。

_文档由 code-audit 追加核验并升格 bes `[x]`_
