const fs = require('fs');
const path = require('path');

// 模拟基础浏览器环境
global.window = global;
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.document = {
  getElementById: () => ({ innerHTML: '', classList: { add: () => {}, remove: () => {} }, appendChild: () => {} }),
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {}, classList: { add: () => {}, remove: () => {} } }),
  querySelectorAll: () => [],
  querySelector: () => null,
  documentElement: { classList: { add: () => {}, remove: () => {} }, setAttribute: () => {}, style: {} },
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {}
};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.performance = { now: () => 100, mark: () => {} };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.MutationObserver = class { observe() {} disconnect() {} };

async function test() {
  try {
    const assetsDir = 'apps/crish-desktop/dist/assets';
    const indexFile = fs.readdirSync(assetsDir).find(f => f.startsWith('index-') && f.endsWith('.js'));
    console.log('Testing import of', indexFile);
    await import('file:///' + path.resolve(assetsDir, indexFile).replace(/\\/g, '/'));
    console.log('SUCCESS: Index chunk imported without TDZ or uncaught exceptions!');
  } catch (err) {
    console.error('CRITICAL EVALUATION ERROR:', err);
  }
}

test();
