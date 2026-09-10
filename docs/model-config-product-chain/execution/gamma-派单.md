# 轮次 γ 派单（S3 全界面读路径单轨）

## 1.1 问题识别

β 写核已接线。主界面仍读 LS / thinkingGear / 正则视觉。本轮闭合：Composer 徽标 / 思考档 / 附图入口与设置同一棵树。

## 1.2 / 1.3 分配

| Agent | 任务 | 写集 |
| --- | --- | --- |
| γ-1 | 唯一读 API + 去 128000 + findCatalogModel 双键 | `api/modelsCatalogLive.ts`（新）；`modelsCatalogSelectors.ts`；`modelsCatalogQuery.ts`；对应测试 |
| γ-2 | 会话 thinkingTitle + handoff 接到 runtime | `SessionRuntimeRegistry` 及相关类型；不要改 Composer TSX（γ-3） |
| γ-3 | Composer 融合触发读 live；档位卸载 | `ComposerFusedTrigger.tsx` 及其测试 |
| γ-4 | Picker 读 live；形态④搜索勿改坏 | `ModelBadgePickerMenu*`（数据源；样式尽量不动） |
| γ-5 | 视觉入口：preflight + attachments + 粘贴/文件 | `slashSendPreflight.ts`；`modelVisionSupport.ts`；`useChatAttachments.ts`；`ChatComposer.tsx`（file input）；`TiptapEditorExtensions.ts`（粘贴图） |
| γ-6 | 水合 + header/picker 订 catalog | `bootstrap-full.ts`；`ChatHeaderControls.tsx`；`useChatModelPicker.ts` |
| γ-7 | 设置读侧：侧栏/列表/自愈 | `ModelProfileList.tsx`；`ModelsSettingsTab.tsx`（读 tick）；`useModelProfilesState.ts` **仅读侧过滤/展示**（禁止改 saveConfig） |
| γ-8 | readiness 窗口 + 发送前 thinking 文案 | `api/chat-bridge/readiness.ts`；`api/provider-profiles/contextStatePending.ts` |

禁动：engine_provider / build_* / pricing.rs；旧岛提交；β 的 saveConfig 正序；CSS 大改（ε）。

同文件：`useModelProfilesState.ts` 仅 γ-7；`ChatComposer.tsx` 仅 γ-5。
