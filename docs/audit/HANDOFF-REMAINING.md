# Crish 系统性修复 · 额度暂停交接文档

> 日期：2026-09-08（America/New_York）  
> 仓库：`C:\Software\conex` · 分支：`refactor/architecture` · 无 git remote  
> 原因：用户额度不足，**主动停掉后台改码**，本文件供后续续跑（人或其他 agent）。  
> 总方案：`docs/audit/SYSTEMATIC-FIX-PLAN.md`  
> 质量闸门：`docs/audit/QUALITY-GATE.md`（实现 → 自测 → FIX-PROGRESS → code-audit 可证伪核查 → 无阻断才进下一节）

---

## 1. 当前状态一句话

**§1–§5 已闭合；§6 有条件通过（差门禁挂名）；§7 落地进行中被中断；§8–§10 与 §2.2 未做。**

侧边栏助手：`main` + `code-audit`（群：Crish 代码审查）。

---

## 2. 已完成（可视为放行）

| 节 | 核查文档 | 要点 |
|----|----------|------|
| §1 基础原语 | `FIX-§1-verification.md` | 路径沙箱、拆 shell 读盘、审批 Null→{}、Token 单轨、`check:markdown-style` / `check:no-pseudo-dispatch` 进 desktop |
| §2.1 拆 stub | `FIX-§2-verification.md` | 物理删除空 dispatch；真 injectSeed/toast；`check-no-pseudo-dispatch` |
| §3 拖放/多模态 | `FIX-§3-verification.md` | 单管道、json 真解析、非视觉脱敏；`check:no-nonvision-dataurl` 已挂名 |
| §4 宿主桥 | `FIX-§4-verification.md` | preview origin、drag-region、可执行后缀 SSOT；`check:blocked-executable-ssot` 已挂名 |
| §5 会话 UI 轨 | `FIX-§5-verification.md` | 测重测、store 订阅、审批显式不可用、confirm 分桶；F5-1 复检通过 |

进度正文：`FIX-PROGRESS-§1.md` … `FIX-PROGRESS-§5.md`（及部分 sec* 别名副本）。

主审审计（改前）：`SUMMARY.md`、`BATCH-*-review.md`、`secondary-*.md`。

---

## 3. 进行中 / 半成品（续跑优先）

### 3.1 §6 便签闭环 — 有条件通过

- 功能：6.1 应急草稿读回、6.2 flush 形式化排空、6.3 生产 crypto 块 ID → 核查 **`[x]`**
- 文档：`FIX-PROGRESS-§6.md`、`FIX-§6-verification.md`
- **剩余 `[~]`**：`scripts/check-sec6-note-drain-entropy.mjs` 已有且本机 PASS，但 **根 `package.json` / `check:desktop` 正式挂名可能未完成**（后台挂名任务被中断）。  
  **续跑第一步**：确认 `package.json` 是否含 `check:sec6-note-drain-entropy`；没有则挂上并去掉任何嵌入双扫；喊 code-audit 把 `[~]`→`[x]`。

### 3.2 §7 渲染纪律 — 落地被中断

摸查已完成：`SCOUT-§7.md`。计划三路：

| 子项 | 内容 | 中断时状态 |
|------|------|------------|
| §7.1 | Markdown 点击 URL 统一 sanitizer | 后台落地任务已停，**需核对工作区是否有未提交半成品** |
| §7.2 | Tiptap DOMPurify 收紧 + 回归测 | 同上 |
| §7.4 | 删技能预览 previewHtml 死轨 | 与 7.2 同路，同上 |
| §7.3 | GFM emoji 默认关（Rust+JS） | 同上 |

**续跑**：`git status` / diff 看 §7 相关文件是否有半截改动；有则收完+测+`FIX-PROGRESS-§7.md`；无则按 `SCOUT-§7.md` 重做。然后 code-audit → `FIX-§7-verification.md`。

---

## 4. 尚未开始（按方案逻辑顺序）

### §2.2 文档伪连通清零
- 文档宣称的铁律必须有脚本/测试接线，否则改口；示例密钥改明显假值。  
- 可与 §9 一并做。

### §8 Rust / crates 与桌面边界对齐
- relay 无默认密钥与失败路径、markdown（HR/emoji/CJK）与前端同一决策、db/会话事务与前端叙事一致 + 契约测。

### §9 防回潮总闸一次性装上
须全部进 `check:desktop`（缺一失败），至少包括方案所列：
1. 禁 chat-injection / 空 dispatch  
2. 禁 localFileReader shell 读盘  
3. 禁业务 CSS 裸 Hex / 双轨标题 token  
4. 禁非视觉 dataUrl/绝对路径进 prompt  
5. IPC 空参与错误码契约  
6. preview postMessage 必须 origin 校验  
7. 应急草稿生产调用 load 路径存在  

（部分已散落实现；§9 是**收齐+去嵌入双扫+文档一致**。）

### §10 验收闭环
- `FIX-ACCEPTANCE.md`：§0 不变量 → 证据（路径/测试/门禁名）  
- code-audit 再跑一轮 `secondary-checklist` 式总复核  
- 三者一致才逻辑闭合；禁止兼容层假装完成  

---

## 5. 建议续跑顺序（逻辑依赖，非排期）

1. **收 §6 门禁挂名** → code-audit 升 `[x]`  
2. **清点并完成 §7**（半成品收口或按 SCOUT 重做）→ 核查  
3. **§8** crates/前端对齐  
4. **§2.2 + §9** 文档与总闸  
5. **§10** 验收文档 + 总复核  

过程中遵守 `QUALITY-GATE.md`；用户偏好多路**不占侧边栏**后台并行，但**上一节无阻断才进下一节**。

---

## 6. 已知摩擦（省额度技巧）

- 根 `package.json` 写入多次被 Auto-review 拦截 → 可嵌入临时门禁再正式挂名，或用户本机手改三行脚本名。  
- 本机连接偶发掉线 → 隔约 5 分钟再试即可，勿狂连。  
- 仓库无 remote → 云端 agent 不好直接用；工作在本地 `C:\Software\conex`。

---

## 7. 关键文件索引

```
docs/audit/
  SYSTEMATIC-FIX-PLAN.md      # 总方案
  QUALITY-GATE.md             # 放行闸门
  SUMMARY.md                  # 改前主审总报告
  SCOUT-§7.md                 # §7 摸查
  FIX-PROGRESS-§1.md … §6.md
  FIX-§1-verification.md … §6-verification.md
  HANDOFF-REMAINING.md        # 本文件
```

---

## 8. 暂停时动作记录

- 用户声明额度不足。  
- main **停止**正在跑的 §6 挂名与 §7 三路后台任务。  
- **未**宣称 §7–§10 完成。  
