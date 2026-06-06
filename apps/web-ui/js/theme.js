/* 
   ==========================================================================
   CODEX THEME & SETTINGS CONTROLLER (theme.js)
   ========================================================================== 
*/

window.CodexApp = window.CodexApp || {};

window.CodexApp.initTheme = function() {
    const showToast = window.CodexApp.showToast || (() => {});

    // DOM Elements
    const windowMenu = document.getElementById("menu-window");
    const windowDropdown = document.getElementById("window-dropdown");
    const settingsBtn = document.getElementById("nav-settings");
    const settingsBubble = document.getElementById("settings-bubble");
    
    const mainSettingsView = document.getElementById("main-settings-view");
    const settingsBackdrop = document.getElementById("settings-backdrop");
    const bubbleSettingsTrigger = document.getElementById("bubble-trigger-settings");
    const settingsBackBtn = document.getElementById("settings-back-to-app");

    // 1. Click Outside Closers
    document.addEventListener("click", (e) => {
        if (windowMenu && windowDropdown) {
            if (!windowMenu.contains(e.target) && !windowDropdown.contains(e.target)) {
                windowDropdown.classList.remove("show");
                windowMenu.classList.remove("active");
            }
        }
        if (settingsBtn && settingsBubble) {
            if (!settingsBtn.contains(e.target) && !settingsBubble.contains(e.target)) {
                settingsBubble.classList.remove("show");
            }
        }
    });

    // 2. Titlebar "窗口" Dropdown Menu Logic
    if (windowMenu && windowDropdown) {
        windowMenu.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = windowDropdown.classList.toggle("show");
            windowMenu.classList.toggle("active", isOpen);
            if (settingsBubble) settingsBubble.classList.remove("show");
        });
    }

    // Dropdown Items Tauri mock triggers
    const minBtn = document.getElementById("drop-min");
    const zoomBtn = document.getElementById("drop-zoom");
    const closeBtn = document.getElementById("drop-close");

    if (minBtn) minBtn.addEventListener("click", () => {
        if (windowDropdown) windowDropdown.classList.remove("show");
    });
    if (zoomBtn) zoomBtn.addEventListener("click", () => {
        if (windowDropdown) windowDropdown.classList.remove("show");
    });
    if (closeBtn) closeBtn.addEventListener("click", () => {
        if (windowDropdown) windowDropdown.classList.remove("show");
    });

    // 3. Top-Right Window Controls Buttons
    const winMin = document.getElementById("win-min");
    const winMax = document.getElementById("win-max");
    const winClose = document.getElementById("win-close");

    if (winMin) winMin.addEventListener("click", () => {});
    if (winMax) winMax.addEventListener("click", () => {});
    if (winClose) winClose.addEventListener("click", () => {});

    // 4. Left Profile Trigger Settings bubble
    if (settingsBtn && settingsBubble) {
        settingsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            settingsBubble.classList.toggle("show");
            if (windowDropdown) windowDropdown.classList.remove("show");
        });
    }

    const logoutTrigger = document.getElementById("bubble-trigger-logout");
    if (logoutTrigger) {
        logoutTrigger.addEventListener("click", () => {
            showToast("API 密钥已注销");
            if (settingsBubble) settingsBubble.classList.remove("show");
        });
    }

    // 5. Centered Pop-up settings Modal Transitions
    if (bubbleSettingsTrigger && mainSettingsView) {
        bubbleSettingsTrigger.addEventListener("click", () => {
            if (settingsBubble) settingsBubble.classList.remove("show");
            if (settingsBackdrop) settingsBackdrop.classList.add("show");
            
            // Force a layout reflow
            mainSettingsView.offsetHeight;
            mainSettingsView.classList.add("show-modal");
            showToast("已进入设置");
        });
    }

    function closeSettingsModal() {
        if (mainSettingsView) mainSettingsView.classList.remove("show-modal");
        if (settingsBackdrop) settingsBackdrop.classList.remove("show");
        showToast("已返回");
    }

    if (settingsBackBtn) settingsBackBtn.addEventListener("click", closeSettingsModal);
    if (settingsBackdrop) settingsBackdrop.addEventListener("click", closeSettingsModal);

    // 6. Settings Sidebar Navigation
    const settingsTabs = document.querySelectorAll(".repl-settings-nav-item");
    const settingsPanels = document.querySelectorAll(".repl-settings-tab-panel");
    const placeholderTitle = document.getElementById("placeholder-title");
    const placeholderBackBtn = document.getElementById("placeholder-back-btn");

    function switchSettingsTab(tabId, label) {
        settingsTabs.forEach(t => t.classList.remove("active"));
        settingsPanels.forEach(p => p.classList.remove("active"));

        const clickedTab = Array.from(settingsTabs).find(t => t.getAttribute("data-tab") === tabId);
        if (clickedTab) clickedTab.classList.add("active");

        const targetPanel = document.getElementById(tabId);
        if (targetPanel) {
            targetPanel.classList.add("active");
        } else if (placeholderTitle) {
            const placeholderPanel = document.getElementById("tab-placeholder");
            placeholderTitle.textContent = `${label} 设置`;
            if (placeholderPanel) placeholderPanel.classList.add("active");
        }
    }

    settingsTabs.forEach(tab => {
        tab.addEventListener("click", () => {
            const tabId = tab.getAttribute("data-tab");
            const labelNode = tab.querySelector("span:not(.repl-settings-nav-icon)");
            const label = labelNode ? labelNode.textContent : "常规";
            switchSettingsTab(tabId, label);
        });
    });

    if (placeholderBackBtn) {
        placeholderBackBtn.addEventListener("click", () => {
            switchSettingsTab("tab-general", "常规");
        });
    }

    // 7. General Settings (Work Mode toggle cards)
    const modeCoding = document.getElementById("mode-coding");
    const modeDaily = document.getElementById("mode-daily");

    if (modeCoding && modeDaily) {
        modeCoding.addEventListener("click", () => {
            modeCoding.classList.add("active");
            modeCoding.querySelector(".repl-mode-card-radio").classList.add("checked");
            
            modeDaily.classList.remove("active");
            modeDaily.querySelector(".repl-mode-card-radio").classList.remove("checked");
            showToast("模式: 编程");
        });

        modeDaily.addEventListener("click", () => {
            modeDaily.classList.add("active");
            modeDaily.querySelector(".repl-mode-card-radio").classList.add("checked");
            
            modeCoding.classList.remove("active");
            modeCoding.querySelector(".repl-mode-card-radio").classList.remove("checked");
            showToast("模式: 日常");
        });
    }

    // Permission switches uploader changes
    const permDefault = document.getElementById("toggle-permission-default");
    const permAudit = document.getElementById("toggle-permission-audit");
    const permFull = document.getElementById("toggle-permission-full");

    if (permDefault) permDefault.addEventListener("change", (e) => showToast(`文件读写: ${e.target.checked ? "ON" : "OFF"}`));
    if (permAudit) permAudit.addEventListener("change", (e) => showToast(`自动审核: ${e.target.checked ? "ON" : "OFF"}`));
    if (permFull) permFull.addEventListener("change", (e) => showToast(`完全授权: ${e.target.checked ? "ON" : "OFF"}`));

    // Dropdown selectors
    const dropTarget = document.getElementById("drop-open-target");
    const dropEnv = document.getElementById("drop-agent-env");
    const dropShell = document.getElementById("drop-shell-type");
    const dropLang = document.getElementById("drop-language");

    function initDropdown(triggerEl, options, placeholder) {
        if (!triggerEl) return;
        var valEl = triggerEl.querySelector(".repl-select-val");
        var currentVal = valEl ? (valEl.textContent || "").trim() : "";
        var menu = document.createElement("div");
        menu.className = "repl-select-menu";
        options.forEach(function(opt) {
            var item = document.createElement("div");
            item.className = "repl-select-option" + (opt === currentVal ? " selected" : "");
            item.innerHTML = '<span>' + opt + '</span><svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
            item.addEventListener("click", function(e) {
                e.stopPropagation();
                if (valEl) {
                    var iconSpan = valEl.querySelector(".repl-vscode-icon");
                    if (iconSpan) {
                        valEl.innerHTML = "";
                        valEl.appendChild(iconSpan);
                        valEl.appendChild(document.createTextNode(opt));
                    } else {
                        valEl.textContent = opt;
                    }
                }
                menu.querySelectorAll(".repl-select-option").forEach(function(o) { o.classList.remove("selected"); });
                item.classList.add("selected");
                menu.classList.remove("open");
                showToast(placeholder + ": " + opt);
            });
            menu.appendChild(item);
        });
        triggerEl.appendChild(menu);
        triggerEl.addEventListener("click", function(e) {
            e.stopPropagation();
            document.querySelectorAll(".repl-select-menu.open").forEach(function(m) {
                if (m !== menu) m.classList.remove("open");
            });
            menu.classList.toggle("open");
        });
    }

    initDropdown(dropTarget, ["VS Code", "Cursor", "Windsurf", "Neovim"], "IDE");
    initDropdown(dropEnv, ["Windows 原生", "WSL Linux", "Docker 沙箱"], "环境");
    initDropdown(dropShell, ["PowerShell", "CMD", "Git Bash", "WSL Bash"], "Shell");
    initDropdown(dropLang, ["自动检测", "简体中文", "English"], "语言");

    // 8. Appearance Settings tab panel
    const themeLight = document.getElementById("theme-light");
    const themeDark = document.getElementById("theme-dark");
    const themeSystem = document.getElementById("theme-system");

    function applyTheme(themeName) {
        if (themeName === "light") {
            document.documentElement.setAttribute("data-theme", "light");
        } else if (themeName === "dark") {
            document.documentElement.setAttribute("data-theme", "dark");
        } else if (themeName === "system") {
            const systemTheme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
            document.documentElement.setAttribute("data-theme", systemTheme);
        }
    }

    // Monitor system theme preferences changing
    const systemThemeMedia = window.matchMedia("(prefers-color-scheme: light)");
    function handleSystemThemeChange() {
        if (themeSystem && themeSystem.classList.contains("active")) {
            applyTheme("system");
        }
    }
    if (systemThemeMedia.addEventListener) {
        systemThemeMedia.addEventListener("change", handleSystemThemeChange);
    } else if (systemThemeMedia.addListener) {
        systemThemeMedia.addListener(handleSystemThemeChange);
    }

    function selectThemeSegment(target, themeName) {
        if (!target) return;
        [themeLight, themeDark, themeSystem].forEach(opt => opt && opt.classList.remove("active"));
        target.classList.add("active");
        applyTheme(themeName);
        localStorage.setItem("codex-theme", themeName);
    }

    if (themeLight) themeLight.addEventListener("click", () => { selectThemeSegment(themeLight, "light"); showToast("白天模式"); });
    if (themeDark) themeDark.addEventListener("click", () => { selectThemeSegment(themeDark, "dark"); showToast("黑夜模式"); });
    if (themeSystem) themeSystem.addEventListener("click", () => { selectThemeSegment(themeSystem, "system"); showToast("跟随系统"); });

    // Bootstrap theme initially
    const savedTheme = localStorage.getItem("codex-theme") || "dark";
    const initialActiveTab = savedTheme === "light" ? themeLight : (savedTheme === "system" ? themeSystem : themeDark);
    if (initialActiveTab) {
        selectThemeSegment(initialActiveTab, savedTheme);
    }

    // Fonts, colors and sliders settings
    const dropThemeName = document.getElementById("drop-theme-name");
    const pickAccent = document.getElementById("pick-accent");
    const pickBg = document.getElementById("pick-bg");
    const pickFg = document.getElementById("pick-fg");
    const selUiFont = document.getElementById("select-ui-font");
    const selCodeFont = document.getElementById("select-code-font");

    if (dropThemeName) dropThemeName.addEventListener("click", () => showToast("选择主题"));
    if (pickAccent) pickAccent.addEventListener("click", () => showToast("选择强调色"));
    if (pickBg) pickBg.addEventListener("click", () => showToast("选择背景色"));
    if (pickFg) pickFg.addEventListener("click", () => showToast("选择前景色"));
    if (selUiFont) selUiFont.addEventListener("click", () => showToast("选择 UI 字体"));
    if (selCodeFont) selCodeFont.addEventListener("click", () => showToast("选择代码字体"));

    const translucentSidebar = document.getElementById("toggle-sidebar-translucent");
    if (translucentSidebar) {
        translucentSidebar.addEventListener("change", (e) => showToast(`侧栏透明: ${e.target.checked ? "ON" : "OFF"}`));
    }

    // Contrast Range Slider
    const contrastSlider = document.getElementById("slider-contrast");
    const contrastValue = document.getElementById("val-contrast");

    if (contrastSlider && contrastValue) {
        contrastSlider.addEventListener("input", (e) => {
            contrastValue.textContent = e.target.value;
        });
        contrastSlider.addEventListener("change", (e) => {
            showToast(`对比度: ${e.target.value}%`);
        });
    }

    const pointerCursor = document.getElementById("toggle-pointer-cursor");
    if (pointerCursor) {
        pointerCursor.addEventListener("change", (e) => showToast(`指针光标: ${e.target.checked ? "ON" : "OFF"}`));
    }

    // Motion effects picker segment
    const motionSys = document.getElementById("motion-sys");
    const motionOn = document.getElementById("motion-on");
    const motionOff = document.getElementById("motion-off");

    function selectMotionSegment(target, mode) {
        if (!target) return;
        [motionSys, motionOn, motionOff].forEach(opt => opt && opt.classList.remove("active"));
        target.classList.add("active");
        showToast(`动效: ${mode}`);
    }
    if (motionSys) motionSys.addEventListener("click", () => selectMotionSegment(motionSys, "系统设置"));
    if (motionOn) motionOn.addEventListener("click", () => selectMotionSegment(motionOn, "开启平滑动画"));
    if (motionOff) motionOff.addEventListener("click", () => selectMotionSegment(motionOff, "关闭动画 (节能模式)"));

    // Base UI and code base line pixels
    const inputUiSize = document.getElementById("input-ui-size");
    const inputCodeSize = document.getElementById("input-code-size");

    if (inputUiSize) inputUiSize.addEventListener("change", (e) => showToast(`UI字号: ${e.target.value}px`));
    if (inputCodeSize) inputCodeSize.addEventListener("change", (e) => showToast(`代码字号: ${e.target.value}px`));

    // Ide switchers and external models config
    const ideSwitcherBtn = document.getElementById("ide-switcher");
    const btnAttach = document.getElementById("btn-attach");
    const btnAccess = document.getElementById("btn-access");
    const btnModel = document.getElementById("btn-model");
    const btnTemp = document.getElementById("btn-temp");

    if (ideSwitcherBtn) ideSwitcherBtn.addEventListener("click", () => showToast("打开 IDE"));
    if (btnAttach) btnAttach.addEventListener("click", () => showToast("添加项目"));
    if (btnAccess) btnAccess.addEventListener("click", () => showToast("完全授权"));
    if (btnModel) btnModel.addEventListener("click", () => showToast("切换模型"));
    if (btnTemp) btnTemp.addEventListener("click", () => showToast("调节温度"));

    // Active bottom capsule options
    const pillHistory = document.getElementById("pill-history");
    const pillMode = document.getElementById("pill-mode");
    const pillBranch = document.getElementById("pill-branch");

    if (pillHistory) pillHistory.addEventListener("click", () => showToast("本地检索"));
    if (pillMode) pillMode.addEventListener("click", () => showToast("本地连接"));
    if (pillBranch) pillBranch.addEventListener("click", () => showToast("Git 分支"));

    // 9. API Configuration Panel Bindings
    window.CodexApp.initApiSettingsPanel = function() {
        var CM = window.CodexApp.ConfigManager;
        if (!CM) return;
        var config = CM.get();
        var api = config.api || {};

        var elBaseUrl = document.getElementById("cfg-api-baseurl");
        var elToken = document.getElementById("cfg-api-token");
        var elTokenToggle = document.getElementById("cfg-api-token-toggle");
        var elModel = document.getElementById("cfg-api-model");
        var elTemperature = document.getElementById("cfg-api-temperature");
        var elTempVal = document.getElementById("cfg-api-temperature-val");
        var elTopP = document.getElementById("cfg-api-topp");
        var elTopPVal = document.getElementById("cfg-api-topp-val");
        var elMaxTokens = document.getElementById("cfg-api-maxtokens");
        var elSystemPrompt = document.getElementById("cfg-api-systemprompt");
        var elStream = document.getElementById("cfg-api-stream");
        var btnSave = document.getElementById("cfg-api-save");
        var btnReset = document.getElementById("cfg-api-reset");
        var btnTest = document.getElementById("cfg-api-test");
        var elTestResult = document.getElementById("cfg-api-test-result");

        function populateFields() {
            var c = CM.get();
            var a = c.api || {};
            if (elBaseUrl) elBaseUrl.value = a.baseUrl || "";
            if (elToken) elToken.value = a.token || "";
            if (elModel) elModel.value = a.model || "mimo-v2.5";
            if (elTemperature) { elTemperature.value = a.temperature !== undefined ? a.temperature : 0.7; }
            if (elTempVal) elTempVal.textContent = a.temperature !== undefined ? a.temperature : 0.7;
            if (elTopP) { elTopP.value = a.topP !== undefined ? a.topP : 0.95; }
            if (elTopPVal) elTopPVal.textContent = a.topP !== undefined ? a.topP : 0.95;
            if (elMaxTokens) elMaxTokens.value = a.maxTokens || 4096;
            if (elSystemPrompt) elSystemPrompt.value = a.systemPrompt || "";
            if (elStream) elStream.checked = a.stream !== false;
        }

        populateFields();

        if (elTemperature && elTempVal) {
            elTemperature.addEventListener("input", function(e) {
                elTempVal.textContent = parseFloat(e.target.value).toFixed(1);
            });
        }

        if (elTopP && elTopPVal) {
            elTopP.addEventListener("input", function(e) {
                elTopPVal.textContent = parseFloat(e.target.value).toFixed(2);
            });
        }

        if (elTokenToggle && elToken) {
            elTokenToggle.addEventListener("click", function() {
                var isPassword = elToken.type === "password";
                elToken.type = isPassword ? "text" : "password";
                var icon = elTokenToggle.querySelector("i");
                if (icon) icon.setAttribute("data-lucide", isPassword ? "eye" : "eye-off");
                if (window.lucide) window.lucide.createIcons({ node: elTokenToggle });
            });
        }

        if (btnSave) {
            btnSave.addEventListener("click", function() {
                CM.set("api.baseUrl", elBaseUrl ? elBaseUrl.value : "");
                CM.set("api.token", elToken ? elToken.value : "");
                CM.set("api.model", elModel ? elModel.value : "mimo-v2.5");
                CM.set("api.temperature", elTemperature ? parseFloat(elTemperature.value) : 0.7);
                CM.set("api.topP", elTopP ? parseFloat(elTopP.value) : 0.95);
                CM.set("api.maxTokens", elMaxTokens ? parseInt(elMaxTokens.value) : 4096);
                CM.set("api.systemPrompt", elSystemPrompt ? elSystemPrompt.value : "");
                CM.set("api.stream", elStream ? elStream.checked : true);
                showToast("配置已保存");
            });
        }

        if (btnReset) {
            btnReset.addEventListener("click", function() {
                CM.reset();
                populateFields();
                showToast("已恢复默认");
            });
        }

        if (btnTest) {
            btnTest.addEventListener("click", function() {
                if (!elTestResult) return;
                elTestResult.style.display = "block";
                elTestResult.style.backgroundColor = "var(--bg-input)";
                elTestResult.style.color = "var(--text-muted)";
                elTestResult.textContent = "正在测试连接...";

                var client = window.CodexApp.MimoClient;
                if (!client) {
                    elTestResult.textContent = "API 客户端模块未加载";
                    elTestResult.style.color = "#ef4444";
                    return;
                }

                client.sendChat(
                    [{ role: "user", content: "Hi" }],
                    {
                        onContent: function(chunk, full) {},
                        onComplete: function(result) {
                            elTestResult.style.backgroundColor = "rgba(16, 185, 129, 0.08)";
                            elTestResult.style.color = "#10b981";
                            elTestResult.textContent = "连接成功! 响应: " + (result.content || "").substring(0, 100) + (result.content && result.content.length > 100 ? "..." : "");
                        },
                        onError: function(err) {
                            elTestResult.style.backgroundColor = "rgba(239, 68, 68, 0.08)";
                            elTestResult.style.color = "#ef4444";
                            elTestResult.textContent = "连接失败: " + err.message;
                        }
                    },
                    CM.get()
                );
            });
        }

        CM.onChange(function() {
            populateFields();
        });
    };

    window.CodexApp.initApiSettingsPanel();

    document.addEventListener("click", function() {
        document.querySelectorAll(".repl-select-menu.open").forEach(function(m) {
            m.classList.remove("open");
        });
    });
};
