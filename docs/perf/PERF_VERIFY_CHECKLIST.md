# Crish Desktop 性能整改 — 人工 QA Checklist

> 对应计划：`docs/perf/MULTI_AGENT_PERF_PLAN.md`（R1–R3）  
> 自动化：先跑 §A，再按 §B–§E 手测。

---

## A. 自动化（提交前）

```powershell
cd C:\Software\conex

npm --workspace @crish/crish-desktop run typecheck

npx vitest run `
  apps/crish-desktop/src/api/StreamRenderBuffer.test.ts `
  apps/crish-desktop/src/api/VirtualScrollManager.test.ts `
  apps/crish-desktop/src/store/autoIndexMiddleware.test.ts `
  apps/crish-desktop/src/store/streamingStore.test.ts `
  apps/crish-desktop/src/api/streamTextBatcher.test.ts `
  packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts `
  apps/crish-desktop/tests/fuzz/stream-buffer.test.ts `
  apps/crish-desktop/tests/fuzz/virtual-scroll.test.ts
```

可选一键：`powershell -File docs/perf/_run_verify.ps1` → 输出 `docs/perf/_verify_out.txt`。

| 项 | Pass? | 备注 |
|----|:-----:|------|
| typecheck 无 **新增** perf 相关错误 | ☐ | 存量 EOPT 错误可记入 backlog，勿当本轮回归 |
| StreamRenderBuffer 单测 | ☐ | 默认无 bridge/hljs；htmlNeeded opt-in |
| VirtualScrollManager 单测 | ☐ | messageId 高度 + expand/clear |
| autoIndexMiddleware 单测 | ☐ | id 集不变不重建 map |
| streamingStore 单测 | ☐ | set/clear/applyStreamText |
| streamTextBatcher + fuzz buffer/vscroll | ☐ | |

---

## B. 流式输出

前置：开一个空会话，用能稳定吐长文的模型；DevTools → Performance（可选）+ Console。

| # | 场景 | 期望 | Pass? |
|---|------|------|:-----:|
| B1 | 普通问答流式 | 气泡持续增长，无明显卡顿/整页闪白 | ☐ |
| B2 | 长 Markdown（标题/列表/表格） | **流式期已是 MD**，不是 plain 结束后才渲染 | ☐ |
| B3 | 流式代码块 | 有代码容器；流式期**不高亮**或不高成本高亮；结束后可高亮 | ☐ |
| B4 | 200 tok/s 或等价快速流（粘贴长 prompt 逼输出） | 主线程可交互；10s 内 Long Task>50ms 尽量 **&lt;2** | ☐ |
| B5 | 流式时滚动查看**更早**消息 | 历史行不应剧烈重排/闪烁 | ☐ |
| B6 | 流式中点 Stop / 切会话 / 再发 | 无残留幽灵 stream；新会话文本不串 | ☐ |
| B7 | 工具调用穿插（shell/read） | 工具卡出现后正文继续追加正确 | ☐ |

**Profiler 提示（B4/B5）**

- 录 5–10s 流式：搜 `highlight` / `prepare` / `layout` 是否在 token 热路径。  
- React Profiler：历史 `ChatAssistantMessageRow` 在 token 期 commit 应接近 0（#10 未完全闭环前可能仍有 session 写触发 — 记缺陷）。

---

## C. 拖拽 / Resize

| # | 场景 | 期望 | Pass? |
|---|------|------|:-----:|
| C1 | 二叉树 leaf sash 拖宽 | 拖中跟手；**仅 pointerup** 进 store/历史 | ☐ |
| C2 | sash 拖中按 Escape | 取消，不写入错误 ratio | ☐ |
| C3 | 工作区列/组分隔条 | 拖中流畅；松手一次 commit | ☐ |
| C4 | 顶栏 / 工作区 Tab 拖拽重排 | translate 跟手；松手后顺序正确 | ☐ |
| C5 | 侧栏 session 拖拽排序 | ghost 不挡点击；松手顺序正确 | ☐ |
| C6 | 拖拽时有 iframe/预览面板 | 指针不丢（iframe 屏蔽生效） | ☐ |

**FPS（可选）**：拖 3s，中位 FPS ≥55；无 Forced Reflow 风暴（Performance 看紫色长条）。

---

## D. Composer 输入

| # | 场景 | 期望 | Pass? |
|---|------|------|:-----:|
| D1 | 中文 IME 连续输入 | 不丢字、不卡首字 | ☐ |
| D2 | 多行粘贴 + 自动增高 | 高度随内容变，无抖动循环 | ☐ |
| D3 | 快速打字时 CPU | keystroke 路径无 pretext prepare | ☐ |
| D4 | 输入中切换 session | draft 不串、不丢（防抖后落盘） | ☐ |
| D5 | 无机器人头像 / 气泡宽度 | 无 Bot 头像节点；气泡靠 CSS，不 RO 量宽 | ☐ |

---

## E. 虚拟列表 / 长会话

| # | 场景 | 期望 | Pass? |
|---|------|------|:-----:|
| E1 | 80+ 条历史滚上下 | 无白块久悬；回到底部按钮可用 | ☐ |
| E2 | expand older / 加载更早 | 锚点不乱跳（messageId 高度保留） | ☐ |
| E3 | 搜索命中跳转（若开启） | 命中行可见，总高度不漂移崩溃 | ☐ |
| E4 | thinking 进行中 | 秒数跳动时**整列表不**每秒全量刷新 | ☐ |

---

## F. 终端批写（R1-B）

| # | 场景 | 期望 | Pass? |
|---|------|------|:-----:|
| F1 | 工具输出多行 shell | 终端一次出现多行，无明显逐行 set 卡顿 | ☐ |

---

## G. 签收

| 角色 | 日期 | 结论（Pass / Fail + 链接 issue） |
|------|------|----------------------------------|
| Dev | | |
| QA  | | |

**已知残留（勿当新回归）**

1. `#10` **正文**路径：renderBuffer 仍可能每帧 `updateMessageText`；行级 streamingStore 订阅是否全接通以代码复查。**工具 intermediate → streamingStore / terminal → session** 已在 Wave 5 落地（见 `wave4-6-perf-notes.md`）。  
2. 全仓 typecheck 可能有与 perf 无关的存量错误。  
3. 侧栏 session 标题量字仍可用 pretext（非输入/流式热路径）。  
4. live resize DOM map 仍 partial（shell S4.3）。

**Wave 4–6 增补纪要**：`docs/plans/progress/wave4-6-perf-notes.md`；方案侧 §12：`MULTI_AGENT_PERF_PLAN.md`。
