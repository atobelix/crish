/* 
   ==========================================================================
   CODEX CHAT ENGINE & BUBBLES CONTROLLER (chat.js)
   ========================================================================== 
*/

window.CodexApp = window.CodexApp || {};

window.CodexApp.ChatHistory = [];

window.CodexApp.initChat = function() {
    var showToast = window.CodexApp.showToast || (function() {});
    var chatInput = window.CodexApp.chatInput || document.getElementById("chat-input");
    var sendBtn = window.CodexApp.sendBtn || document.getElementById("btn-send");
    var currentRequest = null;

    if (chatInput) {
        chatInput.addEventListener("input", function() {
            chatInput.style.height = "auto";
            chatInput.style.height = (chatInput.scrollHeight) + "px";
        });
    }

    function getChatFeed() {
        var feed = document.querySelector("#main-chat-view .repl-chat-feed");
        if (!feed) {
            feed = document.querySelector("#main-chat-view .repl-main-card");
        }
        return feed;
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.appendChild(document.createTextNode(text));
        return div.innerHTML;
    }

    function appendUserMessage(text) {
        var feed = getChatFeed();
        if (!feed) return;
        var row = document.createElement("div");
        row.className = "repl-chat-msg-row user";
        row.innerHTML = '<div class="repl-chat-msg-bubble">' + escapeHtml(text) + '</div>';
        var suggestions = feed.querySelector(".repl-suggestions-panel");
        if (suggestions) {
            feed.insertBefore(row, suggestions);
        } else {
            feed.appendChild(row);
        }
        scrollToBottom();
    }

    function createAssistantMessage() {
        var feed = getChatFeed();
        if (!feed) return null;
        var row = document.createElement("div");
        row.className = "repl-chat-msg-row agent";
        var bubble = document.createElement("div");
        bubble.className = "repl-chat-msg-bubble";

        var reasoningBlock = document.createElement("div");
        reasoningBlock.className = "repl-reasoning-block";
        reasoningBlock.style.cssText = "display:none; margin-bottom:8px; padding:8px 12px; border-radius:6px; background:rgba(59,130,246,0.06); border-left:3px solid var(--blue-accent); font-size:12px; color:var(--text-muted);";
        
        var reasoningLabel = document.createElement("div");
        reasoningLabel.style.cssText = "font-size:11px; font-weight:600; color:var(--blue-accent); margin-bottom:4px; display:flex; align-items:center; gap:4px;";
        reasoningLabel.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a8 8 0 0 0-8 8c0 3.4 2.1 6.3 5 7.5V20h6v-2.5c2.9-1.2 5-4.1 5-7.5a8 8 0 0 0-8-8z"/><line x1="9" y1="22" x2="15" y2="22"/></svg> 思考过程';
        reasoningBlock.appendChild(reasoningLabel);

        var reasoningContent = document.createElement("div");
        reasoningContent.className = "repl-reasoning-text";
        reasoningContent.style.cssText = "white-space:pre-wrap; word-break:break-word;";
        reasoningBlock.appendChild(reasoningContent);

        var contentEl = document.createElement("div");
        contentEl.className = "repl-assistant-text";
        contentEl.style.cssText = "white-space:pre-wrap; word-break:break-word; line-height:1.6;";

        var statusEl = document.createElement("div");
        statusEl.className = "repl-stream-status";
        statusEl.style.cssText = "display:flex; align-items:center; gap:6px; margin-top:8px; font-size:11px; color:var(--text-dark);";
        statusEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon" style="animation:spin 1s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> 正在生成...';

        bubble.appendChild(reasoningBlock);
        bubble.appendChild(contentEl);
        bubble.appendChild(statusEl);
        row.appendChild(bubble);

        var suggestions = feed.querySelector(".repl-suggestions-panel");
        if (suggestions) {
            feed.insertBefore(row, suggestions);
        } else {
            feed.appendChild(row);
        }
        scrollToBottom();

        return {
            row: row,
            reasoningBlock: reasoningBlock,
            reasoningContent: reasoningContent,
            contentEl: contentEl,
            statusEl: statusEl
        };
    }

    function scrollToBottom() {
        var feed = getChatFeed();
        if (feed) {
            feed.scrollTop = feed.scrollHeight;
        }
    }

    // ==========================================
    // Slash Command Menu System
    // ==========================================
    var slashCommands = [
        { cmd: "/agent", desc: "启动子智能体模式", icon: "bot" },
        { cmd: "/review", desc: "打开代码审查面板", icon: "file-text" },
        { cmd: "/code", desc: "打开代码文件视图", icon: "file-json" },
        { cmd: "/clear", desc: "清空当前对话", icon: "trash-2" },
        { cmd: "/help", desc: "显示所有可用命令", icon: "help-circle" },
        { cmd: "/settings", desc: "打开设置面板", icon: "settings" },
        { cmd: "/theme", desc: "切换深色/浅色主题", icon: "sun" }
    ];

    var slashMenu = null;

    function createSlashMenu() {
        if (slashMenu) return slashMenu;
        var menu = document.createElement("div");
        menu.className = "repl-slash-menu";
        menu.style.cssText = "position:absolute; bottom:100%; left:0; right:0; background:var(--bg-popup,#1a1a1e); border:1px solid var(--border-card); border-radius:8px; padding:4px; margin-bottom:4px; box-shadow:0 -8px 24px rgba(0,0,0,0.3); z-index:100; display:none; max-height:220px; overflow-y:auto;";
        menu.id = "slash-command-menu";

        slashCommands.forEach(function(item) {
            var row = document.createElement("div");
            row.className = "repl-slash-menu-item";
            row.setAttribute("data-cmd", item.cmd);
            row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:5px; cursor:pointer; font-size:12px; color:var(--text-secondary); transition:background 0.1s;";
            row.innerHTML = '<i data-lucide="' + item.icon + '" style="width:13px;height:13px;color:var(--text-dim);flex-shrink:0;"></i><span style="font-weight:600;color:var(--text-primary);font-family:var(--font-mono);">' + item.cmd + '</span><span style="color:var(--text-dim);margin-left:auto;">' + item.desc + '</span>';

            row.addEventListener("mouseenter", function() { row.style.background = "rgba(255,255,255,0.04)"; });
            row.addEventListener("mouseleave", function() { row.style.background = "transparent"; });
            row.addEventListener("click", function() {
                if (chatInput) {
                    chatInput.value = item.cmd + " ";
                    chatInput.focus();
                    chatInput.style.height = "auto";
                    chatInput.style.height = chatInput.scrollHeight + "px";
                }
                hideSlashMenu();
            });

            menu.appendChild(row);
        });

        // Insert menu into input container
        var inputContainer = document.querySelector(".repl-input-box-container");
        if (inputContainer) {
            inputContainer.style.position = "relative";
            inputContainer.appendChild(menu);
        }

        slashMenu = menu;
        return menu;
    }

    function showSlashMenu(filter) {
        var menu = createSlashMenu();
        var items = menu.querySelectorAll(".repl-slash-menu-item");
        var hasVisible = false;
        items.forEach(function(item) {
            var cmd = item.getAttribute("data-cmd");
            if (!filter || cmd.indexOf(filter) === 0) {
                item.style.display = "flex";
                hasVisible = true;
            } else {
                item.style.display = "none";
            }
        });
        if (hasVisible) {
            menu.style.display = "block";
            if (window.lucide) window.lucide.createIcons();
        } else {
            menu.style.display = "none";
        }
    }

    function hideSlashMenu() {
        if (slashMenu) slashMenu.style.display = "none";
    }

    // Listen for slash input
    if (chatInput) {
        chatInput.addEventListener("input", function() {
            var val = chatInput.value;
            if (val.charAt(0) === "/" && val.indexOf(" ") === -1) {
                showSlashMenu(val);
            } else {
                hideSlashMenu();
            }
        });

        chatInput.addEventListener("keydown", function(e) {
            if (slashMenu && slashMenu.style.display !== "none") {
                if (e.key === "Escape") {
                    hideSlashMenu();
                    e.preventDefault();
                    return;
                }
                if (e.key === "Tab") {
                    var first = slashMenu.querySelector('.repl-slash-menu-item[style*="display: flex"], .repl-slash-menu-item:not([style*="display: none"])');
                    if (first) {
                        var cmd = first.getAttribute("data-cmd");
                        chatInput.value = cmd + " ";
                        chatInput.focus();
                        hideSlashMenu();
                    }
                    e.preventDefault();
                    return;
                }
            }
        });
    }

    // Close slash menu on outside click
    document.addEventListener("click", function(e) {
        if (slashMenu && !slashMenu.contains(e.target) && e.target !== chatInput) {
            hideSlashMenu();
        }
    });

    function executeSlashCommand(text) {
        var parts = text.split(" ");
        var cmd = parts[0].toLowerCase();
        var arg = parts.slice(1).join(" ").trim();

        switch (cmd) {
            case "/agent":
            case "/subagent":
                if (window.CodexApp.simulateAutonomousSubagentWorkflow) {
                    window.CodexApp.simulateAutonomousSubagentWorkflow();
                } else {
                    showToast("子智能体模式已激活");
                    // Open agent panel in sidebar
                    var rightSidebar = document.getElementById("right-sidebar");
                    var tabAgents = document.getElementById("rs-tab-agents");
                    if (rightSidebar && rightSidebar.classList.contains("hide-panel")) {
                        rightSidebar.classList.remove("hide-panel");
                        var rightToggle = document.getElementById("sub-sidebar-right-toggle");
                        if (rightToggle) rightToggle.classList.add("active");
                    }
                    if (tabAgents) tabAgents.click();
                }
                return true;

            case "/review":
                var rightSidebar2 = document.getElementById("right-sidebar");
                var tabReview = document.querySelector('[data-target-rs-view="rs-view-details"]');
                if (rightSidebar2 && rightSidebar2.classList.contains("hide-panel")) {
                    rightSidebar2.classList.remove("hide-panel");
                    var rightToggle2 = document.getElementById("sub-sidebar-right-toggle");
                    if (rightToggle2) rightToggle2.classList.add("active");
                }
                if (tabReview) tabReview.click();
                showToast("已打开代码审查面板");
                return true;

            case "/code":
                var rightSidebar3 = document.getElementById("right-sidebar");
                var tabCode = document.getElementById("rs-tab-code");
                if (rightSidebar3 && rightSidebar3.classList.contains("hide-panel")) {
                    rightSidebar3.classList.remove("hide-panel");
                    var rightToggle3 = document.getElementById("sub-sidebar-right-toggle");
                    if (rightToggle3) rightToggle3.classList.add("active");
                }
                if (tabCode) tabCode.click();
                showToast("已打开代码视图");
                return true;

            case "/clear":
                window.CodexApp.ChatHistory = [];
                var feed = getChatFeed();
                if (feed) {
                    var msgs = feed.querySelectorAll(".repl-chat-msg-row");
                    msgs.forEach(function(m) { m.remove(); });
                }
                showToast("对话已清空");
                return true;

            case "/help":
                var helpText = slashCommands.map(function(c) { return c.cmd + " - " + c.desc; }).join("\n");
                appendUserMessage("/help");
                var helpRow = document.createElement("div");
                helpRow.className = "repl-chat-msg-row agent";
                helpRow.innerHTML = '<div class="repl-chat-msg-bubble"><pre style="white-space:pre-wrap;font-size:12px;line-height:1.6;color:var(--text-secondary);font-family:var(--font-mono);">' + helpText + '</pre></div>';
                var feed2 = getChatFeed();
                var sug2 = feed2 ? feed2.querySelector(".repl-suggestions-panel") : null;
                if (sug2) feed2.insertBefore(helpRow, sug2);
                else if (feed2) feed2.appendChild(helpRow);
                scrollToBottom();
                return true;

            case "/settings":
                var settingsModal = document.getElementById("settings-modal");
                if (settingsModal) {
                    settingsModal.classList.add("active");
                    showToast("已打开设置面板");
                }
                return true;

            case "/theme":
                if (window.CodexApp.toggleTheme) {
                    window.CodexApp.toggleTheme();
                } else {
                    var html = document.documentElement;
                    var current = html.getAttribute("data-theme");
                    html.setAttribute("data-theme", current === "light" ? "dark" : "light");
                    showToast("主题已切换");
                }
                return true;

            default:
                return false;
        }
    }

    function sendMessage() {
        if (!chatInput) return;
        var text = chatInput.value.trim();
        if (!text) {
            showToast("请在输入框中写下你的指令。");
            return;
        }

        if (currentRequest) {
            currentRequest.abort();
            currentRequest = null;
        }

        // Slash command handling
        if (text.charAt(0) === "/") {
            chatInput.value = "";
            chatInput.style.height = "auto";
            hideSlashMenu();
            var handled = executeSlashCommand(text);
            if (handled) return;
            // If not recognized, fall through to send as normal message
        }

        appendUserMessage(text);

        window.CodexApp.ChatHistory.push({ role: "user", content: text });

        chatInput.value = "";
        chatInput.style.height = "auto";
        chatInput.disabled = true;
        chatInput.style.opacity = "0.6";
        chatInput.placeholder = "AI 正在回复中...";

        var ui = createAssistantMessage();
        if (!ui) return;

        var config = window.CodexApp.ConfigManager ? window.CodexApp.ConfigManager.get() : {};
        var apiConfig = config.api || {};
        var messages = [];

        if (apiConfig.systemPrompt) {
            messages.push({ role: "system", content: apiConfig.systemPrompt });
        }
        messages = messages.concat(window.CodexApp.ChatHistory);

        var client = window.CodexApp.MimoClient;
        if (!client) {
            ui.contentEl.textContent = "API 客户端未加载，请检查 js/api.js 是否正确引入。";
            ui.statusEl.innerHTML = '<span style="color:#ef4444;">连接失败</span>';
            restoreInput();
            return;
        }

        currentRequest = client.sendChat(messages, {
            onReasoning: function(chunk, full) {
                ui.reasoningBlock.style.display = "block";
                ui.reasoningContent.textContent = full;
                scrollToBottom();
            },
            onContent: function(chunk, full) {
                ui.contentEl.textContent = full;
                scrollToBottom();
            },
            onComplete: function(result) {
                window.CodexApp.ChatHistory.push({ role: "assistant", content: result.content });
                if (result.reasoningContent) {
                    window.CodexApp.ChatHistory[window.CodexApp.ChatHistory.length - 1].reasoning_content = result.reasoningContent;
                }
                ui.statusEl.innerHTML = '<span style="color:var(--text-dark);">生成完毕</span>';
                restoreInput();
                currentRequest = null;
            },
            onError: function(err) {
                ui.contentEl.textContent = "请求失败: " + err.message;
                ui.contentEl.style.color = "#ef4444";
                ui.statusEl.innerHTML = '<span style="color:#ef4444;">请求出错</span>';
                restoreInput();
                currentRequest = null;
            },
            onAbort: function() {
                ui.statusEl.innerHTML = '<span style="color:#d97706;">已中止</span>';
                restoreInput();
                currentRequest = null;
            }
        }, config);
    }

    function restoreInput() {
        if (chatInput) {
            chatInput.disabled = false;
            chatInput.style.opacity = "1";
            chatInput.placeholder = "输入消息，或按 '/' 触发命令...";
            chatInput.focus();
        }
    }

    if (sendBtn) sendBtn.addEventListener("click", sendMessage);
    if (chatInput) {
        chatInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    // 3. Interactive Suggestion Cards (Click to fill prompt)
    const suggestionCards = document.querySelectorAll(".repl-suggestion-card");
    suggestionCards.forEach(card => {
        card.addEventListener("click", () => {
            const promptText = card.getAttribute("data-prompt");
            if (promptText && chatInput) {
                chatInput.value = promptText;
                chatInput.style.height = "auto";
                chatInput.style.height = (chatInput.scrollHeight) + "px";
                chatInput.focus();
                showToast("已自动加载建议提示词。");
            }
        });
    });

    // 4. Interactive Monospaced Logs (Three-Tier Terminal Toggles) via Global Event Delegation
    document.addEventListener("click", (e) => {
        // Handle repl-tool-header clicks
        const toolHeader = e.target.closest(".repl-tool-header");
        if (toolHeader) {
            const group = toolHeader.closest(".repl-tool-group");
            const body = group ? group.querySelector(".repl-tool-body") : null;
            const arrow = toolHeader.querySelector(".repl-tool-arrow");
            
            if (body) {
                const isCollapsed = body.classList.toggle("collapsed");
                const arrowIcon = arrow ? arrow.querySelector("i") : null;
                
                if (arrowIcon) {
                    if (isCollapsed) {
                        arrowIcon.setAttribute("data-lucide", "chevron-right");
                    } else {
                        arrowIcon.setAttribute("data-lucide", "chevron-down");
                    }
                    if (window.lucide && arrow) {
                        window.lucide.createIcons({
                            attrs: { style: 'width: 14px; height: 14px; stroke-width: 2.2px;' },
                            nameAttr: 'data-lucide',
                            node: arrow
                        });
                    }
                }
                showToast(`终端步骤：已${isCollapsed ? "折叠" : "展开"}`);
            }
            return;
        }

        // Handle repl-tool-cmd-header clicks
        const cmdHeader = e.target.closest(".repl-tool-cmd-header");
        if (cmdHeader) {
            const cmdRow = cmdHeader.closest(".repl-tool-cmd-row");
            const output = cmdRow ? cmdRow.querySelector(".repl-tool-cmd-output") : null;
            const arrow = cmdHeader.querySelector(".repl-tool-cmd-arrow");
            
            if (output) {
                const isCollapsed = output.classList.toggle("collapsed");
                const arrowIcon = arrow ? arrow.querySelector("i") : null;
                
                if (arrowIcon) {
                    if (isCollapsed) {
                        arrowIcon.setAttribute("data-lucide", "chevron-right");
                    } else {
                        arrowIcon.setAttribute("data-lucide", "chevron-down");
                    }
                    if (window.lucide && arrow) {
                        window.lucide.createIcons({
                            attrs: { style: 'width: 14px; height: 14px; stroke-width: 2px;' },
                            nameAttr: 'data-lucide',
                            node: arrow
                        });
                    }
                }
                showToast(`输出：已${isCollapsed ? "折叠" : "展开"}`);
            }
            return;
        }
    });

    // 5. Code Preview Tab Actions
    const copyCodeBtn = document.getElementById("code-copy-btn");
    if (copyCodeBtn) {
        copyCodeBtn.addEventListener("click", () => {
            const codeText = `document.addEventListener("DOMContentLoaded", () => {\n    // 1. Initialize Lucide Icons\n    lucide.createIcons();\n...`;
            navigator.clipboard.writeText(codeText)
                .then(() => {
                    showToast("已复制到剪贴板");
                })
                .catch(() => {
                    showToast("复制失败");
                });
        });
    }

    const fsCodeBtn = document.getElementById("code-fullscreen-btn");
    if (fsCodeBtn) {
        fsCodeBtn.addEventListener("click", () => {
            showToast("已全屏锁定");
        });
    }

    // 立即运行极简 Popover 与工具审批控制引擎
    if (window.CodexApp.initChatInteractiveInteractions) {
        window.CodexApp.initChatInteractiveInteractions();
    }
};

/* 
   ==========================================================================
   CODEX MINIMALIST INTERACTION CONTROLLER (js/chat.js)
   ========================================================================== 
*/

window.CodexApp.initChatInteractiveInteractions = function() {
    const showToast = window.CodexApp.showToast || (() => {});
    
    // ==========================================
    // 1. 输入栏底部动作徽章 Popover 控制（纯稳定版）
    // ==========================================
    const badges = {
        attach: { btn: document.getElementById("btn-attach"), pop: document.getElementById("popover-attach") },
        access: { btn: document.getElementById("btn-access"), pop: document.getElementById("popover-access") },
        model: { btn: document.getElementById("btn-model"), pop: document.getElementById("popover-model") },
        temp: { btn: document.getElementById("btn-temp"), pop: document.getElementById("popover-temp") }
    };

    function closeAllPopovers() {
        Object.values(badges).forEach(item => {
            if (item.pop) item.pop.classList.add("hidden");
        });
    }

    // 点击按钮切换状态，瞬间响应
    Object.entries(badges).forEach(([key, item]) => {
        if (item.btn && item.pop) {
            item.btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const isHidden = item.pop.classList.contains("hidden");
                closeAllPopovers();
                if (isHidden) {
                    item.pop.classList.remove("hidden");
                }
            });
        }
    });

    // 点击页面任意空白处，瞬间收拢面板
    document.addEventListener("click", (e) => {
        let clickedInsidePopover = false;
        Object.values(badges).forEach(item => {
            if (item.pop && item.pop.contains(e.target)) {
                clickedInsidePopover = true;
            }
        });
        if (!clickedInsidePopover) {
            closeAllPopovers();
        }
    });

    // 1.1 安全等级切换响应
    const accessRows = document.querySelectorAll("#popover-access .repl-pop-opt-row");
    const mainAccessBadgeText = document.querySelector("#btn-access span");
    accessRows.forEach(row => {
        row.addEventListener("click", () => {
            accessRows.forEach(r => r.classList.remove("active"));
            row.classList.add("active");
            
            const levelName = row.querySelector(".repl-opt-name").textContent.split(" (")[0];
            if (mainAccessBadgeText) {
                mainAccessBadgeText.textContent = levelName;
            }
            showToast(`授权: ${levelName}`);
            closeAllPopovers();
        });
    });

    // 1.2 模型切换响应
    const modelCards = document.querySelectorAll("#popover-model .repl-model-card");
    const mainModelBadge = document.getElementById("btn-model");
    modelCards.forEach(card => {
        card.addEventListener("click", () => {
            modelCards.forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            
            const modelName = card.querySelector(".repl-model-name").textContent.split(" (")[0];
            if (mainModelBadge) {
                mainModelBadge.textContent = modelName;
            }
            showToast(`模型: ${modelName}`);
            closeAllPopovers();
        });
    });

    // 1.3 温度滑块数值实时同步联动（高稳定性）
    const tempSlider = document.getElementById("temp-slider-control");
    const tempSliderLabel = document.getElementById("slider-temp-label");
    const mainTempBadgeText = document.querySelector("#btn-temp span");

    if (tempSlider && tempSliderLabel && mainTempBadgeText) {
        tempSlider.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value).toFixed(1);
            let desc = "平衡";
            if (val <= 0.3) desc = "严格";
            else if (val <= 0.7) desc = "平衡";
            else if (val <= 1.2) desc = "创意";
            else desc = "发散";
            
            tempSliderLabel.textContent = `${val} ${desc}`;
            mainTempBadgeText.textContent = `${val} ${desc}`;
        });
    }

    // ==========================================
    // 2. 输入栏上方工具审批闸门 HUD 控制引擎
    // ==========================================
    const approvalDeck = document.getElementById("tool-approval-deck");
    const deckCommandCode = document.getElementById("tool-deck-command");
    const deckMetaName = document.getElementById("tool-deck-meta-name");
    const chatInputTextarea = document.getElementById("chat-input");
    
    const deckBtnModify = document.getElementById("deck-btn-modify");
    const deckBtnModifyText = document.getElementById("deck-btn-modify-text");
    const deckBtnDeny = document.getElementById("deck-btn-deny");
    const deckBtnApprove = document.getElementById("deck-btn-approve");
    
    const deckModifyWrapper = document.getElementById("deck-modify-wrapper");
    const deckModifyField = document.getElementById("deck-modify-field");
    const toolDeckCodeView = document.getElementById("tool-deck-code-view");

    let activeApprovalResolve = null;

    // 全局工具审批 HUD 触发接口
    window.CodexApp.triggerToolApprovalGate = function(toolName, commandStr) {
        return new Promise((resolve) => {
            if (!approvalDeck) {
                resolve({ approved: true, command: commandStr });
                return;
            }
            activeApprovalResolve = resolve;

            // 写入命令与元数据
            if (deckMetaName) deckMetaName.textContent = `Tool: ${toolName}`;
            if (deckCommandCode) deckCommandCode.textContent = commandStr;
            if (deckModifyField) deckModifyField.value = commandStr;

            // 重设编辑状态为折叠
            if (deckModifyWrapper) deckModifyWrapper.classList.add("hidden");
            if (toolDeckCodeView) toolDeckCodeView.classList.remove("hidden");
            if (deckBtnModifyText) deckBtnModifyText.textContent = "修改参数";

            // 弹出显示，锁定输入区
            approvalDeck.classList.remove("hidden");
            if (chatInputTextarea) {
                chatInputTextarea.disabled = true;
                chatInputTextarea.style.opacity = "0.6";
                chatInputTextarea.placeholder = "等待工具审批授权中...";
            }
        });
    };

    // 允许按钮
    if (deckBtnApprove) {
        deckBtnApprove.addEventListener("click", () => {
            if (activeApprovalResolve) {
                const finalCmd = deckModifyField ? deckModifyField.value : (deckCommandCode ? deckCommandCode.textContent : "");
                activeApprovalResolve({ approved: true, command: finalCmd });
                activeApprovalResolve = null;
            }
            approvalDeck.classList.add("hidden");
            if (chatInputTextarea) {
                chatInputTextarea.disabled = false;
                chatInputTextarea.style.opacity = "1";
                chatInputTextarea.placeholder = "输入消息，或按 '/' 触发命令...";
            }
            showToast("审批通过");
        });
    }

    // 拒绝按钮
    if (deckBtnDeny) {
        deckBtnDeny.addEventListener("click", () => {
            if (activeApprovalResolve) {
                activeApprovalResolve({ approved: false });
                activeApprovalResolve = null;
            }
            approvalDeck.classList.add("hidden");
            if (chatInputTextarea) {
                chatInputTextarea.disabled = false;
                chatInputTextarea.style.opacity = "1";
                chatInputTextarea.placeholder = "输入消息，或按 '/' 触发命令...";
            }
            showToast("已拒绝");
        });
    }

    // 修改参数按钮
    if (deckBtnModify) {
        deckBtnModify.addEventListener("click", () => {
            if (!deckModifyWrapper || !toolDeckCodeView) return;
            const isEditing = !deckModifyWrapper.classList.contains("hidden");
            
            if (isEditing) {
                // 编辑中再次点击，保存并运行
                if (deckBtnApprove) deckBtnApprove.click();
            } else {
                // 进入修改状态
                deckModifyWrapper.classList.remove("hidden");
                toolDeckCodeView.classList.add("hidden");
                if (deckBtnModifyText) deckBtnModifyText.textContent = "保存执行";
                if (deckModifyField) deckModifyField.focus();
            }
        });
    }

    // ==========================================
    // 3. 子智能体工具折叠手风琴绑定
    // ==========================================
    window.CodexApp.registerSubagentCollapsible = function(cardId) {
        const card = document.getElementById(cardId);
        if (!card) return;

        const header = card.querySelector(".repl-subagent-header");
        const body = card.querySelector(".repl-subagent-body");
        const arrow = card.querySelector(".repl-subagent-arrow-icon");

        if (header && body && arrow) {
            header.addEventListener("click", () => {
                const isCollapsed = card.classList.toggle("collapsed-agent");
                if (isCollapsed) {
                    arrow.classList.remove("expanded");
                } else {
                    arrow.classList.add("expanded");
                    setTimeout(() => {
                        body.scrollTop = body.scrollHeight;
                    }, 50);
                }
            });
        }
    };

    // 初始化注册当前存在的子 Agent
    document.querySelectorAll(".repl-subagent-card").forEach(card => {
        if (card.id) window.CodexApp.registerSubagentCollapsible(card.id);
    });
};

/* 
   ==========================================================================
   SUB-AGENT ACTIVE SIMULATION WORKFLOW
   ========================================================================== 
*/
window.CodexApp.simulateAutonomousSubagentWorkflow = function() {
    const chatFeed = document.querySelector("#main-chat-view .repl-chat-feed");
    if (!chatFeed) return;
    const showToast = window.CodexApp.showToast || (() => {});

    // 1. 创建子智能体卡片（开始为展开状态且运行中）
    const cardId = `agent-card-${Date.now()}`;
    const cardHTML = `
        <div class="repl-subagent-card" id="${cardId}">
            <div class="repl-subagent-header">
                <div class="repl-subagent-header-left">
                    <span class="repl-subagent-status-dot running" id="dot-${cardId}"></span>
                    <span class="repl-subagent-name">子任务: zo2api 端口审计</span>
                    <span class="repl-subagent-step-desc" id="desc-${cardId}">子任务已派发，正在验证本地配置...</span>
                </div>
                <div class="repl-subagent-header-right">
                    <span class="repl-subagent-arrow-icon expanded" id="arrow-${cardId}"><i data-lucide="chevron-down"></i></span>
                </div>
            </div>
            <div class="repl-subagent-body" id="body-${cardId}">
                <div class="repl-subagent-scroll-viewport" id="viewport-${cardId}">
                    <div class="repl-subagent-cot">
                        <i data-lucide="brain"></i>
                        <span>思考: 主任务需要连接 mail.flowbit，我需要抓取其配置文件以确认其协议握手端口。</span>
                    </div>
                </div>
            </div>
        </div>
    `;

    const chatRow = document.createElement("div");
    chatRow.className = "repl-chat-msg-row agent";
    chatRow.style.alignSelf = "center";
    chatRow.innerHTML = `
        <div class="repl-msg-avatar"><i data-lucide="bot"></i></div>
        <div class="repl-msg-content-wrapper">
            <div class="repl-msg-bubble markdown-body">
                正在委派子智能体检查运行环境...
                ${cardHTML}
            </div>
        </div>
    `;
    
    chatFeed.appendChild(chatRow);
    if (window.lucide) window.lucide.createIcons();

    // 注册卡片的手动收起展开事件
    window.CodexApp.registerSubagentCollapsible(cardId);

    const viewport = document.getElementById(`viewport-${cardId}`);
    const dot = document.getElementById(`dot-${cardId}`);
    const desc = document.getElementById(`desc-${cardId}`);
    const cardElement = document.getElementById(cardId);
    const arrowElement = document.getElementById(`arrow-${cardId}`);

    // 2. 1.2秒后，子 Agent 触发一个工具调用，并拦截由审批闸口进行安全处理
    setTimeout(() => {
        if (!viewport) return;
        desc.textContent = "正在调用探测工具...";
        
        const toolDiv = document.createElement("div");
        toolDiv.className = "repl-sub-tool-block";
        toolDiv.innerHTML = `
            <div class="repl-sub-tool-title">bash: mail-probe --target=mail.flowbit.com</div>
            <pre class="repl-sub-tool-output">Awaiting authorization in main input approval deck...</pre>
            <div class="repl-sub-tool-status" id="tool-status-${cardId}" style="color: #d97706;">
                等待授权
            </div>
        `;
        viewport.appendChild(toolDiv);

        // 3. 呼出审批闸口
        window.CodexApp.triggerToolApprovalGate("mail-probe", "mail-probe --target=mail.flowbit.com --port=465 --secure=true")
            .then((result) => {
                const toolOutput = toolDiv.querySelector(".repl-sub-tool-output");
                const toolStatus = document.getElementById(`tool-status-${cardId}`);
                
                if (result.approved) {
                    // 执行成功
                    toolOutput.innerHTML = `Running command: ${result.command}\nConnection handshake: SECURE PORT 465 VERIFIED.\nMX Records: mx1.flowbit.com [Priority: 10]`;
                    toolStatus.innerHTML = '<i data-lucide="check-circle" style="width: 11px; height: 11px;"></i><span>成功</span>';
                    toolStatus.style.color = "#16a34a";
                    
                    // 4. 任务圆满结束，工具行自动收折坍塌
                    setTimeout(() => {
                        desc.textContent = "运行完成 (耗时 3.4s)";
                        if (dot) {
                            dot.className = "repl-subagent-status-dot completed";
                        }
                        if (cardElement) {
                            cardElement.classList.add("collapsed-agent");
                        }
                        if (arrowElement) {
                            arrowElement.classList.remove("expanded");
                        }
                        showToast("子任务处理完毕，已自动折叠收合。");
                    }, 1200);

                } else {
                    // 拒绝运行
                    toolOutput.textContent = "Aborted: Execution denied by user.";
                    toolStatus.innerHTML = '已拒绝';
                    toolStatus.style.color = "#dc2626";
                    
                    setTimeout(() => {
                        desc.textContent = "运行已中断";
                        if (dot) dot.style.backgroundColor = "#dc2626";
                    }, 1000);
                }
                if (window.lucide) window.lucide.createIcons();
            });

    }, 1200);
};
