# 打包 / 发布 / 更新闭环深度分析（05）

> 产出类型：深度分析（只读 + 本文档）；未修改任何代码。
> 数据基准：源码实读（apps/agent-workbench/src-tauri、apps/crish-desktop、.github/workflows、Cargo.toml 各层）+ git 跟踪状态。
> 结论置信度：标注「未实测」的项为本环境无法执行 `tauri build` / 联网验证的推断，需在打包第一步实测确认。
> 关联背景：当前分支 `refactor/architecture`；仓库仅有 4 个 CI workflow（ci.yml / ci-mid.yml / ci-slow.yml / perf-test.yml），无任何发布（release）job。

---

## 0. 摘要（结论先行）

1. **P0-1（头号问题）：`host_paths::app_dir()` 在 release 安装形态下必然解析失败**（host_paths.rs:6-24）。`CARGO_MANIFEST_DIR` 是编译期常量，指向构建机源码路径；安装到用户机器后该路径不存在，`package.json` 探测失败即落入 `current_dir()` 向上回溯找 `apps/agent-workbench` 的分支——安装目录（如 `Program Files`）下不存在该结构，**返回 Err**。其后果是**会话数据库、日志、快照、默认工作区全部断链**：sessions.db 每次启动降级内存库（会话数据丢失）、日志目录退化为相对路径 `logs/`（可能写入失败）、WorkspaceRegistry 无默认根（文件命令全部 `outside_workspace` 拒绝）。**这是打包后第一个雷，必须随打包一起修**，迁移到 `tauri::Manager` 的 `app_data_dir()`/`app_config_dir()`（详见 §1）。
2. **P0-2：更新闭环零落地**。`tauri-plugin-updater` 未在 Cargo.toml 依赖（src-tauri/Cargo.toml:17-59 无）、未在 main.rs builder 注册（main.rs:281 仅 dialog）、前端无 `@tauri-apps/plugin-updater`、capabilities 无 updater 权限、`pubkey` 为空（tauri.conf.json:37）、`workbench_apply_update` 是恒成功 stub（commands.rs:10-13）、前端更新按钮的 localStorage 标记**无任何设置方**（updateStore.ts 的 `setUpdateAvailable` 是私有函数，全仓无调用）→ 按钮永远不出现。整条更新链路是演示壳（详见 §2.3、§4）。
3. **P0-3：打包资产与配置不齐，首次 `tauri build` 大概率卡壳**：tauri.conf.json 引用的 4 个 PNG 图标（32x32.png / 128x128.png / 128x128@2x.png / icon.png）**全部不存在**（icons 目录仅 icon.ico / icon.icns，git ls-files 佐证）；`plugins.updater.active:true` + `pubkey:""` 的组合在接入 updater 插件后会被 CLI 拒绝或产出无法验证的产物（未实测，见 §2.2）；`bundle.targets:"all"` 在 CI Linux 侧必然缺 PNG 而失败。
4. **P0-4：无发布 workflow**。`.github/workflows` 四件套全部 ubuntu-latest、只做检查/测试，无 `tauri build` job、无产物上传、无 GitHub Release。发布闭环从零开始（规格见 §3）。

5. 已隔离的安全项（无需担心）：MCP 调试 socket 已被 `#[cfg(debug_assertions)]` 双保险隔离（main.rs:285-286、dev_mcp.rs:55-56）；前端 MCP guest 已 `import.meta.env.DEV` 门控（main.tsx:111-123），生产 bundle 不包含。
6. 发布路径建议（结论）：**Windows 先行（nsis 为主），tauri-action 自动化，GitHub Releases 静态托管更新端点，暂不代码签名（文档明示 SmartScreen 风险），releases.crish.me 域名待验证后切换**。全部步骤见 §3、§4。

---

## 1. release 形态路径审计（头号问题）

### 1.1 app_dir() 语义与 release 行为推演

`apps/agent-workbench/src-tauri/src/host_paths.rs` 全文 49 行，逻辑：

```rust
pub(crate) fn app_dir() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));      // 编译期常量
    if let Some(parent) = manifest_dir.parent() {                       // src-tauri 的父目录
        if parent.join("package.json").exists() {                       // 构建机上有 package.json → 命中
            return Ok(parent.to_path_buf());                            // dev 形态：apps/agent-workbench
        }
    }
    env::current_dir()                                                  // 运行时 cwd
        .and_then(|cwd| find_agent_workbench_dir(&cwd)                  // 向上回溯找 apps/agent-workbench
            .ok_or_else(|| format!("could not locate apps/agent-workbench from current directory: {}", cwd.display())))
}
```

**关键推演（release 安装形态）**：

| 环节 | dev（`tauri dev`） | release 安装形态 |
|---|---|---|
| `CARGO_MANIFEST_DIR` | 构建机源码目录 `...\conex\apps\agent-workbench\src-tauri`，`parent.join("package.json")` 存在 → **命中第 9 行分支** | 编译期常量仍为构建机路径；用户机器上该路径**不存在** → `exists()` 为 false，跳过 |
| `current_dir()` + 回溯 | 任意 cwd 向上找 `apps/agent-workbench/package.json`，repo 内都能命中 | 安装目录（`C:\Program Files\Crish\` 或用户双击时的 cwd）**没有** `apps/agent-workbench/package.json` 结构 → 回溯到盘符根仍无 → **返回 Err** |
| 结论 | 恒成功（dev 走第 8-11 行，根本不会用 fallback） | **恒失败**（除非用户把应用装在某种包含 `apps/agent-workbench` 的目录里，实际不可能） |

补充：`current_dir()` 本身在从资源管理器/快捷方式启动时通常可解析（返回安装目录或用户目录），所以错误信息是明确的 Err（不是 panic）。**行为是「确定性失败」而非随机**——每条依赖链都以各自方式降级或报错（见 1.3）。

### 1.2 全部依赖点清单（实读全量，grep `app_dir\(\)|workspace_root\(` 29 处命中）

| # | 位置 | 用途 | release 下的行为 |
|---|---|---|---|
| 1 | main.rs:259-260 | `app_dir().unwrap_or_default()` → `log_dir = app_dir.join("logs")` 传给 conex-telemetry 文件通道 + panic hook 崩溃文件目录 | Err → 空 PathBuf → 日志目录退化为**相对路径 `logs/`**（随 cwd，安装目录通常无写权限 → 文件通道失效，仅 stderr） |
| 2 | main.rs:227-232 | `open_session_db`：`app_dir()/sessions.db` | Err → **降级内存库 + `db_ready=false`**（main.rs:236-253）：会话持久化完全丢失，重启即空 |
| 3 | main.rs:351 | `orchestrator-snapshot.json` 于 `setup_app_dir`（同 259 的 app_dir 克隆） | 快照文件写相对路径/不可写 → restore/快照链失效 |
| 4 | workspace.rs:86-94 | `WorkspaceRegistry::init` 注册默认应用根 `workspace_root(app_dir)`；canonicalize 失败则跳过 | 注册失败 → **roots 为空** → 全部文件命令经 `resolve_guard` 返回 `outside_workspace`（workspace.rs:189-194）；用户只能靠目录对话框授权新工作区（行为可用但不自洽） |
| 5 | workspace.rs:283-293 | `is_default_app_root`：recent 复授权比对基准 | 恒 false（默认根不可解析）→ 历史 recent 目录无法复授权，被误判 `workspace_not_granted` |
| 6 | fs_commands/types.rs:100-107 | `WorkspaceFsGuard::for_default_workspace` | 直接 Err（ERR_INTERNAL） |
| 7 | core_query_commands.rs:245-250 | `log_dir()` 状态面板显示 | Err → 返回空串，前端显示「未知」 |
| 8 | process.rs:191-197 | shell 默认 cwd 回落 `workspace_root` | 回退 `current_dir()`（shell 在安装目录启动，未必可写） |
| 9 | pty/session.rs:119-125 | PTY 默认 cwd 回落 | 同 8，回退 cwd 或 `.` |
| 10 | background.rs:702-711 | 任务日志根 `app_dir()/logs/tasks` | 有显式兜底：回退系统 temp 目录（**已防退化**，注释明示） |
| 11 | host_openers/execute.rs:83-87、159-163 | host opener 目标路径解析的工作区根 | 返回 `host-path-root-unavailable` 错误 → 打开文件/URL 功能失败 |
| 12 | cli_bridge.rs:112-123 | `workbench_cli_run` 以 `workspace_root` 为 cwd 执行 **npm** CLI | Err 前已因 npm 不存在失败；release 下该命令面应整体禁用（dev 专属工具经 GUI 暴露，P2） |
| 13 | 文件级：main.rs:12、background.rs:6、background.rs:219、core_query_commands.rs:244 注释 | 语义文档 | — |

**结论**：release 下 app_dir 失败导致 **12 处运行路径中 11 处失效或降级**（仅 background 有 temp 兜底）。其中 1/2/3（日志、会话 DB、快照）是数据级损失，为 P0。

### 1.3 与已有正确形态的对照（迁移时对齐）

仓库里**已有**两处不依赖 app_dir 的正确实现，可作为迁移参照：

- `config/persistence.rs:39-51` `config_dir()`：`CRISH_WORKBENCH_CONFIG_DIR` → `%APPDATA%\Crish\AgentWorkbench` → temp 兜底。
- `workspace.rs:302-316` `workspace_config_dir()`：同上语义（recent-workspaces.json 已落 APPDATA，release 可用）。

即**配置类路径已按用户数据目录设计，唯独「应用数据根」（DB/日志/快照）绑死在源码目录上**——架构断层清晰：app_dir 是 dev 时代产物，release 需要一套「用户数据根」。

### 1.4 迁移建议（方案）

**目标形态**：dev 保留现状（`app_dir()` 指向 monorepo，便于开发调试）；release 引入「应用数据根」概念：

1. **release 分支走 `tauri::Manager::path()`**：`app.path().app_data_dir()`（Windows 实际为 `%APPDATA%\io.github.conex-community.crish`，由 identifier 决定；`app_config_dir()` 语义雷同）。sessions.db、logs/、orchestrator-snapshot.json 全部挂在此根下——与 `assetProtocol.scope: ["$APPDATA/**"]`（tauri.conf.json:27）**天然对齐**（前端预览 assets 已覆盖）。
2. **改造方式（推荐）**：`host_paths` 增加 release 分支 + 惰性初始化，避免改 12 个调用点签名：
   - 新函数 `app_data_root() -> Result<PathBuf, String>`：`#[cfg(not(debug_assertions))]` 下从 Tauri 的 app handle 或 `tauri::Manager` 路径取；因 host_paths 是静态函数无 handle，可仿照 `workspace_config_dir` 的 env 优先 + APPDATA 直算形态（identifier 已固定，`APPDATA/io.github.conex-community.crish` 可直拼，**零依赖 app handle、零时序问题**，且与 tauri 实际路径一致需在打包后实测核对一次）。
   - `app_dir()` 语义改为：dev → 现逻辑；release → 返回应用数据根（调用点语义从「源码目录」变为「数据目录」，命令名不变，12 处调用零改动）。
   - `workspace_root()` 在 release 下不再有意义（无 monorepo 根）：release 分支返回与 `app_data_root` 相同的值并让 WorkspaceRegistry 不注册默认根（靠 Dialog 授权），或为 release 定义「数据根即默认工作区」（产品决策，需用户裁决）。
3. **dev/release 判别**：`cfg!(debug_assertions)` 或 `cfg!(feature = "custom-protocol")`（tauri 构建时自动开启的 feature）均可；**建议编译期判别 + 单元测试双分支覆盖**（当前 host_paths 无任何测试，tests/ 下无引用——测试缺失本身是 P1）。
4. **数据迁移**：dev 期间 `apps/agent-workbench/sessions.db` 已入库（git status 显示被修改，属仓库跟踪文件）；release 迁移需一次性复制逻辑（首次启动把 dev 数据目录残留拷入 APPDATA 根，可选；至少文档明示 dev 数据不随 release）。

---

## 2. bundle / updater 配置现状审计

### 2.1 tauri.conf.json 逐字段（apps/agent-workbench/src-tauri/tauri.conf.json，60 行）

| 字段 | 现值 | 判定 |
|---|---|---|
| productName / version / identifier | `Crish` / `0.1.0` / `io.github.conex-community.crish` | 正常；version 需与 Cargo.toml workspace version（0.1.0）及发布 tag 三处一致（§3.4 加校验） |
| build.frontendDist | `../../crish-desktop/dist` | 正常；`beforeBuildCommand: npm run build` 在 `apps/agent-workbench`（该包有 `build` 脚本代理到 crish-desktop，package.json 已证实） |
| app.windows | 单窗 1320×880、decorations:false | 正常；无 `createUpdaterArtifacts` 相关冲突项 |
| security.assetProtocol | enable:true，scope `$APPDATA/**` + `$RESOURCE/**` | **与 §1.4 迁移天然对齐**；注意 `$APPDATA/**` 在 release 下若数据走 APPDATA 则资产预览可用 |
| security.csp | 严格清单：script-src 'self' 'wasm-unsafe-eval'；connect-src 含 `http://localhost:8765 ws://localhost:8765`（provider 直连端口） | 严格模式已定；**release 前端资源是否全量合规（无 eval、无内联脚本）未实测**（vite build 产物 + 动态 import 场景，P1）；8765 是 agent-provider 本地服务端口，release 保留是产品需求而非漏洞 |
| plugins.updater.active | `true` | **配置已激活但插件未装**（§2.2）——当前无行为；接入插件后 pubkey 空会触发校验问题 |
| plugins.updater.endpoints | `https://releases.crish.me/updates/{{target}}-{{arch}}/{{current_version}}` | 域名**本环境 DNS 解析超时，存在性未证实**（§3.5）；URL 模板本身合法（tauri updater 协议） |
| plugins.updater.dialog | `true` | 使用系统对话框形态；若走自定义 UI（现有 Sidebar 按钮），应改 `false` |
| plugins.updater.pubkey | `""` | **空**：未生成签名密钥（§4.1 流程） |
| bundle.targets | `"all"` | Windows = msi + nsis；**Linux 侧需要 PNG 图标（缺失，P0-3）**；建议先收敛为 `["nsis"]` |
| bundle.icon | 5 个文件，**PNG×4 全部不存在**（仅 icon.ico / icon.icns 被 git 跟踪） | P0-3：Windows bundle 是否因 PNG 缺失直接失败**未实测**；Linux appimage/deb 必失败 |
| bundle.windows | certificateThumbprint:null、digestAlgorithm:sha256、timestampUrl:null | 无代码签名（§3.4）；digestAlgorithm/timestampUrl 字段在 v2 属旧字段形态（**以 CLI schema 校验为准**，未实测） |
| bundle.macOS | signingIdentity/providerShortName 均 null | 未签名；macOS 后续阶段再处理 |

### 2.2 updater 接线现状（依赖/注册/权限，全部缺失）

| 接入点 | 现状 | 证据 |
|---|---|---|
| Cargo.toml（src-tauri） | **无 `tauri-plugin-updater`**；tauri = workspace（features protocol-asset/test）；仅有 tauri-plugin-dialog + tauri-plugin-mcp(git) | src-tauri/Cargo.toml:17-59；Cargo.lock 全文无 updater |
| main.rs builder 链 | 仅 `tauri_plugin_dialog::init()`；MCP 在 cfg(debug_assertions) 下按 env 注册 | main.rs:281、:285-286 |
| capabilities/default.json | 权限含 dialog/mcp:default 等，**无 updater 系列权限**（gen/schemas/desktop-schema.json 亦无 updater 条目） | capabilities/default.json:14-27（实测 rg 无命中） |
| 前端依赖 | **无 `@tauri-apps/plugin-updater`**；有 `@tauri-apps/api ^2.8.0`、`@tauri-apps/plugin-dialog ^2.7.2` | apps/crish-desktop/package.json dependencies |
| Rust 命令面 | `workbench_apply_update` 为恒成功 stub（`{"ok":true}`），注释「TODO: 接入真实更新下载/安装流程」 | commands.rs:6-13、command_manifest.rs:97、main.rs:125 |

**pubkey 空 + active:true 的行为判定**（未实测，标注）：接入 `tauri-plugin-updater` 后，CLI 构建时若 updater 激活而 pubkey 为空，Tauri 2 在 `tauri build` 阶段会要求签名密钥（通常报「updater public key 缺失」类错误）——**应在接入插件的第一时间生成密钥并填 pubkey**，否则打包被拦截。当前因插件未装，此问题潜伏。

### 2.3 前端更新 UI 现状（演示壳，无真源）

- `apps/crish-desktop/src/api/updateStore.ts`：`isUpdateAvailable()` 读 localStorage `crish_update_available`；`applyUpdateWhenIdle()` 检查后台任务后调 `workbench_apply_update`（stub）并清标记。**`setUpdateAvailable` 为模块私有且全仓无调用 → 标记永远为 0 → 按钮永不显示**。
- `Sidebar.tsx:111` 初值读 `isUpdateAvailable()`；`:190` 订阅 `onUiEvent('update-changed')`；`SidebarFooter.tsx:53-70` 有「有新版本，点击安装更新」按钮 UI 与 Tooltip。
- 结论：**UI 骨架已存在且与后端事件面（update-changed）预留了接线点**，真实接入只需：① Rust 侧插件 + 检查逻辑向事件面发射 `update-changed`；② 前端补 `@tauri-apps/plugin-updater` 消费；③ `workbench_apply_update` 替换为真实安装（或直接改由前端 plugin 侧执行 install）。

---

## 3. release workflow 规格（.github/workflows/release.yml）

### 3.1 总体设计

- **触发**：`push: tags: ['v*.*.*']`（语义化 tag 即版本真源；加 `workflow_dispatch` 便于手工补发）。**tag 与 tauri.conf.json / Cargo.toml version 三处一致校验**放 CI（脚本比对，不一致即失败，防「标签 v0.2.0 产物却是 0.1.0」）。
- **并发**：`concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }`（发版不可取消）。
- **权限**：`permissions: { contents: write, actions: read }`（写 Release 附件需要）。
- **平台矩阵**：一期仅 `windows-latest`（MSI 需要 WiX，仅 Windows runner 可靠；NSIS 在 ubuntu 交叉也能打，但一致性优先）。Linux（appimage/deb）/ macOS（dmg）列为二期矩阵项，**Linux 需先补齐 PNG 图标与 webkit2gtk 依赖**。
- **产物策略**：nsis 安装器（主）+ msi（可选，企业分发）。`--bundles nsis` 先行，updater 伪目标产物（`.sig` 签名文件 + updater JSON）由 tauri 在 updater active 时随 bundle 自动生成（**`bundle.createUpdaterArtifacts` 未在配置中显式声明，v2 默认值以 CLI 为准，打包时核对**——未实测）。

### 3.2 步骤规格（推荐 tauri-action 官方模式）

```yaml
jobs:
  build-windows:
    runs-on: windows-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - uses: actions-rust-lang/setup-rust-toolchain@v1   # 与 ci.yml 同款，stable
      - run: npm ci                                        # 根锁文件（含 crish-desktop）
      - run: npm run build:packages                        # turbo 构建共享包（若发布产物依赖 dist，需按现状确认）
      - name: Tauri build (nsis + updater)
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "Crish ${{ github.ref_name }}"
          releaseBody: "见仓库 CHANGELOG（占位）"
          releaseDraft: true            # 先草稿，人工确认后发布
          prerelease: false
          args: --bundles nsis          # 二期 msi/msi,nsis
      # 兜底：若暂缓 tauri-action 的 release 能力，可退化为：
      # - run: npm --workspace @crish/agent-workbench run tauri -- build --bundles nsis
      # - uses: actions/upload-artifact@v4（src-tauri/target/release/bundle/nsis/*.exe + *.sig）
      # - 手工 gh release create 挂附件（softprops/action-gh-release@v2）
```

- **为何用 tauri-action 而非裸 `npm run tauri build`**：tauri-action 自动处理 NSIS/WebView2 引导下载、为 updater 生成签名产物、把「版本号 → 安装器 → 签名 → Release 附件」串成原子步骤，且显式声明 `args: --bundles nsis` 规避 `targets:"all"` 的 Linux PNG 坑。若团队倾向最小依赖，退化路径也已写出（上注释块）。
- **产物核验步骤（建议加）**：构建后 `ls src-tauri/target/release/bundle/nsis/*` 断言存在 `.exe` 与 `.sig`；可选 smoke：启动安装器静默安装到临时目录再拉起 `Crish.exe` 检查进程存活（本期可不做，P2）。

### 3.3 Windows 代码签名（现状：无）

- 现状：`certificateThumbprint: null` → 产物不签名。**不签名不阻塞功能，但触发 SmartScreen「未知发布者」与杀软误报概率上升**（§5 P1）。
- 路径：① 首选正式 OV/EV 证书（CI 用 Azure Trusted Signing 或证书文件 + signtool 经 `signCommand` 注入）；② 过渡期**跳过签名**，Release 文档明示风险；③ 自签证书仅适合内部验证（需导入受信根，用户侧体验差，不推荐对外）。
- 决定点：**证书获取是外部依赖（时间/成本），本期应显式选择「暂不签名」并记录决策**，避免 workflow 半途被签名步骤卡死。

### 3.4 发布产物与版本一致性

| 校验项 | 方案 |
|---|---|
| tag ↔ tauri.conf.json version | CI 步骤 `jq -e '.version == env.TAG_VERSION'`（或 Node 脚本），不一致即失败 |
| tauri.conf.json ↔ Cargo.toml workspace version | 现有仓库无联动脚本；发布前置脚本校验两处一致 |
| 更新端点与 tag 对应 | updater JSON 的 `version` 字段由 tauri 从 tauri.conf.json 读出，**保证产物 version 与 JSON version 同源即可**（tauri-action 语义内建） |

### 3.5 updater 端点托管方案（三选）

| 方案 | 说明 | 建议 |
|---|---|---|
| A. GitHub Releases 静态 | 上传端点为 GitHub Releases 的 release-assets 直链（`https://github.com/conex-community/crish/releases/download/vX/...`），URL 模板改 `{{target}}-{{arch}}` 目录；零服务器成本，签名防篡改 | **一期推荐**：endpoints 改为 `https://github.com/conex-community/crish/releases/download/{{current_version}}/{{target}}-{{arch}}/latest.json` 之类稳定路径（具体模板需按资产命名定稿，见 §4.3） |
| B. 自建静态服务器（releases.crish.me） | 域名 + 对象存储/静态托管；URL 模板保持现状 | 需先验证域名归属与可用性（**本环境 DNS 超时未证实**）；二期切 |
| C. 第三方分发（S3 + CloudFront 等） | 成本/复杂度高 | 不需要 |

> 诚实边界：`releases.crish.me` 的 DNS 解析在本环境超时（nslookup 无应答），既不能证实也不能证伪；一期按方案 A 落地，域名验证后切换只改 endpoints 一处。

---

## 4. 更新闭环方案

### 4.1 签名密钥生成（一次性，负责人保管私钥）

```bash
# 在 app 目录（apps/agent-workbench）执行，或全局 tauri CLI
npm run tauri -- signer generate -w ~/.tauri/crish.key -p <强口令>
npm run tauri -- signer print -k ~/.tauri/crish.key   # 输出公钥
```

- 公钥 → 填入 `tauri.conf.json plugins.updater.pubkey`；**私钥不进仓库**，入 GitHub 仓库 Secrets：`TAURI_SIGNING_PRIVATE_KEY`（文件内容）+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 私钥丢失 = 无法发布可验证更新（用户侧将拒绝任何新版本），需离线备份（文档化保管责任）。
- 每版本签名：CI 中 tauri-action 用上述两个 secret 自动完成 `signature` 生成（`.sig` 与 updater JSON）。

### 4.2 客户端接入清单（按顺序）

1. `src-tauri/Cargo.toml`：加 `tauri-plugin-updater = "2"`。
2. `main.rs:281` builder 链：`.plugin(tauri_plugin_updater::Builder::new().build())`（紧邻 dialog 注册）。
3. `capabilities/default.json`：加 `"updater:default"`（含 check/download/install 权限面；gen/schemas 需重新生成——目前 schema 无 updater 条目）。
4. `apps/crish-desktop`：`npm i @tauri-apps/plugin-updater`（`@tauri-apps/plugin-updater` v2 对应）。
5. 检查逻辑（Rust 侧或前端侧，推荐 Rust 侧后台任务）：`app.updater().check()` → 有新版 → 经既有 `EventBridge` 发射 `update-changed`（Sidebar.tsx:190 已订阅）→ 前端复用现有按钮/`applyUpdateWhenIdle` 流程（updateStore.ts）。
6. `workbench_apply_update`（commands.rs:10-13）由 stub 改为真实安装（或前端改用 plugin 的 `install()`；**二者择一，避免双通道**——建议前端直用 plugin API，stub 命令退役并在 manifest 登记退役）。
7. tauri.conf.json：`dialog:false`（走自定义 UI）+ `pubkey` 填入 + endpoints 定稿（§3.5）。

### 4.3 服务端协议与产物命名

- tauri updater 协议：endpoint（`.../{{target}}-{{arch}}/{{current_version}}`）必须返回 JSON：`{ "url": "<安装器直链>", "version": "0.2.0", "notes": "...", "pub_date": "...", "signature": "<base64 签名>" }`。`{{target}}` 在 Windows = `nsis`（或 `msi`），`{{arch}}` = `x86_64`。
- 产物命名建议（静态托管路径稳定）：`Crish_0.2.0_x64-setup.exe` + `Crish_0.2.0_x64-setup.exe.sig` + `latest.json`（含对应 URL/signature）；endpoints 模板随托管方案定稿（方案 A 则 `.../download/v{{current_version}}/...`）。
- **版本对比语义**：updater 按语义化版本比较；当前 `version: 0.1.0` 起步无问题。

### 4.4 更新检查时机与静默策略

| 项 | 建议 |
|---|---|
| 时机 | 启动后延迟 3-5s 后台检查一次（`spawn` 于 setup 尾部，失败静默）；会话内不重复（标记位防重复触发） |
| 频率 | 每会话一次即可；如需高频（自动更新偏好），默认关 |
| 打扰控制 | 默认「有新版 → 侧栏按钮亮起」（现有 UI 已具备形态），**不弹窗**；`dialog:false` 保证无系统模态 |
| 下载/安装 | 按钮触发下载+安装（NSIS 支持自动替换当前 exe，安装后重启应用）；`applyUpdateWhenIdle` 的「有后台任务不安装」守卫已实现（updateStore.ts），保留 |
| 失败处理 | 下载失败/签名不匹配 → 事件面发射错误状态，UI 提示重试；不自动回滚 |
| 静默自动更新 | 二期考虑（autoInstall 偏好 + 无任务时自动装），本期不做 |

---

## 5. 风险清单（P0-P3）

### P0（阻断发布或数据损失，必须先修）

| # | 风险 | 证据 | 影响 | 缓解 |
|---|---|---|---|---|
| P0-1 | `app_dir()` release 解析必失败，数据根全断（DB/日志/快照/默认工作区） | host_paths.rs:6-24；main.rs:227-260；workspace.rs:86-94 | 会话数据丢失（降级内存库）、日志失效、文件命令全拒 | §1.4 迁移：release 走 APPDATA 数据根（与 assetProtocol $APPDATA 对齐）；dev/release 编译期双分支 + 补单测 |
| P0-2 | 更新闭环零落地（插件/注册/权限/公钥/命令 stub/前端标记无设置方） | src-tauri Cargo.toml:17-59；main.rs:281；capabilities；commands.rs:10-13；updateStore.ts | 更新功能完全不存在；发布即「死端」 | §4.2 七步接入清单；私钥生成入发布前置检查 |
| P0-3 | 打包资产不齐：PNG 图标×4 缺失；pubkey 空 + updater active:true；targets:"all" | tauri.conf.json:33-48；icons 目录仅 icns/ico（git ls-files） | 首次 `tauri build` 失败或产物不可验证（Linux 必失败；Windows 未实测） | 补全 4 个 PNG（512×512 源图导出）；生成密钥填 pubkey；targets 收敛 `["nsis"]` |
| P0-4 | 无发布 workflow，无产物、无 Release、无更新端点 | .github/workflows 仅 4 个 CI yml（全 ubuntu，无 build job） | 无法发版 | §3 release.yml 规格落地（tauri-action + 草稿 Release） |

### P1（高影响但不阻断首版）

| # | 风险 | 说明 |
|---|---|---|
| P1-1 | Windows 无代码签名 → SmartScreen「未知发布者」+ 杀软误报 | §3.3：本期决策「暂不签名」并记录；证书到位后经 signCommand 注入 |
| P1-2 | `releases.crish.me` 域名未证实（本环境 DNS 超时）；endpoints 指向无效域名 | 一期切 GitHub Releases 静态端点；域名验证后改回 |
| P1-3 | dev 数据（sessions.db 已入库）与 release 数据（APPDATA）割裂，无迁移 | 首版提供一次性迁移或文档明示；`.gitignore` 不再入库运行期 DB |
| P1-4 | release 前端在严格 CSP 下未实测（vite 产物动态 import / 内联样式 / wasm） | 打包后跑一次全量冒烟（启动 + 打开全部主要面板 + PTY + 文件预览）；CSP 报错会在 devtools 体现 |
| P1-5 | `workbench_cli_run`（cli_bridge.rs:112-123）release 下依赖 npm + monorepo，必然失败且无降级 | 该命令面在 release 分支禁用（或标记 dev-only），防用户误触报错 |
| P1-6 | `bundle.createUpdaterArtifacts` 未显式声明、`digestAlgorithm/timestampUrl` 为旧字段形态，CLI 校验行为未实测 | 打包第一步跑 `npm run tauri build -- --bundles nsis` 实测，按 CLI 报错修正配置 |
| P1-7 | host_paths 无任何测试（tests/ 无引用） | 迁移时补 dev/release 双分支单元测试（对齐既有壳测试门禁） |

### P2（体验/工程化增强）

| # | 风险/事项 | 说明 |
|---|---|---|
| P2-1 | 安装路径权限：NSIS per-machine 安装到 Program Files 后，日志/DB 需在 APPDATA（P0-1 修复后自然解决）；per-user 安装可彻底规避 | 首版建议 per-user（NSIS `installMode: currentUser`），避免 UAC |
| P2-2 | WebView2 依赖：NSIS 默认下载 bootstrapper（构建期联网）；运行期目标机可能缺 WebView2 | 文档明示依赖；或用 evergreen 策略（系统已有则复用）；构建机需稳定网络 |
| P2-3 | 更新检查策略（频率/自动安装偏好/断网静默） | §4.4 已给默认值；产品偏好后续迭代 |
| P2-4 | 单实例（已运行的 app 被安装器替换/多开） | NSIS 侧配置或应用内单实例锁，二期 |
| P2-5 | 发布 smoke：安装→启动→冒烟→卸载 全链路 | 人工 checklist 先行，CI 化二期 |

### P3（远期/平台扩展）

| # | 事项 | 说明 |
|---|---|---|
| P3-1 | Linux（appimage/deb）+ macOS（dmg）矩阵 | 需 PNG 图标（P0-3 一并解决）+ webkit2gtk 依赖 + macOS 签名/公证（notarization）；Linux 侧无符号也常见，SmartScreen 类风险低 |
| P3-2 | `targets:"all"` 恢复为全平台产物 | 等 P0-3 图标与平台矩阵就绪 |
| P3-3 | 静默自动更新 / 增量更新 | 依赖签名链稳定后设计 |

---

## 附录：实读证据索引

| 证据 | 位置 |
|---|---|
| app_dir 编译期常量 + fallback | apps/agent-workbench/src-tauri/src/host_paths.rs:6-24 |
| workspace_root 推导（monorepo 根 = app_dir 的父的父） | host_paths.rs:26-32 |
| 日志目录（unwrap_or_default + join("logs")） | main.rs:259-268；panic hook 同目录 :270 |
| sessions.db 打开（失败降级内存库） | main.rs:224-254 |
| 快照文件路径 | main.rs:351 |
| 默认工作区注册（canonicalize 失败跳过） | workspace.rs:86-94 |
| is_default_app_root / workspace_config_dir（APPDATA 正确形态） | workspace.rs:283-316 |
| 配置目录（APPDATA 正确形态，对照基准） | config/persistence.rs:39-51 |
| builder 链（仅 dialog + MCP cfg 隔离） | main.rs:281-286 |
| MCP 生产隔离双保险 | dev_mcp.rs:9-13、55-56；main.tsx:111-123 |
| updater stub 命令 | commands.rs:6-13 |
| 前端更新演示壳 | api/updateStore.ts（setUpdateAvailable 私有无调用方）；Sidebar.tsx:111/190/278；SidebarFooter.tsx:53-70 |
| tauri.conf.json 全部字段 | tauri.conf.json:1-60 |
| capabilities（无 updater 权限） | src-tauri/capabilities/default.json:14-27 |
| 前端依赖（无 plugin-updater） | apps/crish-desktop/package.json dependencies |
| icons 跟踪清单（仅 icns/ico） | `git ls-files apps/agent-workbench/src-tauri/icons` |
| 发布 profile（strip/lto） | .cargo/config.toml（release: strip=true, lto=thin, codegen-units=1） |
| workspace 版本与 tauri 依赖 | Cargo.toml:22-23、:52-53 |
| CI 现状（无 build job） | .github/workflows/ci.yml / ci-mid.yml / ci-slow.yml / perf-test.yml |
| DNS 验证（超时，未证实） | `Resolve-DnsName releases.crish.me` / nslookup（本环境） |
