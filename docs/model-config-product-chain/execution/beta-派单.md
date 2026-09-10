# 轮次 β 派单（S2 设置写路径保存即落盘）

## 1.1 问题识别

| 字段 | 值 |
| --- | --- |
| 轮次代号 | β |
| 对应维 | S2 |
| 本轮要对齐的 §3 动词 | 点保存 → 磁盘 ~/.conex/models.yaml 出现同等字段 |
| 上轮未闭合 | 抽屉 saveConfig 仍 LS；Composer 读路径；出站 Default 清空 map；4000 未跑 |
| 依赖是否已满足 | 是。α：updateModel → workbench_save_models_yaml；providers 往返不丢字段 |
| 工作区风险 | 旧岛三文件仍 dirty，禁止提交、禁止当实现面 |

## 1.2 任务分解

| 任务单元 | 写集 | 禁动 | 验收 |
| --- | --- | --- | --- |
| T2-1 | `apps/crish-desktop/src/api/modelsDraftMap.ts`（新）及其测试；`modelProfilesHelpers.ts` 仅 rev 签名改读 ModelSpec | UI；IPC | draft→patch 规范键；空价省略；思考关闭省略；contextWindow；不写 defaultThinkingLevel |
| T2-4 | `apps/crish-desktop/src/api/modelsLsImport.ts`（新）及其测试 | 旧岛实现面；saveProfiles | 空 yaml+LS → 树含字段；yaml 已有 thinking 不被 LS 覆盖；完成标记后零读配置键；坏 JSON 不播种 |
| T2-2 T2-3 T2-5 | `useModelConfigSession.ts`；`modelsIpcHelpers.ts` | Composer；engine | saveConfig 正序；废止 applyMetaForModel 生产调用；打开草稿读 selectModel |
| T2-3 其它入口 T2-6 | `useModelProfilesState.ts`；`useModelProviderActions.ts`；`ModelList.tsx`；`ProviderProfileForm.tsx`；`ModelsSettingsTab.tsx`（挂载导入 + 列表读 store） | useModelConfigSession（β-3）；Composer | 手填/扫描/启用/删除/协议/BaseURL 走 store；Select 含 google/generate-content |
| T2-7 | 本维相关 `settings-models/**/*.test.*`；禁止只断言有保存按钮 | 不改产品算法，只改测 | 保存测断言 serialize/yaml 含 thinking/modalities/cacheRead |

## 1.3 Agent 分配

| Agent | 任务 | 写集 |
| --- | --- | --- |
| β-1 | T2-1 | modelsDraftMap.ts + test；modelProfilesHelpers.ts 的 revision |
| β-2 | T2-4 | modelsLsImport.ts + test |
| β-3 | T2-2/3/5 抽屉主路径 | settings-models/useModelConfigSession.ts；modelsIpcHelpers.ts |
| β-4 | 其它写入口 + 协议选项 + 设置页挂载 | useModelProfilesState.ts；useModelProviderActions.ts；ModelList.tsx；ProviderProfileForm.tsx；ModelsSettingsTab.tsx（及同目录仅被这些入口占用的小文件，不得改 CSS） |
| β-5 | T2-7 测试改写 | settings-models 测试；useModelConfigSession 测试；不得把测改成只 spy 按钮 |
| β-6 | 审计 | 实现收齐后；产出 audits/β-执行位抽检.md |

## 1.4 互斥

| 路径 | 所有者 |
| --- | --- |
| modelsDraftMap.ts | β-1 |
| modelsLsImport.ts | β-2 |
| useModelConfigSession.ts / modelsIpcHelpers.ts | β-3 |
| useModelProfilesState / Actions / ModelList / ProviderProfileForm / ModelsSettingsTab | β-4 |
| 上述测试文件 | β-5（与实现文件冲突时：实现改完后 β-5 再写测；若并行，β-5 只动 `*.test.*`） |
| modelsCatalogStore.ts / Ipc / catalog_types | 禁改（α 已闭合） |
| modelCatalog* 旧岛 | 禁写禁提交 |
| Composer / engine_provider | 禁改 |
