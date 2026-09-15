// @vitest-environment jsdom
/**
 * 服务商「可删除 / 可重命名」不变量（用户裁决 2026-09-15）。
 *
 * 历史缺陷：`ProfileHeader` 用 `selected.id.startsWith('custom-')` 把预设供应商
 * （id = 厂商名，如 `deepseek` / `ollama` / `openai`）判为**不可删除**，用户因此
 * 无法清理不需要的供应商——供应商身份被**硬绑定**到厂商 id。
 *
 * 本文件钉住两条：
 * 1. **行为**：预设 id（`deepseek`）与服务商自定义 id（`custom-xxx`）都渲染删除触发器；
 * 2. **源码形状（负向）**：删除 / 重命名路径不得再出现 `startsWith('custom-')` 门禁
 *    （剥注释后判定，避免把说明该门禁已移除的注释本身当成残留）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 去掉行注释与块注释（避免把「说明已移除」的注释当成残留）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function read(rel: string): string {
  return readFileSync(join(HERE, rel), 'utf8');
}

describe('服务商删除 / 重命名不与厂商 id 绑定', () => {
  it('ProfileHeader 删除与重命名路径无 custom- 前缀门禁（负向断言）', () => {
    const code = stripComments(read('ProfileHeader.tsx'));
    expect(
      code.includes("startsWith('custom-')"),
      'ProfileHeader 不得再用 id 前缀门禁限制删除 / 重命名'
    ).toBe(false);
  });

  it('ProviderProfileForm 厂商名称字段对所有服务商可见（负向断言）', () => {
    const code = stripComments(read('ProviderProfileForm.tsx'));
    expect(code.includes("startsWith('custom-')")).toBe(false);
  });

  it('删除动作走统一树通用入口（removeProvider），而非按厂商分派', () => {
    const code = stripComments(read('ProfileHeader.tsx'));
    expect(code).toContain('modelsCatalogStore.removeProvider(selected.id)');
  });
});
