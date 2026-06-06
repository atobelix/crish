window.CodexApp = window.CodexApp || {};

document.addEventListener("DOMContentLoaded", () => {
    const toast = document.getElementById("action-toast");
    let toastTimeout;

    window.CodexApp.showToast = function(message) {
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add("show");

        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            toast.classList.remove("show");
        }, 2200);
    };

    window.CodexApp.mainSidebar = document.querySelector(".repl-sidebar");
    window.CodexApp.rightSidebar = document.getElementById("right-sidebar");
    window.CodexApp.chatInput = document.getElementById("chat-input");
    window.CodexApp.sendBtn = document.getElementById("btn-send");

    if (window.lucide) {
        window.lucide.createIcons();
    }

    if (window.CodexApp.ConfigManager) {
        window.CodexApp.ConfigManager.init(function(config) {
            console.log("[ConfigManager] initialized, model:", (config.api || {}).model);
        });
    }

    if (window.CodexApp.initTheme) window.CodexApp.initTheme();
    if (window.CodexApp.initSplitters) window.CodexApp.initSplitters();
    if (window.CodexApp.initSubAgents) window.CodexApp.initSubAgents();
    if (window.CodexApp.initCollapsers) window.CodexApp.initCollapsers();
    if (window.CodexApp.initChat) window.CodexApp.initChat();
    if (window.CodexApp.initHoverReveal) window.CodexApp.initHoverReveal();

    console.log("Codex Application fully bootstrapped successfully.");
});
