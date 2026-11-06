# S1a 链接定位修复 — 施工报告

日期：2026-11-06。治理依据：`B-链接定位.md`（§4 按任务书枚举施工，见登记项 5）+ `G-列表导航.md` 文件树接缝。结论：**修复完成，定向测试全绿，实机点击验证通过。** 未 commit / 未 push（纪律）。

## 根因回顾（一句）

聊天路径链接的事件 detail 盖的是**发送方会话叶 leafId**，FilesCard 守卫 `shouldConsumeScopedEvent` 按 leafId 不符短路丢弃（面板在 dock 叶、会话在 session 叶，必丢）；且聊天通道从不写 pending 暂存，冷启动无兜底。本批把定址从「发送叶」改为「目标会话」，两条分发通道收敛为一个投递原语。

## 改动文件（14）

生产代码（9）：

| 文件 | 改动 |
|---|---|
| `api/filePanelOpener.ts` | 新增唯一投递原语 `dispatchOpenFileRequest(detail)`：写 pending 暂存 + 派发 `crish-open-file`。detail 契约 `CrishOpenFileDetail { path, line?, lineRange?: [number, number], sessionId? }`——**永不携带 leafId**（注释写明原因：面板在 dock 叶，leafId 定址必被守卫丢弃）。pending 暂存由「裸路径字符串」升级为完整 detail；保留 `takePendingOpenPath()` 旧契约，新增 `peekPendingOpenFileRequest()` / `takePendingOpenFileRequest()`。`openFileInPanel` 第一步改走该原语（绕行通道收敛，删多轨） |
| `api/workspaceFsApi.ts` | hub 再导出新原语与类型（与既有 `openFileInPanel` 同门面） |
| `components/chat-card/useChatSessionActions.ts` | `openPathInFilesPanel` 两处分发改走 `dispatchOpenFileRequest`，定址改为 `sessionId: activeSessionId`，去掉 leafId。顺带修复潜在类型 bug：原 detail 的 lineRange 是字符串 `` `${a}-${b}` ``，消费端类型是 `[number, number]`——改为真元组 |
| `components/files/FilesCard.tsx` | 挂载兜底改用 peek→**sessionId 匹配校验**→take（不匹配的暂存留给正确的面板，不再被先挂载的面板误吞）；事件消费时同步清暂存。`handleOpenFile` 新增**目录分支**：探测父目录列表确认 isDir → `revealPath` 展开父链 + 选中目录行 + 切 browse 视图，**不读文件**；探测失败回落文件流程。FilePreview 回调接线拆分：`onOpenFile: (path) => handleOpenFile(path)`、`onOpenDefault: handleOpenFromPreview` |
| `components/files/FilePreview.tsx` | actions 契约拆分：`onOpenFile: (path: string) => void`（md 链接带被点击的路径）、新增 `onOpenDefault: () => void`（「用默认应用打开」按钮专用）。删除原零参回调复用——此前 md 链接点击打开的是「当前选中文件」而非被点击文件 |
| `components/files/FileViewerCard.tsx` | 「在文件树中定位」改走 `dispatchOpenFileRequest({ path, sessionId: scopedSessionId })`（原盖自身 viewer 叶 leafId，同病）；开面板动作保留。**删除无条件假成功 toast**（原代码无论定位成败都弹「已在本地文件树中定位该文件」）——反馈改为面板打开 + 树脉冲本身 |
| `extensions/conversation-flow/ThinkingBlock.tsx` | 新增可选 prop `onOpenPath`，点击处理把回调注入 markdown 点击上下文——思考块内路径链接从「死链接」变可点 |
| `extensions/conversation-flow/narrativeRenderers.tsx` | `renderNarrativeThought(args, onOpenPath?)` 透传（适配器按 F2 口径只传 path、丢弃 location）；`createNarrativeRenderers(messages, options?)` 新增可选第二参，存量单参调用/测试不受影响 |
| `extensions/conversation-flow/host.tsx` | 从 `props.navigation?.onOpenPath`（ChatCard 已注入 = 修复后的 `openPathInFilesPanel`）取值并经 renderers 闭包下传。**借此避开禁改清单**：`MessageContent.tsx` / `ProcessItemRenderer.tsx`（禁改）未动一字，注入点在 host 层完成 |

测试（5）：

| 文件 | 内容 |
|---|---|
| `api/filePanelOpener.test.ts` | +3：detail 带 sessionId/line/lineRange 且**永不带 leafId**；peek 不消费 / take 返回完整 detail 并清空（含旧 `takePendingOpenPath` 兼容）；`openFileInPanel` 经同一原语写暂存 |
| `components/files/FilePreview.test.tsx` | +2：md 链接点击 → `onOpenFile('src/clicked.ts')` 且不触发 onOpenDefault；默认应用按钮 → 只触发 onOpenDefault。默认 props 补 `onOpenDefault` |
| `components/files/FilesCard.splitResize.test.tsx` | workspaceFsApi mock 补齐新导出（peek/take → null、`pathDirname`、`isSameFsPath`、`toCanonicalFsPath` 存根）——hub 新增再导出后 mock 命名空间必须同步 |
| `components/files/openFileDelivery.test.tsx`（新） | **真实拓扑**集成测试（参考 dockToolsIsolation 模式）：真实 FilesCard / FileViewerCard 分别挂在 dock 叶 LeafScopeProvider（sess-a / sess-b / viewer 三叶）。4 例：①已挂载面板——会话定址事件只被 sess-a 面板消费（打开文件 + 祖先展开 + 树行 aria-selected），sess-b 面板纹丝不动；②未挂载——pending 暂存不被 sess-b 面板挂载误吞，sess-a 面板挂载时消费兜底；③目录目标——选中目录行、停留 browse、**从不调用 readTextFile**；④FileViewerCard「更多操作 → 在应用文件树中定位」跨叶投递成功、`openTool('files')` 被调、**假成功 toast 文案不出现** |
| `extensions/conversation-flow/ThinkingBlock.openPath.test.tsx`（新） | 4 例：路径胶囊点击 → `onOpenPath('src/app.ts', { line: 12 })`；相对 href 链接 → `onOpenPath('docs/guide.md', {})`；无回调时点击不抛错；`renderNarrativeThought` 转发回调（只传 path） |

## B 报告 §5 核查结论：定位链无缺口，未改

- `useFileNavigation.revealPath` 实现完整：断言工作区内 → `getAncestorDirPaths` 求祖先链 → 逐级 `loadDir` + 置 expanded。
- `getAncestorDirPaths`（workspaceFsApi）实现完整：双侧规范化（盘符小写、斜杠统一）、严格前缀判定（拒绝兄弟前缀）、祖先链**不含目标自身**——文件与目录目标都正确（目录的父链即其展开所需集合）。G 报告担心的「只写 selected 不展祖先 → findIndex===-1 静默」在现有 revealPath 路径上不成立。本批只需在 FilesCard 目录分支复用它。

## 测试结果（亲跑，orange 主体，仓库根 vitest --project unit）

- 本批 5 套件首跑：40 例，38 过 2 红——2 红均为新拓扑测试的树行断言。**定因：测试假 FS 的目录键未对齐规范化盘符小写**（`getAncestorDirPaths` 返回 `c:/ws/src`，假表键是 `C:/ws/src`，查表落空返回空列表，展开「成功」但无子项）——测试夹具 bug，非生产缺陷（诊断用例打印树状态坐实：预览已开、祖先未展开、假表未命中）。修正键归一（全小写比对，符合 Windows 大小写不敏感语义）后单文件复跑 **4/4 全绿**。
- 本批 5 套件合计：**40/40 过**（filePanelOpener 13、FilesCard.splitResize 11、FilePreview 8、openFileDelivery 4、ThinkingBlock.openPath 4）。
- 相邻回归 9 套件：首跑 68 例执行全过、4 个文件 load/transform 层失败（FileTreeView、narrativeRenderers、host、host.narrative——并行 transform 争用，本机与收口全量窗口并行所致）；单独复跑 **24/24 全过**。相邻合计 **92/92**（含 FileViewerCard 11、useFileNavigation 15、workspaceFsApi 24、dockToolsIsolation 10、narrative.source 8）。
- 定向总计 **132 例全绿**。
- 类型：`apps/crish-desktop` 内 `tsc -b`（orange）**exit 0，零错误**。

## 实机验证（Tauri MCP，直播应用真实点击）

会话 `sess-1793946729351`（含 6 个 `.md-path-link`）内真实点击：

1. `package.json` 链接——**首次点击时面板只开在根目录 browse（旧行为）**：此时 webview 仍跑 HMR 未更新的旧代码；`location.reload()` 后再点 → 面板 **mode=detail**、预览头 **conex/package.json**，打开的是文件本身而非根目录。
2. `apps/crish-desktop/vitest.config.ts` 链接 → 面板 detail 模式打开该文件；文件树 **`apps` 与 `crish-desktop` 两级 aria-expanded=true**（祖先链展开），**`vitest.config.ts` 行 aria-selected=true**（idx 26，渲染窗内）。
3. 脉冲动画为 1.6s 瞬态，探测在点击 3s 后执行、已结束，未直接观测到脉冲帧；其驱动状态（selected + 展开）已如上坐实，拓扑测试亦断言同一状态。

## 登记项（不硬做）

1. **多项目串扰风险真实**：`api/projectStore.ts` 无 session→project 映射（仅有 `session.folder → projectIdForSessionFolder` 间接推导）；`getWorkspacePath()` 是 localStorage 全局单例（键 `crish_workspace`）。当前分发端与消费端同源于该单例，单工作区形态下自洽；多项目形态下相对路径解析基线可能串扰。按任务书口径登记，不 hack。
2. **相对路径 cwd 候选探测未建**：相对路径只有工作区根一条基线（任务书口径）。FilePreview 内 md 相对链接同此基线（文档所在目录相对解析未建），同族登记。
3. **FileTreeView 脉冲接线存疑（观察项）**：脉冲定时器 1400ms 与动画 1.6s 不一致是 G 报告既有登记；本批另注意到 FilesCard 渲染 FileTreeView 时 grep 不到 `revealSelectionKey` 传入——脉冲/滚动定位是否完整接线建议后续批核查，本批不下结论、未动。
4. **双监听并存（观察项）**：`hooks/useTreePanelEvents.ts` 也监听 `crish-open-file` 负责「打开面板」（其 sessionId 路由本就正确，与本批修复互补）；FilesCard 监听负责「打开文件」。本批未合并两者——分工清晰且实机/测试均正常，登记备查。
5. **B 报告文件本身被截断**：`~/workspace/desktopdetails-20261106/B-链接定位.md` 与 PC 份均为 7,903 B、以字面 `[truncated 3072 chars]` 结尾（两份哈希一致）；其 §4 全文未存盘，本批按任务书对 §4 的枚举施工，施工面与枚举逐项对齐。

## 纪律执行

- 编辑前 12 个存量文件已备份至 PC `C:\Users\Administrator\AppData\Local\Temp\muse-backup-20261106-s1a\`，且推送前核对线上文件与备份一致（无他线并发改动）；全部 14 个文件推送后延迟 MD5 复核与本机一致（14/14）。
- 禁改清单零触碰：思考块注入经 `host.tsx` 完成，未动 `MessageContent.tsx` / `ProcessItemRenderer.tsx`。
- 未 commit、未 push、未动 stash、未重启应用、未动 `MuseB1Vite`；测试全程 orange 计划任务（`MuseRunS1a`），只跑定向套件，未跑全量（全量窗口归收口）。
- 诊断用临时测试文件（openFileDebug.test.tsx）已从 PC 与本机删除。
