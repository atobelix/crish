# DEEPCHECK-10 依赖安全审计

- 执行：子 Agent E6（只读分析 + OSV/crates.io/npm registry 实测）
- 日期：2026-08-09
- 范围：Cargo.lock（742 包）/ package-lock.json（724 条）/ git 历史处置记录
- 结论：**无 P0**；npm 2 high / 4 moderate（其中 2 high + 3 moderate 位于**已删除依赖的幽灵子树**，非运行路径）；Rust 侧无高危附着告警。最严重可修复项为 dompurify XSS（直接依赖，一行可修）。

---

## 一、审计结果总表

| 编号 | 依赖 | 版本 | 严重度 | 类型 | 来源路径 | 修复版本 | 处置建议 |
|---|---|---|---|---|---|---|---|
| D-01 | dompurify | 3.4.12 | moderate（XSS） | **直接依赖** | crish-desktop dependencies | 3.4.13 | `npm update dompurify`（^3.4.12 已允许） |
| D-02 | ip-address | 10.2.0 | **high**（SSRF 旁路 ×3） | 幽灵子树 | express-rate-limit → @modelcontextprotocol/sdk@1.29.0（已 extraneous） | 10.3.1 | 重建 lockfile 清除孤儿树 |
| D-03 | fast-uri | 3.1.4 | **high**（host 混淆） | 幽灵子树+dev | ajv@8.20（MCP SDK 孤儿 + dependency-cruiser dev） | 3.1.5+/4.x | 同上（dev 路径非 prod） |
| D-04 | hono | 4.12.31 | moderate（ReDoS/memo 泄露等 ×4） | 幽灵子树 | @modelcontextprotocol/sdk@1.29.0 | 4.12.34 | 同上 |
| D-05 | @hono/node-server | 1.19.14 | moderate（Windows 路径穿越） | 幽灵子树 | @modelcontextprotocol/sdk@1.29.0 | 2.0.5 | 同上 |
| D-06 | @modelcontextprotocol/sdk | 1.29.0 | moderate（经其子依赖） | 幽灵子树 | 已被 f7058268 从 package.json 删除，lockfile 残留 | 1.30.0 | 同上 |
| R-01 | quick-xml | 0.30.0 | RUSTSEC-2026-0194/0195（DoS ×2） | 传递依赖 | xcb@1.7.0（xcap 链，Linux/X11 专用） | 0.41.0（xcb 未跟进，无现成修复） | 跟踪 xcb 发版；低暴露 |
| R-02 | rusqlite | 0.31.0 | 无 RUSTSEC 附着 | 直接依赖（conex-db） | workspace.dependencies | 0.40.2 | 卫生升级建议（P2） |
| R-03 | tauri-plugin-mcp | git c7d271a | 无已知漏洞 | git 依赖（非 fork） | agent-workbench（dev debug bridge） | — | 维持 commit 钉住，勿漂移 |

---

## 二、npm audit（--omit=dev，production）

```
info 0 / low 0 / moderate 4 / high 2 / critical 0 / total 6（exit code 1）
```

### 关键发现：2 个 high 均在「幽灵子树」而非运行路径

- `npm ls @modelcontextprotocol/sdk` → `extraneous`（ip-address/hono/@hono/node-server 同）。
- 根因：提交 `f7058268`（knur 收敛，删除 MCP SDK 直连死链）**从 package.json 删除了声明，但 package-lock.json 未重建**，整个 SDK 子树（hono/express-rate-limit/ip-address/ajv/fast-uri）成为锁文件孤儿。
- 运行影响：`rg "@modelcontextprotocol" apps/crish-desktop/src` 无任何 import；vite.config.ts 仅做构建期 node: 协议 stub（nodeBuiltinStubPlugin），且 SDK 不进产物。**线上不可达**。
- 修复：`npm install` 重建 lockfile（npm prune 移除 extraneous 子树）后重跑 audit；fast-uri 的 dev 路径（dependency-cruiser→ajv）随 dev 树一并处理。

### 真实暴露点：dompurify@3.4.12（P1）

- GHSA-55q2-fjhq-7xh7：IN_PLACE hook 移除后残留分离子树可执行 → XSS。crish-desktop 为**声明在 dependencies 的直接依赖**，用于 tiptap/markdown 预览净化，消费用户与模型产出的内容——净化器漏洞属安全相关。
- 修复已就绪：latest 3.4.13，且声明 `^3.4.12` 已允许，一行命令解决。

---

## 三、cargo-audit 不可用说明

`cargo audit` 未安装（`cargo 1.94.0` 无 audit 子命令，`cargo install cargo-audit` 可装但非本会话职责）。**替代方案**：对锁文件全部高风险位点（直接依赖 + 多版本 crate）逐个走 OSV.dev API 实测，结果如上表 R 行。建议后续 `cargo install cargo-audit` 纳入常规门禁（P2）。

### Rust 依赖规模（Cargo.lock）

- 总包数 742，唯一 crate 657，85 个重名多版本条目。
- 重复 major 均为传递旧链（无告警附着）：windows-sys ×5（0.45/0.52/0.59/0.60/0.61，tauri 生态正常）、syn 1/2/3、toml 0.8/0.9/1.1、schemars 0.8/0.9/1.2、hashbrown 0.12/0.14/0.17、getrandom 0.2/0.3/0.4、bitflags 1/2、thiserror 1/2、rustix 0.38/1.1、base64 0.21/0.22、jni 0.21/0.22。
- **无 axum / 无 h2**（消除 h2 历史 CVE 面）；rand 仅 0.9.5/0.10.2（clean，0.8.x 不存在）。
- git 依赖仅 1 个：`tauri-plugin-mcp` → P3GLEG 上游仓库钉 commit c7d271a（2026-07-17，对应 v0.3.1，非我们的 fork；同款模式即 grok-build fork async-openai 一类——但我们为**钉提交的上游直连**，可复现）。npm 侧另有 `tauri-plugin-mcp@0.3.1`（JS wrapper，clean，不同包）。
- 关键位点版本 vs crates.io latest：tokio 1.53.1 = latest；reqwest 0.13.4 = latest；tauri 2.11.5 = latest；hyper 1.11.0 = latest；ring 0.17.14 = latest；rustls 0.23.43 = latest；futures-util 0.3.33 = latest；serde 1.0.229 = latest。**全部在最新**。
- 落后项：rusqlite 0.31.0 vs latest 0.40.2（差 9 个 major；捆绑 SQLite 3.46.0 为 2024-06 版，SQLite 官方此后有多次安全修复，但无 RUSTSEC 附着于 0.31.0——CVE-2024-13815/CVE-2025-3967 经 NVD 核验并非 SQLite，不引用）。P2 卫生项。

---

## 四、npm 依赖规模（package-lock.json）

- 724 条 lock 条目 / 716 个 node_modules；**0 个嵌套（未 hoist）包**——hoisting 完全干净。
- 无 patches/ 目录、无本地 patch 机制；无 overrides。
- 跨 major 并存 23 包（ajv/eslint 工具链为主，多为 dev）。
- 关键版本 vs registry latest：vite 7.3.5（latest）、react 19.2.7（latest）、zustand 5.0.14（latest）、typescript 5.9.3（latest）、@tiptap/core 3.29.2、@tauri-apps/api 2.11.0、zod 3.25.76、highlight.js 11.11.1、immer 11.1.8——OSV 抽查均 clean。

---

## 五、已知漏洞与处置记录（git 历史）

- `git log --grep="audit|CVE|漏洞|security"` 命中 52 条，**全部为代码审计战役（AUDIT-B1~B10 / PS-0x / F-0xx）与安全硬化（sandbox 越界、symlink 逃逸、push refspec、API key 轮换）**，**无一条是依赖漏洞处置**。
- 无 dependabot/renovate 提交（0 条）——依赖更新为手工管理。
- 与依赖直接相关的唯一历史节点：`f7058268`（MCP SDK 声明删除）→ 即本次 lockfile 漂移的源头。

---

## 六、风险分级

| 级别 | 项 | 说明 |
|---|---|---|
| **P0** | 无 | 无可在运行路径直接利用的漏洞 |
| **P1** | D-01 dompurify XSS（真实直接依赖，一行可修）；D-02~D-06 幽灵子树（high 计数虚高、掩盖真实状态，需重建 lockfile 后重测） | 修复成本均为分钟级 |
| **P2** | R-01 quick-xml 0.30（Linux-only DoS，无现成修复）；R-02 rusqlite 落后 9 个 major；R-03 git 依赖钉提交维护；cargo-audit 未安装；无依赖机器人 | 整洁项/跟踪项 |

## 七、建议动作（按序）

1. `npm update dompurify`（→3.4.13）+ 提交；
2. `npm install` 重建 lockfile 清除 extraneous 子树，重跑 `npm audit --omit=dev` 验收归零；
3. 将 `cargo install cargo-audit` 与 `cargo audit` 纳入 CI 快层（可选依赖机器人）；
4. 跟踪 xcb 1.7.0+ 与 rusqlite 0.37+（捆绑 SQLite 3.50+）的升级窗口。
