const { spawn } = require('child_process');
const http = require('http');

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port = 9333;
const edgeProc = spawn(edgePath, [
  '--remote-allow-origins=*',
  '--headless=new',
  `--remote-debugging-port=${port}`,
  '--disable-gpu',
  '--no-sandbox',
  'http://127.0.0.1:5188'
]);

setTimeout(async () => {
  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/json`);
    const tabs = await listRes.json();
    console.log('Tabs:', tabs);
    const wsUrl = tabs[0]?.webSocketDebuggerUrl;
    if (!wsUrl) {
      console.log('No ws url');
      edgeProc.kill();
      return;
    }
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({ id: 2, method: 'Log.enable' }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Runtime.exceptionThrown') {
        console.error('EXCEPTION THROWN:', JSON.stringify(msg.params.exceptionDetails, null, 2));
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        console.log('CONSOLE:', msg.params.type, msg.params.args.map(a => a.value || a.description));
      }
    });

    setTimeout(() => {
      edgeProc.kill();
      process.exit(0);
    }, 4000);
  } catch (e) {
    console.error('Error connecting to Edge CDP:', e);
    edgeProc.kill();
  }
}, 1500);
