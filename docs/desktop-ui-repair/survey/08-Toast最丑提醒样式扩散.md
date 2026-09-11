# Toast 最丑提醒样式扩散 · 调研清单

> 2026-08-19。桌面界面一致性战役 `survey/08`（文件名按派单；同目录另有一份 `08-token基座与全局气质断层.md`，本文件不覆盖它）。
> **只梳理，不定案、不改源码、不提交。** 分类写入，问题同权，不按 P0/P1 砍项。
> **用户原话**：`crish-agent-workbench_q25sR8DuIH.png` 这条「已自动获取 7 个模型」提醒——怎么把最丑的样式弄出来的？很多都接了这个很丑的样式，看着都堵得慌。
> **用户锁（调研边界 §8）**：最丑 Toast；竖分割 + ×；多处 `notify` 接同一套皮。
> 范围：`apps/crish-desktop` 产品面（`reference/` 里的 `FM.toast` 不入库产品路径，文末另记）。

---

## 0. 做了什么 / 没做什么

**做了：**

- 读完 `ToastStack.tsx` / `ToastStack.module.css`、`useToastQueue.ts` / `toastQueueLogic.ts`、`ToastContext.tsx` / `ToastContainer.tsx`、`useModelProviderActions.ts:72` 与 `notify` 接线。
- 普查 `apps/crish-desktop` 全部 `toast.show` / `showToast(` / `useToast(` / `useToastQueue` / `notify(` 产品调用点（测试与 `reference/` 分开记）。
- 对照 Banner / Ribbon / inline alert 是否套同类「文案 + ghost sm ×」构图。
- 对照设置页退化按钮、侧栏会话「更多」灰方块是否同源 `ui/Button ghost sm`。

**没做：** 不改源码、不 git、不实现、不写第二份文档、不派子代理。未打开真机 PNG（仓库内无 `q25sR8DuIH.png`），竖分割的视觉归因以 CSS 构图 + 边界文档描述为准。未连 CDP 9222 复现入场过弹。

**不确定：** WebView2 里 `backdrop-filter: blur(8px)` + 18% 阴影叠在半透明底上的最终脏感，只能从 token 与截图描述对齐，不能代替真机像素。`Button ghost sm` 的 1px 透明边在部分主题下会不会显成发丝竖线，代码上 `toastDismissBtn` 写了 `border: none`，真机若仍看见线，更可能是灰块左缘而不是 border。

---

## 1. 结论先行

这套皮不是「一处写丑了」，是 **三条线拧在一起**：

1. **唯一渲染器** `ToastStack`：底栏居中 max-content 胶囊 + 永远涂灰的 `Button ghost sm` × + 过弹入场。成功 / 失败 / 可撤销 **视觉完全一样**（`AppToast.type` 存了不用）。
2. **唯一发射器** `toast.show` / `useToast().showToast` → `useToastQueue` → 同一 Portal `#toast-root`。设置页 `notify(ok, msg)` **丢掉 `ok`**，成功失败都打进这根管子。
3. **策略门闩是前缀正则，被实现文案绕开。** 禁令写的是 `/^已获取\s/`、`/^连通成功/`；真机文案是 `已自动获取 7 个模型`、`服务商连通正常 (120ms)`。测试还在用旧文案挡回流，新产品句从旁边溜走。

用户点模型页那颗 28×28 `ghost sm`「自动获取」→ `notify(true, …)` → `toast.show` → 底栏弹出这颗胶囊。侧栏「更多」灰方块、模型页扫描/连通/添加灰方块、Toast 上的 ×，是 **同一颗 `ui/Button variant="ghost" size="sm"`**。Toast 还额外给 × 常驻 `--tint-active` 灰底，所以比侧栏更堵，看起来像「文字 | 竖分割 | ×」。

---

## 2. 真机锚点与触发链

| 项 | 证据 |
| --- | --- |
| 截图 | `crish-agent-workbench_q25sR8DuIH.png`（调研边界：胶囊 + 竖分割 + ×） |
| 文案 | `已自动获取 ${n} 个模型` |
| 发射 | `apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts:72` `notify(true, …)` |
| 按钮 | `ModelListHeader.tsx:65-91`「自动获取」= `Button ghost sm`，inline `height/width: 28px` |
| `notify` 实现 | `useModelProfilesState.ts:113-117`：`(_ok, msg) => toast.show(msg)`，`ok` 弃用 |
| 渲染 | `ToastProvider`（`main.tsx:22`）→ `ToastContainer` Portal `#toast-root` → `ToastStack` |
| 同链还会弹 | `useModelProviderActions.ts:96` `服务商连通正常 (${latency}ms)`（点「检查连通性」同一排 28×28 灰钮） |

保存密钥路径：`useModelProfilesState.ts:240` 先 `notify(true, '密钥已保存，正在自动扫描…')`（命中 `/^密钥已保存/`，**策略会 drop**），再 `void runScan()`，scan 成功改走 `已自动获取 N 个模型` **漏出**。所以用户即使没手点扫描，存 key 也会看到这颗丑 Toast。

---

## 3. 这套皮怎么拼出来的（视觉解剖）

没有独立「分割线」组件。CSS 里搜不到 `border-left` / divider。丑是 **原子叠出来的**。

### 3.1 胶囊

`ToastStack.module.css:26-52` `.toastAlert`：

- `width: max-content` + `max-width: min(360px, calc(100vw - 32px))` → 短句收成一条 pill。
- `padding: 6px 12px` 对 12px 字，却塞进 **高 28px** 的 `Button size="sm"`（`Button.module.css:99-107` `--btn-h: 28px`）。条的高度被 × 钮撑到约 28–40px。
- `border-radius: var(--radius-lg)`：`:root` 8px；`[data-ui-size='small']` 改成 **7px**（`tokens.css:821`）。高 ~32px、半径 7–8px，短句看起来就是胶囊。用户锁「不要用旧胶囊化战役盖过 7px」——Toast 根本没按 7px 设置钮契约走，它吃的是 **内容半径 token**。
- `color: var(--text-secondary)`：成功文案用次级灰字，发闷。
- `font-size: var(--font-size-sm, 12px)`。

`.toastAlert` 还留着单枚时代的 `position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%)`（26-31 行），被 `.toastStack .toastAlert`（16-24 行）改成 `relative` + `transform: none`。两套定位叠在同一选择器族上，是旧单 Toast 残骸。

### 3.2 「竖分割」（假分割，不是线）

结构（`ToastStack.tsx:54-77`）：

```
[ span 文案 ]  (gap: --space-2 = 8px / small 档 5px)  [ Button ghost sm × ]
```

× 钮 class 叠了两层：

| 层 | 来源 | 效果 |
| --- | --- | --- |
| `Button ghost sm` | `Button.module.css` | 高 28px、`--btn-px: 10px`、圆角 `--radius-md`（6px / small 5px）、`:active { scale(0.98) }`、`::before` hover 遮罩 |
| `.toastDismissBtn` | `ToastStack.module.css:73-85` | **常驻** `background: var(--tint-active)`（`tokens.css:42` = `text-primary 8%` 灰）、`padding: 0 4px`、`border-radius: var(--radius-xs)`（2px）、**不改 height** |

结果：文案区是半透明玻璃条，右侧是一块 **永远灰、几乎方、比字高一截** 的 sm 按钮。灰块左缘就是真机上的「竖分割」。撤销钮（`variant="secondary" size="sm"` + `.toastUndoBtn` 再涂 `--tint-strong`）出现时会变成「文案 | 撤销灰块 | × 灰块」，更堵。

`×` 是字面量 `×`（U+00D7）塞进 `icon=`，不是 Lucide `X`。旁边 RunNoticeBar / FilesActionHint 用 Lucide X，关闭字形不统一。

### 3.3 阴影（堵的主因之一）

`.toastAlert` `box-shadow: 0 4px 16px color-mix(in srgb, var(--shadow-color) 18%, transparent)`（`ToastStack.module.css:41`）。

对比 `tokens.css:278-284` 的 `--shadow-sm` / `--shadow-md`：混入只有 **1%–1.5%**。Toast 用 **18%**，再加 `backdrop-filter: blur(8px)` 和 `bg-elevated 92%` 半透明。AGENTS.md §13 要求输入/浮层克制阴影——这条是漂着的脏斑。eco 档只关 blur，**阴影仍在**。

边框是 `border-subtle 8%`，几乎看不见，轮廓全靠那坨 18% 阴影。

### 3.4 过弹动画

- 入场：`animation: toast-slide-in var(--transition-enter) forwards`（128-129 行）。
- `--transition-enter: 400ms cubic-bezier(0.175, 0.885, 0.32, 1.275)`（`tokens.css:306`）。**y2=1.275 过冲**。`survey/01` 已记：全仓活消费几乎只有 Toast 入场。
- keyframes 从 `translateX(120%)` 滑到 `0`（右进、越过、弹回）。底栏居中短胶囊从右侧砸进来再回弹，就是「太弹」。
- 退场：`toast-slide-out` + `--transition-exit` 250ms，无过冲；JS `handleDismiss` 再 `setTimeout(250)`（`ToastStack.tsx:24-31`）与 CSS 对齐。
- eco 把 `--transition-enter` 置 `0ms`（`tokens.css:954`）。默认产品路径不是 eco。
- × 按下另叠 Button 的 `scale(0.98)`（果冻-按下缩放，survey/01 枢纽）。点关闭也会弹一下。

### 3.5 为何丑（合成，问题同权）

1. 短句 max-content → 假胶囊。
2. 28px ghost sm 灰块撑高、切出假竖分割。
3. × 常驻 `--tint-active`，休息态就是灰方块（侧栏更多钮至少默认透明）。
4. 18% 阴影 + blur 玻璃，脏、压内容。
5. 入场 1.275 过冲从右侧弹入。
6. 成功/失败同皮、同次级灰字，没有语义色。
7. 产品禁令写「成功不 toast」，这句成功文案照样漏进来，所以用户觉得「很多地方都在弹这颗」。

### 3.6 策略门闩漏洞（文案层，不是皮，但决定谁穿这套皮）

`toastQueueLogic.ts:83-152` 禁成功；`155-188` 放行错误/可撤销。`enqueueToast`（402-410 行）：

- **只要传入 `options.type`，整段策略跳过**（空串除外）。`TrashSection` / `SettingsShortcutsTab` / `SettingsSecurityTab` 用 `{ type: 'error' }` 走这条。`toast.success()` 会带 `type: 'success'`，**成功也能强制入队**（生产尚未调用 `toast.success`，但 API 敞着）。
- 无 `type` 时靠前缀正则。下列 **真机/代码实文句不在禁令里，会 show**：

| 实发文案 | 禁令以为挡住的 | 结果 |
| --- | --- | --- |
| `已自动获取 7 个模型` | `/^已获取\s/`（测例还写着「已获取 12 个模型，列表已更新」） | **漏出**（本截图） |
| `服务商连通正常 (120ms)` | `/^连通成功/` | **漏出** |
| `会话 ID 已复制到剪贴板` / `绝对路径已复制` / `文件源码已复制到剪贴板` / `标准 Git Patch 已复制…` | `/^已复制/` | **漏出**（主语在前） |
| `已发送到笔记` | 无 `/^已发送/` | **漏出** |
| `已在本地文件树中定位该文件` | 无 `/^已在/` | **漏出** |
| `已设置 Claude 扫描目录` 等 | 只有 `/^已设为当前/` | **漏出** |
| `已开启：下次启动将尝试恢复…` | 无 `/^已开启/` | **漏出** |
| `已关闭：下次启动为干净新对话` / `配对已关闭` / `技能斜杠命令已关闭` | **允许集** `/已关闭/` | 成功态被当成「允许」 |
| `插件已启用` / `插件已停用` | `/^已启用/` `/^已禁用/` | **漏出**（前面有「插件」） |
| `压缩完成：…` | `/^已完成/` | **漏出** |
| `仅登记包名（未连接引擎安装）` / `仅标记本机已装…` | 无 | **漏出** |
| `已开始安装更新` | 无 `/^已开始/` | **漏出** |
| `设备已改名` / `配对已开启` / `多端服务已开启` / `设备已撤销` / `已收到回溯预览` | 无对应前缀 | **漏出** |
| `密钥已保存，正在自动扫描…` | `/^密钥已保存/` | drop（随后 scan 仍漏） |
| `已删除对话: …` | `/^已删除/` | drop（无 Undo，删除成功其实弹不出来） |

`isForbiddenSuccessToast` 与调用点文案 **双源漂移**：测的是旧句，产品改了用词。

---

## 4. 入口拓扑（接这套皮 = 进这根管子）

```
业务  toast.show / useToast().showToast / notify→toast.show
        ↓
ToastContext.handleShowToast
        ↓
useToastQueue.showToast → enqueueToast（策略 / 去重 / 最多 5 条 / TTL 5s）
        ↓
ToastContainer createPortal(#toast-root)
        ↓
ToastStack  ← 唯一皮肤
```

- 全局命令式：`services/toast/ToastContext.tsx:44-92` `toast.show/success/info/error/warning`。
- Hook：`useToast()`。Provider 未挂时 fallback 到同一 `toast.show`（148-158 行）。
- `useToastQueue` **只**在 `ToastProvider` 里实例化一次（102 行）。其它文件 `import type from useToastQueue` 是类型/文案 helper，不另开队列。
- `AppToast.type` / `title` / `action` **渲染层全不用**（`ToastStack.tsx` 只读 `message` / `onUndo` / `ariaLive`）。

---

## 5. 全仓调用点（接了这套皮的每一处）

口径：凡 `toast.show` / `showToast(` / `notify→toast.show` 的 **产品源文件** 都算「接皮」。策略 drop 的也列入——发射器已经对准这根管子，文案一改就会冒出来。测试、`reference/` 不入主表。

判定列：**漏** = 成功/状态类且现策略放行；**错** = 错误/用法，策略本就允许；**撤** = 带 `onUndo`；**drop** = 现策略会静默；**死** = 只 import `useToast` 未发射。

### 5.1 设置 · 模型（本截图源头）

| 文件 | 行 | 文案 / 行为 | 判定 |
| --- | --- | --- | --- |
| `useModelProfilesState.ts` | 113-117 | `notify` → `toast.show(msg)`，丢 `ok` | 枢纽 |
| 同上 | 135 | 配置已被外部修改，请确认后重载或丢弃草稿 | 错 |
| 同上 | 237 | `保存失败：…` | 错 |
| 同上 | 240 | `密钥已保存，正在自动扫描服务器可用模型...` | drop → 仍触发 scan |
| 同上 | 277 | `请填写模型 id` | 错 |
| `useModelProviderActions.ts` | 48 | `连通失败 · ${model}：…` | 错 |
| 同上 | 51, 78, 101 | `Error.message` | 错 |
| 同上 | **72** | **`已自动获取 ${n} 个模型`** | **漏（截图）** |
| 同上 | 74 | `未能检测到服务器可用模型` / `r.error` | 错 |
| 同上 | 96 | `服务商连通正常 (${ms}ms)` | 漏 |
| 同上 | 98 | `连通检查失败：…` | 错 |
| `useModelConfigSession.ts` | 92 | 配置已被外部修改，保存已取消… | 错 |
| `ProviderProfileForm.tsx` | 48-51 | `地址保存失败：…` | 错 |
| `ModelsSettingsTab.tsx` | 120 | `useToast()` 赋 `_showToast` | 死 |

### 5.2 设置 · 其它页

| 文件 | 行（约） | 文案 / 行为 | 判定 |
| --- | --- | --- | --- |
| `useAppearanceSettings.ts` | 149, 156, 185, 209, 227 | 外观应用/读取/保存/密度/形态失败 | 错 |
| 同上 | 295-299 | `已开启：下次启动将尝试恢复工作台布局` / `已关闭：下次启动为干净新对话` | 漏（后者还命中允许集「已关闭」） |
| `SettingsAppearanceTab.tsx` | 148 | `重置失败：…` | 错 |
| `SettingsPersonalizeTab.tsx` | 47, 66 | 读取失败 / 保存失败 | 错 |
| `FontSettingsSection.tsx` | 100, 115, 184 | 字体应用失败 / 扫描失败 / 非法字体名或「请输入字体名称」 | 错 |
| `useRulesState.ts` | 148, 196, 210, 212, 248, 250, 261, 265 | 读取/更新失败、引擎降级、已截断、请输入、该规则已存在 | 错 |
| `SettingsRulesTab.tsx` | 82 | `请先选择项目` | 错 |
| `useWorkflowsState.ts` | 195 | `fail()` → 行内 + `toast.show` | 错（成功走 `setOk` 行内，这条路径正确） |
| `ScheduledTasksPanel.tsx` | 73 | `该次运行暂无关联会话` | 错 |
| `SettingsScheduleTab.tsx` | 32 | `_showToast` | 死 |
| `PriceConfigModal.tsx` | 98, 107, 111, 118 | 请填写 / 不能为负 / 保存失败 | 错 |
| 同上 | 156, 162 | `已保存 ${row.model} 的定价` / `已删除 ${row.model} 的定价` | drop（`/^已保存/` `/^已删除/`；「单价已保存」另有禁令） |
| `useDeviceRename.ts` | 73, 80, 82 | 标签不能为空 / **设备已改名** / 改名失败 | 错 / **漏** / 错 |
| `useDevicePairing.ts` | 96-160 | 配对已开启/关闭、多端服务已开启、服务已关闭、开启/关闭失败、**配对码已复制**、复制失败 | 漏+错（「已关闭」命中允许集） |
| `SettingsDevicesTab.tsx` | 169, 171 | 设备已撤销 / 撤销失败 | 漏 / 错 |
| `StatusDiagnosticsPanel.tsx` | 154-179 | 已复制错误信息（drop）/ 复制失败 / **已触发搜索索引重建**（`/^已触发/` drop）/ 重建失败 | 混 |
| `SettingsProfileTab.tsx` | 70-130 | 导出/导入/连接失败 | 错 |
| `SettingsUsageTab.tsx` | 64 | 定价表读取失败 | 错 |
| `SettingsShortcutsTab.tsx` | 95, 109, 152 | 保存/恢复/录制失败，带 `{ type: 'error' }` **绕过策略** | 错 |
| `SettingsSecurityTab.tsx` | 129-166 | 无效命令 / 添加移除清空权限失败，带 `{ type: 'error' }` | 错 |
| `ExternalSessionImport.tsx` | 156, 182-205, 240-267 | 扫描失败；**已设置/已恢复 Claude/Codex 扫描目录**；导入部分失败 / 跳过 N 条 / 导入失败 | 漏（已设置）/ drop（已恢复）/ 错 |

### 5.3 设置 · 技能 / MCP / 扩展

| 文件 | 行（约） | 文案 / 行为 | 判定 |
| --- | --- | --- | --- |
| `useSkillList.ts` | 139, 244, 247, 281, 298, 305 | 扫描技能失败；引擎降级；更新失败；启用/禁用部分失败；同步失败 | 错 |
| `useSkillEditor.ts` | 45, 60, 84 | 创建技能失败；复制失败 | 错 |
| `useSkillDirectories.ts` | 53, 63, 73, 109, 129 | 添加/选择/移除目录失败；导入部分失败 | 错 |
| `SkillsMoreMenu.tsx` | 111 | 快捷命令保存失败 | 错 |
| `SkillDetailPreview.tsx` | 101 | 无法打开路径（需桌面壳） | 错 |
| `SkillsSettingsTab.tsx` | 28 | `_showToast`（文件头注释写明成功不 toast） | 死 |
| `useMcpSettings.ts` | 140, 168, 246, 253, 291, 306 | 加载/复制/启停/保存/删除失败（`toast.show?.`） | 错 |
| `McpServerForm.tsx` | 68 | 未知的传输类型 | 错 |
| `McpSettingsTab.tsx` | 22 | `_showToast` | 死 |
| `useExtensionMarket.tsx` | 184, 294, 307, 309, 343, 368, 385, 389, 404 | 扩展刷新失败；**仅登记包名**；**仅标记本机已装**；安装/卸载/工具开关/启停失败；**插件已启用/已停用** | 漏+错 |
| `SettingsExtensionsTab.tsx` | 32 | `_showToast` | 死 |

### 5.4 侧栏 / 快捷键 / 更新

| 文件 | 行（约） | 文案 / 行为 | 判定 |
| --- | --- | --- | --- |
| `useSidebarContextMenu.ts` | 172, 183 | `已归档: …` / `已分叉: …` + Undo | 撤 |
| 同上 | 202, 205 | 导出失败 | 错 |
| 同上 | 212 | **会话 ID 已复制到剪贴板** | 漏 |
| 同上 | 230 | `已删除对话: …` 无 Undo | drop |
| `SidebarFooter.tsx` | 110 | `applyUpdateWhenIdle().message`：`当前没有可用更新` / `仍有任务在运行…` / `更新失败` / **`已开始安装更新`** | 漏+错 |
| `AppShortcuts.ts` | 148 | `formatBranchUndoToast` + Undo（Ctrl+Shift+F） | 撤 |

### 5.5 对话流 / 审批 / 斜杠

| 文件 | 行（约） | 文案 / 行为 | 判定 |
| --- | --- | --- | --- |
| `useChatHandlers.ts` | 46-49 | 导出失败 | 错 |
| 同上 | 65-87 | 无法回溯 / 回溯预览失败 / **已收到回溯预览（…）** / 回溯不可用 | 漏+错 |
| 同上 | 115-135 | 无法撤回 / 没有可撤回的用户消息 / 撤回失败 | 错 |
| 同上 | 191 | `formatBranchUndoToast` + Undo | 撤 |
| `useChatAttachments.ts` | 95 | 图片粘贴失败 | 错 |
| `useChatModelPicker.ts` | 55 | `pickerInlineError` 一有值就 `toast.show` 再清空。上游 `slashSendPreflight.ts:93-105`、`useSlashSend.ts:104,129,178,203`：请先配置密钥与模型 / 请手填模型 / domain 文案 / 会话不可用 / 发送失败已保留输入 | 错（名叫 Inline，实际进 Toast） |
| `useChatApprovalExecutor.ts` | 89, 120, 168, 183, 231, 246 | 批准/拒绝失败；N 个工具批准/拒绝失败 | 错 |
| `useAgentToolApproval.ts` | 126, 176 | 批准失败 / 拒绝未送达 | 错 |
| `ApprovalDock.tsx` | 81 | 未找到待确认项 | 错 |
| `slashSendPreflight.ts` | 138-270 | 用法 /learn /goal /grill-me /compact；技能命令已关闭；未找到技能；加载技能失败；规则已存在；会话不可用；**压缩完成：…**；压缩未接线/失败 | 错 + **漏（压缩完成）** |
| `useGoalMode.ts` | 140 | `decision.toast`，仅 `max_iter`（`goalStopAllowsToast`） | 错 |
| `streamCallbacksEvents.ts` | 288-291 | `surface === 'banner-toast'` 时 **横幅 + toast 双发** 同一 `message`（blocked/auth/no_key/no_project） | 错，双皮 |
| `useChatMessageState.ts` | 198, 230, 234, 258 | 复制失败；没有可重新生成；请等待当前回复完成 | 错 |
| `useScrollAnchor.ts` | 80, 86, 93 | 不在过滤结果 / 未找到固定消息 | 错 |
| `ChatUserMessageRow.tsx` | 86 | 复制失败 | 错 |
| `ChatAssistantMessageRow.tsx` | 87, 92 | 没有可复制的正文 / 复制失败 | 错 |
| `MessageActions.tsx` | 79, 85 | **已发送到笔记** / 发送到笔记失败 | 漏 / 错 |
| `ChatCard.tsx` | 36 | `_showToast` | 死 |

### 5.6 工作区 / 文件 / Diff / 浏览器 / 电脑

| 文件 | 行（约） | 文案 / 行为 | 判定 |
| --- | --- | --- | --- |
| `TrashSection.tsx` | 68-94 | 恢复/清除失败，`{ type: 'error' }` 绕过策略 | 错 |
| `BgTasksSection.tsx` | 56 | 读取后台任务输出失败 | 错 |
| `ApprovalSection.tsx` | 59-114 | 未找到待确认会话 / 缺少工具 id / 批准拒绝失败 | 错 |
| `FileViewerCard.tsx` | 124, 127, 167, 173, 360 | **文件源码已复制…** / 复制失败 / **已在本地文件树中定位** / 打开系统管理器失败 / **绝对路径已复制** | 漏+错 |
| `FilesCard.tsx` | 94 | **绝对/相对路径已复制** | 漏 |
| `DiffCard.tsx` | 105, 201-204, 251 | `toastFail` 转错误；**最新源码已复制**；复制失败；**已复制标准 Git Patch** | 漏+错 |
| `DiffCardFileList.tsx` | 254, 281 | **标准 Git Patch 已复制** / **绝对路径已复制** | 漏 |
| `usePreviewNavigation.ts` | 114, 203, 237-274 | 导航拒绝原因；当前地址无法刷新；页面无法刷新；无法外部打开；浏览器拦截弹窗；无法打开系统浏览器；空白页无法加入书签 | 错 |
| `useBrowserSession.ts` | 143, 163, 172, 186 | 查询/启动/停止浏览器失败（`describeInvokeFailure`） | 错 |
| `useComputerSession.ts` | 135, 157-177 | 查询/启用/停用电脑操作失败或未接线 | 错 |
| `useBookmarksImport.ts` | 51 | `书签导入失败：` + 行内 | 错 |
| `useHistoryImport.ts` | 42, 76 | `历史导入失败：` / 列表失败 + 行内 | 错 |
| `useExportAuth.ts` | 47 | 登录态导出失败 + 行内 | 错 |
| `useStorageImport.ts` | 49 | `登录态导入失败：` + 行内 | 错 |
| `PreviewCard.tsx` / `BrowserPanel.tsx` | | `_showToast` | 死 |

浏览器导入四钩是 **行内 `role=alert` + toast 双发** 同一句，错误会同时看见两条皮。

### 5.7 死接线 / 只 import 不发射（仍算接了基础设施）

`PreviewCard.tsx`、`BrowserPanel.tsx`、`SettingsExtensionsTab.tsx`、`ModelsSettingsTab.tsx`、`SkillsSettingsTab.tsx`、`McpSettingsTab.tsx`、`SettingsScheduleTab.tsx`、`ChatCard.tsx`：`const { showToast: _showToast } = useToast()`。壳在、弹点在子 hook。

类型-only `import type {} from useToastQueue`：`ComputerPanel.tsx`、`useComputerSession.ts`、`BrowserPanel.tsx`、`useBookmarksImport.ts`、`BrowserImportSection.tsx`、`useChatApprovalHandlers.ts`、`ChatComposerWrapper.tsx`、`UserProfileCard.tsx`、`Sidebar.tsx` —— 不发射。

### 5.8 断桥

`pickWorkspaceFolder.ts:33` `emitUiEvent('workspace-picker-unavailable')`。注释写 App.tsx `useToastQueue` 宿主订阅弹可见 toast。全仓 **没有订阅者**。旧 ToastBus 死通道迁到事件后，事件也死了。不是「接了这套皮」，是 **接皮失败**。

`updateStore.ts:70` 成功句 `已开始安装更新` 经 `SidebarFooter` 进 Toast，策略未挡。

---

## 6. 第二套提醒是否套了同类丑皮

「同类」= 圆角条 + 文案 + `Button ghost sm` 关闭（假分割感），不是「任意通知」。

| 面 | 文件 | 像不像 Toast 皮 | 说明 |
| --- | --- | --- | --- |
| RunNoticeBar | `RunNoticeBar.tsx:49-57` + `RunNoticeBar.module.css` | **像** | 文案 + `Button ghost sm` + Lucide X。inline、无 18% 阴影、无过弹。`streamCallbacksEvents` 可行动错误会 **横幅+Toast 各来一条** |
| CircuitBreakerBanner | `CircuitBreakerBanner.tsx:23` `Button ghost sm`「关闭」 | **像（弱）** | 橙 8% 底 + hairline + ghost sm。构图「字 \| 关闭钮」 |
| GlobalErrorBanner | `GlobalErrorBanner.tsx` + `.module.css` | **像，且抢位** | `position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%)` 与 Toast **同一锚点**。ghost sm「知道了」。z 用 `--z-popover`，Toast 用 `--z-toast`（= `--z-modal`，`z-index.css:23`），叠在一起会盖住 |
| crashRibbon | `ChatStatusRibbons.tsx:349-357` | 部分 | ghost sm「自动重连」，不是 × |
| SetupHintBanner | `SetupHintBanner.module.css` | 不像 | 行内 hairline，下划线文字按钮，无 ghost sm 灰块 |
| retrySlotNotice | `ChatStatusRibbons.module.css:154-168` | 不像 | 无按钮 |
| PlanGoalRibbons | `PlanGoalRibbons.module.css` | 不像 | 模式条，icon btn 不是 Toast × |
| DynamicChipBar | `ChatStatusRibbons.tsx` + `.dynamicChip` | 气质近 | `Button ghost sm` + 26px 高 chip + `chipFadeIn` 带 `scale(0.96)`（survey/01 弹入类） |
| filesActionHint | `FilesCard.tsx:324-344` + `.module.css:930-971` | 原子同源、皮不同 | 仍 `Button ghost sm` + X；CSS 想压成 18×18 透明。底是红 7% 条 + 底边 hairline，不是底栏胶囊 |
| Settings `setOk` / 行内 hint | `useWorkflowsState.ts` 等 | 不像 | 策略要求的正确通道；成功不该进 Toast |
| MirrorDriftStatusBar | 三颗 ghost sm 动作钮 | 不像 Toast | 工具条，不是提醒关闭 |

第二套里 **最像、会一起堵** 的是：RunNoticeBar（双发）、GlobalErrorBanner（同坐标）、CircuitBreakerBanner（ghost sm 关闭）。

---

## 7. 与设置页退化按钮、侧栏灰方块是否同源

问句里的公式：`ui/Button ghost sm + 竖分割`。

### 7.1 侧栏灰方块 —— 同源原子，构图不同

`SessionRow.tsx:353-377`：`Button variant="ghost" size="sm"` + `sessionActionsBtn`（`SidebarSessionList.module.css:402-437`）。

- 同：`ghost sm`、标尺 28×28、圆角 `--radius-md`、按下 `scale(0.98)`、`::before` hover 灰。
- 不同：侧栏 CSS 写 `background: none`，休息态透明，hover 才显；Toast × 被 `.toastDismissBtn` **永远涂 `--tint-active`**。侧栏没有「文案 | 灰块」，所以没有竖分割，只有单独灰方块（调研边界「会话更多灰方块」）。

### 7.2 模型页触发钮 —— 同源，且就是弹出这颗 Toast 的手

`ModelListHeader.tsx:37-133` 三颗 `Button ghost sm`，**inline style 28×28**：连通 / 自动获取 / 添加。排成 `mrdModelsActions` 一排灰方块。点「自动获取」→ 第 2 节触发链。设置页退化按钮里，这一排与 Toast × **同一颗原子、同一尺寸**。

### 7.3 设置页其它退化按钮 —— 部分同源

- 外观「重置」「重试」：`SettingsAppearanceTab.tsx:50-58, 123-154` `Button secondary sm`。同尺寸矩阵（28px / `--radius-md`），变体是 secondary（软底+细边），不是 ghost。圆角吃 `--radius-md`（6px，small 档 5px），**不是**用户锁的设置钮 7px。退化感来自次级实心小钮 + 行控件，不是竖分割。
- Schema 渲染的控件（外观/通用几乎不能用，见其它 survey）：很多不是 `Button ghost sm`，是原生/Schema 裸控件。定时任务截图「筛选项/模式钮退回浏览器默认方框」**不宜**算进 Toast 同源。
- 设置行 `SettingsUI.module.css` 卡片 hairline + `--radius-xl`，与 Toast 胶囊无关。

### 7.4 竖分割只属于 Toast 构图

全仓 Toast CSS **没有**竖线。假分割 = ghost sm 灰块左缘。把「竖分割」当成独立组件去搜会空手而归；要拆这套皮，得拆 **Toast 布局（文案+28px 灰 ×）** 和 **ghost sm 在提醒关闭位的误用**，不是去找一根 `border-left`。

同源公式更精确的写法：

> **同源原子**：`Button variant="ghost" size="sm"`（28px 灰方、按下果冻）。
> **Toast 加码**：常驻 `--tint-active` + 与短文案横排 → 假竖分割。
> **侧栏/模型工具条**：同一原子，单独成块，没有竖分割。
> **设置 secondary sm / 原生方框**：相邻病，不是同一条皮。

---

## 8. 额外发现（任务外但会害这套皮继续铺）

1. **`notify` 丢 `ok`**：成功本可走页内 hint，接口第一个参数是摆设。
2. **`options.type` 旁路策略**：错误调用图省事写成 `{ type: 'error' }`；`toast.success` 一旦被用，禁令作废。
3. **`AppToast.type` 不进 class**：就算想做对错两色，渲染器也画不出来。
4. **双发**：可行动 run error（横幅+Toast）；浏览器导入（行内+Toast）；`pickerInlineError` 名 inline 实 Toast。
5. **`workspace-picker-unavailable` 无订阅**（§5.8）。
6. **快照测仍 import 已删 `ToastBus`**：`tests/snapshots/ToastStack.test.tsx:6`。旧死通道迁完，测试类型源没迁。
7. **`--z-toast` = `--z-modal`**：提醒与模态同层。拖拽幽灵 `tabDragGhost.ts`、DevHealthOverlay 也吃这个 token。
8. **撤销 Toast 更堵**：归档/分叉合法走这套皮时，会多一颗 secondary sm「撤销」，三截胶囊。
9. **`reference/chat-composer-component`** 另有 `FM.toast` / `FlowMount.toast`，不进桌面 `ToastStack`。不要拿参考仓假壳当产品皮。

---

## 9. 对实现阶段的边界（调研不砍项，只标依赖）

本清单不提方案。实现若动这套皮，至少会碰到：

- 皮肤只在 `ToastStack.tsx` + `ToastStack.module.css`（一处改、全仓变）。
- 成功漏出要同时改 **调用点文案** 和 **`FORBIDDEN_SUCCESS_TOAST_PATTERNS`**，只改一边会再漂移（本截图就是证据）。
- `Button ghost sm` 是设置工具条 / 侧栏更多 / 提醒关闭的公共原子；只改 Toast 的 `.toastDismissBtn` 盖不住侧栏灰方块，只改 Button 会波及所有 ghost sm（含 Composer、Diff、Files）。
- 入场过弹 token `--transition-enter` 几乎只服务 Toast；改 token 等于改这套皮的弹法（survey/01 已列）。

---

## 10. 没核对的边

- 真机 PNG 像素（不在仓库）。
- CDP 录一次入场是否明显越过中线再回弹（曲线数学上会，观感幅度未测）。
- `ToastStack` 快照是否已因 ToastBus 删除而红（未跑测试）。
- 每个 drop 文案在 DEV 下 `console.warn('[toast policy] dropped…')` 的刷屏量。
- `blackhole/style.css` 等非产品壳的 toast 半径。
