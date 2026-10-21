#!/usr/bin/env node
/**
 * scripts/check-release-version.mjs
 * 发布版本号一致性门禁（SEC-06）
 *
 * 背景：产品版本号分散在 6 处真源/派生物里——tauri.conf.json（安装包与 updater
 * 比对用的 version）、根 Cargo.toml [workspace.package].version（Rust 侧
 * CARGO_PKG_VERSION，server/mod.rs 等运行期上报）、Cargo.lock 中
 * crish-agent-workbench 条目、根 / apps/agent-workbench / apps/crish-desktop 三个
 * package.json，以及 package-lock.json 对这三个包的镜像。升级版本（如 2087dfb84
 * 0.1.0 → 0.1.1）只要漏改一处，产物就会出现「安装包写 0.1.1、关于页 / 上报写
 * 0.1.0」或 updater 版本比对错位；原 release.yml 只比对 tauri.conf.json 一处，
 * 无法发现这类漂移。
 *
 * 契约标记：@zero-tolerance（不读基线；所有来源必须完全一致）
 *
 * 用法：
 *   node scripts/check-release-version.mjs            # 仅校验仓库内各处一致
 *   node scripts/check-release-version.mjs v0.1.1     # 另校验与发布 tag 一致（须带 v 前缀）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 产品版本所在 workspace 包（package.json / package-lock.json 两侧都要一致） */
const PRODUCT_PACKAGES = ['apps/agent-workbench', 'apps/crish-desktop'];
/** Cargo.lock 中代表桌面产品的 crate 名（apps/agent-workbench/src-tauri） */
const PRODUCT_CRATE = 'crish-agent-workbench';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readText(root, rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

function readJson(root, rel) {
  return JSON.parse(readText(root, rel));
}

/** 取 TOML 某个 [section] 表内的 version = "x"（不跨入下一个表头） */
export function tomlSectionVersion(text, section) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      inSection = header[1].trim() === section;
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*version\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return undefined;
}

/** 取 Cargo.lock 中 name = "<crate>" 条目的 version */
export function cargoLockVersion(text, crate) {
  const blocks = text.split(/\r?\n(?=\[\[package\]\])/);
  for (const block of blocks) {
    const name = block.match(/^name = "([^"]+)"/m);
    if (name && name[1] === crate) {
      const v = block.match(/^version = "([^"]+)"/m);
      return v ? v[1] : undefined;
    }
  }
  return undefined;
}

/** 收集所有产品版本来源：[{ source, version }] */
export function collectVersions(root = ROOT) {
  const out = [];
  out.push({
    source: 'apps/agent-workbench/src-tauri/tauri.conf.json#version',
    version: readJson(root, 'apps/agent-workbench/src-tauri/tauri.conf.json').version,
  });
  out.push({
    source: 'Cargo.toml#[workspace.package].version',
    version: tomlSectionVersion(readText(root, 'Cargo.toml'), 'workspace.package'),
  });
  out.push({
    source: `Cargo.lock#${PRODUCT_CRATE}`,
    version: cargoLockVersion(readText(root, 'Cargo.lock'), PRODUCT_CRATE),
  });
  out.push({ source: 'package.json#version', version: readJson(root, 'package.json').version });
  for (const pkg of PRODUCT_PACKAGES) {
    out.push({ source: `${pkg}/package.json#version`, version: readJson(root, `${pkg}/package.json`).version });
  }
  const lock = readJson(root, 'package-lock.json');
  out.push({ source: 'package-lock.json#version', version: lock.version });
  out.push({ source: 'package-lock.json#packages[""].version', version: lock.packages?.['']?.version });
  for (const pkg of PRODUCT_PACKAGES) {
    out.push({ source: `package-lock.json#packages["${pkg}"].version`, version: lock.packages?.[pkg]?.version });
  }
  return out;
}

/**
 * 校验：返回错误信息数组（空数组 = 通过）。
 * @param {{ source: string, version: string | undefined }[]} versions
 * @param {string | undefined} tag 发布 tag（须为 v<semver>）；undefined 时只校验内部一致
 */
export function validate(versions, tag) {
  const errors = [];
  for (const { source, version } of versions) {
    if (typeof version !== 'string' || version === '') {
      errors.push(`${source}: 未找到版本号`);
    } else if (!SEMVER.test(version)) {
      errors.push(`${source}: "${version}" 不是合法 semver`);
    }
  }
  const expected = versions[0]?.version;
  for (const { source, version } of versions.slice(1)) {
    if (typeof version === 'string' && version !== expected) {
      errors.push(`${source}: ${version} ≠ tauri.conf.json ${expected}`);
    }
  }
  if (tag !== undefined) {
    if (!/^v/.test(tag)) {
      errors.push(`发布 tag "${tag}" 必须带 v 前缀（如 v${expected}）`);
    } else if (tag !== `v${expected}`) {
      errors.push(`发布 tag ${tag} ≠ 仓库产品版本 v${expected}`);
    }
  }
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--guide')) {
    console.log('[check-release-version] 正确做法 · 五元规约\n');
    for (const l of [
      '违反项：产品版本号在 tauri.conf.json / Cargo.toml / Cargo.lock / package.json / package-lock.json 之间不一致，或与发布 tag 不一致。',
      '文件:行号 / 当前值：FAIL 输出逐条列出来源与取值。',
      '阈值：全部来源完全相等；带 tag 参数时 tag === v<version>。',
      '正确做法：同一提交内同步修改所有来源，再运行 npm install --package-lock-only 与 cargo update -w 刷新锁文件；不得只改 tag。',
      '复核：node scripts/check-release-version.mjs [vX.Y.Z]  # 期望 OK',
    ]) console.log('  ' + l);
    return 0;
  }
  const tag = args.find((a) => !a.startsWith('--'));
  const versions = collectVersions();
  for (const { source, version } of versions) console.log(`  ${source} = ${version ?? '<缺失>'}`);
  const errors = validate(versions, tag);
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::SEC-06 ${e}`);
    console.error(`[check-release-version] FAIL ${errors.length} 处不一致`);
    return 1;
  }
  console.log(`[check-release-version] OK ${versions[0].version}${tag ? `（tag ${tag}）` : ''}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}