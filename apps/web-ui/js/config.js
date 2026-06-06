window.CodexApp = window.CodexApp || {};

window.CodexApp.ConfigManager = (function() {
    var STORAGE_KEY = "codex_config_override";
    var CONFIG_URL = "/config.json";
    var POLL_INTERVAL_MS = 5000;

    var _fileConfig = null;
    var _pollTimer = null;
    var _listeners = [];

    function deepMerge(base, override) {
        var result = {};
        for (var key in base) {
            if (base.hasOwnProperty(key)) {
                if (override && override.hasOwnProperty(key) && typeof base[key] === "object" && typeof override[key] === "object" && !Array.isArray(base[key]) && !Array.isArray(override[key])) {
                    result[key] = deepMerge(base[key], override[key]);
                } else if (override && override.hasOwnProperty(key)) {
                    result[key] = override[key];
                } else {
                    result[key] = base[key];
                }
            }
        }
        for (var key in override) {
            if (override.hasOwnProperty(key) && !base.hasOwnProperty(key)) {
                result[key] = override[key];
            }
        }
        return result;
    }

    function loadFromLocalStorage() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    function saveToLocalStorage(overrides) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
        } catch {
            // storage full or blocked
        }
    }

    function fetchFileConfig(callback) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", CONFIG_URL + "?_t=" + Date.now(), true);
        xhr.onreadystatechange = function() {
            if (xhr.readyState === 4) {
                if (xhr.status === 200) {
                    try {
                        _fileConfig = JSON.parse(xhr.responseText);
                    } catch {
                        // keep previous config
                    }
                }
                if (callback) callback();
            }
        };
        xhr.send();
    }

    function get() {
        var base = _fileConfig || {
            api: {
                baseUrl: "https://token-plan-cn.xiaomimimo.com",
                token: "",
                model: "mimo-v2.5",
                temperature: 0.7,
                topP: 0.95,
                maxTokens: 4096,
                stream: true,
                systemPrompt: "You are Codex, a helpful AI assistant."
            },
            ui: {
                toastLevel: "minimal",
                theme: "dark"
            }
        };
        var overrides = loadFromLocalStorage();
        return overrides ? deepMerge(base, overrides) : base;
    }

    function set(path, value) {
        var overrides = loadFromLocalStorage() || {};
        var keys = path.split(".");
        var current = overrides;
        for (var i = 0; i < keys.length - 1; i++) {
            if (!current[keys[i]] || typeof current[keys[i]] !== "object") {
                current[keys[i]] = {};
            }
            current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = value;
        saveToLocalStorage(overrides);
        notifyListeners();
    }

    function reset() {
        localStorage.removeItem(STORAGE_KEY);
        notifyListeners();
    }

    function onChange(listener) {
        _listeners.push(listener);
    }

    function notifyListeners() {
        var config = get();
        for (var i = 0; i < _listeners.length; i++) {
            try {
                _listeners[i](config);
            } catch (e) {
                console.error("[ConfigManager] listener error:", e);
            }
        }
    }

    function startPolling() {
        if (_pollTimer) return;
        _pollTimer = setInterval(function() {
            fetchFileConfig(function() {
                var prev = JSON.stringify(get());
                notifyListeners();
            });
        }, POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (_pollTimer) {
            clearInterval(_pollTimer);
            _pollTimer = null;
        }
    }

    function init(callback) {
        fetchFileConfig(function() {
            startPolling();
            if (callback) callback(get());
        });
    }

    return {
        init: init,
        get: get,
        set: set,
        reset: reset,
        onChange: onChange,
        startPolling: startPolling,
        stopPolling: stopPolling
    };
})();
