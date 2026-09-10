# §1 修复抽查（F4 + 整节闭合）· FIX-§1-verification

> 核查人：code-audit · 2026-09-08（America/New_York）  
> 标准：`QUALITY-GATE.md` 可证伪  
> 对照：`FIX-PROGRESS-§1.md`（F4 已关闭）

## 总裁定：**§1 闭合通过**

| ID | 项 | 标记 |
|----|----|:----:|
| F1 | 无根相对路径硬失败 | `[x]` |
| F2 | 附件入队 / 消息行 convertFileSrc 沙箱 | `[x]` |
| F3 | listPending 契约单测 | `[x]` |
| F4 | package.json 正式挂名 + 去掉嵌入双跑 | `[x]` |

复检清单 1–4 全部勾选。按 QUALITY-GATE，允许进入方案下一节（§3）；§2.2 仍属进度自报未做，不阻断 §1→§3 依赖链上的路径沙箱前置。

---

## F4 `[x]`（本轮可证伪）

**package.json scripts**

- `check:markdown-style` = `node scripts/check-markdown-style-compliance.mjs`
- `check:no-pseudo-dispatch` = `node scripts/check-no-pseudo-dispatch.mjs`
- `check:desktop` 链含：… → `check:input-guard` → `check:markdown-style` → `check:no-pseudo-dispatch` → …（顺序正确）

**嵌入清除**

- `check-input-guardrails.mjs` 中 `SEC14_SEC2_EMBEDDED_GATES` / `runEmbeddedDesktopGates`：**已不存在**（`EMBED_GONE_OK`）

**活跑**

- `node scripts/check-no-pseudo-dispatch.mjs` → `PASS`
- `node scripts/check-markdown-style-compliance.mjs` → 合规通过

---

## F1–F3（沿用上一轮复检，未回退）

- F1：falsify = `REPRO_F1_threw`；无根相对硬失败  
- F2：入队先 assert；`resolveUserImageSrc` 先 assert（**R1 残留**：点击 `handleOpenPath(img.source)` 仍传原始 source——不阻断闭合，建议 §3/收尾统一 assert）  
- F3：`normalize_list_pending_approvals_params` + 契约单测行为断言齐全  

---

## 放行说明

- **§1：通过并闭合**  
- **§3：可以开工**（路径/读盘/IPC 空参/Token 门禁前置已满足）  
- 请 main 同步刷新过期的 `FIX-PROGRESS-sec1-rereview.md`（仍写 F4 未关闭），以免文档双轨  

_文档由 code-audit 勾选 F4 并裁定 §1 闭合_
