window.CodexApp = window.CodexApp || {};

window.CodexApp.MimoClient = (function() {
    var PROXY_PREFIX = "/api/v1/chat/completions";

    function buildRequestBody(messages, config) {
        var apiConfig = config.api || {};
        return {
            model: apiConfig.model || "mimo-v2.5",
            messages: messages,
            temperature: apiConfig.temperature !== undefined ? apiConfig.temperature : 0.7,
            top_p: apiConfig.topP !== undefined ? apiConfig.topP : 0.95,
            max_completion_tokens: apiConfig.maxTokens || 4096,
            stream: apiConfig.stream !== undefined ? apiConfig.stream : true
        };
    }

    function parseSSELine(line) {
        if (!line || line.startsWith(":")) return null;
        if (line.startsWith("data: ")) {
            var data = line.substring(6).trim();
            if (data === "[DONE]") return { done: true };
            try {
                return { chunk: JSON.parse(data) };
            } catch {
                return null;
            }
        }
        return null;
    }

    function extractDelta(parsed) {
        if (!parsed || !parsed.choices || parsed.choices.length === 0) return null;
        var choice = parsed.choices[0];
        var delta = choice.delta || {};
        return {
            content: delta.content || "",
            reasoningContent: delta.reasoning_content || "",
            finishReason: choice.finish_reason || null,
            role: delta.role || null
        };
    }

    function streamChat(messages, callbacks, config) {
        var body = buildRequestBody(messages, config);
        var controller = new AbortController();
        var signal = controller.signal;

        var reader = null;
        var buffer = "";
        var fullContent = "";
        var fullReasoning = "";

        fetch(PROXY_PREFIX, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: signal
        })
        .then(function(response) {
            if (!response.ok) {
                return response.text().then(function(text) {
                    var errMsg = "API request failed: " + response.status;
                    try {
                        var errObj = JSON.parse(text);
                        errMsg = errObj.error && errObj.error.message ? errObj.error.message : errMsg;
                    } catch {}
                    throw new Error(errMsg);
                });
            }

            reader = response.body.getReader();
            var decoder = new TextDecoder();

            function processChunk() {
                return reader.read().then(function(result) {
                    if (result.done) {
                        if (callbacks.onComplete) {
                            callbacks.onComplete({
                                content: fullContent,
                                reasoningContent: fullReasoning
                            });
                        }
                        return;
                    }

                    buffer += decoder.decode(result.value, { stream: true });
                    var lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (var i = 0; i < lines.length; i++) {
                        var parsed = parseSSELine(lines[i]);
                        if (!parsed) continue;
                        if (parsed.done) {
                            if (callbacks.onComplete) {
                                callbacks.onComplete({
                                    content: fullContent,
                                    reasoningContent: fullReasoning
                                });
                            }
                            return;
                        }
                        if (parsed.chunk) {
                            var delta = extractDelta(parsed.chunk);
                            if (delta) {
                                if (delta.role && callbacks.onRole) {
                                    callbacks.onRole(delta.role);
                                }
                                if (delta.reasoningContent) {
                                    fullReasoning += delta.reasoningContent;
                                    if (callbacks.onReasoning) {
                                        callbacks.onReasoning(delta.reasoningContent, fullReasoning);
                                    }
                                }
                                if (delta.content) {
                                    fullContent += delta.content;
                                    if (callbacks.onContent) {
                                        callbacks.onContent(delta.content, fullContent);
                                    }
                                }
                                if (delta.finishReason && callbacks.onFinishReason) {
                                    callbacks.onFinishReason(delta.finishReason);
                                }
                            }
                        }
                    }

                    return processChunk();
                });
            }

            return processChunk();
        })
        .catch(function(err) {
            if (err.name === "AbortError") {
                if (callbacks.onAbort) callbacks.onAbort();
                return;
            }
            if (callbacks.onError) {
                callbacks.onError(err);
            } else {
                console.error("[MimoClient] stream error:", err);
            }
        });

        return {
            abort: function() {
                controller.abort();
                if (reader) {
                    try { reader.cancel(); } catch {}
                }
            }
        };
    }

    function sendChat(messages, callbacks, config) {
        var apiConfig = (config || window.CodexApp.ConfigManager.get()).api || {};
        if (apiConfig.stream !== false) {
            return streamChat(messages, callbacks, config || window.CodexApp.ConfigManager.get());
        }

        var body = buildRequestBody(messages, config || window.CodexApp.ConfigManager.get());
        var controller = new AbortController();

        fetch(PROXY_PREFIX, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal
        })
        .then(function(response) {
            if (!response.ok) throw new Error("API request failed: " + response.status);
            return response.json();
        })
        .then(function(data) {
            var choice = data.choices && data.choices[0];
            if (choice && choice.message) {
                if (callbacks.onComplete) {
                    callbacks.onComplete({
                        content: choice.message.content || "",
                        reasoningContent: choice.message.reasoning_content || ""
                    });
                }
            }
        })
        .catch(function(err) {
            if (err.name === "AbortError") return;
            if (callbacks.onError) callbacks.onError(err);
        });

        return { abort: function() { controller.abort(); } };
    }

    return {
        sendChat: sendChat,
        streamChat: streamChat
    };
})();
