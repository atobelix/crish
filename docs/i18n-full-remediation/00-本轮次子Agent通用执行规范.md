# i18n 全景系统重构战役 —— 本轮次子 Agent 通用执行规范与纪律守则

> **文件标识**：`docs/i18n-full-remediation/00-本轮次子Agent通用执行规范.md`  
> **制定版本**：v2.0（基于 Phase 5 双盲独立审计查获 24 项缺陷后的终极加固版）  
> **适用范围**：本战役所有参与执行的子 Agent、主控调度器及执行期审计员  
> **核心原则**：反退避、反作弊、零破损、强互斥、立体验证

---

## 一、通用纪律与协作红线

### 1. Git 提交权唯一性（绝不妥协）

- **子 Agent 严禁提交**：子 Agent **绝对禁止** 执行 `git commit`、`git push`、`git reset --hard`、`git checkout .`、`git restore`！
- **改动留存与主控收口**：子 Agent 完成任务后，将改动留在本地工作区（保留好修改的精确文件），通过消息向主 Agent 汇报完成并列出修改的文件清单与验证结果；由主 Agent 验证无误后统一执行 `git commit --only <paths>` 限定本次改动范围收口提交。
- **严禁擅自回撤他人文件**：如遇工作区有其他文件的改动，不得执行任何清理或重置操作，严格执行最小路径原则。

### 2. 子 Agent 调度与执行环境

- **嵌套禁止（REQ-D08）**：子 Agent 深度仅为 1，无派发子 Agent 权限（工具表中已禁用 `invoke_subagent`）。
- **执行环境**：统一使用 **pwsh7（PowerShell 7+）** 执行终端命令，杜绝 Windows PowerShell 5.1 的 GBK 编码与变量插值问题。
- **文件编码**：所有写入或修改的文件一律使用 **UTF-8 无 BOM** 格式，保留既有换行符（LF/CRLF 自适应）。
- **命令等待纪律**：如果设置定时器，最短为 **100 秒**；长耗时构建或测试命令采用系统推送通知（Reactive Wakeup），严禁高频死循环轮询。

---

## 二、反作弊与反退避七大禁令（违者必撤）

所有子 Agent 在编写与审查代码时，必须严格遵守以下 7 大反作弊刚性红线：

|    序号    | 作弊/偷懒模式            | 典型恶劣表现                                                | 正确规范标准                                                                               | 门禁拦截手段                                                   |
| :--------: | :----------------------- | :---------------------------------------------------------- | :----------------------------------------------------------------------------------------- | :------------------------------------------------------------- |
| **红线 1** | **伪翻译与敷衍拷贝**     | 在 `en-US` 字典中原样保留中文，或充斥全角标点（`，。？！`） | 必须提供地道英文对照，英文包汉字与全角标点严格为 0                                         | `scripts/check-i18n-symmetry.mjs` 纯度断言刚性拦截（退出码 1） |
| **红线 2** | **字符串拼接伪国际化**   | `t('common.delete') + ' ' + itemName`                       | 严禁拼接，必须使用命名插值：`t('common.deleteItem', { name: itemName })`                   | `scripts/check-i18n-hardcoded.mjs` AST 判据拦截                |
| **红线 3** | **三元硬编码分支**       | `lang === 'zh' ? '保存' : 'Save'`                           | 严禁在业务逻辑中保留硬编码语言分支，统一由 i18n 字典驱动                                   | AST 扫描器拦截 JSX/TS 中文节点                                 |
| **红线 4** | **滥用抑制标记**         | 到处乱贴 `/* i18n-allow */` 或随意改动全局白名单            | 仅允许静态专有名词和协议头使用；门禁严格校验抑制白名单并审计留痕                           | 门禁扫描器白名单差分比对与审计员审查                           |
| **红线 5** | **向用户暴露点分裸 Key** | 找不到词条时直接给用户展示 `settings.nav.about`             | 必须建立 4 级降级漏斗（目标语言 $\to$ 缺省参数填补 $\to$ zh-CN 兜底 $\to$ 语义回退文案）   | `I18nProvider` 兜底断言测试覆盖                                |
| **红线 6** | **UI 文本膨胀截断破坏**  | 英文文本比中文长 50%~100%，导致容器高度塌陷或撑爆布局       | 侧边栏/小控件强制接入 Defensive CSS 三防线（`nowrap + min-width: 0 + ellipsis + Tooltip`） | 视觉验收与 DOM 边界断言                                        |
| **红线 7** | **虚假测试与空断言**     | 测试用例仅 `expect(true).toBe(true)`，未做实质逻辑检验      | 必须包含双语切换断言、参数插值断言、缺失降级断言与边界断言                                 | Phase 8 专职审计员双盲人工与自动化复核                         |

---

## 三、文件物理所有权互斥锁矩阵（File Mutex Locks）

为防止多 Agent 并行执行时产生 Git 冲突，必须严格遵循以下独占锁规则：

### 1. 枢纽文件只读冻结机制

- **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/index.ts`**：
  - 在 **Wave 0.1** 由 `AGENT-INFRA` 一次性建立骨架并固化聚合逻辑；
  - **自 Wave 0.2 起全仓只读冻结**，主控以 SHA-256 哈希值守卫，严禁后续任何业务 Agent 触碰与修改！
  - 各业务模块通过在各自独立的物理子文件中扩展词条，`index.ts` 自动使用 `import * as ...` 动态聚合导出。

### 2. 模块物理隔离与独占分工表

| 任务领域                           | 独占写入文件/目录白名单                                                                                       | 严禁触碰的禁区                               |
| :--------------------------------- | :------------------------------------------------------------------------------------------------------------ | :------------------------------------------- |
| **基础架构底座 (Wave 0)**          | `src/i18n/locales/**`, `src/i18n/SafeIntl.ts`, `src/i18n/I18nContext.tsx`, `scripts/check-i18n-*.mjs`         | 业务组件目录 (`src/components/`, `src/api/`) |
| **底层渲染与解耦 (Wave 1.1)**      | `src/components/chat/markdown/unitReconciler.ts`（紧急解耦）                                                  | Rust 目录、侧栏与设置组件                    |
| **Rust 语义渲染 (Wave 1.2)**       | `crates/conex-markdown/src/lib.rs` 等 Rust 源码                                                               | 前端 TypeScript 源码                         |
| **设置契约与前置改造 (Wave 1.3)**  | `src/components/settings/SettingsSchemaRenderer.tsx`, `settingsTabsMeta.ts`                                   | 设置各具体 Tab 页面、侧边栏                  |
| **会话正则修复 (Wave 1.4)**        | `src/components/sidebar/session-list/SessionRow.tsx`                                                          | 会话列表其他组件、聊天核心流                 |
| **错误契约与翻译 (Wave 1.5, 2.3)** | `packages/agent-provider/src/error-registry.ts`, `src/utils/error-translation.ts`, `src/stores/ToastStore.ts` | 界面组件、底层解析器                         |
| **设置 15 Tab 改造 (Wave 3)**      | 按 Tab 页面文件分配独占所有权（每个 Agent 负责专属 Tab 组）                                                   | 其他 Agent 的 Tab 文件、`SettingsLayout.tsx` |
| **侧栏排版防御 (Wave 3.3)**        | `src/components/settings/SettingsSidebar.tsx`, `SettingsSidebar.css`                                          | 对话框、Markdown 渲染器                      |
| **空态与对话流 (Wave 3.4)**        | `src/api/chatEmptyState.ts`, `src/components/chat/composer/`                                                  | 设置模块、错误注册表                         |

---

## 四、核心技术架构断层处置标准

参与相关任务的 Agent 必须严格落实 Phase 5 审计查获的技术决议：

### 1. `unitReconciler.ts` 紧急解耦规范（因果 B）

- **现状危害**：`src/components/chat/markdown/unitReconciler.ts:45` 硬编码 `[aria-label="表格"]` 强行绑定中文。
- **解耦操作**：
  1. 前端先重构选择器为：`.md-table-wrap, [data-md-table="true"]`；
  2. 保持对历史可能残存 `[aria-label="表格"]` 的短期并集兼容 `selector = '.md-table-wrap, [data-md-table="true"], [aria-label="表格"]'`；
  3. 待前端解耦完成并测试通过后，Rust `conex-markdown` 输出语义属性 `data-md-table="true"` 与 class `md-table-wrap`，彻底拔除中文污染。

### 2. `SessionRow.tsx` 会话分支算法重塑规范

- **现状危害**：行 270 使用中文正则 `t.replace(/ - 分支$/, '')`，在英文环境（`- branch`）及复杂分支下严重失效并引发逻辑 Bug。
- **重塑操作**：
  - 彻底废止基于标题字符串的正则截断！
  - 引入单一真理源纯逻辑函数 `getSessionCleanTitle(session: SessionItem): string`：
    基于会话真实元数据（`s.branchParentId` 与系统自动命名标志）推导洁净标题，或在展示层统一剥离已知的多语言分支后缀集合。

### 3. `api/chatEmptyState.ts` 资产绝对保护规范

- **红线要求**：必须 100% 保护现有的 699 行 `chatEmptyState.test.ts` 资产，严禁破坏既有测试！
- **重构方案**：采用双层解耦模式：
  - **Layer 1（结构化描述符）**：提供语言中立的卡片定义与 Key 契约；
  - **Layer 2（运行时求值层）**：提供 `getLocalizedEmptyCards(t: TranslateFn)`；
  - **兼容保障**：在模块顶层显式导出保留原有的 `CHAT_EMPTY_TITLES` 等常量结构，作为 zh-CN 的权威镜像，确保老单测零修改全绿通过！

### 4. 105 错误码契约与 ToastStore 消费规范

- **注册表清理**：`CRISH_ERROR_REGISTRY` 拔除 3 处硬编码中文长句污染（`DEVICE_FLOW_BROWSER_NOT_ALLOWED`、`STREAM_DECODE_ERROR`、`WINDOW_FRAME_INIT_ERROR`），统一替换为地道英文与对应的 `messageKey`；
- **元数据通道**：`error-translation.ts` 接入 Level 2 权威契约，杜绝由于 `titleKey` 缺失而向用户弹出大写英文 `"Title"`；
- **ToastStore 重塑**：`ToastStore.addToast` 增加原生消费标准 `CrishError` / `UserVisibleError` 对象重载，自动完成本地化翻译与参数注入。

### 5. 侧边栏 Defensive CSS 三防线与 Tooltip 规范

- **CSS 三防线**：
  ```css
  .nav-item-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1 1 auto;
  }
  ```
- **Tooltip 挂载规范**：
  - 必须使用项目自定义 `<Tooltip>` 组件（严禁使用原生 HTML `title` 属性）；
  - 属性名必须为 `delayShow={300}`（**严禁** 误写为 `delayMs`！）；
  - 引入 `useIsTruncated` 机制，仅当文本实际发生物理截断（`scrollWidth > clientWidth`）时挂载 Tooltip，防止无意义气泡干扰阅读。

---

## 五、任务完成与验收汇报格式

子 Agent 在完成分配的任务后，汇报消息必须包含以下结构化区块：

```markdown
### 1. 任务完成概要

- 负责任务：[任务编号与名称]
- 涉及领域：[底层 / UI / 字典 / 门禁]

### 2. 精确改动文件清单 (UTF-8 无 BOM)

- `path/to/file1.ts` (+15, -3)
- `path/to/file2.tsx` (+42, -18)

### 3. 立体验证与门禁通过证据

- [x] TypeScript 类型检查：`npm run typecheck` 通过（无 TS 错误）
- [x] 单元测试套件：`npm run test -- [相关测试文件]` 通过（测试数量与断言证据）
- [x] i18n 防作弊扫描：`npm run check:i18n` 扫描通过（零新增硬编码违规）
- [x] 语言纯度验证：en-US 汉字数为 0，全角标点为 0

### 4. Git 纪律自检确认

- [x] 确认未执行 `git commit` / `git push`
- [x] 确认未执行 `git reset` / `git restore`
- [x] 所有修改安全保留在工作区等待主控统一收口提交
```

---

> **结语**：本规范自发布起立即生效，作为本战役后续所有实现与审计波次的最高执行标准。严格遵守规范，杜绝偷懒与作弊，确保 Conex / Crish 国际化与系统重构交付业界顶尖品质。
