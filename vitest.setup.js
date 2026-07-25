"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var vitest_1 = require("vitest");
/**
 * Node vitest 环境补齐 browser 全局，避免 seed layoutStore 时 localStorage 缺失。
 */
var mem = new Map();
var localStorageMock = {
    getItem: function (k) { return (mem.has(k) ? mem.get(k) : null); },
    setItem: function (k, v) {
        mem.set(k, String(v));
    },
    removeItem: function (k) {
        mem.delete(k);
    },
    clear: function () {
        mem.clear();
    },
    key: function (i) { var _a; return (_a = __spreadArray([], mem.keys(), true)[i]) !== null && _a !== void 0 ? _a : null; },
    get length() {
        return mem.size;
    },
};
// @ts-expect-error test env
globalThis.localStorage = localStorageMock;
// @ts-expect-error test env  
if (typeof globalThis.window === 'undefined') {
    // @ts-expect-error test env
    globalThis.window = globalThis;
}
// Node vitest：sessionActions.setActiveSessionId → projectStore 会 dispatch 自定义事件
if (typeof globalThis.window.dispatchEvent !== 'function') {
    globalThis.window.dispatchEvent = function () { return true; };
}
if (typeof globalThis.CustomEvent === 'undefined') {
    // @ts-expect-error test env
    globalThis.CustomEvent = /** @class */ (function () {
        function CustomEvent(type, init) {
            this.type = type;
            this.detail = init === null || init === void 0 ? void 0 : init.detail;
        }
        return CustomEvent;
    }());
}
(0, vitest_1.beforeEach)(function () {
    vitest_1.vi.useFakeTimers();
});
(0, vitest_1.afterEach)(function () {
    vitest_1.vi.restoreAllMocks();
    vitest_1.vi.useRealTimers();
});
// 确保未处理的 Promise 拒绝不会静默吞没
process.on('unhandledRejection', function (reason) {
    console.error('[vitest.setup] Unhandled Rejection:', reason);
});
// TODO(C2-9/J-20): 当 GatewayV2Bridge 去单例化完成后，
// 在此处 import { resetProviderEngine } from 'packages/agent-runtime/src/provider-gateway' 并调用
