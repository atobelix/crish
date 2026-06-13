import { render } from 'preact';
import App from './components/App';
import { tauriBridge } from './core/tauri-bridge';

let unloadTeardownStarted = false;
const requestDaemonTeardown = () => {
  if (unloadTeardownStarted) return;
  unloadTeardownStarted = true;
  void tauriBridge.stopDaemon().catch(() => {
    /* daemon teardown failure on unload is non-critical */
  });
};

window.addEventListener('beforeunload', requestDaemonTeardown);
window.addEventListener('pagehide', requestDaemonTeardown);

// 挂载 Preact 应用到 #app
const appContainer = document.getElementById('app');
if (appContainer) {
  render(<App />, appContainer);
} else {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#ef4444;">应用启动失败：找不到挂载点</div>';
}
