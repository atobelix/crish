# BATCH-08～14 代码审计

> 审查范围：`4c8d0d2a` … `b2411850`（含），分支 `refactor/architecture`，机器本地 checkout（未 clone）。
> 证据口径：仅记录有路径/符号可定位的问题。

## 总览评分

| 批次 | Commit | 主题 | 评分 | 一句话 |
|------|--------|------|------|--------|
| BATCH-08 | `4c8d0d2a` | chat-injection 物理废除 | **B-** | 删除面扎实，但派发 API 变空壳后仍被多处调用 |
| BATCH-09 | `383a2bdd` | crates markdown/relay/db | **A-** | 默认密钥清除与 HMAC 向量测试到位；GFM emoji 与 UI 禁 Emoji 铁律冲突 |
| BATCH-10 | `b8b5b69d` | 虚拟滚动代码引擎 | **A-** | LineBuffer/VirtualCodeEngine 架构清晰；测高一次锁定有隐患 |
| BATCH-11 | `46c9162f` | 文件卡片/批注/导航 | **B+** | 批注组件化与换行偏好 SSOT 好；jsonc/jsonl 格式化与大文件 split 有坑 |
| BATCH-12 | `427281e9` | 架构文档沉淀 | **B** | 纯文档；+65k 行体量巨大，缺与实现同步门禁 |
| BATCH-13 | `99b56892` | avatar-studio | **B** | 视口 rAF 节流做得好；超大 TS 数据文件与缺 WebGL/单元测试 |
| BATCH-14 | `b2411850` | Tauri IPC/auth/PTY | **C+** | 凭据/鉴权加固优秀；`listPendingApprovals` 传入 `Null` 可致命令恒失败 |

**综合：B / B-**（BATCH-14 严重功能回归拉低整体）

---

## 按批次发现

### BATCH-08 · `4c8d0d2a` fix(chat-injection)

#### 严重
- （无独立“可利用”级问题；功能空洞见中等。）

#### 中等
- **`dispatchWorkflowAssistantCard` / `slashContextCards` 空壳回潮风险**
  - 路径：`apps/crish-desktop/src/api/workflow-api/workflowAssistantCard.ts` 中 `dispatchWorkflowAssistantCard` 恒 `return null`；`apps/crish-desktop/src/hooks/chat-stream/slashContextCards.ts` 中 `dispatchSkillContextCard` / `dispatchGoalModeCard` / `dispatchGrillMeCard` / `dispatchAttachmentCards` 恒返回 `''` 或 no-op。
  - 仍被调用：`slashSendPreflight.ts`（约 L167/L175/L227/L356）、`ScheduledTasksPanel.tsx`（约 L137）、`SettingsScheduleTab.tsx`（约 L121）。
  - 问题：调用方仍按“已派发卡片”语义前进，实际无时间线反馈；属于半删除死接口，易伪装“已修完”。
  - 建议：删除 stub 与所有调用，或改为显式 `injectSeed`/状态横幅且让调用方处理返回值；加 ESLint/测试禁止再引入 `chat-injection` 路径。

- **`WorkflowConfirmCard` 模块级确认集合无界**
  - 路径：`apps/crish-desktop/src/components/workflow-confirm/WorkflowConfirmCard.tsx` 中 `confirmedPayloadSignatures: Set<string>`。
  - 问题：跨挂载持久化防重复创建合理，但 Set 从不清理；长会话同构 payload 签名碰撞或内存只增不减。
  - 建议：按 sessionId 分桶，或绑定 workflow id，并在会话销毁时清理。

#### 轻微
- **`isContextStateInjection` 标题启发式**（`contextStateUtils.ts`）：除 `metadata.mode === 'context-state'` 外，还用标题「上下文状态切换」/「状态切换」兜底，未来文案改动可能漏判或误判。建议只信 metadata。
- **注入目录物理删除成功**：`apps/crish-desktop/src/components/chat-injection/` 已不存在；`MessageContent` 对非 context-state injection 返回 `null`，防回潮方向正确。
- **`contextInjectionDispatcher` 仍存活**（`streamSession.ts` 约 L179–L206）仅用于 context-state，与 SSOT 一致；需持续门禁防止其它 kind 回潮。

---

### BATCH-09 · `383a2bdd` refactor(crates)

#### 严重
- （无。默认密钥删除属正向修复。）

#### 中等
- **GFM Emoji 短码翻译 vs AGENTS §21 禁 Emoji**
  - 路径：`crates/conex-markdown/src/renderer.rs` 新增 `lookup_gfm_emoji` / `translate_gfm_emoji`，在 `handle_text` 路径对正文做 `:sparkles:` → `✨` 等转换。
  - BATCH-08 写入的 `AGENTS.md` §21 明确「全系统界面杜绝任何 Emoji 字符」。Markdown 渲染结果会进入对话流 UI，形成产品纪律冲突。
  - 建议：默认关闭短码翻译，或仅在显式设置开启；至少与 §21 对齐文档/开关。

#### 轻微
- **HR 行为变更**：`handle_rule` 从“删除 HR”改为输出 `<hr class="md-hr" />`，与历史 JS「`---` → 空」行为分叉；需确认前端 CSS/快照测试已更新。
- **正向**：`crates/conex-relay` 删除 `DEFAULT_SECRET = "conex-flowbit-relay-secret-key-2026"`；`main.rs` 要求 `RELAY_SECRET` ≥32 字节；`ticket.rs` 增加 RFC 4231 HMAC 向量与篡改拒绝测试。
- **正向**：`sanitizer.rs` 去掉纯 CJK 强插 `<wbr>`，减少表格列宽畸变，并补测试。

---

### BATCH-10 · `b8b5b69d` feat(diff)

#### 严重
- （无。）

#### 中等
- **`isMeasuredRef` 永久锁定测高**
  - 路径：`apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx`：`useLayoutEffect` 在测得 `rowHeight`+`charWidth` 后置 `isMeasuredRef.current = true`，之后直接 return。
  - 问题：首帧测在字体/UI 缩放未就绪时会锁定错误标量；用户切换字号/ui-size 后虚拟列表行高错位（滚动跳动/空白）。
  - 建议：监听相关 CSS 变量或 `ResizeObserver` 到 measure 节点，变化超过阈值时重置 `isMeasuredRef`。

#### 轻微
- **剪贴板假成功已修**：`DiffCardFileList.copySingleFilePatch` 改为 `await writeText` 后再 toast（注释标明 audit T24）——做得好。
- **`LineBuffer` / `VirtualCodeEngine`**：typed array 前缀和 + 固定行高 O(1) 通道设计扎实；`MAX_DOM_LINE_CHARS`/`MAX_EXPANDED_LINE_CHARS` 防 Blink 卡死合理。
- **`overflowAnchor: 'none'`** 三处设置，有利于抑制浏览器滚动锚定干扰。

---

### BATCH-11 · `46c9162f` feat(files)

#### 严重
- （无直接安全穿越；路径工具仍拒绝 `..`。）

#### 中等
- **`.jsonc` / `.jsonl` 扩展可点「格式化」但 `JSON.parse` 必败**
  - 路径：`jsonFormatUtils.ts` 中 `JSON_EXT_RE` 含 `jsonc|jsonl|ndjson`，`formatJsonSafe` 仅 `JSON.parse`。
  - 问题：按钮对带注释/多行 JSONL 文件显示后 toast 失败，体验假开通。
  - 建议：格式化入口收窄到纯 `.json`，或为 jsonc 去注释、jsonl 分行处理。

- **`usePlainCodeLoader` 大文件 `split('\n')`**
  - 路径：`hooks/usePlainCodeLoader.ts`：工作区外/回退路径对 `localText` 执行 `localText.split('\n').length`。
  - 问题：与 BATCH-10 消灭全量 split 的目标相反，≥512KB 本地文件会再分配巨量数组。
  - 建议：复用 `LineBuffer` 或只做采样计数/流式计行。

- **`revealPath` 工作区判定在非 Windows 绝对路径上偏松**
  - 路径：`useFileNavigation.ts`：`isInside = rel && rel !== '.' && !rel.startsWith('..') && !rel.includes(':')`。
  - `pathRelativeToRoot` 在不在根下时返回原 `full`；Unix 绝对路径无 `:`，可能被误判 inside。
  - 建议：显式比较 `resolveWorkspacePath` 非空 + 前缀边界（与 `resolveWorkspacePath` 内 A6-H03 同口径）。

#### 轻微
- **`FileAnnotationPopover` 滚动 `requestAnimationFrame` 未在 cleanup 取消**（约 L183）：快速卸载可能对已卸载组件 `setState`。应保存 rAF id 并在 effect cleanup `cancelAnimationFrame`。
- **`writeTextFile(selected, editBuf, true)`**（`useFilePreview.ts`）：显式 `overwrite=true` 合理，需确认调用方不会误覆盖只读/冲突文件（依赖后端）。
- **正向**：批注从 `FilePreview` 内联拆到 `FileAnnotationPopover`；`useWordWrapPreference` 以 `crish:file-viewer-word-wrap` 为 SSOT。

---

### BATCH-12 · `427281e9` docs(architecture)

#### 严重 / 中等
- （无代码缺陷。）

#### 轻微
- **体量**：65 文件、约 +65609 行纯文档。价值在战役留痕，但缺少「文档声明的删除面/API 与 HEAD 代码一致性」自动校验，易与后续 batch 漂移。
- 建议：为关键铁律（如 chat-injection 禁止回潮、RELAY_SECRET）保留短门禁脚本，而非仅长文。

---

### BATCH-13 · `99b56892` feat(avatar-studio)

#### 严重
- （未发现密钥硬编码或路径穿越；子应用相对独立。）

#### 中等
- **超大源码数据文件进包**
  - 路径：`apps/avatar-studio/src/avatar-engine/avatarEntityPresets.ts`（约 174KB）、`avatarAnimations.ts`（约 119KB）、`avatarSpeciesBreeds.ts`（约 78KB）等。
  - 问题：TS 源内嵌大体量预设，拖慢类型检查/打包/冷启动；缺按需加载。
  - 建议：拆 JSON/二进制资源 + 动态 import，或按物种分 chunk。

#### 轻微
- **`BlenderViewport` wheel effect cleanup**（约 L143–L149）：清理了 timer 与 listener，但未 `cancelAnimationFrame(rafIdRef.current)`，卸载时可能多一次 `setLocalView`。
- **`SunlitAvatar`** 为纯 SVG，无 WebGL 泄漏问题（正面）。
- 未见配套单元测试（视口几何/seed 解析）；回归依赖人工。

---

### BATCH-14 · `b2411850` feat(workbench)

#### 严重
- **`listPendingApprovals` 向泛型骨架传入 `serde_json::Value::Null`，命令极大概率恒失败**
  - 路径：`apps/agent-workbench/src-tauri/src/server/ws.rs`（约 L1208–L1221）。
  - 逻辑：先把真实 `params_val` `unwrap_or_default` 进闭包外的 `params`，却把 `Value::Null` 交给 `run_remote_command`；骨架内 `serde_json::from_value::<ListPendingApprovalsParams>(Null)` 对普通 struct **不能**反序列化（`ListPendingApprovalsParams` 无 `#[serde(transparent)]` / null 兼容），直接 `CmdInvalid`，闭包内已捕获的 `params` 永不执行。
  - 影响：移动端/远程「待办审批对账」链路功能性回归；属 IPC 契约面故障。
  - 建议：传入已解析参数的专用分支，或 `run_remote_command` 增加「预解析跳过反序列化」重载；并补集成测试覆盖 `listPendingApprovals`。

#### 中等
- **`open_path_with_default_app` 永远回报成功**
  - 路径：`host_openers/execute.rs`（Windows 分支）：`thread::spawn` 内 `ShellExecute` 失败再 `explorer.exe`，`drop(handle)` 后无条件 `Ok(HostOpenResult { ok: true, ... })`。
  - 问题：IPC 调用方无法感知打开失败；错误被吞。
  - 建议：同步等待/通道回传真实结果，或至少区分「已调度」与「已成功」语义并在 UI 标明。

#### 轻微
- **正向 · 鉴权**：`credential_store` 路径名白名单防 `../evil`；Windows DPAPI；删除伪造 `u-default` 用户；401 清凭据；`RELAY`/`CRISH_AUTH_BASE_URL` 配置化。
- **正向 · PTY**：基于 portable-pty 0.9.0 共享 Arc 的事实回退 slave 保活，并加 `conpty_slave_drop_regression_anchor` 测试——文档化充分。
- **非 Windows 凭据明文 + 0600**：模块头已如实声明，保持即可，勿再标「加密」。

---

## 做得好的地方

1. **BATCH-08**：真正物理删除 `chat-injection/` 12 文件，并用 `ContextStateNotice` + metadata `context-state` 收敛状态微提示；AGENTS §21 防回潮铁律落盘。
2. **BATCH-09**：清除源码硬编码 `DEFAULT_SECRET`，启动期强制 `RELAY_SECRET`；手写 HMAC 用 RFC 4231 钉死。
3. **BATCH-10**：`LineBuffer` 零包装对象 + `VirtualCodeEngine` 双模视口，剪贴板不再假绿。
4. **BATCH-11**：批注浮层组件化、换行偏好 SSOT、JSON 格式化失败有 toast。
5. **BATCH-14**：auth 客户端去掉 refreshToken/user 回退伪造；凭据文件路径注入测试；ConPTY 回归锚测试。

---

## 建议优先修复清单

1. **[P0][BATCH-14]** 修复 `ws.rs` `listPendingApprovals`：不要把 `Value::Null` 送进 `run_remote_command` 反序列化；补远程命令单测防假绿。
2. **[P1][BATCH-08]** 删除或真正实现 `dispatch*ContextCard` / `dispatchWorkflowAssistantCard` 空壳，并改掉 `slashSendPreflight` / 设置页调用。
3. **[P1][BATCH-14]** `open_path_with_default_app` 不得无条件 `ok: true`；回传调度/失败状态。
4. **[P1][BATCH-09]** 对齐 GFM emoji 翻译与 AGENTS §21（默认关或设置项）。
5. **[P2][BATCH-10]** `VirtualPlainCodeViewer` 测高支持字号/缩放再测，勿永久 `isMeasuredRef`。
6. **[P2][BATCH-11]** `formatJsonSafe` 与扩展名矩阵对齐；`usePlainCodeLoader` 去掉大文件全量 `split`。
7. **[P2][BATCH-11]** 收紧 `revealPath` 的 inside-workspace 判定至与 `resolveWorkspacePath` 相同边界。
8. **[P3][BATCH-13]** 预设大数据外置分片；`BlenderViewport` unmount 取消 rAF。
9. **[P3][BATCH-08]** `confirmedPayloadSignatures` 按会话清理。
10. **[P3][BATCH-12]** 为关键铁律加短门禁，而非仅依赖超长文档。

---

## 审查方法摘要

- 每 commit：`git show --stat <hash>`
- 关键文件：`git show <hash> -- <paths>`（应用代码在 `apps/crish-desktop` / `apps/agent-workbench` / `crates/*` / `apps/avatar-studio`）
- 交叉：`git grep` 追踪 stub 调用与符号残留