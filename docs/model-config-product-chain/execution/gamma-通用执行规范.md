# γ 轮通用执行规范

> 实现子 Agent = `00-总方案.md` + `plans/03-全界面读路径单轨.md` + `execution/β-轮次报告.md` + 本文件。
> 轮次：γ。对应维：S3。禁止 git commit / restore / reset。禁止派生子 Agent。

## 本轮鼓励

- 主对话模型下拉、思考档位、附图入口只读 `modelsCatalogStore` 投影（§3.2 唯一读 API）。
- 刷新只订 `models-catalog-changed` / `useModelsCatalogVersion`。
- `findCatalogModel` 必带 `providerId`；视觉只信 `modalities.input`。
- 思考标签 = yaml 字典 key；选中 Title 活在会话 runtime，不写 yaml。
- 缺 thinking = DOM 物理卸载。缺 contextWindow = undefined，禁止 128000。
- 启动必须 `ensureModelsCatalogLoaded()`。

## 本轮禁止

- 生产再读 `getModelMeta` / `thinkingGear` / `loadProfiles` 当规格。
- 正则猜视觉；`globalModelIndex[0]` 跨厂商。
- 把 `defaultThinkingLevel` 写入 yaml。
- 改 saveConfig 写语义（β 已闭合）；改 `request_options` / builder（δ）。
- 提交旧岛；新增 fallback / 双轨读。
- 只 abort 发送、入口仍可挂图。

## 交叉契约

唯一读 API 放 `apps/crish-desktop/src/api/modelsCatalogLive.ts`（可 re-export selectors）。符号名必须是 plans/03 §3.2：`getLiveProvider` / `getLiveModel` / `listLivePickerEntries` / `modelAcceptsInput` / `listThinkingOptions` / `resolveThinkingHandoff`。

会话选中档：`SessionRuntimeRegistry` 的 `thinkingTitle`。

## 轮末汇总

同 α 格式。用户路径默认未跑 4000。
