import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@crish/plugin-sdk/src/manifest';
import {
  declaredToolsInfo,
  manifest,
  PLUGIN_ID,
  TOOL_PARSE_CLAUDE_CODE,
  TOOL_PARSE_CODEX_ROLLOUT,
} from '../manifest';

describe('官方导入插件 manifest', () => {
  it('身份与版本符合 E3 任务卡', () => {
    expect(manifest.id).toBe('@crish/import-claude-codex');
    expect(manifest.name).toBe('Claude/Codex 对话导入');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.trustLevel).toBe('full');
    expect(manifest.entrypoints.main).toBe('./src/index.ts');
    expect(PLUGIN_ID).toBe('@crish/import-claude-codex');
  });

  it('能力清单：两个只读工具 + session.start 钩子', () => {
    expect(manifest.declaredTools).toEqual([
      'parse-claude-code-jsonl',
      'parse-codex-rollout-jsonl',
    ]);
    expect(manifest.declaredHooks).toEqual(['session.start']);
    expect(manifest.declaredMcpServers).toEqual([]);
    expect(TOOL_PARSE_CLAUDE_CODE).toBe('parse-claude-code-jsonl');
    expect(TOOL_PARSE_CODEX_ROLLOUT).toBe('parse-codex-rollout-jsonl');
  });

  it('权限最小面：hook:observe + tool:execute', () => {
    expect(manifest.permissions).toEqual(['hook:observe', 'tool:execute']);
  });

  it('工具声明与 declaredTools 一一对应', () => {
    const names = declaredToolsInfo.map((t) => t.name);
    expect(names).toEqual(manifest.declaredTools);
  });

  it('结构契约：可赋给 plugin-sdk 的 PluginManifest（双向锁定）', () => {
    // 类型层断言（编译期）：manifest 须满足 @crish/plugin-sdk 的声明契约。
    const asSdkManifest: PluginManifest = manifest;
    expect(asSdkManifest.id).toBe(manifest.id);
  });
});
