/* 
   ==========================================================================
   CODEX COLLAPSIBLE INTERACTIVE LAYOUTS CONTROLLER (collapsers.js)
   ========================================================================== 
*/

window.CodexApp = window.CodexApp || {};

window.CodexApp.initCollapsers = function() {
    const showToast = window.CodexApp.showToast || (() => {});
    const mainSidebar = window.CodexApp.mainSidebar || document.querySelector(".repl-sidebar");
    const rightSidebar = window.CodexApp.rightSidebar || document.getElementById("right-sidebar");

    // 1. Folder Tree Expand / Collapse Toggles
    const treeNodes = document.querySelectorAll(".repl-tree-node");
    treeNodes.forEach(node => {
        node.addEventListener("click", () => {
            const targetId = node.getAttribute("data-target");
            const childrenContainer = document.getElementById(targetId);
            const arrow = node.querySelector(".repl-tree-node-arrow");
            const iconSpan = node.querySelector(".repl-tree-node-icon");
            
            if (childrenContainer) {
                const isCollapsed = childrenContainer.classList.toggle("collapsed");
                
                if (isCollapsed) {
                    if (arrow) arrow.classList.remove("expanded");
                    if (iconSpan) iconSpan.innerHTML = '<i data-lucide="folder"></i>';
                } else {
                    if (arrow) arrow.classList.add("expanded");
                    if (iconSpan) iconSpan.innerHTML = '<i data-lucide="folder-open"></i>';
                }
                
                if (window.lucide && iconSpan) {
                    window.lucide.createIcons({
                        attrs: { style: 'width: 15px; height: 15px; stroke-width: 1.8px;' },
                        nameAttr: 'data-lucide',
                        node: iconSpan
                    });
                }
            }
        });
    });

    const expandBtn = document.querySelector(".repl-expand-btn");
    if (expandBtn) {
        expandBtn.addEventListener("click", () => {
            showToast("工作区历史：已加载全部 24 个历史归稿对话草稿。");
        });
    }

    // Direct items & child items selection
    const directItems = document.querySelectorAll(".repl-sidebar-direct-item, .repl-tree-child-item");
    directItems.forEach(item => {
        item.addEventListener("click", (e) => {
            directItems.forEach(i => i.classList.remove("active"));
            const target = e.target.closest(".repl-sidebar-direct-item, .repl-tree-child-item");
            if (target) {
                target.classList.add("active");
                const titleSpan = target.querySelector(".repl-sidebar-direct-title, .repl-tree-child-title");
                const title = titleSpan ? titleSpan.textContent : "对话草稿";
                showToast(`正在从侧栏加载对话: "${title}"`);
            }
        });
    });

    // 2. Global Main Card Tab Switcher
    const globalTabItems = document.querySelectorAll(".repl-tab-item");
    const globalTabViews = document.querySelectorAll("#main-chat-view .repl-tab-view-panel");

    globalTabItems.forEach(tab => {
        tab.addEventListener("click", () => {
            globalTabItems.forEach(t => t.classList.remove("active"));
            globalTabViews.forEach(v => v.classList.remove("active"));

            tab.classList.add("active");
            const targetViewId = tab.getAttribute("data-target-view");
            const targetView = document.getElementById(targetViewId);
            if (targetView) {
                targetView.classList.add("active");
                const spanNode = tab.querySelector("span:not(.repl-tab-icon)");
                const label = spanNode ? spanNode.textContent.trim() : "主卡片";
                showToast(`主卡片已切换视图: "${label}"`);
            }
        });
    });

    // 3. Right Sidebar Tabs Switcher (Overview, Review, Code, Agents)
    const rsTabItems = document.querySelectorAll(".repl-rs-tab");
    const rsTabViews = document.querySelectorAll(".repl-right-sidebar .repl-rs-view-panel");

    function adjustRsMenuButtonVisibility() {
        const tabsContainer = document.querySelector(".repl-rs-tabs");
        const menuBtn = document.getElementById("rs-menu-btn");
        if (!tabsContainer || !menuBtn) return;
        
        // Measure horizontal overflow: if scrollWidth is greater than clientWidth + 5px tolerance
        const isOverflowing = tabsContainer.scrollWidth > tabsContainer.clientWidth + 5;
        if (isOverflowing) {
            menuBtn.style.display = "flex";
        } else {
            menuBtn.style.display = "none";
        }
    }

    rsTabItems.forEach(tab => {
        tab.addEventListener("click", () => {
            rsTabItems.forEach(t => t.classList.remove("active"));
            rsTabViews.forEach(v => v.classList.remove("active"));

            tab.classList.add("active");
            const targetViewId = tab.getAttribute("data-target-rs-view");
            const targetView = document.getElementById(targetViewId);
            if (targetView) {
                targetView.classList.add("active");
                const spanNode = tab.querySelector("span:not(.repl-tab-icon)");
                const label = spanNode ? spanNode.textContent.trim() : "视图";
                showToast(`右侧面板已切换视图: "${label}"`);
            }
            setTimeout(adjustRsMenuButtonVisibility, 50);
        });
    });

    // 4. Tab Close Handler for code tab (app.js)
    const codeTabCloseBtn = document.getElementById("rs-tab-code-close");
    const codeTab = document.getElementById("rs-tab-code");

    if (codeTabCloseBtn && codeTab) {
        codeTabCloseBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            codeTab.classList.add("hidden-tab");

            if (codeTab.classList.contains("active")) {
                const overviewTab = document.querySelector('.repl-rs-tab[data-target-rs-view="rs-view-overview"]');
                if (overviewTab) {
                    overviewTab.click();
                }
            }
            showToast("已成功关闭 app.js 代码选项卡");
            setTimeout(adjustRsMenuButtonVisibility, 50);
        });
    }

    // 5. Overview Accordions collapsers
    function setupOverviewCollapser(toggleId, bodyId, arrowId, sectionName) {
        const toggle = document.getElementById(toggleId);
        const body = document.getElementById(bodyId);
        const arrow = document.getElementById(arrowId);

        if (toggle && body && arrow) {
            toggle.addEventListener("click", () => {
                const isCollapsed = body.classList.toggle("collapsed");
                if (isCollapsed) {
                    arrow.classList.remove("expanded");
                    arrow.innerHTML = '<i data-lucide="chevron-right"></i>';
                } else {
                    arrow.classList.add("expanded");
                    arrow.innerHTML = '<i data-lucide="chevron-down"></i>';
                }
                
                if (window.lucide) {
                    window.lucide.createIcons({
                        attrs: { style: 'width: 14px; height: 14px; stroke-width: 2.2px;' },
                        nameAttr: 'data-lucide',
                        node: arrow
                    });
                }
                showToast(`总览区折叠：已${isCollapsed ? "收折" : "展开"} ${sectionName} 列表`);
            });
        }
    }

    setupOverviewCollapser("ov-toggle-files", "ov-files-body", "ov-files-arrow", "更改文件 Files Changed");
    setupOverviewCollapser("ov-toggle-artifacts", "ov-artifacts-body", "ov-artifacts-arrow", "制品 Artifacts");
    setupOverviewCollapser("ov-toggle-tasks", "ov-tasks-body", "ov-tasks-arrow", "后台任务 Background Tasks");

    // 6. Interactive Sidebar Collapsible Folding
    const sidebarFoldBtn = document.getElementById("sub-sidebar-toggle");
    if (sidebarFoldBtn && mainSidebar) {
        sidebarFoldBtn.addEventListener("click", () => {
            if (typeof window.CodexApp.clearLeftHover === "function") {
                window.CodexApp.clearLeftHover();
            }
            const isFolded = mainSidebar.classList.toggle("hide-sidebar");
            showToast(`主工作区侧边栏已${isFolded ? "完全折叠收起" : "平滑滑出展开"}`);
        });
    }

    // 7. Navigation arrows click
    const navBack = document.getElementById("sub-nav-back");
    const navForward = document.getElementById("sub-nav-forward");

    if (navBack) navBack.addEventListener("click", () => showToast("审查记录：已返回上一页历史缓存。"));
    if (navForward) navForward.addEventListener("click", () => showToast("审查记录：已前进至下一页历史缓存。"));

    // 8. Right Sidebar collapsible triggers
    const rightSidebarClose = document.getElementById("right-sidebar-close");
    const rightSidebarToggle = document.getElementById("sub-sidebar-right-toggle");
    
    function toggleRightSidebar() {
        if (!rightSidebar) return;
        if (typeof window.CodexApp.clearRightHover === "function") {
            window.CodexApp.clearRightHover();
        }
        const isHidden = rightSidebar.classList.toggle("hide-panel");
        showToast(isHidden ? "右侧多任务面板已平滑收折收起。" : "右侧多任务面板已优雅滑出展开。");
        if (rightSidebarToggle) rightSidebarToggle.classList.toggle("active", !isHidden);
    }

    const subInfo = document.getElementById("sub-info");
    if (subInfo) {
        subInfo.addEventListener("click", () => {
            if (!rightSidebar) return;
            if (typeof window.CodexApp.clearRightHover === "function") {
                window.CodexApp.clearRightHover();
            }
            const isHidden = rightSidebar.classList.contains("hide-panel");
            if (isHidden) {
                rightSidebar.classList.remove("hide-panel");
                if (rightSidebarToggle) rightSidebarToggle.classList.add("active");
                showToast("会话详情：右侧多任务面板已滑出。");
            }
            const overviewTab = document.querySelector('.repl-rs-tab[data-target-rs-view="rs-view-overview"]');
            if (overviewTab) {
                overviewTab.click();
            }
        });
    }
    
    if (rightSidebarToggle) rightSidebarToggle.addEventListener("click", toggleRightSidebar);
    
    if (rightSidebarClose && rightSidebar) {
        rightSidebarClose.addEventListener("click", () => {
            if (typeof window.CodexApp.clearRightHover === "function") {
                window.CodexApp.clearRightHover();
            }
            rightSidebar.classList.add("hide-panel");
            if (rightSidebarToggle) rightSidebarToggle.classList.remove("active");
            showToast("右侧多任务面板已收折收起。");
        });
    }

    // Right sidebar config triggers
    const toggleRsTerminal = document.getElementById("toggle-rs-terminal");
    const toggleRsBackup = document.getElementById("toggle-rs-backup");
    const toggleRsCompact = document.getElementById("toggle-rs-compact");

    if (toggleRsTerminal) toggleRsTerminal.addEventListener("change", (e) => showToast(`终端设置：实时后台终端输出已 ${e.target.checked ? "开启" : "关闭"}`));
    if (toggleRsBackup) toggleRsBackup.addEventListener("change", (e) => showToast(`备份设置：自动打包备份历史草稿已 ${e.target.checked ? "开启" : "关闭"}`));
    if (toggleRsCompact) toggleRsCompact.addEventListener("change", (e) => showToast(`上下文设置：高吞吐上下文压缩已 ${e.target.checked ? "开启" : "关闭"}`));

    const subMinus = document.getElementById("sub-minus");
    if (subMinus) {
        subMinus.addEventListener("click", () => {
            const mainCard = document.querySelector(".repl-main-card");
            if (mainCard) {
                const isCollapsed = mainCard.classList.toggle("collapsed-card");
                subMinus.classList.toggle("active", isCollapsed);
                showToast(isCollapsed ? "工作区主面板已折叠收起。点击再次展开。" : "工作区主面板已恢复展开。");
                subMinus.title = isCollapsed ? "展开工作区" : "折叠工作区";
            }
        });
    }

    const subColumnsBtn = document.getElementById("sub-columns");
    if (subColumnsBtn) subColumnsBtn.addEventListener("click", () => showToast("窗口分栏：分栏排列展示模式已生效。"));

    const subMoreOptions = document.getElementById("sub-more-options");
    if (subMoreOptions) subMoreOptions.addEventListener("click", (e) => { e.stopPropagation(); showToast("会话管理：调出该会话的增量打包、重命名及归档设置。"); });

    // 9. Overview Files list row clicks (intelligent mapping)
    const fileRows = document.querySelectorAll(".repl-file-row");
    fileRows.forEach(row => {
        row.addEventListener("click", () => {
            const fileNameSpan = row.querySelector(".repl-file-row-name");
            const fileName = fileNameSpan ? fileNameSpan.textContent.trim() : "";
            
            if (fileName === "app.js") {
                const appJsTab = document.getElementById("rs-tab-code");
                if (appJsTab) {
                    appJsTab.classList.remove("hidden-tab");
                    appJsTab.click();
                }
                
                if (rightSidebar && rightSidebar.classList.contains("hide-panel")) {
                    rightSidebar.classList.remove("hide-panel");
                    if (rightSidebarToggle) rightSidebarToggle.classList.add("active");
                    showToast("智能文件浏览：已为您滑出展开右侧多任务面板。");
                }
                showToast(`已加载代码查看器: replicate_ui/app.js`);
            } else {
                showToast(`文件查看暂不可用: "${fileName}" (当前预览仅包含高保真 app.js)`);
            }
            setTimeout(adjustRsMenuButtonVisibility, 50);
        });
    });

    // 10. Initial execution and resize listener for tabs overflow menu
    setTimeout(adjustRsMenuButtonVisibility, 100);
    window.addEventListener("resize", adjustRsMenuButtonVisibility);
};
