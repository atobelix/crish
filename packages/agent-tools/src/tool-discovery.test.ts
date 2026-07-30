import { describe, expect, it } from 'vitest';
import type { AgentTool, ToolSource } from '@crish/shared-types';
import type { JsonObject } from '@crish/shared-types';
import {
  DeferredToolSource,
  ToolDiscoveryIndex,
  tokenizeToolDiscoveryText,
} from './tool-discovery';

function makeTool(options: {
  name: string;
  label?: string;
  description?: string;
  category?: AgentTool['category'];
  schemaKeys?: string[];
}): AgentTool {
  return {
    name: options.name,
    label: options.label ?? options.name,
    description: options.description ?? `${options.name} tool`,
    category: options.category ?? 'internal',
    concurrency: 'parallel',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        (options.schemaKeys ?? []).map((key) => [key, { type: 'string' }])
      ),
    },
    isReadOnly: () => true,
    summarize: () => options.name,
    async execute(input: JsonObject) {
      return { text: String(input.value ?? 'ok') };
    },
  };
}

describe('ToolDiscoveryIndex', () => {
  it('tokenizes identifiers, accents, and camel case consistently', () => {
    expect(tokenizeToolDiscoveryText('mcp__GitHubCreateIssue cafe')).toEqual([
      'mcp',
      'git',
      'hub',
      'create',
      'issue',
      'cafe',
    ]);
  });

  it('ranks tools across name, label, description, category, and explicit tokens', () => {
    const index = new ToolDiscoveryIndex([
      makeTool({
        name: 'mcp__github_create_issue',
        label: 'GitHub issue',
        description: 'Create an issue in a repository',
        category: 'mcp',
        schemaKeys: ['owner', 'repo', 'title', 'body'],
      }),
      makeTool({
        name: 'mcp__slack_post_message',
        label: 'Slack message',
        description: 'Post a message to a channel',
        category: 'mcp',
        schemaKeys: ['channel', 'text'],
      }),
      {
        tool: makeTool({
          name: 'file_digest',
          label: 'File digest',
          description: 'Summarize a local file',
          category: 'filesystem',
        }),
        tokens: ['checksum', 'hash'],
      },
    ]);

    const githubResults = index.search('github issue', { maxResults: 5 });
    expect(githubResults[0]?.tool.name).toBe('mcp__github_create_issue');
    expect(githubResults[0]?.fieldScores.name).toBeGreaterThan(0);
    expect(githubResults[0]?.fieldScores.label).toBeGreaterThan(0);
    expect(githubResults[0]?.fieldScores.description).toBeGreaterThan(0);

    const categoryResults = index.search('mcp', { maxResults: 5 });
    expect(categoryResults[0]?.fieldScores.category).toBeGreaterThan(0);

    const tokenResults = index.search('checksum', { maxResults: 5 });
    expect(tokenResults[0]?.tool.name).toBe('file_digest');
    expect(tokenResults[0]?.fieldScores.token).toBeGreaterThan(0);
  });

  it('respects maxResults and excludes names', () => {
    const index = new ToolDiscoveryIndex(
      [
        makeTool({ name: 'alpha_read', description: 'Read alpha data' }),
        makeTool({ name: 'beta_read', description: 'Read beta data' }),
        makeTool({ name: 'gamma_read', description: 'Read gamma data' }),
      ],
      { maxResults: 2 }
    );

    expect(index.search('read').map((result) => result.tool.name)).toHaveLength(
      2
    );
    expect(
      index.search('read', { maxResults: 1 }).map((result) => result.tool.name)
    ).toHaveLength(1);
    expect(
      index
        .search('read', { excludeNames: ['alpha_read'], maxResults: 3 })
        .map((result) => result.tool.name)
    ).not.toContain('alpha_read');
  });

  it('rejects empty queries and invalid result caps', () => {
    const index = new ToolDiscoveryIndex([makeTool({ name: 'read' })]);
    expect(() => index.search('   ')).toThrow(
      'Query must contain at least one letter or number.'
    );
    expect(() => index.search('read', { maxResults: 0 })).toThrow(
      'maxResults must be a positive integer.'
    );
  });
});

describe('DeferredToolSource', () => {
  it('starts with active tools only, then activates deferred matches by query', async () => {
    const read = makeTool({
      name: 'read',
      description: 'Read files',
      category: 'filesystem',
    });
    const githubIssue = makeTool({
      name: 'mcp__github_create_issue',
      label: 'GitHub create issue',
      description: 'Create issues in GitHub repositories',
      category: 'mcp',
      schemaKeys: ['owner', 'repo', 'title'],
    });
    const slackPost = makeTool({
      name: 'mcp__slack_post_message',
      label: 'Slack post message',
      description: 'Send channel messages',
      category: 'mcp',
      schemaKeys: ['channel', 'text'],
    });
    const source = new DeferredToolSource({
      activeTools: [read],
      deferredTools: [githubIssue, slackPost],
      maxResults: 1,
    });

    await expect(source.listTools()).resolves.toEqual([read]);

    const activation = await source.activate('github issue');
    expect(activation.activatedNames).toEqual(['mcp__github_create_issue']);
    await expect(source.listTools()).resolves.toEqual([read, githubIssue]);

    const nextMatches = await source.search('github issue');
    expect(nextMatches.map((match) => match.tool.name)).not.toContain(
      'mcp__github_create_issue'
    );
  });

  it('implements ToolSource while wrapping another deferred source', async () => {
    const active = makeTool({
      name: 'bash',
      description: 'Run shell commands',
      category: 'terminal',
    });
    const hidden = makeTool({
      name: 'web_fetch',
      description: 'Fetch a URL over the network',
      category: 'network',
    });
    const deferredSource: ToolSource = {
      id: 'remote',
      label: 'Remote',
      async listTools() {
        return [hidden];
      },
    };
    const source: ToolSource = new DeferredToolSource({
      tools: [active],
      deferredSource,
    });

    expect((await source.listTools()).map((tool) => tool.name)).toEqual([
      'bash',
    ]);

    const deferred = source as DeferredToolSource;
    await deferred.activate('fetch url');

    expect((await source.listTools()).map((tool) => tool.name)).toEqual([
      'bash',
      'web_fetch',
    ]);
  });
});
