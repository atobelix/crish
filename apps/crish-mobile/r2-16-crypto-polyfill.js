// R2-16 联调临时 polyfill（不入库，运行后删除；见 R2-16-acceptance-execution.md 遗留清单）
// RN/Hermes 无 crypto.getRandomValues，noble/curves x25519.keygen() 需要它。
// Expo Go 原生侧在 JS 运行前即安装 globalThis.expo.modules（JSI 宿主对象），
// 此处直接取 ExpoCrypto 原生同步实现补齐 crypto.getRandomValues（无需 require）。
(function () {
  if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = {};
  }
  if (typeof globalThis.crypto.getRandomValues === 'function') {
    return;
  }
  try {
    var expoCrypto = globalThis.expo && globalThis.expo.modules && globalThis.expo.modules.ExpoCrypto;
    if (expoCrypto && typeof expoCrypto.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues = function (typedArray) {
        expoCrypto.getRandomValues(typedArray);
        return typedArray;
      };
    }
  } catch (e) {
    // 静默降级：若原生对象暂不可用，后续模块执行期仍可再补（见 pairing 失败路径）
  }
})();
