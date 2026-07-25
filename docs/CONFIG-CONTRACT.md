# Config Contract Document (配置契约文档)

> Phase 0 / T0 — 配置关系图、存储方式、写入目标矩阵

---

## API Key 管理

### 5 层配置层叠优先级

API Key 及 Provider 配置遵循严格的 5 层优先级（从低到高）：

| 优先级 | 层名 | 说明 | 示例来源 |
|--------|------|------|----------|
| P0 (0) | **default** | 代码级硬编码默认值 | `DAEMON_DEFAULT_PROVIDER` |
| P1 (100) | **workspace-config** | 项目/工作区级配置 | `.crish/config.json` workspace 段 |
| P2 (200) | **user-config** | 用户级配置文件 | `~/.crish/config.json` 或 localStorage |
| P3 (300) | **env** | 环境变量 | `CRISH_API_KEY`, `FLOWBIT_API_KEY` 等 |
| P4 (500) | **runtime-update** | WebSocket `update-config` 消息 | 桌面端 UI 设置页提交 |

**工作原理：**
- 高优先级层覆盖低优先级层的同名字段。
- 每层可以只提供部分字段，缺失字段从低优先级层继承。
- `apiKey` 在多环境变量名间按 `CRISH_API_KEY` → `FLOWBIT_API_KEY` → `OPENAI_API_KEY` 顺序自动回退。
- `credentialMode`（`direct`/`auto`）推理规则：env 层读取 `CRISH_CREDENTIAL_MODE` → `FLOWBIT_CREDENTIAL_MODE` → `OPENAI_CREDENTIAL_MODE`。

### 配套安全机制

| 机制 | 文件 | 说明 |
|------|------|------|
| **Env 白名单** | `packages/agent-daemon/src/env-whitelist.ts` | 所有 `process.env` 读取必须通过 `readEnv()`，非白名单变量访问抛出异常 |
| **SecretRedactor** | `packages/agent-runtime/src/secrets-obfuscation.ts` | 日志输出自动脱敏，通过 `setLogRedactor` 全局注册 |
| **WebSocket 认证** | `packages/agent-daemon/src/server.ts` | 客户端 `hello` 消息携带 `token`，服务端验证；`DAEMON_SECRET` 环境变量或自动生成 |
| **last4 暴露控制** | `DaemonConfig.apiKeyLast4Exposure` | `"none"`(不暴露) / `"last4"`(默认) / `"full"`(仅调试) |
| **daemon-ready 脱敏** | `packages/agent-daemon/src/index.ts` | stdout daemon-ready JSON 中的 API Key 信息使用 `DaemonProviderRedactedApiKeyStatus` 输出 |

### 环境变量白名单

见 `env-whitelist.ts` 中的 `ALLOWED_ENV_NAMES` 常量。当前允许的变量包括：

`DAEMON_PORT`, `DAEMON_BUILD_HASH`, `DAEMON_MAX_CONCURRENT`, `DAEMON_SESSION_EVENT_LOG_DIR`, `DAEMON_LOG_LEVEL`, `CRISH_API_KEY`, `FLOWBIT_API_KEY`, `OPENAI_API_KEY`, `CRISH_DAEMON_HOME`, `DAEMON_SECRET`, `CRISH_MAX_SUBAGENT_DEPTH`, `LOCALAPPDATA`, `XDG_STATE_HOME`, `DAEMON_DISABLE_AUTH`, `VITEST`

---

## 写入目标矩阵说明

| 标签 | 说明 |
|------|------|
| **UI-ONLY** | 仅影响 UI 表现，不存储，刷新即失 |
| **LS** | 仅存 localStorage，不写引擎，本场景独立 |
| **ENGINE-CONFIG** | 通过 daemon `update-config` 写引擎 |
| **ENGINE-SCOPED** | 通过 `upsert-scoped-context` 写引擎 |
| **ENGINE-RUN** | 通过 `run-task` 参数传递给引擎 |
| **ENGINE-WORKFLOW** | 通过 workflow API 管理 |
| **ENGINE-MCP** | 通过 MCP API 管理 |
| **DEAD** | 不再使用的代码路径，仅 demo 模式有效 |
| **HONEST-HIDE** | UI 展示但标注"未接入引擎"，用 demo stub |

---

## 配置项关系表

### 外观与主题 (Appearance & Theme)

| 配置字段 | 存储 key | 组件位置 | 写入目标 |
|-----------|-----------|--------------|------------|
| 主题模式 (theme mode) | `crish_theme` | `api/themeStore.ts` readStoredTheme/persistTheme | LS |
| 主题皮肤 (skin) | `crish_theme_skin` | `api/themeStore.ts` readStoredPersonalization | LS |
| 自定义背景色 | `crish_theme_custom_bg` | `api/themeStore.ts` | LS |
| 自定义前景色 | `crish_theme_custom_fg` | `api/themeStore.ts` | LS |
| 亮度微调 | `crish_theme_brightness_adjust` | `api/themeStore.ts` | LS |
| 氛围色彩融合 | `crish_theme_brightness_vibrant` | `api/themeStore.ts` | LS |
| 智能时光温感过渡 | `crish_theme_brightness_auto_time` | `api/themeStore.ts` | LS |
| 字体偏好 | `crish_fonts` | `api/fontStore.ts` readStoredFonts/persistFonts | LS |
| 字体大小微调 | `crish_font_size_adjust` | `api/themeStore.ts` | LS |
| UI 密度 (ui size) | `crish_ui_size` | `store/layoutStore.ts` setUiSize / `store/settingsUiStore.ts` | LS |
| Shell Chrome 模式 | `crish_shell_chrome` | `api/shellChrome.ts` / `store/layoutStore.ts` | LS |
| Tab 模式 | `crish_tab_mode` | `store/layoutStore.ts` setTabModeEnabled | LS |

### 布局与面板 (Layout & Panel)

| 配置字段 | 存储 key | 组件位置 | 写入目标 |
|-----------|-----------|--------------|------------|
| 工作区布局快照 | `crish_workspace_layout_v1` | `api/workspaceLayoutStore.ts` | LS |
| 侧栏折叠状态 | localStorage (zustand persist `crish-layout-v1`) | `store/layoutStore.ts` withPersist | LS |
| 侧栏宽度 | `crish_sidebar_width` | `components/Sidebar.tsx` | LS |
| 侧栏列表偏好 | `crish_sidebar_list_prefs` | `components/Sidebar.tsx` | LS |
| 工作区存活索引 | localStorage (zustand persist `crish-layout-v1`) | `store/layoutStore.ts` withPersist | LS |
| 侧栏折叠 | `crish_sidebar_collapsed` | `store/minimalConfig.ts` | LS |
| 设置层显示 | UI-ONLY (memory) | `store/settingsUiStore.ts` showSettingsOverlay | UI-ONLY |
| 设置选项卡 | UI-ONLY (memory) | `store/settingsUiStore.ts` settingsActiveTab | UI-ONLY |
| 工具列状态 (session) | sessionStorage `crish_tool_col_state_v1:*` | `store/layoutHelpers.ts` | LS (session) |
| 本会话已自定义布局 | sessionStorage `crish_ws_layout_session_customized_v1` | `api/workspaceLayoutStore.ts` | LS (session) |
| 本会话已应用布局 | sessionStorage `crish_ws_layout_session_applied_v1` | `api/workspaceLayoutStore.ts` | LS (session) |

### 设置与配置 (Settings & Config)

| 配置字段 | 存储 key | 组件位置 | 写入目标 |
|-----------|-----------|--------------|------------|
| 全局设置 JSON | `crish_settings` | `api/clientApi.ts` getSettings/saveSettingsEx | LS |
| 项目设置 JSON | `crish_project_settings_*` | `api/clientApi.ts` getProjectSettings | LS |
| engine 配置 (apiKey/baseUrl/model) | daemon update-config | `api/engineConfig.ts` updateEngineConfig | ENGINE-CONFIG |
| 最近模型列表 | `crish_recent_models` | `api/engineConfig.ts` pushRecentModel | LS |
| 权限模式 | `crish_permission_mode` | `api/permissionModes.ts` persistPermissionMode | LS + ENGINE-RUN |
| 命令白名单 | `crish_command_permissions_v1` | `api/commandPermissions.ts` saveCommandPermissions | LS |
| Provider 列表 | demo: `crish_providers` / config schema | `api/clientApi.demo.ts` / `services/config-schema.ts` | DEAD(demo) / LS |
| 定时任务 | demo: `crish_cron` | `api/clientApi.demo.ts` | DEAD(demo) / HONEST-HIDE |
| MCP 服务列表 | demo: `crish_mcp` | `api/clientApi.demo.ts` | DEAD(demo) / HONEST-HIDE |
| 快捷键覆盖 | `crish_config_v2:shortcuts.overrides` | `services/config-schema.ts` ConfigService | LS (ConfigService) |
| 发送快捷键 | `crish_send_shortcut` | `components/ChatComposer.tsx` | LS |
| 显示引擎设置 | `crish_show_engine_settings` | `api/productMode.ts` | LS (dev-only) |
| Daemon WS 地址覆盖 | `crish_daemon_ws` | `api/daemonClient.ts` | LS (dev-override) |
| 强制 mock 模式 | `crish_use_mock` | `api/chatApi.demo.ts` | LS (dev-only) |

### 会话与数据 (Session & Data)

| 配置字段 | 存储 key | 组件位置 | 写入目标 |
|-----------|-----------|--------------|------------|
| 会话索引 | `crish_session_index_v1` | `api/sessionPersistence.ts` | LS + disk mirror |
| 会话消息正文 | `crish_session_body_v1:*` (JSONL) | `api/sessionPersistence.ts` | LS + disk mirror |
| 会话协作 agent | `crish_session_agents_v1:*` | `api/sessionPersistence.ts` | LS |
| 活动会话 id | `crish_active_session_v1` | `api/sessionPersistence.ts` | LS + disk mirror |
| 文件夹顺序 | `crish_folder_order_v1` | `api/sessionPersistence.ts` | LS |
| Composer 草稿 | `crish_composer_drafts_v1` | `api/beforeunloadFlush.ts` | LS (beforeunload) |
| Composer 种子文案 | sessionStorage `crish_composer_seed_v1` | `api/composerSeed.ts` | LS (session) |
| 会话搜索查询 | sessionStorage `crish_session_search_query` | `api/sessionSearch.ts` | LS (session) |
| 打开的会话 tab 列表 | `crish_open_session_tabs_v1` | `api/workspaceChromeTabs.ts` | LS |
| 会话磁盘镜像元数据 | `crish_session_disk_mirror_v1` | `api/sessionDiskMirror.ts` | LS |
| 同步游标 | `crish_sync_cursor` | `services/SessionSyncService.ts` | LS |

### 项目与工作区 (Project & Workspace)

| 配置字段 | 存储 key | 组件位置 | 写入目标 |
|-----------|-----------|--------------|------------|
| 项目列表 | `crish_projects_v1` | `api/projectStore.ts` | LS |
| 活动项目 id | `crish_active_project_id` | `api/projectStore.ts` | LS |
| 当前工作区路径 | `crish_workspace` | `api/projectStore.ts` | LS + ENGINE-RUN (cwd) |
| 项目路径别名映射 | `crish_project_folder_aliases_v1` | `api/projectStore.ts` | LS |
| 工作区布局快照 | `crish_workspace_layout_v1` | `api/workspaceLayoutStore.ts` | LS |

### 技能与扩展 (Skills & Extensions)

| 配置字段 | 存储 key | 组件位置 | 写入目标 |
|-----------|-----------|--------------|------------|
| 技能激活态 | `crish_skill_activation_v1` | `api/skillsApi.ts` setSkillActivation | LS + ENGINE-SCOPED |
| 额外技能目录 | `crish_skill_extra_dirs_v1` | `api/skillsApi.ts` setExtraSkillDirs | LS |
| 技能已知 ids | `crish_skill_known_ids_v1` | `components/SkillsSettingsTab.tsx` | LS |
| 技能缓存 | `crish_skills_cache_v1` | `components/SettingsExtensionsTab.tsx` | LS |
| 扩展安装目录 | `crish_extension_catalog_installed_v1` | `api/extensionCatalog.ts` | LS |
| MCP 工具禁用缓存 | sessionStorage `crish_mcp_tool_disabled_cache_v1` | `api/extensionCatalog.ts` | LS (session) |

### 用量与遥测 (Usage & Telemetry)

| 配置字段 | 存储 key | 组件位置 | 写入目标 |
|-----------|-----------|--------------|------------|
| 用量历史 | `crish_usage_history_v1` | `api/usageStore.ts` recordUsageDelta | LS |
| 遥测日志 | `crish_telemetry_log` | `services/TelemetryService.ts` | LS |
| 未发送错误队列 | `crish_error_queue_v1` | `api/beforeunloadFlush.ts` | LS (beforeunload) |
| 模型目录元数据 | `crish_model_meta_v1` | `api/modelCatalog.ts` | LS |
| 模型价格缓存 | `crish_model_prices_v1` | `api/pricingStore.ts` | LS |

### 应用模式与设备识别

| 配置字段 | 存储 key | 组件位置 | 写入目标 |
|-----------|-----------|--------------|------------|
| 应用模式 (demo/normal) | `crish_app_mode` | `api/appMode.ts` setAppMode | LS |
| Product shell 标志 | `crish_product_shell` | `createSsrGlobals.ts` / `api/productMode.ts` | LS |
| Agent 配置列表 | `crish_agent_profiles_v1` | `api/agentProfiles.ts` | LS |
| 更新可用标记 | `crish_update_available` | `api/updateStore.ts` setUpdateAvailable | LS |
| 首次运行完成 | `crish_first_run_done` / `crish_first_run_done_v1` | `createSsrGlobals.ts` / `components/FirstRunWizard.tsx` | LS |
| 浏览器预览状态 | `crish_preview_url_v1` / `crish_preview_history_v1` / `crish_preview_bookmarks_v1` | `api/previewBrowserStore.ts` | LS |
| 跨标签页 Leader | `crish_cross_tab_leader` | `services/CrossTabCoordinator.ts` | LS (internal) |

### 不再使用 / 未接入 (DEAD / HONEST-HIDE)

| 配置字段 | 存储 key | 组件位置 | 写入目标 | 备注 |
|-----------|-----------|--------------|------------|------|
| Provider 列表 | `crish_providers` | `api/clientApi.demo.ts` / `api/clientApi.ts` | DEAD (demo) | 正式用 providerProfiles.ts |
| 定时任务 | `crish_cron` | `api/clientApi.demo.ts` | DEAD (demo) | 正式无定时 |
| MCP 服务列表 | `crish_mcp` | `api/clientApi.demo.ts` | DEAD (demo) | 正式用 mcpApi |
| 供应商卷旧版 | `conex_pi_settings` / `conex_pi_providers` / `conex_pi_cron` / `conex_pi_mcp` | 迁移用 | DEAD | 旧版 Pi 体系遗留 |

---

## ConfigContract 标注添加目标

以下是需要添加 `// ConfigContract: <target>` 标注的关键 API 文件：

| 文件 | 标注 |
|------|------|
| `api/themeStore.ts` | `// ConfigContract: LS` |
| `api/fontStore.ts` | `// ConfigContract: LS` |
| `api/permissionModes.ts` | `// ConfigContract: LS + ENGINE-RUN` |
| `api/commandPermissions.ts` | `// ConfigContract: LS` |
| `api/engineConfig.ts` | `// ConfigContract: ENGINE-CONFIG + LS` |
| `api/clientApi.ts` | `// ConfigContract: LS + DEAD(demo)` |
| `api/clientApi.demo.ts` | `// ConfigContract: DEAD` |
| `api/projectStore.ts` | `// ConfigContract: LS + ENGINE-RUN(cwd)` |
| `api/skillsApi.ts` | `// ConfigContract: LS + ENGINE-SCOPED` |
| `api/workspaceLayoutStore.ts` | `// ConfigContract: LS` |
| `appMode.ts` | `// ConfigContract: LS` |
| `productMode.ts` | `// ConfigContract: LS` |
| `updateStore.ts` | `// ConfigContract: LS` |
| `usageStore.ts` | `// ConfigContract: LS` |
| `modelCatalog.ts` | `// ConfigContract: LS` |
| `pricingStore.ts` | `// ConfigContract: LS` |
| `extensionCatalog.ts` | `// ConfigContract: LS` |
| `agentProfiles.ts` | `// ConfigContract: LS` |
| `sessionSearch.ts` | `// ConfigContract: LS(session)` |
| `composerSeed.ts` | `// ConfigContract: LS(session)` |
| `beforeunloadFlush.ts` | `// ConfigContract: LS(beforeunload)` |
| `services/CrossTabCoordinator.ts` | `// ConfigContract: LS(internal)` |
| `services/TelemetryService.ts` | `// ConfigContract: LS` |
| `services/SessionSyncService.ts` | `// ConfigContract: LS` |
| `store/layoutStore.ts` | `// ConfigContract: LS + UI-ONLY` |
| `store/settingsUiStore.ts` | `// ConfigContract: LS + UI-ONLY` |
| `services/config-schema.ts` | `// ConfigContract: LS(ConfigService)` |
| `api/shellChrome.ts` | `// ConfigContract: LS` |