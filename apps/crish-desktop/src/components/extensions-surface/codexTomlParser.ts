/**
 * Codex config.toml 轻量解析器，用于提取 [mcp_servers.<name>] 字段
 */
import { resolveMcpTools } from './knownMcpTools';
import type {
  DetectedExternalMcpServer,
  DetectedExternalMcpSource,
} from './detectExternalMcpServers';

export function parseCodexToml(
  rawToml: string,
  source: DetectedExternalMcpSource = 'Codex'
): DetectedExternalMcpServer[] {
  const results: DetectedExternalMcpServer[] = [];
  const sectionRegex = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm;
  const sections: { name: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(rawToml)) !== null) {
    if (match[1]) {
      sections.push({
        name: match[1],
        start: match.index + match[0].length,
        end: rawToml.length,
      });
    }
  }

  for (let i = 0; i < sections.length; i++) {
    const curr = sections[i];
    if (curr && i + 1 < sections.length && sections[i + 1]) {
      curr.end = sections[i + 1]!.start - 1;
    }
  }

  for (const sec of sections) {
    const body = rawToml.slice(sec.start, sec.end);
    const enabledMatch = body.match(/^enabled\s*=\s*(false|true)/m);
    if (enabledMatch?.[1] === 'false') continue;

    const cmdMatch = body.match(/^command\s*=\s*['"]([^'"]+)['"]/m);
    const command = cmdMatch?.[1];
    const urlMatch = body.match(/^url\s*=\s*['"]([^'"]+)['"]/m);
    const url = urlMatch?.[1];
    if (!command && !url) continue;

    let args: string[] | undefined;
    const argsMatch = body.match(/^args\s*=\s*\[([\s\S]*?)\]/m);
    if (argsMatch?.[1]) {
      args = Array.from(argsMatch[1].matchAll(/['"]([^'"]*)['"]/g))
        .map((m) => m[1])
        .filter((s): s is string => typeof s === 'string');
    }

    const typeMatch = body.match(/^type\s*=\s*['"](stdio|sse)['"]/m);
    const type: 'stdio' | 'sse' =
      typeMatch?.[1] === 'sse' || url ? 'sse' : 'stdio';

    let env: Record<string, string> | undefined;
    // 注意：JS 非 unicode 模式下 \Z 是字面字母 Z 而非字符串结尾断言（曾导致 ZHIPU_API_KEY
    // 等 Z 开头的 env 变量在 lazy 匹配处被截断丢失）。此处用 $(?![\s\S]) 表达真文件末尾，
    // 与 m flag 下的行尾 $ 区分开。
    const envSubRegex = new RegExp(
      `^\\[mcp_servers\\.${sec.name}\\.env\\]([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`,
      'm'
    );
    const envSubMatch = rawToml.match(envSubRegex);
    if (envSubMatch?.[1]) {
      env = {};
      const envLines = envSubMatch[1].split(/[\r\n]+/);
      for (const el of envLines) {
        const m = el.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*['"]([^'"]*)['"]/);
        if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2];
      }
    }

    const resolvedTools = resolveMcpTools(sec.name, command, args);
    results.push({
      id: `detected-codex-${sec.name}`,
      source,
      name: sec.name,
      type,
      command,
      args,
      env: env && Object.keys(env).length > 0 ? env : undefined,
      url,
      description: `Codex 本地 MCP 服务 (${sec.name})`,
      tools: resolvedTools.length > 0 ? resolvedTools : undefined,
      toolsCount: resolvedTools.length > 0 ? resolvedTools.length : undefined,
    });
  }

  return results;
}
