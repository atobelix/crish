/**
 * Tool call templates for demo/streaming simulation.
 */
export const toolCallTemplates = [
  {
    name: 'bash', label: 'src/',
    args: '$ ls -laR src/',
    result: 'src/:\ndrwxr-xr-x   8 user staff   256 Jun 14 10:00 .\n-rw-r--r--   1 user staff  1203 Jun 14 10:01 index.js\n...'
  },
  {
    name: 'read_file', label: 'src/auth/login.js',
    args: '$ cat src/auth/login.js',
    result: 'const bcrypt = require("bcrypt");\nconst { RateLimiter } = require("../utils/rate-limiter");\n\nasync function login(username, password) {\n  ...\n}'
  },
  {
    name: 'grep_search', label: '"TODO|FIXME" 在 src/ 中',
    args: '$ grep -rn "TODO\\|FIXME" src/',
    result: 'src/utils/format.js:42:  // TODO: add support for relative dates\nsrc/index.js:8:  // FIXME: process.env not set'
  },
  {
    name: 'edit_file', label: 'src/auth/login.js',
    args: '$ edit_file src/auth/login.js',
    result: 'Applied 5 edits to src/auth/login.js',
    diff: { file: 'src/auth/login.js', added: 8, removed: 4, hunks: [] }
  },
  {
    name: 'run_test', label: 'auth 测试套件',
    args: '$ npm test -- --filter="auth"',
    result: 'PASS  src/auth/login.test.js\n  ✓ returns token on valid credentials (12ms)\n  ✓ rejects invalid password (8ms)\n\nTests: 4 passed, 4 total'
  }
];
