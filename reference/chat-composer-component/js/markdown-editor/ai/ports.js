/**
 * markdown-editor/ai/ports.js — AI 端口契约（薄转发）
 *
 * 宿主（Conex 主软件）负责全部 AI 能力。本模块：
 * - 不内置 LLM、不生成 mock 文案、不注入演示数据
 * - 仅规范化 options.ai，供编辑器在「有端口时」转发调用
 *
 * 宿主注入示例：
 *   MarkdownEditor.mount(el, {
 *     ai: {
 *       complete: (req) => Promise<string> | AsyncIterable<string>
 *     }
 *   })
 * req: { action, selection, documentMd, signal? }
 *
 * - ai 缺省 / false / null → { enabled: false }
 * - ai 为 function → 视为 complete
 * - ai.complete 为 function → enabled
 * - 无 complete 时绝不伪造输出
 *
 * Prefix: MdxAiPorts
 */
(function () {
  'use strict';

  function asyncIteratorKey() {
    return typeof Symbol !== 'undefined' && Symbol.asyncIterator
      ? Symbol.asyncIterator
      : '@@asyncIterator';
  }

  function isAsyncIterable(x) {
    if (x == null || typeof x !== 'object') return false;
    var key = asyncIteratorKey();
    return typeof x[key] === 'function';
  }

  /**
   * 将 complete 的返回值统一消费为完整字符串。
   * @param {Promise<string>|AsyncIterable<string>|string} result
   * @param {{ onChunk?: (s: string) => void, signal?: AbortSignal }} [opts]
   */
  function consumeComplete(result, opts) {
    opts = opts || {};
    if (result == null) return Promise.resolve('');
    if (typeof result === 'string') {
      if (opts.onChunk) opts.onChunk(result);
      return Promise.resolve(result);
    }
    if (typeof result.then === 'function') {
      return result.then(function (v) {
        return consumeComplete(v, opts);
      });
    }
    if (isAsyncIterable(result)) {
      return (async function () {
        var out = '';
        var key = asyncIteratorKey();
        var iter = result[key]();
        while (true) {
          if (opts.signal && opts.signal.aborted) {
            var err = new Error('Aborted');
            err.name = 'AbortError';
            throw err;
          }
          var step = await iter.next();
          if (step.done) break;
          var chunk = step.value == null ? '' : String(step.value);
          out += chunk;
          if (opts.onChunk && chunk) opts.onChunk(chunk);
        }
        return out;
      })();
    }
    return Promise.resolve(String(result));
  }

  /**
   * @param {*} aiOption mount options.ai
   * @returns {{ enabled: boolean, complete: (Function|null), raw: * }}
   */
  function normalize(aiOption) {
    if (aiOption == null || aiOption === false) {
      return { enabled: false, complete: null, raw: aiOption };
    }
    if (typeof aiOption === 'function') {
      return { enabled: true, complete: aiOption, raw: aiOption };
    }
    if (typeof aiOption === 'object') {
      if (typeof aiOption.complete === 'function') {
        return { enabled: true, complete: aiOption.complete, raw: aiOption };
      }
      // 有对象但无 complete：视为未接入，不启用、不 mock
      return { enabled: false, complete: null, raw: aiOption };
    }
    // true 或其它类型：不启用（避免历史 ai:true → mock）
    return { enabled: false, complete: null, raw: aiOption };
  }

  /**
   * 安全调用：无端口时返回 { ok:false }，绝不编造正文。
   */
  function complete(ports, req, opts) {
    ports = ports || normalize(null);
    if (!ports.enabled || typeof ports.complete !== 'function') {
      return Promise.resolve({ ok: false, reason: 'no-ai-port', text: '' });
    }
    try {
      var result = ports.complete(req || {});
      return consumeComplete(result, opts).then(function (text) {
        return { ok: true, text: text == null ? '' : String(text) };
      });
    } catch (e) {
      return Promise.resolve({
        ok: false,
        reason: (e && e.message) || 'ai-port-error',
        text: '',
        error: e,
      });
    }
  }

  window.MdxAiPorts = {
    normalize: normalize,
    complete: complete,
    consumeComplete: consumeComplete,
    isAsyncIterable: isAsyncIterable,
  };
})();
