/* 
   ==========================================================================
   CODEX SUB-AGENTS SYSTEM (subagents.js)
   Inline agent pills + Floating panel + Right sidebar agent panel with input
   ========================================================================== 
*/

window.CodexApp = window.CodexApp || {};

window.CodexApp.initSubAgents = function() {
    const showToast = window.CodexApp.showToast || (() => {});
    if (window.CodexApp.__subAgentsInitialized) return;
    window.CodexApp.__subAgentsInitialized = true;

    const rightSidebar = document.getElementById("right-sidebar");
    const tabAgents = document.getElementById("rs-tab-agents");

    // Floating agent panel container
    let floatingAgentPanel = null;
    let floatingPanelTimer = null;

    function openRightSidebarAgent(agentId, agentName) {
        // Open right sidebar
        if (rightSidebar && rightSidebar.classList.contains("hide-panel")) {
            rightSidebar.classList.remove("hide-panel");
            const rightToggle = document.getElementById("sub-sidebar-right-toggle");
            if (rightToggle) rightToggle.classList.add("active");
        }
        // Switch to Agents tab
        if (tabAgents) tabAgents.click();
        // Activate the corresponding agent tab
        const agentTab = document.querySelector(`.repl-agent-tab[data-agent-id="${agentId}"]`);
        if (agentTab) agentTab.click();
        showToast(`已打开子智能体: ${agentName}`);
    }

    function openFloatingAgentPanel(agentId, agentName, anchorEl) {
        // Remove existing floating panel
        closeFloatingPanel();

        const rect = anchorEl.getBoundingClientRect();
        const panel = document.createElement("div");
        panel.className = "repl-floating-agent-panel";
        panel.style.cssText = `
            position: fixed;
            top: ${rect.bottom + 6}px;
            left: ${rect.left}px;
            width: 340px;
            max-height: 420px;
            background-color: var(--bg-popup, #1a1a1e);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid var(--border-card);
            border-radius: 10px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.4);
            z-index: var(--z-popover, 100);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            animation: floatPanelIn 0.15s ease;
        `;
        panel.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--border-divider);">
                <div style="display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--text-secondary);">
                    <span class="repl-agent-status-dot active"></span>
                    ${agentName}
                </div>
                <button class="repl-floating-panel-pin" title="固定到侧边栏" style="background:transparent; border:none; cursor:pointer; color:var(--text-dim); display:flex; align-items:center; padding:2px;">
                    <i data-lucide="panel-right" style="width:13px; height:13px;"></i>
                </button>
            </div>
            <div class="repl-floating-agent-messages" style="flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; min-height:120px;">
                <div class="repl-agent-msg agent"><div class="repl-agent-msg-bubble">子智能体 ${agentName} 已就绪，等待指令...</div></div>
            </div>
            <div style="padding:6px 8px; border-top:1px solid var(--border-divider);">
                <div class="repl-agent-input-row">
                    <textarea class="repl-agent-input" placeholder="发送补充指令..." rows="1"></textarea>
                    <button class="repl-agent-send-btn" title="发送"><i data-lucide="arrow-up"></i></button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);
        floatingAgentPanel = panel;

        if (window.lucide) window.lucide.createIcons();

        // Pin to sidebar button
        const pinBtn = panel.querySelector(".repl-floating-panel-pin");
        if (pinBtn) {
            pinBtn.addEventListener("click", () => {
                closeFloatingPanel();
                openRightSidebarAgent(agentId, agentName);
            });
        }

        // Input handling in floating panel
        const floatInput = panel.querySelector(".repl-agent-input");
        const floatSend = panel.querySelector(".repl-agent-send-btn");
        const floatMsgs = panel.querySelector(".repl-floating-agent-messages");

        function sendFloatingMsg() {
            if (!floatInput) return;
            const text = floatInput.value.trim();
            if (!text) return;
            const userMsg = document.createElement("div");
            userMsg.className = "repl-agent-msg user";
            userMsg.innerHTML = `<div class="repl-agent-msg-bubble">${escapeHtml(text)}</div>`;
            floatMsgs.appendChild(userMsg);
            floatInput.value = "";
            floatInput.style.height = "auto";
            floatMsgs.scrollTop = floatMsgs.scrollHeight;
            // Simulated response
            setTimeout(() => {
                const aMsg = document.createElement("div");
                aMsg.className = "repl-agent-msg agent";
                aMsg.innerHTML = `<div class="repl-agent-msg-bubble">收到: "${escapeHtml(text)}"</div>`;
                floatMsgs.appendChild(aMsg);
                floatMsgs.scrollTop = floatMsgs.scrollHeight;
            }, 400);
        }

        if (floatSend) floatSend.addEventListener("click", sendFloatingMsg);
        if (floatInput) {
            floatInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFloatingMsg(); }
            });
            floatInput.addEventListener("input", () => {
                floatInput.style.height = "auto";
                floatInput.style.height = Math.min(floatInput.scrollHeight, 60) + "px";
            });
        }

        // Auto-close timer: 4 seconds, reset on mouse enter
        resetFloatingPanelTimer();
        panel.addEventListener("mouseenter", () => { clearTimeout(floatingPanelTimer); });
        panel.addEventListener("mouseleave", () => { resetFloatingPanelTimer(); });
    }

    function resetFloatingPanelTimer() {
        clearTimeout(floatingPanelTimer);
        floatingPanelTimer = setTimeout(() => { closeFloatingPanel(); }, 4000);
    }

    function closeFloatingPanel() {
        if (floatingAgentPanel) {
            floatingAgentPanel.remove();
            floatingAgentPanel = null;
        }
        clearTimeout(floatingPanelTimer);
    }

    // 1. Agent pill button actions
    const agentPills = document.querySelectorAll(".repl-agent-pill");
    agentPills.forEach(pill => {
        const agentId = pill.getAttribute("data-agent-id");
        const agentName = pill.getAttribute("data-agent-name");

        // Float action icon
        const floatIcon = pill.querySelector(".pill-action-float");
        if (floatIcon) {
            floatIcon.addEventListener("click", (e) => {
                e.stopPropagation();
                openFloatingAgentPanel(agentId, agentName, pill);
            });
        }

        // Sidebar action icon
        const sidebarIcon = pill.querySelector(".pill-action-sidebar");
        if (sidebarIcon) {
            sidebarIcon.addEventListener("click", (e) => {
                e.stopPropagation();
                closeFloatingPanel();
                openRightSidebarAgent(agentId, agentName);
            });
        }

        // Default click on pill -> open in sidebar
        pill.addEventListener("click", () => {
            closeFloatingPanel();
            openRightSidebarAgent(agentId, agentName);
        });
    });

    // Close floating panel on outside click
    document.addEventListener("mousedown", (e) => {
        if (floatingAgentPanel && !floatingAgentPanel.contains(e.target)) {
            const isPillAction = e.target.closest(".pill-action-float") || e.target.closest(".pill-action-sidebar");
            if (!isPillAction) closeFloatingPanel();
        }
    });

    // 2. Agent panel tab switching
    const agentTabs = document.querySelectorAll(".repl-agent-tab");
    agentTabs.forEach(tab => {
        tab.addEventListener("click", () => {
            agentTabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            // In a real app, this would load the specific agent's conversation
            // For now, just switch the active tab visual
        });
    });

    // 3. Agent panel input handling
    const agentInput = document.getElementById("agent-panel-input");
    const agentSendBtn = document.getElementById("agent-panel-send");
    const agentMessages = document.getElementById("agent-panel-messages");

    function sendAgentMessage() {
        if (!agentInput || !agentMessages) return;
        const text = agentInput.value.trim();
        if (!text) return;

        // Add user message
        const userMsg = document.createElement("div");
        userMsg.className = "repl-agent-msg user";
        userMsg.innerHTML = `<div class="repl-agent-msg-bubble">${escapeHtml(text)}</div>`;
        agentMessages.appendChild(userMsg);

        agentInput.value = "";
        agentInput.style.height = "auto";

        // Simulate agent response (in real app, this would call the API)
        setTimeout(() => {
            const agentMsg = document.createElement("div");
            agentMsg.className = "repl-agent-msg agent";
            agentMsg.innerHTML = `<div class="repl-agent-msg-bubble">收到指令，正在处理: "${escapeHtml(text)}"</div>`;
            agentMessages.appendChild(agentMsg);
            agentMessages.scrollTop = agentMessages.scrollHeight;
        }, 600);

        agentMessages.scrollTop = agentMessages.scrollHeight;
    }

    if (agentSendBtn) {
        agentSendBtn.addEventListener("click", sendAgentMessage);
    }

    if (agentInput) {
        agentInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendAgentMessage();
            }
        });

        // Auto-resize textarea
        agentInput.addEventListener("input", () => {
            agentInput.style.height = "auto";
            agentInput.style.height = Math.min(agentInput.scrollHeight, 80) + "px";
        });
    }

    // 4. Tool collapse/expand handlers (for agent panel tool groups)
    document.addEventListener("click", (e) => {
        const toolHeader = e.target.closest(".repl-tool-header");
        if (toolHeader) {
            const toolBody = toolHeader.nextElementSibling;
            if (toolBody && toolBody.classList.contains("repl-tool-body")) {
                toolBody.classList.toggle("collapsed");
                const arrow = toolHeader.querySelector(".repl-tool-arrow");
                if (arrow) arrow.classList.toggle("expanded");
            }
            return;
        }

        const cmdHeader = e.target.closest(".repl-tool-cmd-header");
        if (cmdHeader) {
            const cmdOutput = cmdHeader.nextElementSibling;
            if (cmdOutput && cmdOutput.classList.contains("repl-tool-cmd-output")) {
                cmdOutput.classList.toggle("collapsed");
            }
        }
    });

    // Helper: escape HTML
    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // 5. Code change summary button -> float or sidebar
    const codeChangeBtn = document.getElementById("code-change-summary-btn");
    const tabReview = document.querySelector('[data-target-rs-view="rs-view-details"]');
    let floatingReviewPanel = null;
    let floatingReviewTimer = null;

    function openReviewInSidebar() {
        if (rightSidebar && rightSidebar.classList.contains("hide-panel")) {
            rightSidebar.classList.remove("hide-panel");
            const rightToggle = document.getElementById("sub-sidebar-right-toggle");
            if (rightToggle) rightToggle.classList.add("active");
        }
        if (tabReview) tabReview.click();
        showToast("已打开代码改动审查面板");
    }

    function openReviewFloating(anchorEl) {
        closeFloatingReviewPanel();
        const rect = anchorEl.getBoundingClientRect();
        const panel = document.createElement("div");
        panel.className = "repl-floating-review-panel";
        panel.style.cssText = `
            position: fixed;
            top: ${rect.bottom + 6}px;
            left: ${Math.max(rect.left, 8)}px;
            width: 380px;
            max-height: 460px;
            background-color: var(--bg-popup, #1a1a1e);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid var(--border-card);
            border-radius: 10px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.4);
            z-index: var(--z-popover, 100);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            animation: floatPanelIn 0.15s ease;
        `;
        panel.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--border-divider);">
                <div style="font-size:12px; font-weight:600; color:var(--text-secondary);">
                    <i data-lucide="file-diff" style="width:12px;height:12px;display:inline;vertical-align:middle;"></i>
                    代码改动 <span style="color:#10b981;font-weight:700;">+85</span> <span style="color:#ef4444;font-weight:700;">-16</span>
                </div>
                <button class="repl-floating-review-pin" title="固定到侧边栏" style="background:transparent; border:none; cursor:pointer; color:var(--text-dim); display:flex; align-items:center; padding:2px;">
                    <i data-lucide="panel-right" style="width:13px; height:13px;"></i>
                </button>
            </div>
            <div style="flex:1; overflow-y:auto; padding:6px;">
                <div style="display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:6px; background:rgba(255,255,255,0.02); margin-bottom:3px; cursor:pointer; font-size:11px; color:var(--text-secondary);">
                    <span style="color:#10b981; font-weight:600; font-family:var(--font-mono);">+85 -0</span>
                    <span>styles.css</span>
                </div>
                <div style="display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:6px; background:rgba(255,255,255,0.02); margin-bottom:3px; cursor:pointer; font-size:11px; color:var(--text-secondary);">
                    <span style="color:#10b981; font-weight:600; font-family:var(--font-mono);">+24 -14</span>
                    <span>index.html</span>
                </div>
                <div style="display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:6px; background:rgba(255,255,255,0.02); margin-bottom:3px; cursor:pointer; font-size:11px; color:var(--text-secondary);">
                    <span style="color:#10b981; font-weight:600; font-family:var(--font-mono);">+4 -2</span>
                    <span>App_UI_v6.jsx</span>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        floatingReviewPanel = panel;
        if (window.lucide) window.lucide.createIcons();

        const pinBtn = panel.querySelector(".repl-floating-review-pin");
        if (pinBtn) {
            pinBtn.addEventListener("click", () => {
                closeFloatingReviewPanel();
                openReviewInSidebar();
            });
        }

        resetFloatingReviewTimer();
        panel.addEventListener("mouseenter", () => { clearTimeout(floatingReviewTimer); });
        panel.addEventListener("mouseleave", () => { resetFloatingReviewTimer(); });
    }

    function resetFloatingReviewTimer() {
        clearTimeout(floatingReviewTimer);
        floatingReviewTimer = setTimeout(() => { closeFloatingReviewPanel(); }, 4000);
    }

    function closeFloatingReviewPanel() {
        if (floatingReviewPanel) {
            floatingReviewPanel.remove();
            floatingReviewPanel = null;
        }
        clearTimeout(floatingReviewTimer);
    }

    if (codeChangeBtn) {
        // Float action icon
        const floatIcon = codeChangeBtn.querySelector(".change-action-float");
        if (floatIcon) {
            floatIcon.addEventListener("click", (e) => {
                e.stopPropagation();
                openReviewFloating(codeChangeBtn);
            });
        }

        // Sidebar action icon
        const sidebarIcon = codeChangeBtn.querySelector(".change-action-sidebar");
        if (sidebarIcon) {
            sidebarIcon.addEventListener("click", (e) => {
                e.stopPropagation();
                closeFloatingReviewPanel();
                openReviewInSidebar();
            });
        }

        // Default click -> sidebar
        codeChangeBtn.addEventListener("click", (e) => {
            if (e.target.closest(".change-action-float") || e.target.closest(".change-action-sidebar")) return;
            closeFloatingReviewPanel();
            openReviewInSidebar();
        });
    }

    // Close floating review panel on outside click
    document.addEventListener("mousedown", (e) => {
        if (floatingReviewPanel && !floatingReviewPanel.contains(e.target)) {
            const isChangeAction = e.target.closest(".change-action-float") || e.target.closest(".change-action-sidebar");
            if (!isChangeAction) closeFloatingReviewPanel();
        }
    });

    // 6. Diff file card collapse/expand + revert
    document.addEventListener("click", (e) => {
        // Revert button
        const revertBtn = e.target.closest(".repl-diff-revert-btn");
        if (revertBtn) {
            e.stopPropagation();
            const card = revertBtn.closest(".repl-diff-file-card");
            if (card) {
                const fileName = card.querySelector(".repl-diff-file-name");
                const name = fileName ? fileName.textContent.trim() : "此文件";
                card.style.opacity = "0.4";
                card.style.pointerEvents = "none";
                showToast(`已撤销 ${name} 的改动`);
            }
            return;
        }

        // Toggle collapse on header click
        const diffHeader = e.target.closest(".repl-diff-file-header");
        if (diffHeader) {
            const card = diffHeader.closest(".repl-diff-file-card");
            if (card) {
                card.classList.toggle("collapsed");
            }
        }
    });

    // 7. Code comment on selection in diff blocks
    let activeCommentPopup = null;

    document.addEventListener("mouseup", (e) => {
        // Only act on selections inside diff code blocks
        const diffBlock = e.target.closest(".repl-diff-code-block");
        if (!diffBlock) return;

        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        // Remove existing popup if clicking elsewhere
        if (activeCommentPopup) {
            activeCommentPopup.remove();
            activeCommentPopup = null;
        }

        if (!selectedText || selectedText.length < 2) return;

        // Get position for popup
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const diffRect = diffBlock.getBoundingClientRect();

        // Create comment popup
        const popup = document.createElement("div");
        popup.className = "repl-code-comment-popup";
        popup.style.left = (rect.left - diffRect.left + diffBlock.offsetLeft) + "px";
        popup.style.top = (rect.bottom - diffRect.top + diffBlock.offsetTop + 4) + "px";

        popup.innerHTML = `
            <textarea placeholder="添加评论..." rows="2"></textarea>
            <div class="repl-code-comment-popup-actions">
                <button class="repl-comment-cancel-btn">取消</button>
                <button class="repl-comment-submit-btn">提交</button>
            </div>
        `;

        diffBlock.style.position = "relative";
        diffBlock.appendChild(popup);
        activeCommentPopup = popup;

        const textarea = popup.querySelector("textarea");
        const cancelBtn = popup.querySelector(".repl-comment-cancel-btn");
        const submitBtn = popup.querySelector(".repl-comment-submit-btn");

        textarea.focus();

        cancelBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            popup.remove();
            activeCommentPopup = null;
        });

        submitBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const commentText = textarea.value.trim();
            if (!commentText) return;

            // Insert inline comment after the selection
            const commentEl = document.createElement("div");
            commentEl.className = "repl-diff-inline-comment";
            commentEl.innerHTML = `<span class="comment-icon"><i data-lucide="message-square" style="width:12px;height:12px;"></i></span><span class="comment-text"><strong>评论:</strong> ${escapeHtml(commentText)}</span>`;

            // Find the code element to insert after
            const codeEl = diffBlock.querySelector("code") || diffBlock.querySelector("pre");
            if (codeEl) {
                codeEl.appendChild(commentEl);
            } else {
                diffBlock.appendChild(commentEl);
            }

            // Re-initialize lucide icons for the new element
            if (window.lucide) window.lucide.createIcons();

            // Store comment + code for next input
            const pendingComments = window.CodexApp.__pendingComments || [];
            pendingComments.push({
                code: selectedText,
                comment: commentText
            });
            window.CodexApp.__pendingComments = pendingComments;

            popup.remove();
            activeCommentPopup = null;
            window.getSelection().removeAllRanges();

            showToast("评论已添加，将在下次对话中一并发送");
        });
    });

    // Close comment popup on outside click
    document.addEventListener("mousedown", (e) => {
        if (activeCommentPopup && !activeCommentPopup.contains(e.target)) {
            activeCommentPopup.remove();
            activeCommentPopup = null;
        }
    });

    // 8. File tree click handler in code panel
    const fileTreeItems = document.querySelectorAll(".repl-file-tree-item");
    const codeCurrentFile = document.getElementById("code-current-file");
    const codeContentArea = document.getElementById("code-content-area");

    fileTreeItems.forEach(item => {
        item.addEventListener("click", () => {
            // Update active state
            fileTreeItems.forEach(i => i.classList.remove("active"));
            item.classList.add("active");

            const fileName = item.getAttribute("data-file");
            if (codeCurrentFile) {
                codeCurrentFile.innerHTML = `${escapeHtml(fileName)} <span class="repl-code-file-folder">replicate_ui</span>`;
            }

            // Update tab label
            const tabCode = document.getElementById("rs-tab-code");
            if (tabCode) {
                const tabSpan = tabCode.querySelector("span:last-of-type");
                if (tabSpan) tabSpan.textContent = fileName;
            }

            showToast(`已切换到: ${fileName}`);
        });
    });
};
