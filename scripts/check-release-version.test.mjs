/**
 * scripts/check-release-version.test.mjs
 *
 * check-release-version.mjs 的自测：解析器（TOML 表 / Cargo.lock 条目）与校验规则，
 * 以及对真实仓库的端到端调用。release.yml 在信任 SEC-06 门禁前先跑本测试。
 * 运行：node --test scripts/check-release-version.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cargoLockVersion, collectVersions, tomlSectionVersion, validate } from './check-release-version.mjs';

const SCRIPT = fileURLToPath(new URL('./check-release-version.mjs', import.meta.url));

const v = (version, source = 'src') => ({ source, version });

describe('tomlSectionVersion', () => {
  const toml = [
    '[workspace]',
    'members = ["a"]',
    '',
    '[workspace.package]',
    'edition = "2021"',
    'version = "1.2.3"',
    '',
    '[workspace.dependencies]',
    'serde = { version = "1" }',
    'version = "9.9.9"',
  ].join('\r\n');

  it('只取目标表内的 version', () => {
    assert.equal(tomlSectionVersion(toml, 'workspace.package'), '1.2.3');
  });
  it('不会把其他表（含依赖内联表）的 version 当成产品版本', () => {
    assert.equal(tomlSectionVersion('[workspace.dependencies]\nversion = "9.9.9"\n', 'workspace.package'), undefined);
  });
});

describe('cargoLockVersion', () => {
  const lock = [
    'version = 4',
    '',
    '[[package]]',
    'name = "crish-agent-workbench-helper"',
    'version = "7.0.0"',
    '',
    '[[package]]',
    'name = "crish-agent-workbench"',
    'version = "0.4.2"',
    'dependencies = [',
    ' "serde",',
    ']',
  ].join('\n');

  it('精确匹配 crate 名（不被同前缀 crate 干扰）', () => {
    assert.equal(cargoLockVersion(lock, 'crish-agent-workbench'), '0.4.2');
  });
  it('crate 不存在时返回 undefined', () => {
    assert.equal(cargoLockVersion(lock, 'nope'), undefined);
  });
});

describe('validate', () => {
  it('全部一致且 tag 匹配时通过', () => {
    assert.deepEqual(validate([v('0.1.1'), v('0.1.1')], 'v0.1.1'), []);
  });
  it('不传 tag 时只校验内部一致', () => {
    assert.deepEqual(validate([v('0.1.1'), v('0.1.1')], undefined), []);
  });
  it('任一来源漂移即失败，并点名来源', () => {
    const errors = validate([v('0.1.1', 'tauri'), v('0.1.0', 'Cargo.toml')], undefined);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Cargo\.toml: 0\.1\.0/);
  });
  it('缺失版本号即失败', () => {
    assert.equal(validate([v('0.1.1'), v(undefined, 'lock')], undefined).length, 1);
  });
  it('非 semver 即失败', () => {
    assert.equal(validate([v('0.1'), v('0.1')], undefined).length, 2);
  });
  it('tag 与版本不一致即失败', () => {
    assert.equal(validate([v('0.1.1')], 'v0.1.0').length, 1);
  });
  it('tag 缺 v 前缀即失败', () => {
    assert.equal(validate([v('0.1.1')], '0.1.1').length, 1);
  });
});

describe('真实仓库', () => {
  it('收集到全部 10 个来源且内部一致', () => {
    const versions = collectVersions();
    assert.equal(versions.length, 10);
    assert.deepEqual(validate(versions, undefined), []);
  });
  it('CLI：tag 与仓库版本一致返回 0，不一致返回非 0', () => {
    const [{ version }] = collectVersions();
    execFileSync(process.execPath, [SCRIPT, `v${version}`], { stdio: 'pipe' });
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'v0.0.0-never'], { stdio: 'pipe' }));
  });
});