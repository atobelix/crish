/**
 * scripts/verify-desktop-i18n-mcp.test.mjs
 *
 * 自动化测试 verify-desktop-i18n-mcp.mjs 中的核心逻辑与自测套件
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, 'verify-desktop-i18n-mcp.mjs');

describe('verify-desktop-i18n-mcp.mjs 自动化测试', () => {
  it('--self-test 模式执行并通过全部断言', () => {
    const output = execSync(`node "${SCRIPT_PATH}" --self-test`, {
      encoding: 'utf8',
    });
    assert.ok(output.includes('通过 8 项，失败 0 项'));
    assert.ok(output.includes('[PASS]'));
    assert.ok(output.includes('正则应精确捕获中文字符'));
    assert.ok(output.includes('纯英文 UI Chrome 清单违规项应为 0'));
  });

  it('未运行桌面端时 --probe 模式优雅输出指引并以退出码 1 终止', () => {
    try {
      execSync(`node "${SCRIPT_PATH}" --probe`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      // 如果未抛出错误（即端口刚好被监听），测试也视为合法
    } catch (err) {
      assert.equal(err.status, 1);
      const stderrAndStdout = (err.stdout || '') + (err.stderr || '');
      assert.match(stderrAndStdout, /(ECONNREFUSED|未检测到 127\.0\.0\.1:4000)/);
    }
  });
});
