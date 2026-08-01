// packages/plugin-sdk/src/registry/plugin-discoverer.ts
// 约束来源：ROUND-08-plugin-sdk.md §3.6 + 禁令 15/16/17（仅 user-dir + project-dir）
//
// 迁移自 agent-runtime/src/plugin-fs-registry.ts（113 行双源发现 + 安全门）。
// 系统化改进：
// - 发现与加载职责分离（Discoverer 只发现 manifest，Loader 负责动态 import）
// - manifest 校验委托 8-A 的 validateManifest（纯函数，不抛错，返回错误清单）
// - full 级别 + project-dir 自动降级为 restricted（防仓库投毒，禁令 18）
// - DiscoveredPlugin 携带 origin + pluginDir + entryPath，供 Loader 直接使用

import { readdir, readFile, access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { PluginManifest, PluginOrigin } from '../manifest';
import { validateManifest } from '../manifest';
import type { ManifestValidationResult } from '../manifest';

/**
 * 插件发现器（禁令 15/16/17）。
 *
 * 发现源（仅 2 种）：
 * - user-dir：~/.crish/plugins/<plugin-id>/
 * - project-dir：<cwd>/.crish/plugins/<plugin-id>/
 *
 * 每个插件目录须含：
 * - plugin.json（PluginManifest 序列化，origin 字段由 discoverer 填充）
 * - <entrypoints.main>（入口模块，相对路径）
 *
 * 禁止源（禁令 15/16/17）：mcp / github / inline / npm / global-dir
 *
 * 优先级：project-dir > user-dir（同名覆盖，便于项目级覆盖用户级配置）。
 */
export class PluginDiscoverer {
  /**
   * @param userDir 自定义 user-dir 路径（默认 ~/.crish/plugins）
   * @param projectDir 自定义 project-dir 路径（默认 <cwd>/.crish/plugins）
   */
  constructor(
    private readonly userDir: string = join(homedir(), '.crish', 'plugins'),
    private readonly projectDir: string = join(
      process.cwd(),
      '.crish',
      'plugins',
    ),
  ) {}

  /** 发现全部插件（user-dir 先扫描，project-dir 覆盖同名） */
  async discover(): Promise<DiscoveredPlugin[]> {
    const found = new Map<string, DiscoveredPlugin>();

    // user-dir 优先级低（先扫描，可被 project-dir 覆盖）
    for (const p of await this.scanDir(this.userDir, 'user-dir')) {
      found.set(p.manifest.id, p);
    }
    // project-dir 优先级高（覆盖同名 user-dir 插件）
    for (const p of await this.scanDir(this.projectDir, 'project-dir')) {
      found.set(p.manifest.id, p);
    }

    return [...found.values()];
  }

  /** 暴露发现路径供外部诊断 */
  getPaths(): { userDir: string; projectDir: string } {
    return { userDir: this.userDir, projectDir: this.projectDir };
  }

  /**
   * 扫描单个目录下的全部插件子目录。
   *
   * 系统化设计：目录不存在时静默返回空数组（非错误），
   * manifest 校验失败的插件被跳过并记录 warning（不阻塞其他插件发现）。
   */
  private async scanDir(
    dir: string,
    origin: PluginOrigin,
  ): Promise<DiscoveredPlugin[]> {
    const results: DiscoveredPlugin[] = [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return results; // 目录不存在，静默跳过
    }

    for (const entry of entries) {
      const pluginDir = join(dir, entry);
      const discovered = await this.tryDiscoverPlugin(pluginDir, origin);
      if (discovered) {
        results.push(discovered);
      }
    }
    return results;
  }

  /**
   * 尝试从单个插件目录发现插件。
   * 返回 undefined 表示该目录不是有效插件（manifest 缺失/无效）。
   */
  private async tryDiscoverPlugin(
    pluginDir: string,
    origin: PluginOrigin,
  ): Promise<DiscoveredPlugin | undefined> {
    const manifestPath = join(pluginDir, 'plugin.json');
    try {
      await access(manifestPath);
    } catch {
      return undefined; // 无 plugin.json，跳过
    }

    let raw: unknown;
    try {
      const content = await readFile(manifestPath, 'utf-8');
      raw = JSON.parse(content);
    } catch {
      console.warn(
        `[PluginDiscoverer] skipping ${pluginDir}: plugin.json is not valid JSON`,
      );
      return undefined;
    }

    // 填充 origin（由 discoverer 设置，非作者手动声明）
    const manifest = { ...(raw as Partial<PluginManifest>), origin } as PluginManifest;

    // full 级别仅允许 user-dir（防仓库投毒，禁令 18）
    // project-dir 声明 full 时自动降级为 restricted（在 validation 前，
    // 否则 validateManifest 会以 full-trust-forbidden-origin 拒绝）
    const finalManifest =
      manifest.trustLevel === 'full' && origin === 'project-dir'
        ? downgradeToRestricted(manifest)
        : manifest;

    const validation = validateManifest(finalManifest);
    if (!validation.valid) {
      console.warn(
        `[PluginDiscoverer] skipping ${pluginDir}: manifest invalid: ` +
          validation.errors.map((e) => e.message).join('; '),
      );
      return undefined;
    }

    const entryPath = isAbsolute(finalManifest.entrypoints.main)
      ? finalManifest.entrypoints.main
      : join(pluginDir, finalManifest.entrypoints.main);

    return {
      manifest: finalManifest,
      entryPath,
      pluginDir,
      origin,
      validation,
    };
  }
}

/**
 * 将 project-dir 的 full 级别插件降级为 restricted。
 *
 * 禁令 18：full 级别仅允许 user-dir 来源（防仓库投毒）。
 * project-dir 声明 full 时不拒绝（保持可用），但强制降级为 restricted。
 */
function downgradeToRestricted(
  manifest: PluginManifest,
): PluginManifest {
  console.warn(
    `[PluginDiscoverer] downgrading ${manifest.id} to restricted ` +
      `(full not allowed for project-dir, 禁令 18)`,
  );
  return { ...manifest, trustLevel: 'restricted' };
}

/** 已发现的插件（携带 manifest + 入口路径 + 来源） */
export interface DiscoveredPlugin {
  /** 插件清单（origin 已填充，trustLevel 已按禁令 18 校正） */
  readonly manifest: PluginManifest;
  /** 入口模块绝对路径（供 PluginLoader 动态 import） */
  readonly entryPath: string;
  /** 插件目录绝对路径 */
  readonly pluginDir: string;
  /** 插件来源 */
  readonly origin: PluginOrigin;
  /** manifest 校验结果（discover 阶段已校验，供 Loader 诊断） */
  readonly validation: ManifestValidationResult;
}
