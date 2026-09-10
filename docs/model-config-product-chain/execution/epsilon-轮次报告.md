# 轮次报告：ε（主控亲力亲为，收口段）

## 轮次元信息

- 轮次：ε
- 对应维：S6（样式 token 与人体工学）——**核心段**（幽灵 token 清剿 + sticky 包含块修复 + 四态守门复跑）
- Agent 数：1（主控）
- 输入包：00-总方案 §S6 + plans/06 + execution/delta-轮次报告.md

## 一、已完成（源码形状 + 本会话真跑）

| 项 | 文件 | 修复 |
| --- | --- | --- |
| E1/E2 幽灵 token | `ModelsSettingsTab.module.css` | `--surface-primary`（不存在）→ 真底色 `--bg-card`；`--surface-secondary-raw`（不存在，色相 220 蓝相）→ `color-mix(in srgb, var(--text-primary) 2%/7%, var(--bg-card))`；`--button-radius, 7px` ×4 → `var(--button-radius)`（SSOT 8px）；`--button-radius, 6px` → `var(--radius-md)`（SSOT 6px） |
| E2 白底/幽灵 | `ScanResultsModal.module.css` / `YamlConfigEditorModal.module.css` / `ModelBadgePickerMenu.module.css` / `ChatComposer.module.css` | `#ffffff` 硬编码 → `var(--bg-card)`；`--text-on-brand`（不存在）→ 既有 `--text-on-accent`（tokens.css:258，4 处）；`--bg-surface, rgba(...)` → `--tint-hover`；`--bg-elevated, #ffffff` fallback 去掉；`--success-color` → `--color-success`；`--brand-primary, #0066cc`（Zero-Blue 禁区 fallback）→ `var(--brand-primary)` |
| E4 sticky 包含块 | `ModelsSettingsTab.module.css` `.mrdCfgFooter` | 移除魔术三件套（`position:sticky; bottom:-12px; backdrop-filter` + 幽灵 bg）——footer 实际位于滚动容器外（ModelConfigPanel 底部兄弟），恒可见可达；落 `--bg-card` 真底色 |
| E6 零 Emoji | `ModelProfileList.tsx` | 注释 5 处 🌟 星标装饰清除（AGENTS §21 / plans/06 E6「注释里留星标装饰」属违规） |

**验证（本会话真跑）**：`npm run check:input-guard` 100% 通过；`tsc --noEmit` 绿；ModelProfileList / ModelBadgePickerMenu / ScanResultsModal 三文件 28 测绿；settings-models 域再扫 Emoji/白底/幽灵 token 全净。

## 二、未闭合（诚实）

| 项 | 状态 |
| --- | --- |
| 真窗口视觉验收（4000） | 未跑（η）。「保存钮在抽屉滚动口底部可点」「深色主题观感」需真机确认 |
| 深色主题全仓白块扫尾 | 本轮清 settings-models/provider/chat-composer 域；全仓其它域的 `#fff`/`#ffffff` 组件 fallback 未逐一清（S7 大扫除面） |
| E5 思考区卸载 | 源码形状：抽屉 `ModelThinkingEditor` 条件渲染（`cfgDraft.thinkingEnabled &&`）、Composer 右槽/Picker 高级轨 S3 已物理卸载——DOM 级确认需 4000 |
| E7 保存路径真机 | S2 保存链已通（β）；点得到 + 磁盘落字段需 4000 |

## 三、输出到下一轮

- **ζ（S7 删旧轨）可启动**：生产消费已零的 `pricingStore` 会话模块、`selectEstimatedCost` gravestone、`EngineProviderConfig` 槽位字段、`catalog_vendor`/`responses_supported`（cfg(test)）、陪葬测试清册均可物理删除。
- **η 前置**：4000 全链验收（磁盘/网络/UI/反例，plans/08 §4）。ε 的视觉三连（保存可达/深色观感/思考区卸载）一并归 η 真机确认。
