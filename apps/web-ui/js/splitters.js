/* 
   ==========================================================================
   CODEX PANEL RESIZING DRAG SYSTEM (splitters.js)
   ========================================================================== 
*/

window.CodexApp = window.CodexApp || {};

window.CodexApp.initSplitters = function() {
    const showToast = window.CodexApp.showToast || (() => {});
    const resizerLeft = document.getElementById("resizer-left");
    const resizerRight = document.getElementById("resizer-right");
    const mainSidebar = window.CodexApp.mainSidebar || document.querySelector(".repl-sidebar");
    const rightSidebar = window.CodexApp.rightSidebar || document.getElementById("right-sidebar");

    // Helper to get raw CSS Custom Variable value
    function getCSSVariableWidth(variableName, defaultValue) {
        const val = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
        return val ? parseInt(val) : defaultValue;
    }

    // A. Left Resizer Drag Logic
    if (resizerLeft && mainSidebar) {
        resizerLeft.addEventListener("mousedown", (e) => {
            e.preventDefault();
            document.body.classList.add("dragging-active");
            resizerLeft.classList.add("dragging");

            const startX = e.clientX;
            const startWidth = getCSSVariableWidth('--sidebar-width', 250);

            function onMouseMove(moveEvent) {
                const deltaX = moveEvent.clientX - startX;
                const newWidth = Math.max(160, Math.min(startWidth + deltaX, 480));
                document.documentElement.style.setProperty('--sidebar-width', newWidth + "px");
            }

            function onMouseUp() {
                document.body.classList.remove("dragging-active");
                resizerLeft.classList.remove("dragging");
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                showToast(`左侧侧边栏已调整宽度为: ${getCSSVariableWidth('--sidebar-width', 250)}px`);
            }

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });
    }

    // B. Right Resizer Drag Logic
    if (resizerRight && rightSidebar) {
        resizerRight.addEventListener("mousedown", (e) => {
            e.preventDefault();
            document.body.classList.add("dragging-active");
            resizerRight.classList.add("dragging");

            const startX = e.clientX;
            const startWidth = getCSSVariableWidth('--right-sidebar-width', 320);

            function onMouseMove(moveEvent) {
                const deltaX = moveEvent.clientX - startX;
                // Right panel is on the right, so dragging left (negative deltaX) increases width
                const newWidth = Math.max(240, Math.min(startWidth - deltaX, 600));
                document.documentElement.style.setProperty('--right-sidebar-width', newWidth + "px");
            }

            function onMouseUp() {
                document.body.classList.remove("dragging-active");
                resizerRight.classList.remove("dragging");
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                showToast(`右侧任务面板已调整宽度为: ${getCSSVariableWidth('--right-sidebar-width', 320)}px`);
            }

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });
    }
};
