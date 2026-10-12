import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const manifestData = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Crish Desktop UI Elements and Interaction Selectors Manifest",
  "version": "1.0.0",
  "generatedAt": new Date().toISOString(),
  "targetDirectory": "apps/crish-desktop/src/components/",
  "summary": {
    "category1Count": 12,
    "category2Count": 16,
    "category3Count": 35,
    "category4Count": 12,
    "category5Count": 10,
    "totalEntries": 85
  },
  "categories": {
    "1_main_interface_chrome_and_badges": [
      {
        "id": "main_window_minimize_btn",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": "button[aria-label=\"最小化\"], .win-btn-minimize",
        "eventType": "onClick",
        "triggerCondition": "Always visible in window chrome top right",
        "description": "主界面顶栏窗口最小化按钮",
        "specialHandling": null
      },
      {
        "id": "main_window_maximize_btn",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": "button[aria-label=\"最大化\"], button[aria-label=\"还原\"], .win-btn-maximize",
        "eventType": "onClick",
        "triggerCondition": "Always visible in window chrome top right",
        "description": "主界面顶栏窗口最大化/还原按钮",
        "specialHandling": null
      },
      {
        "id": "main_window_close_btn",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": "button[aria-label=\"关闭窗口\"], .win-btn-close",
        "eventType": "onClick",
        "triggerCondition": "Always visible in window chrome top right",
        "description": "主界面顶栏窗口关闭按钮",
        "specialHandling": null
      },
      {
        "id": "workspace_project_tab",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": ".ws-tab, [data-ws-id], div[class*=\"workspaceTab\"]",
        "eventType": "onClick",
        "triggerCondition": "Project workspace tab line in header",
        "description": "工作区顶栏项目页签",
        "specialHandling": "Supports onMouseDown for tab drag reorder"
      },
      {
        "id": "workspace_add_project_btn",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": "button[aria-label=\"添加工作区\"], .ws-add-btn, button.ws-tab-add",
        "eventType": "onClick",
        "triggerCondition": "Workspace line right side",
        "description": "添加新项目/工作区 (+) 按钮",
        "specialHandling": null
      },
      {
        "id": "session_tab_item",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": ".sess-tab, [data-session-id], div[class*=\"sessionTab\"]",
        "eventType": "onClick",
        "triggerCondition": "Session tab bar below workspace line",
        "description": "主界面会话页签",
        "specialHandling": "Requires right-click (onContextMenu) for tab popup menu, dblclick for rename"
      },
      {
        "id": "session_add_btn",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": "button[aria-label=\"新建对话\"], .sess-add-btn, button.sess-tab-add",
        "eventType": "onClick",
        "triggerCondition": "Session tab bar right side",
        "description": "新建会话 (+) 按钮",
        "specialHandling": null
      },
      {
        "id": "session_tab_close_btn",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": ".sess-tab-close, button[aria-label=\"关闭页签\"]",
        "eventType": "onClick",
        "triggerCondition": "Hover on active or inactive session tab",
        "description": "关闭会话页签 (x) 按钮",
        "specialHandling": null
      },
      {
        "id": "sidebar_toggle_left_btn",
        "component": "SidebarToggleIcons",
        "file": "apps/crish-desktop/src/components/SidebarToggleIcons.tsx",
        "selector": "button[aria-label=\"展开侧栏\"], button[aria-label=\"收起侧栏\"], .sidebar-toggle-btn",
        "eventType": "onClick",
        "triggerCondition": "Top header left edge or sidebar header",
        "description": "展开/收起左侧边栏切换按钮",
        "specialHandling": null
      },
      {
        "id": "model_badge_trigger",
        "component": "ModelBadgePickerMenu",
        "file": "apps/crish-desktop/src/components/ModelBadgePickerMenu.tsx",
        "selector": ".modelBadge, div[class*=\"modelBadge\"], [title*=\"模型\"], .model-picker-trigger",
        "eventType": "onMouseDown",
        "triggerCondition": "Main header or chat composer model selector badge",
        "description": "主界面模型切换徽章按钮",
        "specialHandling": "Triggers menu on onMouseDown / onClick; shows hover info on mouseover"
      },
      {
        "id": "permission_mode_badge",
        "component": "PermissionModeMenu",
        "file": "apps/crish-desktop/src/components/PermissionModeMenu.tsx",
        "selector": ".permission-mode-badge, button[class*=\"permissionMode\"], [title*=\"权限\"]",
        "eventType": "onClick",
        "triggerCondition": "Chat composer bottom right area",
        "description": "权限模式切换徽章 (Auto / Ask / Strict)",
        "specialHandling": null
      },
      {
        "id": "project_picker_trigger",
        "component": "ProjectPickerMenu",
        "file": "apps/crish-desktop/src/components/ProjectPickerMenu.tsx",
        "selector": ".project-picker-trigger, button[aria-label=\"选择项目\"], .project-badge",
        "eventType": "onClick",
        "triggerCondition": "Sidebar top or header project selector area",
        "description": "项目/工程下拉选择触发按钮",
        "specialHandling": null
      }
    ],
    "2_card_panel_tabs_and_menus": [
      {
        "id": "right_panel_expand_btn",
        "component": "CardPanel",
        "file": "apps/crish-desktop/src/components/CardPanel.tsx",
        "selector": "button[aria-label=\"展开右面板\"], button[aria-label=\"收起右面板\"], .panel-expand-btn",
        "eventType": "onClick",
        "triggerCondition": "Right side edge when right tool card panel is collapsed/expanded",
        "description": "展开/收起右侧卡片工具面板按钮",
        "specialHandling": null
      },
      {
        "id": "card_panel_add_btn",
        "component": "CardPanel",
        "file": "apps/crish-desktop/src/components/CardPanel.tsx",
        "selector": ".tabs-add-btn, button[aria-label=\"打开面板\"], .tabs-add-btn button",
        "eventType": "onClick",
        "triggerCondition": "Card panel tab header right (+) button",
        "description": "添加卡片下拉菜单 (+ 按钮)",
        "specialHandling": null
      },
      {
        "id": "compose_plus_menu_items",
        "component": "ComposePlusMenu",
        "file": "apps/crish-desktop/src/components/ComposePlusMenu.tsx",
        "selector": "[role=\"menuitem\"], .tabs-add-menu-item, .add-menu-item, div[aria-label*=\"打开\"]",
        "eventType": "onClick",
        "triggerCondition": "When (+) add card menu is expanded",
        "description": "添加卡片下拉菜单项 (Agent / Chat / Diff / Files / Preview / Terminal / Tasks)",
        "specialHandling": null
      },
      {
        "id": "mounted_card_tab",
        "component": "CardPanel",
        "file": "apps/crish-desktop/src/components/CardPanel.tsx",
        "selector": "[data-card-id], [role=\"tab\"].card-tab, .card-tab-item",
        "eventType": "onClick",
        "triggerCondition": "Card panel header mounted card tabs",
        "description": "右侧面板各个已挂载的卡片页签",
        "specialHandling": "Supports dblclick to expand/maximize card"
      },
      {
        "id": "card_tab_close_btn",
        "component": "CardPanel",
        "file": "apps/crish-desktop/src/components/CardPanel.tsx",
        "selector": ".card-tab-close, button[aria-label=\"关闭卡片\"]",
        "eventType": "onClick",
        "triggerCondition": "Hover on mounted card tab",
        "description": "关闭卡片页签 (x) 按钮",
        "specialHandling": null
      },
      {
        "id": "agent_card_run_btn",
        "component": "AgentCard",
        "file": "apps/crish-desktop/src/components/AgentCard.tsx",
        "selector": "button[aria-label=\"运行 Agent\"], .agent-run-btn",
        "eventType": "onClick",
        "triggerCondition": "Agent Card tab active",
        "description": "Agent 执行控制卡片运行按钮",
        "specialHandling": null
      },
      {
        "id": "agent_card_stop_btn",
        "component": "AgentCard",
        "file": "apps/crish-desktop/src/components/AgentCard.tsx",
        "selector": "button[aria-label=\"停止 Agent\"], .agent-stop-btn",
        "eventType": "onClick",
        "triggerCondition": "Agent task currently executing",
        "description": "Agent 停止执行按钮",
        "specialHandling": null
      },
      {
        "id": "terminal_input_area",
        "component": "TerminalCard",
        "file": "apps/crish-desktop/src/components/TerminalCard.tsx",
        "selector": ".terminal-card input, .xterm-helper-textarea, .terminal-input",
        "eventType": "onKeyDown",
        "triggerCondition": "Terminal Card active",
        "description": "终端卡片命令行输入区域",
        "specialHandling": "Requires onKeyDown (Enter) and onContextMenu for terminal paste"
      },
      {
        "id": "terminal_restart_btn",
        "component": "TerminalCard",
        "file": "apps/crish-desktop/src/components/TerminalCard.tsx",
        "selector": "button[aria-label=\"重启终端\"], .terminal-restart-btn",
        "eventType": "onClick",
        "triggerCondition": "Terminal Card toolbar",
        "description": "终端重启 Shell 实例按钮",
        "specialHandling": null
      },
      {
        "id": "diff_view_toggle_btn",
        "component": "DiffCard",
        "file": "apps/crish-desktop/src/components/DiffCard.tsx",
        "selector": "button[aria-label=\"切换对比视图\"], .diff-mode-toggle",
        "eventType": "onClick",
        "triggerCondition": "Diff Card header toolbar",
        "description": "代码 Diff 对比 Unified / Split 视图切换按钮",
        "specialHandling": null
      },
      {
        "id": "diff_accept_btn",
        "component": "DiffCardGitActions",
        "file": "apps/crish-desktop/src/components/DiffCardGitActions.tsx",
        "selector": "button[aria-label=\"接受修改\"], .diff-accept-btn",
        "eventType": "onClick",
        "triggerCondition": "Diff Card file actions bar",
        "description": "Diff 变更接受并暂存按钮",
        "specialHandling": null
      },
      {
        "id": "files_tree_node",
        "component": "FilesCard",
        "file": "apps/crish-desktop/src/components/FilesCard.tsx",
        "selector": ".file-tree-node, .files-card-item, [data-file-path]",
        "eventType": "onClick",
        "triggerCondition": "Files Card tab active",
        "description": "文件树节点/文件项",
        "specialHandling": "Supports dblclick to open file directly, onContextMenu for file context menu"
      },
      {
        "id": "files_search_input",
        "component": "FilesCard",
        "file": "apps/crish-desktop/src/components/FilesCard.tsx",
        "selector": "input[placeholder*=\"搜索文件\"], .files-search-input",
        "eventType": "onChange",
        "triggerCondition": "Files Card top search bar",
        "description": "文件树模糊搜索输入框",
        "specialHandling": null
      },
      {
        "id": "preview_url_input",
        "component": "PreviewCard",
        "file": "apps/crish-desktop/src/components/PreviewCard.tsx",
        "selector": "input[placeholder*=\"http\"], .preview-url-input",
        "eventType": "onKeyDown",
        "triggerCondition": "Preview Card active",
        "description": "实时预览卡片 URL 地址输入框",
        "specialHandling": "Triggers navigation on Enter key press"
      },
      {
        "id": "preview_reload_btn",
        "component": "PreviewCard",
        "file": "apps/crish-desktop/src/components/PreviewCard.tsx",
        "selector": "button[aria-label=\"刷新预览\"], .preview-reload-btn",
        "eventType": "onClick",
        "triggerCondition": "Preview Card toolbar",
        "description": "刷新 WebView/Iframe 预览页面按钮",
        "specialHandling": null
      },
      {
        "id": "scheduled_task_add_btn",
        "component": "ScheduledTasksPanel",
        "file": "apps/crish-desktop/src/components/ScheduledTasksPanel.tsx",
        "selector": "button[aria-label=\"新建定时任务\"], .task-add-btn",
        "eventType": "onClick",
        "triggerCondition": "Scheduled Tasks panel active",
        "description": "创建新 Cron 定时任务按钮",
        "specialHandling": null
      }
    ],
    "3_settings_panel_and_12_tabs": [
      {
        "id": "settings_modal_close_btn",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "button[aria-label=\"关闭设置\"], .settings-close-btn",
        "eventType": "onClick",
        "triggerCondition": "Settings modal open top right",
        "description": "设置弹窗关闭 (x) 按钮",
        "specialHandling": null
      },
      {
        "id": "settings_search_input",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "input[placeholder*=\"搜索设置\"], [id$=\"-search\"]",
        "eventType": "onChange",
        "triggerCondition": "Settings sidebar top search box",
        "description": "设置弹窗侧栏设置项搜索输入框",
        "specialHandling": null
      },
      {
        "id": "settings_tab_profile",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"profile\"], button:has-text(\"账户\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 1: 账户设置页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_appearance",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"appearance\"], button:has-text(\"外观\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 2: 外观设置页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_personalize",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"personalize\"], button:has-text(\"通用设置\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 3: 通用/偏好设置页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_models",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"models\"], button:has-text(\"模型\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 4: 模型与供应商设置页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_usage",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"usage\"], button:has-text(\"用量\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 5: Token 用量统计页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_rules",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"rules\"], button:has-text(\"规则\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 6: Agent 系统规则指示页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_schedule",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"schedule\"], button:has-text(\"定时任务\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 7: 定时任务管理页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_plugins",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"plugins\"], button:has-text(\"扩展\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 8: 扩展与插件中心页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_shortcuts",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"shortcuts\"], button:has-text(\"快捷键\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 9: 快捷键配置页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_security",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"security\"], button:has-text(\"安全\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar nav",
        "description": "Tab 10: 安全与白名单配置页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_mcp",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"mcp\"], button:has-text(\"MCP\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar or extension tab inner nav",
        "description": "Tab 11: MCP 服务管理页签按钮",
        "specialHandling": null
      },
      {
        "id": "settings_tab_skills",
        "component": "SettingsPanel",
        "file": "apps/crish-desktop/src/components/SettingsPanel.tsx",
        "selector": "[role=\"tab\"][data-tab-id=\"skills\"], button:has-text(\"技能\")",
        "eventType": "onClick",
        "triggerCondition": "Settings sidebar or extension tab inner nav",
        "description": "Tab 12: Agent 自定义技能页签按钮",
        "specialHandling": null
      },
      {
        "id": "tab1_username_input",
        "component": "SettingsProfileTab",
        "file": "apps/crish-desktop/src/components/SettingsProfileTab.tsx",
        "selector": "input[name=\"username\"], input[placeholder*=\"用户名\"]",
        "eventType": "onChange",
        "triggerCondition": "Tab 1 Profile active",
        "description": "账户页：用户名输入框",
        "specialHandling": null
      },
      {
        "id": "tab1_export_workspace_btn",
        "component": "SettingsProfileTab",
        "file": "apps/crish-desktop/src/components/SettingsProfileTab.tsx",
        "selector": "button[data-action=\"export-workspace\"], button.export-btn",
        "eventType": "onClick",
        "triggerCondition": "Tab 1 Profile active",
        "description": "账户页：导出工作区数据按钮",
        "specialHandling": null
      },
      {
        "id": "tab2_theme_option_card",
        "component": "SettingsAppearanceTab",
        "file": "apps/crish-desktop/src/components/SettingsAppearanceTab.tsx",
        "selector": "[data-theme-option], .theme-card",
        "eventType": "onClick",
        "triggerCondition": "Tab 2 Appearance active",
        "description": "外观页：主题切换卡片 (Dark / Light / System)",
        "specialHandling": null
      },
      {
        "id": "tab2_font_select",
        "component": "SettingsAppearanceTab",
        "file": "apps/crish-desktop/src/components/SettingsAppearanceTab.tsx",
        "selector": "select[name=\"fontFamily\"], .font-family-select",
        "eventType": "onChange",
        "triggerCondition": "Tab 2 Appearance active",
        "description": "外观页：字体下拉选择框",
        "specialHandling": null
      },
      {
        "id": "tab3_autosave_switch",
        "component": "SettingsPersonalizeTab",
        "file": "apps/crish-desktop/src/components/SettingsPersonalizeTab.tsx",
        "selector": "button[role=\"switch\"][data-setting=\"autoSave\"], .autosave-switch",
        "eventType": "onClick",
        "triggerCondition": "Tab 3 Personalize active",
        "description": "通用页：自动保存切换开关",
        "specialHandling": null
      },
      {
        "id": "tab4_add_provider_btn",
        "component": "ModelsSettingsTab",
        "file": "apps/crish-desktop/src/components/ModelsSettingsTab.tsx",
        "selector": "button.add-provider-btn, button:has-text(\"+ 添加供应商\")",
        "eventType": "onClick",
        "triggerCondition": "Tab 4 Models active",
        "description": "模型页：添加新模型供应商 (+) 按钮",
        "specialHandling": null
      },
      {
        "id": "tab4_apikey_input",
        "component": "ModelConfigEditor",
        "file": "apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx",
        "selector": "input[type=\"password\"][name=\"apiKey\"], .api-key-input",
        "eventType": "onChange",
        "triggerCondition": "Model provider editor modal / panel",
        "description": "模型页：供应商 API Key 密码输入框",
        "specialHandling": null
      },
      {
        "id": "tab4_baseurl_input",
        "component": "ModelConfigEditor",
        "file": "apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx",
        "selector": "input[name=\"baseUrl\"], .base-url-input",
        "eventType": "onChange",
        "triggerCondition": "Model provider editor modal / panel",
        "description": "模型页：API Base URL 自定义端点输入框",
        "specialHandling": null
      },
      {
        "id": "tab4_test_connection_btn",
        "component": "ModelConfigEditor",
        "file": "apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx",
        "selector": "button.test-connection-btn, button:has-text(\"测试连接\")",
        "eventType": "onClick",
        "triggerCondition": "Model provider editor modal / panel",
        "description": "模型页：API 连通性测试按钮",
        "specialHandling": null
      },
      {
        "id": "tab5_usage_time_filter",
        "component": "SettingsUsageTab",
        "file": "apps/crish-desktop/src/components/SettingsUsageTab.tsx",
        "selector": "select[name=\"usageTimeRange\"], .usage-period-select",
        "eventType": "onChange",
        "triggerCondition": "Tab 5 Usage active",
        "description": "用量页：时间范围筛选下拉框",
        "specialHandling": null
      },
      {
        "id": "tab6_add_rule_btn",
        "component": "SettingsRulesTab",
        "file": "apps/crish-desktop/src/components/SettingsRulesTab.tsx",
        "selector": "button.add-rule-btn, button:has-text(\"+ 新建规则\")",
        "eventType": "onClick",
        "triggerCondition": "Tab 6 Rules active",
        "description": "规则页：新建系统规则按钮",
        "specialHandling": null
      },
      {
        "id": "tab6_rule_textarea",
        "component": "SettingsRulesTab",
        "file": "apps/crish-desktop/src/components/SettingsRulesTab.tsx",
        "selector": "textarea[name=\"ruleContent\"], .rule-editor-textarea",
        "eventType": "onChange",
        "triggerCondition": "Rule creation / edit mode",
        "description": "规则页：规则 System Prompt 编辑文本框",
        "specialHandling": null
      },
      {
        "id": "tab7_add_cron_btn",
        "component": "SettingsScheduleTab",
        "file": "apps/crish-desktop/src/components/SettingsScheduleTab.tsx",
        "selector": "button.add-schedule-btn, button:has-text(\"+ 新建定时\")",
        "eventType": "onClick",
        "triggerCondition": "Tab 7 Schedule active",
        "description": "定时任务页：添加 Cron 表达式任务按钮",
        "specialHandling": null
      },
      {
        "id": "tab8_extension_search",
        "component": "SettingsExtensionsTab",
        "file": "apps/crish-desktop/src/components/SettingsExtensionsTab.tsx",
        "selector": "input[placeholder*=\"搜索扩展\"], .extension-search-input",
        "eventType": "onChange",
        "triggerCondition": "Tab 8 Extensions active",
        "description": "扩展页：扩展/插件市场搜索输入框",
        "specialHandling": null
      },
      {
        "id": "tab8_install_plugin_btn",
        "component": "ExtensionCard",
        "file": "apps/crish-desktop/src/components/settings-extensions/ExtensionCard.tsx",
        "selector": "button.extension-install-btn, button:has-text(\"安装\")",
        "eventType": "onClick",
        "triggerCondition": "Uninstalled extension card",
        "description": "扩展页：一键安装扩展插件按钮",
        "specialHandling": null
      },
      {
        "id": "tab9_shortcut_recorder_btn",
        "component": "SettingsShortcutsTab",
        "file": "apps/crish-desktop/src/components/SettingsShortcutsTab.tsx",
        "selector": ".shortcut-key-btn, button[class*=\"shortcutKey\"]",
        "eventType": "onClick",
        "triggerCondition": "Tab 9 Shortcuts active",
        "description": "快捷键页：按键录制与修改按钮",
        "specialHandling": "Enters key recording state on click"
      },
      {
        "id": "tab10_approval_mode_select",
        "component": "SettingsSecurityTab",
        "file": "apps/crish-desktop/src/components/SettingsSecurityTab.tsx",
        "selector": "select[name=\"securityApprovalMode\"], .approval-mode-select",
        "eventType": "onChange",
        "triggerCondition": "Tab 10 Security active",
        "description": "安全页：命令执行审批模式下拉菜单",
        "specialHandling": null
      },
      {
        "id": "tab11_add_mcp_btn",
        "component": "McpSettingsTab",
        "file": "apps/crish-desktop/src/components/McpSettingsTab.tsx",
        "selector": "button.add-mcp-server-btn, button:has-text(\"+ 新增 MCP\")",
        "eventType": "onClick",
        "triggerCondition": "Tab 11 MCP active",
        "description": "MCP 页：添加 MCP Server 实例按钮",
        "specialHandling": null
      },
      {
        "id": "tab11_mcp_command_input",
        "component": "McpServerForm",
        "file": "apps/crish-desktop/src/components/settings-mcp/McpServerForm.tsx",
        "selector": "input[name=\"mcpCommand\"], .mcp-command-input",
        "eventType": "onChange",
        "triggerCondition": "MCP server creation / edit form",
        "description": "MCP 页：Stdio 启动命令行参数输入框",
        "specialHandling": null
      },
      {
        "id": "tab12_add_skill_btn",
        "component": "SkillsSettingsTab",
        "file": "apps/crish-desktop/src/components/SkillsSettingsTab.tsx",
        "selector": "button.add-skill-btn, button:has-text(\"+ 新增技能\")",
        "eventType": "onClick",
        "triggerCondition": "Tab 12 Skills active",
        "description": "技能页：创建自定义技能按钮",
        "specialHandling": null
      },
      {
        "id": "tab12_skill_toggle_switch",
        "component": "SkillCardList",
        "file": "apps/crish-desktop/src/components/settings-skills/SkillCardList.tsx",
        "selector": "button[role=\"switch\"][data-skill-id], .skill-enable-switch",
        "eventType": "onClick",
        "triggerCondition": "Skill item in list",
        "description": "技能页：启用/禁用技能开关",
        "specialHandling": null
      }
    ],
    "4_modals_menus_and_overlays": [
      {
        "id": "context_menu_overlay",
        "component": "ContextMenu",
        "file": "apps/crish-desktop/src/components/Workspace.tsx",
        "selector": ".context-menu, div[role=\"menu\"].context-menu-container",
        "eventType": "onContextMenu",
        "triggerCondition": "Right click on session tab, file tree item, or chat message",
        "description": "通用右键上下文菜单弹出层",
        "specialHandling": "Triggered via right-click (onContextMenu)"
      },
      {
        "id": "context_menu_item",
        "component": "ContextMenu",
        "file": "apps/crish-desktop/src/components/Workspace.tsx",
        "selector": ".context-menu-item, [role=\"menuitem\"].context-item",
        "eventType": "onClick",
        "triggerCondition": "Context menu open",
        "description": "右键上下文菜单操作项 (重命名, 复制, 删除, 固定)",
        "specialHandling": null
      },
      {
        "id": "quick_open_overlay",
        "component": "QuickOpen",
        "file": "apps/crish-desktop/src/components/QuickOpen.tsx",
        "selector": ".quick-open-overlay, div[class*=\"quickOpen\"]",
        "eventType": "onKeyDown",
        "triggerCondition": "Triggered by Ctrl+P / Cmd+P or quick search button",
        "description": "QuickOpen 快速跳转与文件搜索弹出层",
        "specialHandling": "Listens for global keyboard shortcut Ctrl+P / Cmd+P"
      },
      {
        "id": "quick_open_input",
        "component": "QuickOpen",
        "file": "apps/crish-desktop/src/components/QuickOpen.tsx",
        "selector": "input.quick-open-input, input[placeholder*=\"搜索文件或命令\"]",
        "eventType": "onChange",
        "triggerCondition": "QuickOpen modal open",
        "description": "QuickOpen 模糊搜索框",
        "specialHandling": null
      },
      {
        "id": "cheatsheet_modal_overlay",
        "component": "CheatsheetModal",
        "file": "apps/crish-desktop/src/components/CheatsheetModal.tsx",
        "selector": ".cheatsheet-modal-overlay, div[class*=\"cheatsheet\"]",
        "eventType": "onClick",
        "triggerCondition": "Triggered by Ctrl+/ or help button",
        "description": "快捷键速查表 (Cheatsheet) 弹出层",
        "specialHandling": null
      },
      {
        "id": "cheatsheet_close_btn",
        "component": "CheatsheetModal",
        "file": "apps/crish-desktop/src/components/CheatsheetModal.tsx",
        "selector": "button.cheatsheet-close-btn, button[aria-label=\"关闭速查表\"]",
        "eventType": "onClick",
        "triggerCondition": "Cheatsheet modal open",
        "description": "快捷键速查表关闭按钮",
        "specialHandling": null
      },
      {
        "id": "telemetry_dialog_overlay",
        "component": "TelemetryDialog",
        "file": "apps/crish-desktop/src/components/TelemetryDialog.tsx",
        "selector": ".telemetry-dialog-overlay, div[class*=\"telemetry\"]",
        "eventType": "onClick",
        "triggerCondition": "Telemetry permission dialog prompt",
        "description": "遥测数据收集隐私选项弹窗",
        "specialHandling": null
      },
      {
        "id": "telemetry_confirm_btn",
        "component": "TelemetryDialog",
        "file": "apps/crish-desktop/src/components/TelemetryDialog.tsx",
        "selector": "button.telemetry-confirm-btn, button:has-text(\"同意并继续\")",
        "eventType": "onClick",
        "triggerCondition": "Telemetry dialog open",
        "description": "遥测弹窗确认同意按钮",
        "specialHandling": null
      },
      {
        "id": "first_run_wizard_next",
        "component": "FirstRunWizard",
        "file": "apps/crish-desktop/src/components/FirstRunWizard.tsx",
        "selector": "button.wizard-next-btn, button:has-text(\"下一步\")",
        "eventType": "onClick",
        "triggerCondition": "First run wizard modal open",
        "description": "首次运行向导下一步按钮",
        "specialHandling": null
      },
      {
        "id": "error_boundary_reload_btn",
        "component": "AppErrorBoundary",
        "file": "apps/crish-desktop/src/components/AppErrorBoundary.tsx",
        "selector": "button.error-reload-btn, button:has-text(\"重新加载\")",
        "eventType": "onClick",
        "triggerCondition": "Application component crash screen",
        "description": "全局错误边界页面重新加载按钮",
        "specialHandling": null
      },
      {
        "id": "approval_ask_allow_once_btn",
        "component": "ApprovalAskCard",
        "file": "apps/crish-desktop/src/components/ApprovalAskCard.tsx",
        "selector": "button.approval-allow-once, button:has-text(\"允许一次\")",
        "eventType": "onClick",
        "triggerCondition": "Agent command execution request popover",
        "description": "Agent 工具执行权限询问：仅允许一次按钮",
        "specialHandling": null
      },
      {
        "id": "toast_undo_btn",
        "component": "ToastStack",
        "file": "apps/crish-desktop/src/components/ToastStack.tsx",
        "selector": "button.toast-undo-btn, button:has-text(\"撤销\")",
        "eventType": "onClick",
        "triggerCondition": "Toast notification active with undoable action",
        "description": "Toast 全局通知内撤销操作按钮",
        "specialHandling": null
      }
    ],
    "5_special_interaction_elements": [
      {
        "id": "special_mousedown_model_badge",
        "component": "ModelBadgePickerMenu",
        "file": "apps/crish-desktop/src/components/ModelBadgePickerMenu.tsx",
        "selector": ".modelBadge, div[class*=\"modelBadge\"]",
        "eventType": "onMouseDown",
        "requiredMouseEvent": "mousedown",
        "triggerCondition": "Model picker badge click",
        "description": "模型徽章下拉菜单：防止 focus 丢失需使用 mousedown 事件触发",
        "specialHandling": "Must dispatch mousedown event prior to click"
      },
      {
        "id": "special_mousedown_panel_resizer",
        "component": "Workspace",
        "file": "apps/crish-desktop/src/components/Workspace.tsx",
        "selector": ".sidebar-resizer, .panel-resizer, .pane-divider",
        "eventType": "onMouseDown",
        "requiredMouseEvent": "mousedown",
        "triggerCondition": "Dragging left sidebar or right panel border to resize",
        "description": "面板拖拽调整宽度分割线：使用 mousedown 捕获拖拽手势",
        "specialHandling": "Listen on mousedown and mousemove on window"
      },
      {
        "id": "special_rightclick_session_tab",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": ".sess-tab, [data-session-id]",
        "eventType": "onContextMenu",
        "requiredMouseEvent": "right-click",
        "triggerCondition": "Right click on session tab element",
        "description": "会话页签右键菜单：触发页签右键选项",
        "specialHandling": "Use right-click / contextmenu event"
      },
      {
        "id": "special_rightclick_file_tree_node",
        "component": "FilesCard",
        "file": "apps/crish-desktop/src/components/FilesCard.tsx",
        "selector": ".file-tree-node, [data-file-path]",
        "eventType": "onContextMenu",
        "requiredMouseEvent": "right-click",
        "triggerCondition": "Right click on file tree item",
        "description": "文件树节点右键菜单：触发新建/删除/重命名菜单",
        "specialHandling": "Use right-click / contextmenu event"
      },
      {
        "id": "special_rightclick_chat_message",
        "component": "ChatMessageRow",
        "file": "apps/crish-desktop/src/components/ChatMessageRow.tsx",
        "selector": ".chat-message-row, [data-message-id]",
        "eventType": "onContextMenu",
        "requiredMouseEvent": "right-click",
        "triggerCondition": "Right click on message bubble",
        "description": "聊天消息气泡右键：复制/重试/编辑消息上下文菜单",
        "specialHandling": "Use right-click / contextmenu event"
      },
      {
        "id": "special_dblclick_session_title",
        "component": "WorkspaceChromeBars",
        "file": "apps/crish-desktop/src/components/WorkspaceChromeBars.tsx",
        "selector": ".sess-tab-title, .session-tab-label",
        "eventType": "onDoubleClick",
        "requiredMouseEvent": "dblclick",
        "triggerCondition": "Double click on session tab title text",
        "description": "双击会话页签标题：触发内联重命名文本框",
        "specialHandling": "Use double click (dblclick) event"
      },
      {
        "id": "special_dblclick_file_tree_node",
        "component": "FilesCard",
        "file": "apps/crish-desktop/src/components/FilesCard.tsx",
        "selector": ".file-tree-node, [data-file-path]",
        "eventType": "onDoubleClick",
        "requiredMouseEvent": "dblclick",
        "triggerCondition": "Double click on file tree row",
        "description": "双击文件树节点：立即在主窗口打开文件卡片/编辑器",
        "specialHandling": "Use double click (dblclick) event"
      },
      {
        "id": "special_mouseover_chat_message_actions",
        "component": "ChatMessageRow",
        "file": "apps/crish-desktop/src/components/ChatMessageRow.tsx",
        "selector": ".chat-message-row",
        "eventType": "onMouseEnter",
        "requiredMouseEvent": "mouseover",
        "triggerCondition": "Hover mouse over chat message bubble",
        "description": "悬停消息气泡：触发浮动操作栏 (复制, 重写, 点赞) 显示",
        "specialHandling": "Use mouseover / mouseenter event"
      },
      {
        "id": "special_mouseover_tooltip_trigger",
        "component": "Tooltip",
        "file": "apps/crish-desktop/src/components/Tooltip.tsx",
        "selector": "[data-tooltip], .tooltip-trigger, [title]",
        "eventType": "onMouseEnter",
        "requiredMouseEvent": "mouseover",
        "triggerCondition": "Hover over icon button or badge with custom tooltip",
        "description": "悬停图标或控制按钮：显示黑色圆角 Pill Tooltip",
        "specialHandling": "Use mouseover / mouseenter event"
      },
      {
        "id": "special_mousedown_tab_drag",
        "component": "CardPanel",
        "file": "apps/crish-desktop/src/components/CardPanel.tsx",
        "selector": ".card-tab-drag, .tab-drag-handle",
        "eventType": "onMouseDown",
        "requiredMouseEvent": "mousedown",
        "triggerCondition": "Pressing down mouse on card tab to reorder",
        "description": "卡片页签拖拽重排：捕获 mousedown 开始页签拖拽",
        "specialHandling": "Use mousedown event"
      }
    ]
  }
};

const outputPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui-selectors-manifest.json');
fs.writeFileSync(outputPath, JSON.stringify(manifestData, null, 2), 'utf8');
console.log(`Successfully generated ${outputPath}`);
