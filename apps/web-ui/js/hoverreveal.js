/* 
   ==========================================================================
   INTENTIONAL HOVER REVEAL SYSTEM (hoverreveal.js)
   ========================================================================== 
*/

window.CodexApp = window.CodexApp || {};

window.CodexApp.initHoverReveal = function() {
    const showToast = window.CodexApp.showToast || (() => {});
    const mainSidebar = window.CodexApp.mainSidebar || document.querySelector(".repl-sidebar");
    const rightSidebar = window.CodexApp.rightSidebar || document.getElementById("right-sidebar");
    const rightSidebarToggle = document.getElementById("sub-sidebar-right-toggle");

    if (!mainSidebar || !rightSidebar) return;

    // Create edge trigger overlays programmatically (56px wide comfortable hot zones)
    const leftTrigger = document.createElement("div");
    leftTrigger.id = "left-hover-trigger";
    leftTrigger.className = "repl-edge-trigger";
    document.body.appendChild(leftTrigger);

    const rightTrigger = document.createElement("div");
    rightTrigger.id = "right-hover-trigger";
    rightTrigger.className = "repl-edge-trigger";
    document.body.appendChild(rightTrigger);

    // Create premium edge glow indicators programmatically
    const leftGlow = document.createElement("div");
    leftGlow.id = "left-edge-glow";
    leftGlow.className = "repl-edge-glow";
    document.body.appendChild(leftGlow);

    const rightGlow = document.createElement("div");
    rightGlow.id = "right-edge-glow";
    rightGlow.className = "repl-edge-glow";
    document.body.appendChild(rightGlow);

    let leftEnterTimeout = null;
    let rightEnterTimeout = null;
    let leftLeaveTimeout = null;
    let rightLeaveTimeout = null;
    let leftCollapseTimeout = null;
    let rightCollapseTimeout = null;

    const HOVER_INTENT_DELAY = 350; // Delay in ms to detect intentional hover (avoids fly-bys)
    const EXIT_DELAY = 400;         // Delay in ms before sliding back when mouse leaves sidebar
    const TRANSITION_DURATION = 350; // Matches CSS transition duration (0.35s)

    // --- LEFT SIDEBAR HOVER SYSTEM ---
    function revealLeftSidebar() {
        if (mainSidebar.classList.contains("hide-sidebar")) {
            clearTimeout(leftCollapseTimeout);
            mainSidebar.classList.remove("overlay-collapsing");
            mainSidebar.classList.add("overlay-reveal");
            if (leftGlow) leftGlow.classList.remove("active"); // Turn off glow since sidebar is open
            showToast("智能感知：已为您滑出工作区侧边栏。");
        }
    }

    function collapseLeftSidebar() {
        if (mainSidebar.classList.contains("overlay-reveal")) {
            mainSidebar.classList.remove("overlay-reveal");
            mainSidebar.classList.add("overlay-collapsing");
            
            clearTimeout(leftCollapseTimeout);
            leftCollapseTimeout = setTimeout(() => {
                // Reflow Snapping Refinement: bypass layout transition during static mode fall-back
                mainSidebar.classList.add("no-transition");
                mainSidebar.classList.remove("overlay-collapsing");
                
                // Force instant layout recalculation while transition is disabled
                void mainSidebar.offsetWidth;
                
                setTimeout(() => {
                    mainSidebar.classList.remove("no-transition");
                }, 50);
            }, TRANSITION_DURATION);
        }
    }

    // Mouse enters left edge trigger
    leftTrigger.addEventListener("mouseenter", () => {
        clearTimeout(leftLeaveTimeout);
        clearTimeout(leftEnterTimeout);
        
        // Show glowing indicator instantly on hover to guide intent
        if (mainSidebar.classList.contains("hide-sidebar")) {
            if (leftGlow) leftGlow.classList.add("active");
        }
        
        leftEnterTimeout = setTimeout(() => {
            revealLeftSidebar();
        }, HOVER_INTENT_DELAY);
    });

    leftTrigger.addEventListener("mouseleave", () => {
        clearTimeout(leftEnterTimeout);
        // Fade out glow if mouse flies past without triggering reveal
        if (leftGlow) leftGlow.classList.remove("active");
    });

    // Also keep open while mouse is inside left sidebar
    mainSidebar.addEventListener("mouseenter", () => {
        clearTimeout(leftLeaveTimeout);
        clearTimeout(leftEnterTimeout);
        if (leftGlow) leftGlow.classList.remove("active");
    });

    mainSidebar.addEventListener("mouseleave", () => {
        clearTimeout(leftLeaveTimeout);
        leftLeaveTimeout = setTimeout(() => {
            collapseLeftSidebar();
        }, EXIT_DELAY);
    });

    // --- RIGHT SIDEBAR HOVER SYSTEM ---
    function revealRightSidebar() {
        if (rightSidebar.classList.contains("hide-panel")) {
            clearTimeout(rightCollapseTimeout);
            rightSidebar.classList.remove("overlay-collapsing");
            rightSidebar.classList.add("overlay-reveal");
            if (rightGlow) rightGlow.classList.remove("active");
            showToast("智能感知：已为您滑出多任务面板。");
        }
    }

    function collapseRightSidebar() {
        if (rightSidebar.classList.contains("overlay-reveal")) {
            rightSidebar.classList.remove("overlay-reveal");
            rightSidebar.classList.add("overlay-collapsing");
            
            clearTimeout(rightCollapseTimeout);
            rightCollapseTimeout = setTimeout(() => {
                // Reflow Snapping Refinement
                rightSidebar.classList.add("no-transition");
                rightSidebar.classList.remove("overlay-collapsing");
                
                void rightSidebar.offsetWidth;
                
                setTimeout(() => {
                    rightSidebar.classList.remove("no-transition");
                }, 50);
            }, TRANSITION_DURATION);
        }
    }

    // Mouse enters right edge trigger
    rightTrigger.addEventListener("mouseenter", () => {
        clearTimeout(rightLeaveTimeout);
        clearTimeout(rightEnterTimeout);
        
        if (rightSidebar.classList.contains("hide-panel")) {
            if (rightGlow) rightGlow.classList.add("active");
        }
        
        rightEnterTimeout = setTimeout(() => {
            revealRightSidebar();
        }, HOVER_INTENT_DELAY);
    });

    rightTrigger.addEventListener("mouseleave", () => {
        clearTimeout(rightEnterTimeout);
        if (rightGlow) rightGlow.classList.remove("active");
    });

    // Keep open while mouse is inside right sidebar
    rightSidebar.addEventListener("mouseenter", () => {
        clearTimeout(rightLeaveTimeout);
        clearTimeout(rightEnterTimeout);
        if (rightGlow) rightGlow.classList.remove("active");
    });

    rightSidebar.addEventListener("mouseleave", () => {
        clearTimeout(rightLeaveTimeout);
        rightLeaveTimeout = setTimeout(() => {
            collapseRightSidebar();
        }, EXIT_DELAY);
    });
    
    // Automatically close overlay-reveal sidebars when user clicks anywhere in the main panel
    const mainChatView = document.getElementById("main-chat-view");
    if (mainChatView) {
        mainChatView.addEventListener("click", () => {
            collapseLeftSidebar();
            collapseRightSidebar();
        });
    }

    // --- DYNAMIC EDGE TRIGGER STATE SYSTEM (RESTORES CLICKABILITY FOR ALL SIDEBAR BUTTONS) ---
    function updateTriggerVisibilities() {
        const leftOpen = !mainSidebar.classList.contains("hide-sidebar") || mainSidebar.classList.contains("overlay-reveal");
        const rightOpen = !rightSidebar.classList.contains("hide-panel") || rightSidebar.classList.contains("overlay-reveal");

        if (leftTrigger) {
            leftTrigger.style.pointerEvents = leftOpen ? "none" : "auto";
            leftTrigger.style.display = leftOpen ? "none" : "block";
        }
        if (rightTrigger) {
            rightTrigger.style.pointerEvents = rightOpen ? "none" : "auto";
            rightTrigger.style.display = rightOpen ? "none" : "block";
        }
    }

    // Expose clear helpers globally so that collapsers.js can cancel hover overlays instantly on click
    window.CodexApp.clearLeftHover = function() {
        clearTimeout(leftEnterTimeout);
        clearTimeout(leftLeaveTimeout);
        clearTimeout(leftCollapseTimeout);
        if (leftGlow) leftGlow.classList.remove("active");
        mainSidebar.classList.remove("overlay-reveal", "overlay-collapsing", "no-transition");
        updateTriggerVisibilities();
    };

    window.CodexApp.clearRightHover = function() {
        clearTimeout(rightEnterTimeout);
        clearTimeout(rightLeaveTimeout);
        clearTimeout(rightCollapseTimeout);
        if (rightGlow) rightGlow.classList.remove("active");
        rightSidebar.classList.remove("overlay-reveal", "overlay-collapsing", "no-transition");
        updateTriggerVisibilities();
    };

    // Set up MutationObserver to automatically synchronize edge trigger states on class changes
    const sidebarObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.attributeName === "class") {
                updateTriggerVisibilities();
            }
        });
    });

    sidebarObserver.observe(mainSidebar, { attributes: true, attributeFilter: ["class"] });
    sidebarObserver.observe(rightSidebar, { attributes: true, attributeFilter: ["class"] });

    // Run once on initialization to correctly setup state
    updateTriggerVisibilities();
};
