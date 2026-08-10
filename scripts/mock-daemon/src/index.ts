// =======================================================================
// mock daemon v0（R0-06）——CLI 入口
//
// 启动：npm run start -- --pair --scenario approval
// 用途：多端互通移动端（R2）联调夹具服务器，纯测试基建，不进生产代码。
// =======================================================================

import { main } from './cli.js';

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((e) => {
    console.error(`[mock-daemon] 致命错误：${String(e)}`);
    process.exit(1);
  });
