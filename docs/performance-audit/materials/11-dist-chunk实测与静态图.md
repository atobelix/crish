# 11-dist-chunk实测与静态图（底稿）

> 采集时间：2026-09-13（dist 构建时间戳 2026-09-12 03:03，`apps/crish-desktop/dist/`）
> 方法：解析 `dist/.vite/manifest.json` 静态闭包；文件字节数 `statSync` 实测；chunk 内容指纹（字符串包含）解剖。原始 gzip/parse 计时属运行时 V 项，未在本底稿冒充。

## 1. dist 总量

| 维度 | 实测 |
| ---- | ---- |
| 文件总数 | 165 |
| 总体积 | 5.12 MiB |
| .js | 4050.8 KiB |
| .css | 750.6 KiB |
| .woff | 173.1 KiB |
| .woff2 | 150.2 KiB |
| .json（manifest） | 57.6 KiB |
| .png/.ico/.svg/.html | ≈63.8 KiB |

## 2. entry 静态 import 图（JS，与 07 口径一致：仅 JS chunk）

entry = `index.html` → `assets/index-BtjSSAtt.js`（509306 B = 497.4 KiB）

| # | chunk | KiB | entry imports 中 |
| - | ----- | --- | ---------------- |
| 1 | chat-provider-catalog-DQHM7wt8.js | 550.5 | 是 |
| 2 | index-BtjSSAtt.js（entry 本体） | 497.4 | — |
| 3 | vendor-react-BgW_Lbld.js | 210.9 | 是 |
| 4 | chat-bridge-transport-KhiBkYmz.js | 137.7 | 是 |
| 5 | vendor-hugeicons-BJuF4DL6.js | 117.3 | 是 |
| 6 | vendor-highlight-F2iis0FW.js | 108.6 | 是 |
| 7 | vendor-workers-kluSXrD6.js | 52.1 | 是 |
| 8 | chat-stream-core-CHjJ9Skh.js | 18.2 | 是 |
| 9 | vendor-zustand-OjF86IYf.js | 16.6 | 是 |
| — | **JS 静态图合计** | **1709.3** | 9 chunks |
| — | 静态 CSS（index css + transport css） | 255.1 | — |
| — | JS+CSS 静态图 | ≈1964.4 | 11 files |

懒加载正例（不在静态图）：vendor-xterm 430.7 / vendor-tiptap 408.7 / modelVendorCatalog 153.6 / ChatCard 128.4 / ChatAssistantMessageRow 126.8 / NoteLeafHost 122.4 / ModelsSettingsTab 71.1 …

manifest 互边证据：
- entry imports 含 `_chat-provider-catalog-DQHM7wt8.js`（静态）。
- `chat-bridge-transport` imports 含 catalog；catalog imports 含 transport → **互 static 边仍在**（07 §9.1 结论未解除）。
- catalog 同时是 entry 的 dynamicImports 目标（多条 `import()` 预留了惰性意图）——静态边与动态边并存，静态边胜出。

## 3. index.html modulepreload（新增证据，B1）

`dist/index.html`（7661 B）modulepreload 列表：

```
/assets/vendor-react-BgW_Lbld.js
/assets/vendor-workers-kluSXrD6.js
/assets/vendor-zustand-OjF86IYf.js
/assets/vendor-hugeicons-BJuF4DL6.js
/assets/chat-stream-core-CHjJ9Skh.js
/assets/chat-bridge-transport-KhiBkYmz.js
/assets/chat-provider-catalog-DQHM7wt8.js   ← 550.5 KiB 被 preload
/assets/vendor-highlight-F2iis0FW.js
```

含义：即便 JS 执行前的网络调度阶段，WebView 也会对 catalog 发起下载请求——「首屏必付」在网络层被 modulepreload 再次钉死。CRP 内联：critical css 2914 B + critical js 736 B（loader 内联，正面）。

## 4. catalog chunk（550.5 KiB）内容解剖（B3）

指纹实测（字符串包含，minified 后仍稳定的标识）：

| 指纹 | 命中 | 归属源码域 |
| ---- | ---- | ---------- |
| `ZodError` / `joinValues` / `invalid_union_discriminator` | 是（偏移 ≈43K–85K+） | zod v3 全量（src 唯一消费方 `services/ConfigService.ts:1`） |
| `import_from_localstorage`（`session-persistence/migrateFromLocalStorage.ts` IPC 面） | 是（偏移 ≈232K 起，`activeSessionId` 出现 92 次） | 会话持久化/迁移域 |
| `navigateToSurface` / `chatMainSurface` | 是（偏移 ≈418K） | `store/surfaceRouter.ts` + layout chrome 域 |
| `getActiveModelId` | 是（5 次，偏移 ≈325K） | provider-profiles 域 |
| `LEGACY_SEED_MODELS` / `KNOWN_PROFILE_LABELS` | 是（偏移 ≈547K，chunk 尾部） | providerProfiles 门面 re-export 集合 |
| baseline JSON probe（`modelsAutofillBaselineData.json` 内模型键） | 是（entry 中无） | `api/modelsAutofillBaseline.ts` → 59.5 KiB JSON 打入 |
| `CATALOG_RATES`（pricingCatalogData*） | 否 | pricing 数据不在本 chunk |
| `<svg` / `file_type_word` | 否 | 图标字典不在本 chunk（在 modelVendorCatalog） |

结论：**chunk 名「catalog」≠ 内容只是模型目录**。它是 manualChunks 路径分组 + Rollup 共享模块归置共同作用下的杂物抽屉：zod、会话迁移、surface 路由、autofill 基线 JSON 与 profiles/catalog 业务域焊死在同一 550 KiB 文件里。任何动态触达（含 SettingsShortcutsTab 等为取 zod 而静态 import catalog 的 chunk）都会整块拉取。

zod 落点副作用链（manifest）：`SettingsShortcutsTab` imports = [react, entry, SettingsUI, transport, **catalog**, workers, zustand, highlight, hugeicons, stream-core]——设置页 chunk 被迫静态指向 catalog，只为 ConfigService→zod。

## 5. 会话首开链（B4）

manifest 静态边：

```
(entry dynamic) ChatCard-*.js
  ├─ STATIC ChatAssistantMessageRow-*.js (126.8 KiB)
  │    └─ STATIC modelVendorCatalog-*.js (153.6 KiB)
  │         = fileIcons.ts(149.6 KiB 源，含 base64 PNG 的 pdf 图标)
  │         + modelVendorIcons.ts(72 KiB 源) 压缩后产物
  ├─ STATIC streamStop-*.js (47.3) —— streamStop 亦 STATIC import modelVendorCatalog
  ├─ STATIC chatToolCallUtils (57.4，内含 marked：outputLink 指纹仅此 chunk)
  └─ STATIC catalog / transport / workers / stream-core（与 entry 共享）
```

首个会话打开的增量 JS ≈ ChatCard 128.4 + CAR 126.8 + modelVendorCatalog 153.6 + streamStop 47.3 + chatToolCallUtils 57.4 + … ≈ **400+ KiB**（不含已在静态图的共享 chunk）。

fileIcons 源码样本：`src/assets/icons/fileIcons.ts:7-20` 为 160+ 条内联 SVG；pdf 图标内嵌 `xlink:href="data:image/png;base64,…"`（行 20，单行截断前 >2 KB）。

## 6. 依赖磁盘面（node_modules 实测）

| 包 | 磁盘 | bundle 落点 |
| -- | ---- | ----------- |
| @hugeicons/core-free-icons | 69.25 MB | vendor-hugeicons 117.3 KiB（按 iconMap 导入树摇） |
| highlight.js | 5.25 MB | vendor-highlight 108.6 KiB（lib/core+22 语言） |
| @xterm/xterm | 5.65 MB | vendor-xterm 430.7 KiB（lazy） |
| react-dom | 6.98 MB | vendor-react 210.9 KiB |
| zod | 3.43 MB | **在 catalog chunk 内**（无独立 vendor） |
| motion + motion-dom + motion-utils | 0.68+3.32+0.09 MB | **零**（死依赖） |
| @fontsource 四族合计 | ≈9.6 MB | fonts 323.3 KiB（woff+woff2 全量） |
| node_modules 总计 | **880.9 MB** | 含 crish-mobile(expo/RN) 等非桌面依赖 |

重复依赖检查：react/react-dom/highlight/marked/motion/zustand/immer/xterm/dompurify/tiptap 均仅根 node_modules 一份（无嵌套副本）；`resolve.dedupe: ['react','react-dom','react-dom/client']`（vite.config.ts:688）——**无双 React**。

## 7. 门禁脚本复跑输出（2026-09-13）

`node scripts/check-startup-budget.mjs`：

```
entry 文件合计: 509306 B (497.4 KiB) / 预算 520 KiB
静态 import 图合计（信息）: 1750274 B (1709.3 KiB)
[check-startup-budget] OK（软模式；阈值 520 KiB；无 chat-bridge 硬断言）
```

- 预算锚：entry 单文件（check-startup-budget.mjs:221-224,260-266）；`totalBytes` 静态图合计仅打印（:245-247），不进 warnings/errors。
- check-dist.mjs：主入口断言 `--max-app-kb` 缺省 500（:26,74-84）；实测 497.4 KiB → 余量 **2.6 KiB（0.5%）**；vendor-tiptap/xterm 存在性断言（:86-96）；**无**静态图/modulepreload/CSS/总量断言。
- chunk 体积硬门禁：vite.config.ts:45 `CHUNK_SIZE_GATE_KB = 600`（generateBundle 抛错，:57-75）；catalog 550.5 < 600 → 放行。

## 8. 字体清单（B9）

16 文件 / 323.3 KiB：inter / ibm-plex-sans / ibm-plex-mono / jetbrains-mono × {latin, latin-ext} × {woff, woff2}。最大单文件 inter-latin-ext-400 woff 46.4 KiB。vendor-fonts 由 entry 动态 import（8 条 dyn 边）——加载时机正面；格式冗余（woff 对 WebView2 可去）与 latin-ext 可裁。

## 9. CSS 侧（B10）

| chunk css | KiB |
| --------- | --- |
| index-RyU5I5DR.css（entry 静态） | 246.9 |
| ChatAssistantMessageRow | 73.5 |
| streamStop | 50.3 |
| ModelsSettingsTab | 34.5 |
| chatToolCallUtils | 29.7 |
| ChatCard | 27.7 |
| NoteLeafHost | 27.6 |
| 其余（约 30+ 文件） | 余量 |
| **合计** | **750.6** |

全仓门禁无 CSS 体积项（check-dist/check-startup-budget/chunkSizeGatePlugin 均只看 JS chunk.code）。

## 10. packages sideEffects 盘点（B13）

| 包 | sideEffects | main |
| -- | ----------- | ---- |
| block-paper | 未声明 | ./src/index.ts |
| block-paper-contract | 未声明 | ./src/index.ts |
| conversation-flow | 未声明 | ./src/index.ts |
| editor-kit | 未声明 | ./src/index.ts |
| shared-types | 未声明 | ./dist/index.js |
| shared-utils | 未声明 | ./dist/index.js |
| plugin-import-claude-codex | 未声明 | src/index.ts |
| test-utils | 未声明 | ./src/index.ts |

应用侧经 vite alias 直指 src（vite.config.ts:690-700），无 dist 双打包；但缺 `sideEffects` 声明使 Rollup 对 CSS re-export（block-paper `./chrome.css`/`./paper-list.css`）与纯工具 barrel 采取保守策略。
