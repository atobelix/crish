# 多 Agent 协同实现方案与任务分工总纲

> **文件标识**：`docs/model-capability/01-多Agent协同实现方案与任务分工总纲.md`  
> **制定时间**：2026-09-03  
> **指导思想**：文件域绝对正交、零重叠、零锁冲突；每位 Agent 独立承担单一模块的实现与单元测试；主控统一调度、验证与 Git 收口。

---

## 一、 6 大任务包物理文件域正交矩阵

为确保 6 位子 Agent 能够 100% 并行执行且绝不触发文件写冲突，严格划分文件白名单：

| 任务包 | 责任角色 | 独立物理文件域（仅允许读写本域文件） | 核心攻坚交付物 |
| :--- | :--- | :--- | :--- |
| **Task-A** | 状态机与性能底座工程师 | • `apps/crish-desktop/src/api/modelCatalogMeta.ts`<br>• `apps/crish-desktop/src/api/modelCatalogMeta.test.ts` | 单例 `memoryMetaCache` 内存镜像缓存（防 1340 次高频反序列化）；写入后广播 `model-meta-changed` 事件。 |
| **Task-B** | 原子开关与乐观交互工程师 | • `apps/crish-desktop/src/components/ui/Switch/Switch.tsx` | 0ms 乐观响应状态机（`optimisticChecked`），点击瞬间触发果冻弹动动画，消除受控延迟。 |
| **Task-C** | 级联菜单与 Portal 逃逸工程师 | • `apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx` | `ModelsCascadeSelect` 刚性过滤禁用模型；二级子菜单 Portal 逃逸挂载并注明白名单；修复安全三角反向 180°。 |
| **Task-D** | 视觉重构与样式瘦身工程师 | • `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css` | 彻底清退 1165 行中滥用的 `--bg-secondary` 杂乱灰阶，样式表瘦身 75% 至 ~295 行；全面对齐纯白卡底。 |
| **Task-E** | 弹性视口与滚动隔离工程师 | • `apps/crish-desktop/src/components/settings/SettingsPanel.module.css`<br>• `apps/crish-desktop/src/components/settings/SettingsPanel.tsx`<br>• `apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx` | 彻底拔除 `calc(100vh - 220px)`，锁定外层滚动；右侧构建三段式布局（固定头带弹性上限 + 固定操作栏 + 独立模型滚动视口）。 |
| **Task-F** | YAML 编辑器与直达交互工程师 | • `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.tsx`（新建）<br>• `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css`（新建）<br>• `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx` | 顶栏新增 `[ 配置文件 (YAML) ▾ ]` 组合按钮；实现内置双层轻量语法高亮编辑器；接入外部打开与同厂商自愈降级。 |

---

## 二、 纪律与验证守门

1. **子 Agent 行为纪律**：
   - 使用 **pwsh7** 执行命令，文件输出采用 **UTF-8 无 BOM**；
   - 仅限在自己分配的物理文件域内修改或新增代码；
   - **严禁执行 git 提交、git checkout、git reset**，所有改动保留在工作区；
   - 任务完成后自测（跑通对应文件的单元测试与语法检查），向主控简短汇报。
2. **主控 Agent 收敛验证**：
   - 收集所有子 Agent 终态汇报；
   - 全局运行：`npm run typecheck`（类型检查 0 报错）；
   - 全局运行：`npm run check:line-counts`（1180 个文件 0 违规）；
   - 全套跑通 Vitest 相关测试；
   - 验证无误后由主 Agent 统筹提交。