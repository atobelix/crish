import { render } from 'preact';
import App from './components/App';
import { tauriBridge } from './core/tauri-bridge';

let unloadTeardownStarted = false;
const requestDaemonTeardown = () => {
  if (unloadTeardownStarted) return;
  unloadTeardownStarted = true;
  void tauriBridge.stopDaemon().catch((error) => {
    console.error('Daemon teardown failed during unload:', error);
  });
};

window.addEventListener('beforeunload', requestDaemonTeardown);
window.addEventListener('pagehide', requestDaemonTeardown);

// 挂载 Preact 应用到 #app
const appContainer = document.getElementById('app');
if (appContainer) {
  render(<App />, appContainer);
} else {
  console.error('找不到 #app 挂载点');
}
