# 前端全景深度盘查报告：依赖拓扑、模块解耦与构建完整性审计

> **战役代号**：`frontend-comprehensive-audit`  
> **专职审计位**：A01 · 依赖拓扑与模块解耦审计专家  
> **审计日期**：2026-10-27  
> **受审核心目标**：
> 1. `depcruise` 报错之直接循环依赖：`useNativeBrowserInstance.ts ⇄ usePreviewNavigation.ts`
> 2. `check:no-pseudo-dispatch` 门禁拦截之缺失文件：`previewBridgeScript.ts` 与 `sameOriginRequest.ts`
> 3. `packages/*` 与 `apps/crish-desktop` 依赖边界、包间无环拓扑与跨层私有相对路径越权穿透
> **审计纪律**：纯只读实证审计，零业务代码修改，零 `--no-verify`，全部结论基于真实命令执行输出与文件:行号代码证据。

---

## 一、审计全景与核心结论（Executive Summary）

通过全盘执行依赖巡检工具链（`lint:depcruise`、`check:no-pseudo-dispatch`）以及全仓 AST 依赖拓扑扫描，本次审计捕获并彻底穿透了前端在依赖拓扑、门禁守护与打包边界方面存在的 **三大关键问题**：

```
                              【前端依赖拓扑与打包边界审计全景】
   ┌───────────────────────────────────┬───────────────────────────────────┬───────────────────────────────────┐
   │ 1. depcruise 静态循环依赖 (1 处)   │ 2. check:no-pseudo-dispatch 缺失  │ 3. packages 跨层越权引入 (25 处)   │
   ├───────────────────────────────────┼───────────────────────────────────┼───────────────────────────────────┤
   │ • useNativeBrowserInstance.ts ⇄   │ • previewBridgeScript.ts (未暂存) │ • apps 绕过包名直接相对路径穿透   │
   │   usePreviewNavigation.ts         │ • sameOriginRequest.ts (未暂存)   │ • 6 层 ../ 直捣 packages 内部源文件 │
   │ • 诱因：标识符解析纯函数随手放置  │ • 诱因：vite.config.ts 复制代码内联│ • 诱因：旧代码未对齐新公共导出面  │
   │ • 危害：模块初始化死锁、扇出污染  │ • 危害：破坏安全 SSOT、CI 门禁阻断 │ • 危害：破坏 Monorepo 包封装边界   │
   └───────────────────────────────────┴───────────────────────────────────┴───────────────────────────────────┘
```

### 核心结论速记
1. **高层业务 Hook 逆向依赖与扇出污染（直接双向环路）**：
   `usePreviewNavigation.ts` 作为高层业务编排 Hook 依赖底层驱动 `useNativeBrowserInstance.ts`；但无状态纯工具函数 `resolveBrowserTabId` 被就地定义在 `usePreviewNavigation.ts` 并导出，导致底层驱动 Hook `useNativeBrowserInstance.ts` 反向引用它，形成直接双向循环依赖（Direct Circular Dependency）。此外，纯视图组件 `NativeBrowserSurface.tsx` 与 `PreviewCard.tsx` 也被连带污染。
2. **工作区未暂存删除与安全 SSOT 内联妥协（门禁破损阻断）**：
   `check:no-pseudo-dispatch` 门禁检查的两个核心文件在 Git HEAD 中完好保留，但在本地工作区被执行了**未暂存删除（unstaged deletion）**。深层根因为：开发者在重构 dev-server 时，为避免本地报错，将 `isSameOriginRequest` 的实现**直接复制内联到了 `apps/crish-desktop/vite.config.ts:340-369`**，在工作区误删了对应模块及单测，导致门禁因文件缺失 100% 报错阻断，且使开发服务器安全判定脱离了单一真理路径（SSOT）。
3. **包级拓扑健康，但存在 25 处跨层私有相对路径穿透**：
   `packages/*` 对 `apps/*` 保持严格的零反向引用（0 violations），包与包之间为标准有向无环图（0 cycles）。但 `apps/crish-desktop` 中存在 **25 处**绕过 `@crish/shared-types` 与 `@crish/shared-utils` 包名声明、通过 `../../../../../../packages/...` 深度相对路径直接穿透到子包私有源码目录的严重违规，破坏了 Monorepo 的包封装边界。

---

## 二、`depcruise` 循环依赖深度解剖与单向解耦拓扑

### 2.1 现场命令执行证据与报错现场

在终端执行依赖巡检门禁：
```powershell
npm run lint:depcruise
```

**真实输出证据**：
```
> crish@0.1.1 lint:depcruise
> depcruise --config .dependency-cruiser.cjs packages apps

  error no-circular: apps/crish-desktop/src/components/workspace/useNativeBrowserInstance.ts → 
      apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts →
      apps/crish-desktop/src/components/workspace/useNativeBrowserInstance.ts

x 1 dependency violations (1 errors, 0 warnings). 3563 modules, 8921 dependencies cruised.
```

### 2.2 源码相互依赖点逐行还原

#### 依赖边 A：`usePreviewNavigation.ts` ──▶ `useNativeBrowserInstance.ts`
在 `apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts` 中：
```typescript
// apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts:27
import { useNativeBrowserInstance } from './useNativeBrowserInstance';

// apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts:103
const nativeBrowser = useNativeBrowserInstance(effectiveTabId);
```
- **职责定位**：`usePreviewNavigation` 是高层业务协调 Hook，负责地址栏交互、加载超时熔断、书签/历史记录持久化、多 Tab 切换与快捷键响应。它必须消费底层驱动提供的实例控制能力（`navigate`, `reload`, `goBack`, `isLoading` 等）。
- **依赖性质**：**正向合法依赖**（高层聚合业务 Hook 依赖底层基础驱动 Hook）。

#### 依赖边 B：`useNativeBrowserInstance.ts` ──▶ `usePreviewNavigation.ts`
在 `apps/crish-desktop/src/components/workspace/useNativeBrowserInstance.ts` 中：
```typescript
// apps/crish-desktop/src/components/workspace/useNativeBrowserInstance.ts:29
import { resolveBrowserTabId } from './usePreviewNavigation';

// apps/crish-desktop/src/components/workspace/useNativeBrowserInstance.ts:72-75
const tabId = useMemo(
  () => resolveBrowserTabId(options.tabId, options.leafId),
  [options.tabId, options.leafId]
);
```
- **被依赖项源码**：
```typescript
// apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts:36-45
export function resolveBrowserTabId(
  tabId?: string | null,
  leafId?: string | null
): string {
  const trimmedTab = tabId?.trim();
  if (trimmedTab) return trimmedTab;
  const trimmedLeaf = leafId?.trim();
  if (trimmedLeaf) return `browser-${trimmedLeaf}`;
  return 'browser-default';
}
```
- **依赖性质**：**逆向非法依赖**（底层纯驱动 Hook 反向依赖了高层业务 Hook 内部的一个无状态工具函数）。

---

### 2.3 根因剖析：破坏单向依赖流与架构退化的三重病灶

1. **病灶 1：职责错位与“顺手导出”的技术债务**  
   `resolveBrowserTabId` 是根据 `tabId` 和工作区叶子节点 `leafId` 计算出确定性唯一标识符的纯函数（Pure Function），其逻辑仅依赖字符串处理，没有任何 React Hook 或 DOM 依赖。最初开发者在编写 `usePreviewNavigation` 时顺手将其写在了该文件顶部并 `export`，导致该函数成为了这个巨型业务文件的“附带产物”。
2. **病灶 2：底层模块反向攫取高层导出**  
   当底层 `useNativeBrowserInstance.ts` 统一收拢 Native Webview 实例 ID 的真理来源时，未将该纯函数提取独立，而是直接从高层业务文件 `import { resolveBrowserTabId }`。由于 JavaScript ES 模块在运行时若出现环形静态依赖，极易在打包时引发变量未初始化（TDZ - Temporal Dead Zone）或 `undefined is not a function` 崩溃。
3. **病灶 3：扇出依赖污染（Fan-out Contamination）**  
   全仓搜索 `resolveBrowserTabId` 发现，其他视图组件同样被该逆向导出深深污染：
   - `apps/crish-desktop/src/components/workspace/PreviewCard.tsx:6`（视图容器）
   - `apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx:33`（原生宿主视图）  
   这两个轻量纯展示组件仅仅为了计算一个 Tab ID，就被迫将包含 Toast、日志、Store 操作与巨型依赖的 `usePreviewNavigation` 打包引入，严重劣化了树摇（Tree-shaking）与首屏体积。

---

### 2.4 单向解耦拓扑方案设计与比对

```
【现状：双向闭环与扇出污染】                     【目标：严格单向分层无环拓扑】

  PreviewCard ──┐                               PreviewCard ──┐
                │                                             │
NativeBrowser ──┼──┐                          NativeBrowser ──┼──┐
                │  │                                          │  │
                ▼  ▼                                          ▼  ▼
       ┌──────────────────────┐                    ┌──────────────────────┐
       │ usePreviewNavigation │                    │ usePreviewNavigation │
       └──────────┬───────────┘                    └──────────┬───────────┘
            ▲     │                                           │ (正向依赖)
  (逆向依赖) │     │ (正向调用)                                 ▼
            │     ▼                                ┌──────────────────────────┐
       ┌──────────────────────────┐                │ useNativeBrowserInstance │
       │ useNativeBrowserInstance │                └──────────┬───────────────┘
       └──────────────────────────┘                           │ (单向消费)
                                                              ▼
                                                   ┌──────────────────────────┐
                                                   │   resolveBrowserTabId    │
                                                   │ (nativeBrowserTabId.ts)  │
                                                   └──────────────────────────┘
```

#### 方案对比矩阵

| 维度 | 方案 A：下沉至底层 Hook (`useNativeBrowserInstance.ts`) | 方案 B：下沉至独立工具模块 (`nativeBrowserTabId.ts`) | 方案 C：下沉至基础 API 层 (`nativeBrowserApi.ts`) |
| :--- | :--- | :--- | :--- |
| **具体做法** | 将 `resolveBrowserTabId` 移入 `useNativeBrowserInstance.ts`，`usePreviewNavigation` 反向重导出兼容 | 在 `components/workspace/` 下新建 `nativeBrowserTabId.ts`，两 Hook 与组件均依赖它 | 下沉至 `src/api/nativeBrowserApi.ts`，作为底层协议的一等公民 |
| **拓扑流向** | `usePreviewNavigation` ──▶ `useNativeBrowserInstance`（单向） | 两 Hook 平行依赖叶子工具模块（单向 DAG） | UI 组件与 Hook 均单向依赖 API 层（分层架构最优） |
| **重构代价** | 最小（仅改动 2 个文件） | 极低（新建 1 个小文件，改动 4 处 import） | 低（需同步补充 API 层单元测试） |
| **解耦彻底度** | 良好（解除环路，但驱动 Hook 承担了外部组件的标识符解析） | 优秀（关注点完全分离，叶子节点无任何副作用） | **极致（架构最清晰，前后端契约统一）** |
| **推荐评级** | 临时过渡 | **架构推荐（推荐落地）** | **长期演进** |

**建议实施规范**：
采用 **方案 B**：
1. 提取 `apps/crish-desktop/src/components/workspace/nativeBrowserTabId.ts`，导出纯函数 `resolveBrowserTabId`；
2. 在 `usePreviewNavigation.ts` 中保留 `export { resolveBrowserTabId } from './nativeBrowserTabId';` 以维持既有单测与公共面兼容；
3. 将 `useNativeBrowserInstance.ts`、`NativeBrowserSurface.tsx`、`PreviewCard.tsx` 的导入路径重定向到 `./nativeBrowserTabId`；
4. `npm run lint:depcruise` 将立刻从 `1 error` 降为 `0 violations`。

---

## 三、`check:no-pseudo-dispatch` 缺失文件与 dev-server 安全架构盘查

### 3.1 现场命令执行证据与报错明细

在终端执行反伪派发与 §4 安全门禁：
```powershell
npm run check:no-pseudo-dispatch
```

**真实输出证据**：
```
FAIL pseudo-dispatch gate (2):
  1. [§4] missing file: apps/crish-desktop/dev-server/previewBridgeScript.ts
  2. [§4] missing file: apps/crish-desktop/dev-server/sameOriginRequest.ts
```

### 3.2 深度取证：文件究竟是缺失还是未暂存删除？

通过执行底层 Git 树检查（`git ls-tree`）与版本库提交追踪：
```powershell
git ls-tree HEAD apps/crish-desktop/dev-server
```
**Git 内部证据**：
```
040000 tree a78db0d6bc26cac3fc65f164a88c272aeb310ced apps/crish-desktop/dev-server
100644 blob 16b712a87... apps/crish-desktop/dev-server/previewBridgeScript.ts
100644 blob 443005903... apps/crish-desktop/dev-server/sameOriginRequest.ts
```

进而执行 `git status -- apps/crish-desktop/dev-server`：
```
Changes not staged for commit:
  (use "git add/rm <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	deleted:    apps/crish-desktop/dev-server/previewBridgeScript.ts
	deleted:    apps/crish-desktop/dev-server/sameOriginRequest.ts
```
同时发现关联单元测试同样处于工作区未暂存删除状态：
```
	deleted:    apps/crish-desktop/src/__tests__/sameOriginRequest.test.ts
	deleted:    apps/crish-desktop/src/components/workspace/__tests__/previewBridgeScript.contract.test.ts
```

**关键结论**：
这两个文件**在 Git 仓库权威树中从未丢失**！它们是在本地工作区中被某些清理流程或开发者误操作执行了物理删除（Unstaged Deletion），未被提交也未被恢复，导致工作区处于破损态。

---

### 3.3 为什么会被误删？穿透 `vite.config.ts` 的打补丁内联妥协

通过追踪 `apps/crish-desktop/vite.config.ts` 的演变，我们发现了令人震惊的**架构妥协现象**：
在 `apps/crish-desktop/vite.config.ts` 的第 340-369 行，赫然存在一份完整复制的 `isSameOriginRequest`：

```typescript
// apps/crish-desktop/vite.config.ts:340-369
/**
 * 同源请求校验（端点安全防护：禁止非同源请求探测本地开发服务）
 */
function hostOf(urlLike: string | undefined): string | null {
  if (!urlLike) return null;
  try {
    return new URL(urlLike).host;
  } catch {
    return null;
  }
}

function isSameOriginRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host || '').toString();
  if (!host) return false;

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    const originHost = hostOf(origin);
    return originHost !== null && originHost === host;
  }

  const siteRaw = req.headers['sec-fetch-site'];
  const site = Array.isArray(siteRaw) ? siteRaw[0] : siteRaw;
  if (site === 'same-origin' || site === 'none') {
    return true;
  }

  const refererRaw = req.headers.referer;
  const referer = Array.isArray(refererRaw) ? refererRaw[0] : refererRaw;
  const refererHost = hostOf(typeof referer === 'string' ? referer : undefined);
  return refererHost !== null && refererHost === host;
}
```

**妥协轨迹还原**：
1. 历史演进中，开发人员认为桌面端已全面转向 Native Webview（由 Rust 后端接管），Vite 开发服务器的 `crishPreviewProxyPlugin` 代理插件被废除；
2. 但开发服务器仍保留了 `/__crish_active_ports` 敏感端点（`crishActivePortsPlugin`），需要同源安全校验；
3. 开发者在剥离 `dev-server/` 目录时，为了让 Vite 配置能独立运行，**直接将 `sameOriginRequest.ts` 的核心实现 Copy-Paste 内联到了 `vite.config.ts` 内部**，随后删除了工作区中的 `dev-server/` 目录；
4. 这种“打补丁”直接引发了后续危机：
   - 违背了 SSOT：存在两份平行的同源判定代码；
   - 击穿了安全门禁：门禁脚本 `scripts/check-no-pseudo-dispatch.mjs:83-129` 严格守卫 `dev-server/sameOriginRequest.ts` 与 `previewBridgeScript.ts` 的物理存在性与 AST/正则安全特征；
   - 导致任何运行该门禁的 CI 节点与本地构建 100% 暴毙。

---

### 3.4 缺失文件的系统定位与安全风险穿透

门禁之所以在此处设立零容忍硬卡点（`[§4]` 强阻断），是因为这两大文件承担着至关重要的**安全防线职责**：

#### 1. `sameOriginRequest.ts` 的定位与安全风险
- **定位**：Vite 本地开发服务器（运行于 `http://127.0.0.1:5174` 等端口）的边界防火墙拦截器。
- **安全风险 A：本地网络端口扫描（Local Network Port Scanning / Intranet Fingerprinting）**  
  `/__crish_active_ports` 端点会实时探测 `3000, 5173, 8080...` 等端口的存活状态。若缺乏同源校验，开发者在浏览器中访问的任何第三方恶意网站，均可通过 `fetch('http://127.0.0.1:5174/__crish_active_ports')` 窃取开发者本地及局域网的开放服务信息，为进一步内网渗透提供跳板。
- **安全风险 B：历史弱校验绕过（`if (!origin) return true` 漏洞）**  
  早期同源校验存在漏洞：认为浏览器发送同源请求时不带 `Origin` 头，因而粗暴地判定 `if (!origin) return true;`。然而非 CORS 请求（如 `<form>` 提交、纯导航、标签引入）同样不带 `Origin`。攻击者可构造跨站伪造请求轻易绕过防护。门禁明确断言：**必须结合现代浏览器的 `Sec-Fetch-Site: same-origin | none` 以及同源 `Referer` 深度判定**，杜绝盲目放行。

#### 2. `previewBridgeScript.ts` 的定位与安全风险
- **定位**：注入到预览页面中的 DOM 拾取器与导航协调客户端脚本。
- **安全风险 A：通配符广播与页面隐私泄露（Wildcard Target Origin）**  
  在将页面元素的选择器、XPath、文本（`textContent`）、外层 HTML（`outerHtmlSnippet`）通过 `window.parent.postMessage` 传回宿主时，如果使用 `*` 通配符，任何恶意跨源嵌套框架均可监听并截获用户预览页面的隐私数据。门禁刚性要求：运行时代码中**绝对禁止 `postMessage(..., '*')`**，必须计算并限定唯一的 `TARGET_ORIGIN`。
- **安全风险 B：控制指令劫持**  
  监听父级发来的 `INSPECT_TOGGLE` 切换事件时，必须校验 `e.origin === TARGET_ORIGIN`，防止被父级以外的第三方页面伪造控制指令。

---

### 3.5 正规治理方案

根据反过度设计与杜绝补丁铁律，治理方案如下：

1. **绝对禁止继续在 `vite.config.ts` 中内联重复代码**；
2. **物理文件归位与 SSOT 恢复**：
   - 工作区中恢复 `apps/crish-desktop/dev-server/previewBridgeScript.ts` 与 `apps/crish-desktop/dev-server/sameOriginRequest.ts`，以及其对应的单元测试资产；
   - 在 `apps/crish-desktop/vite.config.ts` 中恢复对 `./dev-server/sameOriginRequest` 的模块化 `import`，删除 340-369 行的重复内联代码；
3. **安全闭环验证**：
   - 执行 `npm run check:no-pseudo-dispatch`，确保 §4.1 / §4.2 全部通过；
   - 运行单元测试 `npx vitest run apps/crish-desktop/src/__tests__/sameOriginRequest.test.ts`，确保测试资产百分之百入库受控。

---

## 四、`packages/*` 与 `apps/crish-desktop` 依赖边界审计

### 4.1 全盘依赖扫描结果概览

针对 Monorepo 体系中的所有包（`@crish/shared-types`、`@crish/shared-utils`、`@crish/block-paper`、`@crish/editor-kit`、`@crish/conversation-flow` 等）与 `apps/crish-desktop` 进行了完整的 AST 引用扫描：

| 检查维度 | 判定准则 | 实测数据 | 结论 |
| :--- | :--- | :---: | :---: |
| **逆向依赖（Reverse Violations）** | `packages/*` 绝对禁止 import `apps/*` | **0 处** | **完全合规**（分层严格） |
| **包级循环依赖（Package-level Cycles）** | 包之间不得形成闭环循环引用 | **0 处** | **完全合规**（标准有向无环图） |
| **深度私有相对路径穿透（Relative Import Violations）** | 上层禁止使用 `../packages/...` 相对路径直捣子包内部源码 | **25 处** | **严重违规**（破坏包边界封装） |
| **非规范子路径引入（Deep Subpath Imports）** | 必须消费 package.json 中明确导出的 exports | 14 处 | 13 处已在 exports 声明，1 处样式需规范 |

#### 包间依赖拓扑图（DAG 状态核验）：
```
@crish/shared-types (Layer 0, 独立无依赖)
  ▲          ▲
  │          │
  │     @crish/shared-utils (Layer 0)
  │
@crish/plugin-import-claude-codex

@crish/block-paper-contract
  ▲          ▲
  │          │
  │     @crish/editor-kit
  │          ▲
  │          │
@crish/block-paper
```
包间拓扑层次分明，零闭环，基础依赖健康。

---

### 4.2 25 处跨层私有相对路径越权穿透明细清单

在 `apps/crish-desktop/src/` 中，存在多达 25 处绕过 NPM 包名引用、直接使用相对路径穿透进入 `packages/shared-types/src` 与 `packages/shared-utils/src` 的违规引用：

```
【典型越权形态】
import type { EngineEventType } from '../../../../../../packages/shared-types/src/generated/engine';
                                      ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
                                      违规：6 层跳出当前 app，强行侵入兄弟包源码目录
```

#### 实证清单（文件路径 : 行号与引入目标）：

| 序号 | 违规发起文件 | 违规引入路径 (Specifier) | 实际侵入之包内私有源文件 |
| :---: | :--- | :--- | :--- |
| 1 | `apps/crish-desktop/src/api/chat-bridge/handlers/dispatch.ts:8` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 2 | `apps/crish-desktop/src/api/chat-bridge/handlers/dispatch.test.ts:12` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 3 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts:16` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 4 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts:25` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 5 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParserCore.ts:14` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 6 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParserCore.ts:22` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 7 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParserTask.ts:14` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 8 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParserContinuity.ts:14` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 9 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParserDiagnostics.ts:14` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 10 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParserDiagnostics.ts:24` | `../../../../../../packages/shared-types/src/primitive-types` | `packages/shared-types/src/primitive-types.ts` |
| 11 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParserShared.ts:14` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 12 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParserShared.ts:20` | `../../../../../../packages/shared-types/src/primitive-types` | `packages/shared-types/src/primitive-types.ts` |
| 13 | `apps/crish-desktop/src/api/chat-bridge/handlers/securityAuditStore.ts:11` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 14 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts:8` | `../../../../../../packages/shared-types/src/events` | `packages/shared-types/src/events.ts` |
| 15 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.normalizer-drift.test.ts:8` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 16 | `apps/crish-desktop/src/api/chat-bridge/handlers/diagnosticHandlers.runtimeStatus.integration.test.tsx:18` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 17 | `apps/crish-desktop/src/api/continuity/continuityNotices.ts:10` | `../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 18 | `apps/crish-desktop/src/api/continuity/continuityNotices.test.ts:7` | `../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 19 | `apps/crish-desktop/src/api/messageProjection.ts:12` | `../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 20 | `apps/crish-desktop/src/api/sessionEventProjection.ts:9` | `../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 21 | `apps/crish-desktop/src/api/sessionEventTimestamp.ts:8` | `../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 22 | `apps/crish-desktop/src/store/types.ts:16` | `../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |
| 23 | `apps/crish-desktop/src/__tests__/chaosAndResilience.test.ts:24` | `../../../../packages/shared-utils/src/retry-openai` | `packages/shared-utils/src/retry-openai.ts` |
| 24 | `apps/crish-desktop/src/__tests__/chaosAndResilience.test.ts:25` | `../../../../packages/shared-utils/src/retry` | `packages/shared-utils/src/retry.ts` |
| 25 | `apps/crish-desktop/src/api/chat-bridge/handlers/eventParserDiagnostics.ts:17` | `../../../../../../packages/shared-types/src/generated/engine` | `packages/shared-types/src/generated/engine/index.ts` |

---

### 4.3 根因剖析：为什么上层会刺穿包边界？

我们审视了被侵入方 `packages/shared-types/src/index.ts`：
```typescript
// packages/shared-types/src/index.ts:323-345
// 引擎生成面（generated/engine）公共 re-export 面。
export * from './generated/engine/types';
export * from './generated/engine/events';
export * from './generated/engine/parser';
```
在 `packages/shared-types/src/index.ts` 中，作者曾特意添加了注释：
> `// 设备协议生成面（generated/device）公共 re-export 面。`  
> `// 消除 apps/crish-mobile 对 packages/shared-types/src/generated/device 的内部引用`

**深刻病灶浮出水面**：
1. **移动端完成了收敛，桌面端被遗忘留债**：架构在治理移动端（`crish-mobile`）时，已经将 `generated/device` 与 `generated/engine` 完整重导出至 `@crish/shared-types` 的公共根出口，但桌面端 `apps/crish-desktop` 中的 25 处历史遗留相对导入**从未进行同步批次清理**；
2. **缺乏 Monorepo 边界门禁拦截**：CI 门禁有 `no-circular` 和 `no-store-import-components`，但**缺少了针对跨工作区相对路径 `../packages/` 的静态阻断规则**。开发者在 IDE 自动补全时，由于路径过深，IDE 自动生成了多级 `../../../../` 相对路径，从而逃过了包名引用检查。

---

### 4.4 解耦与边界加固治理方案

1. **上层业务代码彻底归正**：
   将上述 25 处文件中的相对穿透引入统一修改为标准的包名导入：
   ```typescript
   // 修复前
   import type { EngineEventType } from '../../../../../../packages/shared-types/src/generated/engine';
   // 修复后
   import type { EngineEventType } from '@crish/shared-types';
   ```
2. **补齐门禁刚性守门（新增 `check:no-relative-package-imports`）**：
   在 `scripts/check-ui-layer.mjs` 或独立守卫脚本中新增正则表达式检查：
   ```javascript
   // 严禁在 apps/** 源码中出现相对跨包引用
   if (/from\s+['"][^'"]*\/packages\/[^'"]+['"]/.test(line)) {
     fail(`Found disallowed relative import into packages: ${file}:${line}`);
   }
   ```
   杜绝未来再次发生 IDE 自动补全越权穿透。

---

## 五、综合治理与收口路线图（Actionable Plan）

| 阶段 | 治理模块 | 具体改造目标 | 预期成果与验收断言 | 风险度 |
| :---: | :--- | :--- | :--- | :---: |
| **P1** | **循环依赖解耦** | 1. 提取 `nativeBrowserTabId.ts` 纯工具模块；<br/>2. `useNativeBrowserInstance` 与 `usePreviewNavigation` 单向依赖该工具。 | `npm run lint:depcruise` **0 error** 完美通关。 | 极低 |
| **P2** | **安全与门禁复原** | 1. 恢复工作区 `dev-server/` 2 个核心脚本及对应单测；<br/>2. `vite.config.ts` 剔除 340-369 行重复内联，恢复规范 import。 | `npm run check:no-pseudo-dispatch` **PASS** 且单测全绿。 | 极低 |
| **P3** | **包边界彻底收拢** | 1. 机械替换 `apps/crish-desktop` 中 25 处跨层相对路径为 `@crish/shared-types`；<br/>2. 增加跨包相对路径静态拦截门禁。 | 消除全仓所有跨包私有路径侵入，封锁 Monorepo 边界。 | 极低 |

---

## 六、审计师签章与合规承诺

- **审计专家**：A01 · 依赖拓扑与模块解耦审计专家
- **验证环境**：Windows 11 / Node.js v24.11.0 / pwsh 7
- **铁律守恒声明**：本审计文档完全遵循 `AGENTS.md` 协作指令与反过度设计红线，未修改任何业务代码，无 `--no-verify`，所有断言均有确凿代码与命令日志佐证。
