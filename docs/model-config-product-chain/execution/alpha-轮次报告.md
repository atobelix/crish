# 轮次报告：α

## 轮次元信息

- 轮次：α
- 对应维：S1
- 本轮 Agent 数：8（实现 5 / 补洞 2 / 审计 1）
- 任务单元：S1-U1、S1-U2U3、S1-U5、S1-U1TS+U2U3FE、S1-U4-U6、S1-补-删 tree 次路径、S1-补-解析合一
- 输入包：00-总方案 + plans/01 + 无上轮报告
- 本轮闭合的产品链环节（只用调度 §3 动词）：
  - [ ] 设置抽屉编辑 modalities / thinking / pricing / protocol
  - [ ] 点保存
  - [x] 磁盘 ~/.conex/models.yaml 出现同等字段（**仅 IPC/测试往返形状**；设置抽屉未接线）
  - [x] modelsCatalogStore 与 live_catalog 同时反映该树（IPC `providers` + `LiveModels.find`；未跑 4000）
  - [ ] Composer 模型徽标 / 思考档位 / 附件入口读同一棵树
  - [ ] 用户选档位、发消息（纯文本或带图）
  - [ ] 出站 HTTP JSON 含 yaml 字典映射出的 wire 键值
  - [ ] 无图模型若带图：入口不可挂或出站硬拒（不得静默改成文本）
  - [ ] SSE usage 进入 PricingEngine
  - [ ] 会话 UI 展示的费用 = 微元定点结果
- 门禁（三层分开）：源码形状 **过** · 真跑测 **过** · 用户路径 **本轮未触达**

## 一、已完成

| 任务单元 | 文件域 | 改动摘要 | 闭合了哪条 §3 动词 |
| --- | --- | --- | --- |
| S1-U1 | catalog_types / catalog | headers；窗口 Option；LiveModels；废止 DynamicYaml* | 镜像可持树 |
| S1-U2U3 | models_yaml.rs | providers 同构；flatten lossy；往返 thinking.Low | IPC 往返不丢字段 |
| S1-U5 | protocol / engine_provider | live_catalog 可 find；槽位灌入；不改 request_options | live 可被热路径引用 |
| S1 前端 IPC | modelsCatalogIpc / Types | 只打 workbench_*；删 convertFlat | 读消费 providers |
| S1-U4 | Store | fail-closed；未加载拒写 | 失败不覆盖用户文件 |
| S1-补1 | Store | 只认 providers；停 no-op 热重载注册 | 无 tree 次路径 |
| S1-补2 | catalog_types + models_yaml + protocol | 同一 from_yaml_str_detailed；首次坏文件显式错误 | IPC 与 live 同解析 |

## 二、未闭合环节与阻断依赖

| §3 动词或任务单元 | 阻断依赖 | 建议承接轮次 |
| --- | --- | --- |
| 点保存（抽屉） | saveConfig 仍走 LS | β / S2 |
| Composer 读同一棵树 | 仍 getModelMeta | γ / S3 |
| 出站 HTTP 字典 | request_options 仍 Default 清空 map + bundled_catalog | δ / S4 |
| 选择器发明 128000 | modelsCatalogSelectors.ts:47-52 | γ（S3-窗口不发明） |
| YAML 弹窗 4000 往返 | 本轮未跑 MCP | β 或 η |
| DTO 投影结构体暂留 | ModelsYaml*V2 从树投影，非第二解析器 | ζ 可删 |
| 热重载 no-op 导出仍在 | modelsCatalogIpc.ts setupModelsYamlHotReloadListener | ζ |
| 旧岛幽灵注释 | modelCatalogTypes.ts:333 | ζ，禁提交扩字段 |

## 三、文件清单与是否误伤并行域

| 路径 | 任务单元 | 误伤 | 处理 |
| --- | --- | --- | --- |
| crates/agent-provider/src/models/catalog_types.rs | U1 + 补2 | 否 | — |
| crates/agent-provider/src/models/catalog.rs | U1 + 补2 | 否 | — |
| apps/agent-workbench/src-tauri/src/models_yaml.rs | U2U3 + 补2 | 否 | 串行补洞 |
| protocol.rs / engine_provider.rs | U5 + 补2 | 否 | 仅 live 错误态 |
| EngineProviderConfig 字面量测试文件 | U5 | 否 | 仅 `..Default::default()` |
| modelsCatalogIpc.ts / Types / Ipc.test.ts | 前端 IPC | 否 | — |
| modelsCatalogStore.ts 及测试 / probeIncremental.test.ts | U4 + 补1 | 否 | — |
| modelsCatalogActions.ts | U4 | 否 | 仅注释 |
| modelCatalog*.ts 旧岛 | 禁写 | 工作区仍有前置 dirty | **不提交** |

未提交八文件是否出现在本次 diff/commit 名单：否（主控提交时必须排除）

## 四、新发现（同权）

| 编号 | 文件域 | 现象 | 建议承接 |
| --- | --- | --- | --- |
| N1 | modelsCatalogSelectors.ts | 缺 contextWindow 发明 128000 | γ |
| N2 | YAML 1.1 | thinking 键 Off 可能被当成布尔，写出需加引号 | 写路径/测钉 |
| N3 | modelsCatalogQuery.ts | google/generate-content 反映射为 interactions | γ/ζ |
| N4 | IPC 投影 | 省略 protocol 读回可能变成 openai/chat 默认 | β 写出时显式协议（M15） |

## 五、验证结果（三栏分开，禁止合并成一句「测试绿」）

### A. 源码形状

- 命令：rg 幽灵名 / convertFlat / wire.tree / live_catalog dead_code
- 本会话真跑：是
- 命中/零命中：生产 `models_yaml_read|write|reload` invoke = 0（旧岛注释除外）；`convertFlatModelsToTree` = 0；`protocol.rs` 无 `#[allow(dead_code)]`；Store 只认 providers
- 结论：过

### B. 本会话真跑测

| 命令 | 本会话真跑 | 结果 | 摘要 |
| --- | --- | --- | --- |
| `cargo test -p agent-provider --lib catalog` | 是 | 绿 | 71 passed（补洞后） |
| `cargo test -p crish-agent-workbench --bin crish-agent-workbench -- models_yaml live_catalog` | 是 | 绿 | 23 passed |
| `npx vitest run src/api/modelsCatalogIpc.test.ts src/api/modelsCatalogStore.test.ts src/api/probeIncremental.test.ts` | 是 | 绿 | 48 passed（补洞后） |

### C. Tauri 4000 用户路径

- 应用：本轮未跑
- 水合：未跑
- 剧本步骤：全部「未跑」。不得把 vitest 冒充弹窗往返。

## 六、新引入的 fallback / TODO / 双轨

必须为 0。补洞后：解析唯一入口 `UnifiedModelsConfig::from_yaml_str_detailed`；Store 无 tree 次路径。DTO 投影不是第二解析器。

| 路径:行号 | 类型 | 为何出现 | 下一轮必须 |
| --- | --- | --- | --- |
| （空表） |  |  |  |

## 七、输出到下一轮（下一轮 Agent 只读本节 + 总方案 + 维指示）

- 建议启动的任务单元（同权，只按依赖可启动）：**S2 全部**（T2-1…T2-7）。S1 写 IPC / fail-closed / providers 已具备，不阻断 β。
- 仍不可启动及原因：S3 读路径（Composer 仍 LS）；S4 request_options；S7 删旧轨。
- 互斥表变更：α 写集此后只读；β 独占 settings-models 写路径与 `modelsLsImport.ts` / `modelsDraftMap.ts`。
- 八文件状态：仍在工作区但不提交。
- α 交给 β 的保证：`await modelsCatalogStore.updateModel/updateProvider/addModel/addProvider` → `workbench_save_models_yaml`；失败回滚；成功发 `models-catalog-changed`。
