# 二次核查报告 · BATCH-08～27

> 核查人：code-audit
> 日期：2026-09-07（America/New_York）
> 依据：`SUMMARY.md` P0/P1 + `secondary-checklist.md`
> 方法：对照当前工作区源码独立抽查（不依赖主审叙述复述）；标记 `[x]` 确认 · `[~]` 部分成立/有 nuance · `[!]` 与主审不符
> 仓库：`C:\Software\conex` · 分支：`refactor/architecture`

---

## 总览

| 项 | 标记 | 结论 |
|----|:----:|------|
| P0-1 任意路径 shell 读盘 + 拖放放大 | `[x]` | **确认**，合入前止血优先 |
| P0-2 非视觉模型 dataUrl/路径泄漏 | `[x]` | **确认** |
| P0-3 listPendingApprovals Null → CmdInvalid | `[x]` | **确认**，恒失败 |
| P1-1 多路拖放双入队 | `[x]` | **确认**（至少三路） |
| P1-2 write/toAssetUrl 空路径不对称 | `[x]` | **确认** |
| P1-3 preview 只验 source / postMessage `*` | `[x]` | **确认** |
| P1-4 dispatch 空壳仍被调用 | `[x]` | **确认** |
| P1-5 应急草稿只写不读回 | `[x]` | **确认**（有 load API，生产零调用） |
| P1-6 计划条 getSessionById 无订阅 | `[x]` | **确认** |
| P1-7 isMeasuredRef 永久锁定 | `[x]` | **确认** |

**与主审差异**：无推翻项。P1-5 补充 nuance：`loadEmergencyDraftSync` 已实现且单测覆盖，但生产路径从未调用——主审「只写不读回」成立。

**清单维度覆盖（针对 P0/P1）**：安全 ✓ · IPC ✓ · 并发/订阅 ✓ · 虚拟列表 ✓ · 内存（应急草稿）✓ · 死代码 ✓ · 测试缺口（见各条建议）✓

---

## P0 抽查

### P0-1 · localFileReader 任意读 + 拖放放大 `[x]`

**证据**

1. `apps/crish-desktop/src/api/localFileReader.ts`
   - `readLocalImageAsDataUrl` / `readLocalTextBestEffort`：路径 trim 后非空即继续；**无** `resolveWorkspacePath` / allowlist。
   - 兜底：`invokeResult('workbench_run_shell', …)`，Win 侧 `File.ReadAllBytes` / `Get-Content -LiteralPath`，非 Win `base64` / `head`。
2. `apps/crish-desktop/src/components/chat-card/useChatAttachments.ts`
   - `handlePathsSelected` 对入参路径直接 `readLocalImageAsDataUrl` / `readLocalTextBestEffort`。
3. `ChatCard.tsx` L49–55：`tauri://drag-drop` → `handlePathsSelected(paths)`，把 OS 拖放绝对路径灌入上述读盘链。

**判定**：主审成立。拖放 + shell 兜底形成「任意本机路径可读」暴露面；属安全维度 P0。

**建议（同意 SUMMARY）**：禁止 shell 读盘兜底或强制工作区 allowlist；拖放入口先过 `resolveWorkspacePath`；补安全单测。

---

### P0-2 · 非视觉模型 dataUrl / 绝对路径写入 prompt 与落盘 `[x]`

**证据**

1. `hooks/chat-stream/multimodal.ts`（`isVisionSupported === false` 分支）：
   - ``路径: ${a.path}``
   - ``源数据: ${a.dataUrl}``（≤2048 全量，否则截断摘要仍含 dataUrl 头）
2. `hooks/chat-stream/useSlashSend.ts` L165–186：
   - `MessageImageRef.source = a.dataUrl || a.path || a.name`
   - `SessionMessageAttachment` 同步持久化 `path` / `dataUrl`

**判定**：主审成立。非视觉路径刻意下发源数据（注释写「用户裁决」），但与「合入前脱敏」目标冲突；落盘放大泄漏与库膨胀。

**建议**：非视觉只发文件名摘要；落盘禁用完整 dataUrl/绝对路径。

---

### P0-3 · listPendingApprovals 传 Null → CmdInvalid `[x]`

**证据**

1. `apps/agent-workbench/src-tauri/src/server/ws.rs` L1206–1221：闭包外已 `from_value(...).unwrap_or_default()` 得到合法 `params`，却把 `serde_json::Value::Null` 交给 `run_remote_command`。
2. 同文件 L1252–1271：骨架内再次 `from_value::<P>(params_val)`，失败 → `DeviceErrorCode::CmdInvalid`。
3. `crates/conex-types/src/device/commands.rs` L706–712：`ListPendingApprovalsParams { after_sequence: Option<u64> }`，普通 struct，**不能**从 JSON `null` 反序列化（无 transparent / 自定义 Visitor）。

**判定**：主审成立。命令在走到 `be.list_pending_approvals` 前恒失败；闭包捕获的 `params` 死代码。

**建议**：传入 `json!({})` / 已解析值的旁路，或改 `run_remote_command` 预解析重载；补契约单测。

---

## P1 抽查

### P1-1 · 多路拖放易双入队 `[x]`

**证据（至少三路汇入附件）**

| # | 入口 | 落点 |
|---|------|------|
| 1 | `ChatCard` `tauri://drag-drop` | `handlePathsSelected` |
| 2 | `ChatCard` `window` `drop` | `handleFilesSelected` |
| 3 | `ComposerDropHost` `onDrop` + Tiptap `handleDrop`（`TiptapEditorExtensions.ts`） | `onDropFiles` → 同一附件管道 |

`ComposerDropHost.tsx` 注释已承认与 Tiptap `handleDrop` 分工，但 ChatCard 窗口级监听仍可与之重叠。

**判定**：主审成立。未见统一幂等 attachment id / 指纹去重。

---

### P1-2 · writeTextFile / toAssetUrl 空路径未拒 `[x]`

**证据** · `api/workspaceFsApi.ts`

- `readTextFile`：`if (!filePath) throw`；`resolveWorkspacePath` 失败再 throw。
- `writeTextFile`：无空串前置校验，直接 `resolveWorkspacePath` 后 `invoke`。
- `toAssetUrl`：无空串拒绝；`convertFileSrc(path)` 可能吃到空/`resolve` 失败结果。

**判定**：主审成立，与 read 不对称。

---

### P1-3 · preview postMessage 只验 source / 目标 `*` `[x]`

**证据** · `components/workspace/previewHostBridge.ts`

- 校验：`raw.source !== CRISH_PREVIEW_INSPECTOR_SOURCE` → 丢弃；**无** `event.origin` 检查。
- 发送：`contentWindow.postMessage(message, '*')`（约 L216）。
- 订阅：`window.addEventListener('message', handleMessage)`（约 L247）。

**判定**：主审成立（BATCH-15 与 26 桥端均相关）。

---

### P1-4 · dispatch* 空壳仍被调用 `[x]`

**证据**

- `workflowAssistantCard.ts`：`dispatchWorkflowAssistantCard` 恒 `return null`。
- `slashContextCards.ts`：`dispatchSkillContextCard` / `GoalMode` / `GrillMe` 等恒 `''` / no-op。
- 仍被调用：`slashSendPreflight.ts`（约 L167/175/227/356/371）、`ScheduledTasksPanel.tsx` L137、`SettingsScheduleTab.tsx` L121。

**判定**：主审成立；半删除死接口，易伪装「已派发」。

---

### P1-5 · 应急草稿只写不读回 `[x]`（nuance）

**证据** · `note-paper/useNoteTextPersistence.ts`

- 有 `saveEmergencyDraftSync` / `loadEmergencyDraftSync` / `clearEmergencyDraftSync`。
- `beforeunload` 路径会 `saveEmergencyDraftSync`。
- **`loadEmergencyDraftSync` 生产调用点：无**（仅 `useNoteTextPersistence.test.ts`）。

**判定**：主审「只写不读回」成立。补充：读回 API 与单测已在，缺的是启动/开文档恢复接线。

---

### P1-6 · 计划条 getSessionById 无订阅 `[x]`

**证据** · `ChatComposerWrapper.tsx` L74–79

- `currentSession = getSessionById(activeSessionId)` 于渲染期直读。
- `useMemo(..., [currentSession])` 依赖对象引用，但组件**未**订阅 session store。
- 同文件 `useSyncExternalStore` 仅用于 `workspace.chat.composerAbove` slot，与进度无关。

**判定**：主审成立；session 进度更新时计划条可能不刷新（除非父级无关重渲染碰巧带上）。

---

### P1-7 · isMeasuredRef 永久锁定 `[x]`

**证据** · `diff/VirtualPlainCodeViewer.tsx`

- L54：`isMeasuredRef = useRef(false)`
- L109：`if (isMeasuredRef.current) return;`
- L140：测得有效值后 `isMeasuredRef.current = true`
- 无字号 / UI 缩放 / ResizeObserver 重置路径。

**判定**：主审成立；首帧误测或后续缩放会导致虚拟列表行高错位。

---

## 差异与跟进

| ID | 与主审 | 二次补充 | 严重度 |
|----|--------|----------|--------|
| P1-5 | 一致 | load API 已存在，缺生产恢复调用 | P1 |
| （其余） | 一致 | — | — |

无 `[!]` 推翻项。

---

## 二次核查建议修复顺序（同意 SUMMARY，略调表述）

1. **P0-1** 沙箱化 `localFileReader` + 拖放入口 allowlist
2. **P0-2** 非视觉多模态 / 落盘脱敏
3. **P0-3** `listPendingApprovals` 契约修复 + 单测
4. **P1-1** 统一拖放消费方 + 附件指纹去重
5. **P1-2** write/toAssetUrl 对称空路径拒绝
6. **P1-3 / P1-4 / P1-5 / P1-6 / P1-7** 按 SUMMARY §6 排期

---

## 完成标准勾选

- [x] SUMMARY 全部 P0/P1 已对照源码抽查
- [x] 高优先级 BATCH（08/10/14/15/20/21/23/24/26）相关项均有明确 `[x]`/`[~]`
- [x] 差异已记录；结论同步群「Crish 代码审查」

_文档由 code-audit 独立复核生成_
