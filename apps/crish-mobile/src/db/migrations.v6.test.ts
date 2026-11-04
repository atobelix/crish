// v6 SQLite 迁移与 DAO 健壮解码器单测（对齐 06-分维 §3 / W1-6 验收）
//
// 覆盖：
// 1. 从 v5 数据库平滑升级到 v6、版本推进断言；
// 2. 5 个新增可空 JSON 列的存在性验证（hasColumn）；
// 3. 存量消息数据无损保留（原有文本、附件、标记完全一致，新列缺省为 undefined）；
// 4. 带工具调用、执行结果、搜索状态、引用来源与服务端诊断的消息 100% 往返还原（Round-trip）；
// 5. 消息更新（ON CONFLICT DO UPDATE SET）原子回写断言；
// 6. 健壮纯函数解码器（safeJsonParse 及 5 大 decoders）损坏数据容错防护；
// 7. 迁移幂等性（重复执行不报错、不破坏数据）。

import { MemorySqlDriver } from './driver';
import { migrateIfNeeded } from './db';
import { LATEST_VERSION, MIGRATIONS } from './migrations';
import { SCHEMA_VERSION } from './schema';
import {
  hasColumn,
  migrateV6WebSearchAndTools,
  V6_COLUMNS,
} from './migrations/v6_web_search_and_tools';
import {
  SqlLocalThreadsDao,
  safeJsonParse,
  parseToolCalls,
  parseCitations,
  parseSearchState,
  parseServerDiagnostics,
} from './dao/localThreadsDao';
import type {
  LocalChatMessage,
  LocalThreadMeta,
} from '@/domain/types/localChat';

function makeMeta(
  overrides: Partial<LocalThreadMeta> & { id: string }
): LocalThreadMeta {
  return {
    title: '测试线程',
    titleSource: 'derived',
    preview: '',
    modelRef: { providerId: 'p1', modelId: 'm1' },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('v6 数据库迁移：平滑升级与版本推进', () => {
  it('从 v5 数据库平滑升级到 v6，PRAGMA user_version 推进至 6', async () => {
    const db = new MemorySqlDriver();
    // 1. 模拟存量 v5 数据库（只跑前 5 个迁移）
    const v5Migrations = MIGRATIONS.slice(0, 5);
    const v5Version = await migrateIfNeeded(db, v5Migrations);
    expect(v5Version).toBe(5);
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: 5,
    });

    // 2. 在 v5 库中写入存量线程与消息（带有 v5 attachments_json）
    await db.exec(
      'INSERT INTO local_threads (id, title, title_source, preview, provider_id, model_id, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['t1', '历史线程', 'user', '摘要预览', 'p1', 'm1', 1000, 2000]
    );

    const attachmentsJson = JSON.stringify([
      {
        id: 'att_1',
        name: 'test.jpg',
        kind: 'image',
        dataUrl: 'data:image/jpeg;base64,ABCDEF',
        sizeBytes: 1234,
      },
    ]);

    await db.exec(
      'INSERT INTO local_messages (id, thread_id, seq, role, content, stopped, tool_call_count, attachments_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['msg_old_1', 't1', 0, 'user', '用户提问', 0, null, attachmentsJson]
    );

    await db.exec(
      'INSERT INTO local_messages (id, thread_id, seq, role, content, stopped, tool_call_count, attachments_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['msg_old_2', 't1', 1, 'assistant', '历史回答', 1, 3, null]
    );

    // 3. 执行全量迁移（v5 -> v6）
    const v6Version = await migrateIfNeeded(db);
    expect(v6Version).toBe(6);
    expect(v6Version).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBe(SCHEMA_VERSION);
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: 6,
    });

    // 4. 验证存量消息无损保留
    const dao = new SqlLocalThreadsDao(db);
    const messages = await dao.listMessages('t1');
    expect(messages).toHaveLength(2);

    // 验证 msg_old_1
    const m1 = messages[0]!;
    expect(m1.id).toBe('msg_old_1');
    expect(m1.role).toBe('user');
    expect(m1.content).toBe('用户提问');
    expect(m1.attachments).toHaveLength(1);
    expect(m1.attachments![0]!.id).toBe('att_1');
    expect(m1.attachments![0]!.dataUrl).toBe('data:image/jpeg;base64,ABCDEF');
    // 新增字段在存量数据中应自然为 undefined
    expect(m1.toolCalls).toBeUndefined();
    expect(m1.toolResults).toBeUndefined();
    expect(m1.citations).toBeUndefined();
    expect(m1.searchState).toBeUndefined();
    expect(m1.serverToolDiagnostics).toBeUndefined();

    // 验证 msg_old_2
    const m2 = messages[1]!;
    expect(m2.id).toBe('msg_old_2');
    expect(m2.role).toBe('assistant');
    expect(m2.content).toBe('历史回答');
    expect(m2.stopped).toBe(true);
    expect(m2.toolCallCount).toBe(3);
    expect(m2.attachments).toBeUndefined();
    expect(m2.toolCalls).toBeUndefined();
    expect(m2.toolResults).toBeUndefined();
    expect(m2.citations).toBeUndefined();
    expect(m2.searchState).toBeUndefined();
    expect(m2.serverToolDiagnostics).toBeUndefined();
  });
});

describe('v6 数据库迁移：列存在性与幂等性验证', () => {
  it('验证 local_messages 表包含全部 5 个新增 JSON 文本列', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);

    for (const col of V6_COLUMNS) {
      const exists = await hasColumn(db, 'local_messages', col.name);
      expect(exists).toBe(true);
    }

    // 验证不存在的伪列返回 false
    const nonExistent = await hasColumn(
      db,
      'local_messages',
      'non_existent_column'
    );
    expect(nonExistent).toBe(false);
  });

  it('重复执行 migrateIfNeeded 与 migrateV6WebSearchAndTools 具备严格幂等性', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);

    // 重复执行 migrateIfNeeded
    await expect(migrateIfNeeded(db)).resolves.toBe(LATEST_VERSION);

    // 直接调用 migrateV6WebSearchAndTools
    await expect(migrateV6WebSearchAndTools(db)).resolves.not.toThrow();
    await expect(migrateV6WebSearchAndTools(db)).resolves.not.toThrow();

    // 检查表数据结构与版本未损坏
    await expect(db.getFirst('PRAGMA user_version')).resolves.toEqual({
      user_version: LATEST_VERSION,
    });
  });
});

describe('SqlLocalThreadsDao：带工具调用与引用消息 100% 还原往返断言', () => {
  it('单条消息容纳全部 5 个维度的工具与搜索元数据，保存并完整读出', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlLocalThreadsDao(db);

    await dao.upsertThread(makeMeta({ id: 'thread_agent_1' }));

    const complexMessage: LocalChatMessage = {
      id: 'msg_agent_1',
      role: 'assistant',
      content: '根据检索结果，Expo SQLite 在移动端具备极高性能。',
      stopped: false,
      toolCallCount: 1,
      toolCalls: [
        {
          id: 'call_search_101',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: JSON.stringify({
              query: 'React Native Expo SQLite performance',
            }),
          },
          status: 'success',
          startedAt: 1700000000000,
          completedAt: 1700000001200,
        },
      ],
      toolResults: [
        {
          toolCallId: 'call_search_101',
          name: 'web_search',
          content: 'Found 3 results from Expo docs',
          isError: false,
          timingMs: 1200,
        },
      ],
      searchState: {
        phase: 'done',
        currentQuery: 'React Native Expo SQLite performance',
        queryHistory: [
          'React Native Expo SQLite performance',
          'expo-sqlite v6 migrations',
        ],
        fetchedUrls: [
          'https://docs.expo.dev/versions/latest/sdk/sqlite/',
          'https://reactnative.dev/docs/sqlite',
        ],
        activeEngine: 'tavily',
        isFallback: true,
        fallbackReason: 'Brave search rate limited, switched to Tavily',
        latencyMs: 1200,
        totalResults: 3,
      },
      citations: [
        {
          index: 1,
          title: 'Expo SQLite SDK Reference',
          url: 'https://docs.expo.dev/versions/latest/sdk/sqlite/',
          snippet: 'Use SQLite in Expo apps with asynchronous queries.',
          hostname: 'docs.expo.dev',
          iconUrl: 'https://docs.expo.dev/favicon.ico',
          engine: 'tavily',
          publishedAt: '2026-03-01',
          content:
            '# SQLite Documentation\nFull markdown content snippet here...',
        },
        {
          index: 2,
          title: 'React Native SQLite Community',
          url: 'https://reactnative.dev/docs/sqlite',
          snippet: 'Community guides and best practices for SQLite.',
          hostname: 'reactnative.dev',
          engine: 'tavily',
        },
      ],
      serverToolDiagnostics: [
        {
          vendor: 'google',
          capability: 'grounding',
          rawMetadataJson: JSON.stringify({
            webSearchSources: [{ uri: 'https://docs.expo.dev', title: 'Expo' }],
          }),
          extractedQueries: ['React Native Expo SQLite performance'],
          groundingScore: 0.96,
        },
        {
          vendor: 'anthropic',
          capability: 'web_search',
          rawMetadataJson: '{"tool_use_id":"toolu_01"}',
        },
      ],
    };

    // 1. 保存复杂消息
    await dao.saveMessage('thread_agent_1', 0, complexMessage);

    // 2. 通过 listMessages 读取并深度比对
    const messages = await dao.listMessages('thread_agent_1');
    expect(messages).toHaveLength(1);
    const read = messages[0]!;

    expect(read.id).toBe(complexMessage.id);
    expect(read.role).toBe(complexMessage.role);
    expect(read.content).toBe(complexMessage.content);
    expect(read.toolCallCount).toBe(1);

    // 深度验证 toolCalls
    expect(read.toolCalls).toEqual(complexMessage.toolCalls);
    expect(read.toolCalls![0]!.status).toBe('success');
    expect(read.toolCalls![0]!.startedAt).toBe(1700000000000);

    // 深度验证 toolResults
    expect(read.toolResults).toEqual(complexMessage.toolResults);
    expect(read.toolResults![0]!.isError).toBe(false);
    expect(read.toolResults![0]!.timingMs).toBe(1200);

    // 深度验证 searchState
    expect(read.searchState).toEqual(complexMessage.searchState);
    expect(read.searchState!.phase).toBe('done');
    expect(read.searchState!.isFallback).toBe(true);
    expect(read.searchState!.queryHistory).toHaveLength(2);
    expect(read.searchState!.fetchedUrls).toHaveLength(2);

    // 深度验证 citations
    expect(read.citations).toEqual(complexMessage.citations);
    expect(read.citations).toHaveLength(2);
    expect(read.citations![0]!.index).toBe(1);
    expect(read.citations![0]!.url).toBe(
      'https://docs.expo.dev/versions/latest/sdk/sqlite/'
    );
    expect(read.citations![1]!.index).toBe(2);

    // 深度验证 serverToolDiagnostics
    expect(read.serverToolDiagnostics).toEqual(
      complexMessage.serverToolDiagnostics
    );
    expect(read.serverToolDiagnostics![0]!.vendor).toBe('google');
    expect(read.serverToolDiagnostics![0]!.groundingScore).toBe(0.96);
    expect(read.serverToolDiagnostics![1]!.vendor).toBe('anthropic');

    // 3. 通过 listAllMessages 读取，验证同样无损还原
    const all = await dao.listAllMessages();
    expect(all).toHaveLength(1);
    expect(all[0]!.threadId).toBe('thread_agent_1');
    expect(all[0]!.seq).toBe(0);
    expect(all[0]!.message).toEqual(read);
  });

  it('流式中间状态回写更新（ON CONFLICT DO UPDATE SET）原子生效', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlLocalThreadsDao(db);
    await dao.upsertThread(makeMeta({ id: 't_stream' }));

    // 初始状态：正在搜索中
    const initialMessage: LocalChatMessage = {
      id: 'msg_stream_1',
      role: 'assistant',
      content: '正在联网检索...',
      searchState: {
        phase: 'searching',
        currentQuery: 'AI Agent Loop',
        queryHistory: ['AI Agent Loop'],
        fetchedUrls: [],
        activeEngine: 'brave',
      },
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '{"query":"AI Agent Loop"}',
          },
          status: 'running',
          startedAt: 1700000000000,
        },
      ],
    };
    await dao.saveMessage('t_stream', 0, initialMessage);

    const firstRead = (await dao.listMessages('t_stream'))[0]!;
    expect(firstRead.searchState?.phase).toBe('searching');
    expect(firstRead.toolCalls?.[0]?.status).toBe('running');
    expect(firstRead.citations).toBeUndefined();

    // 模拟搜索完成并生成最终总结后，原子回写更新同一条消息
    const finalizedMessage: LocalChatMessage = {
      id: 'msg_stream_1',
      role: 'assistant',
      content: '检索完毕，AI Agent Loop 是自主循环系统。',
      stopped: true,
      searchState: {
        phase: 'done',
        currentQuery: 'AI Agent Loop',
        queryHistory: ['AI Agent Loop'],
        fetchedUrls: ['https://example.com/agent-loop'],
        activeEngine: 'brave',
        latencyMs: 800,
        totalResults: 5,
      },
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '{"query":"AI Agent Loop"}',
          },
          status: 'success',
          startedAt: 1700000000000,
          completedAt: 1700000000800,
        },
      ],
      toolResults: [
        {
          toolCallId: 'call_1',
          name: 'web_search',
          content: 'Agent Loop documentation summary',
          timingMs: 800,
        },
      ],
      citations: [
        {
          index: 1,
          title: 'Agent Loop Spec',
          url: 'https://example.com/agent-loop',
          snippet: 'Agent Loop architecture definition',
        },
      ],
    };

    await dao.saveMessage('t_stream', 0, finalizedMessage);

    const updated = (await dao.listMessages('t_stream'))[0]!;
    expect(updated.content).toBe('检索完毕，AI Agent Loop 是自主循环系统。');
    expect(updated.stopped).toBe(true);
    expect(updated.searchState?.phase).toBe('done');
    expect(updated.searchState?.latencyMs).toBe(800);
    expect(updated.toolCalls?.[0]?.status).toBe('success');
    expect(updated.toolResults).toHaveLength(1);
    expect(updated.citations).toHaveLength(1);
    expect(updated.citations?.[0]?.title).toBe('Agent Loop Spec');
  });
});

describe('健壮纯函数解码器（Robust Pure Decoders）安全熔断与容错', () => {
  it('safeJsonParse：对于损坏或非字符串数据安全返回 undefined，不抛错', () => {
    expect(safeJsonParse(null)).toBeUndefined();
    expect(safeJsonParse(undefined)).toBeUndefined();
    expect(safeJsonParse('')).toBeUndefined();
    expect(safeJsonParse('{ broken json')).toBeUndefined();
    expect(safeJsonParse('123abc')).toBeUndefined();
    expect(safeJsonParse('{"valid": true}')).toEqual({ valid: true });
  });

  it('parseToolCalls：脏数据剔除与合法性兜底', () => {
    expect(parseToolCalls(null)).toBeUndefined();
    expect(parseToolCalls('')).toBeUndefined();
    expect(parseToolCalls('not json')).toBeUndefined();
    expect(parseToolCalls('{}')).toBeUndefined(); // 非数组
    expect(parseToolCalls('[]')).toBeUndefined(); // 空数组返回 undefined

    // 含有损坏项的数组：合法项保留，脏项剔除，非法 status 降级为 success
    const raw = JSON.stringify([
      null,
      123,
      { id: 'call_invalid_no_func' },
      {
        id: 'call_valid',
        function: { name: 'search', arguments: '{}' },
        status: 'flying',
      },
      {
        id: 'call_2',
        function: { name: 'code', arguments: '1+1' },
        status: 'error',
        error: 'boom',
      },
    ]);
    const calls = parseToolCalls(raw);
    expect(calls).toHaveLength(2);
    expect(calls![0]!.id).toBe('call_valid');
    expect(calls![0]!.status).toBe('success'); // 'flying' 降级为 'success'
    expect(calls![1]!.id).toBe('call_2');
    expect(calls![1]!.status).toBe('error');
    expect(calls![1]!.error).toBe('boom');
  });

  it('parseCitations：过滤非 HTTP URL 与非结构化数据', () => {
    expect(parseCitations(null)).toBeUndefined();
    expect(parseCitations('invalid')).toBeUndefined();
    expect(parseCitations('[]')).toBeUndefined();

    const raw = JSON.stringify([
      { url: 'javascript:alert(1)', title: 'XSS attempt' }, // 非 http，必须剔除
      { title: 'No url' }, // 无 url，剔除
      { url: 'https://valid.com/page1', title: 'Valid 1' },
      { url: 'http://valid.com/page2', snippet: 'snippet 2' },
    ]);
    const citations = parseCitations(raw);
    expect(citations).toHaveLength(2);
    expect(citations![0]!.url).toBe('https://valid.com/page1');
    expect(citations![0]!.index).toBe(1);
    expect(citations![1]!.url).toBe('http://valid.com/page2');
    expect(citations![1]!.title).toBe('网页引用'); // 缺省标题兜底
    expect(citations![1]!.snippet).toBe('snippet 2');
  });

  it('parseSearchState：非法枚举与脏字段自动纠偏', () => {
    expect(parseSearchState(null)).toBeUndefined();
    expect(parseSearchState('{}')).toEqual({
      phase: 'done', // 缺失 phase 兜底为 'done'
      queryHistory: [],
      fetchedUrls: [],
    });

    const raw = JSON.stringify({
      phase: 'unknown_phase',
      currentQuery: 'query 1',
      queryHistory: 'not an array', // 脏数据应安全收敛为 []
      fetchedUrls: ['https://a.com'],
      isFallback: 1, // truthy 转换为 boolean
      latencyMs: 'fast', // 非 number 被忽略
    });
    const state = parseSearchState(raw);
    expect(state).toBeDefined();
    expect(state!.phase).toBe('done');
    expect(state!.currentQuery).toBe('query 1');
    expect(state!.queryHistory).toEqual([]);
    expect(state!.fetchedUrls).toEqual(['https://a.com']);
    expect(state!.isFallback).toBe(true);
    expect(state!.latencyMs).toBeUndefined();
  });

  it('parseServerDiagnostics：非法供应商与类型安全过滤', () => {
    expect(parseServerDiagnostics(null)).toBeUndefined();
    const raw = JSON.stringify([
      { vendor: 'unknown_vendor', capability: 'grounding' }, // 非法 vendor 过滤
      { vendor: 'google', capability: 'invalid_cap' }, // 非法 capability 过滤
      {
        vendor: 'openai',
        capability: 'web_search',
        rawMetadataJson: '{"id":"s1"}',
        extractedQueries: ['q1', 'q2'],
        groundingScore: 0.88,
      },
    ]);
    const diagnostics = parseServerDiagnostics(raw);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics![0]!.vendor).toBe('openai');
    expect(diagnostics![0]!.capability).toBe('web_search');
    expect(diagnostics![0]!.extractedQueries).toEqual(['q1', 'q2']);
    expect(diagnostics![0]!.groundingScore).toBe(0.88);
  });

  it('极端容错：数据库底层存在恶意/损坏的 JSON 文本时，整行消息依然可读', async () => {
    const db = new MemorySqlDriver();
    await migrateIfNeeded(db);
    const dao = new SqlLocalThreadsDao(db);

    await dao.upsertThread(makeMeta({ id: 't_corrupt' }));

    // 直接通过底层 SQL 注入恶意/损坏的 JSON 数据
    await db.exec(
      'INSERT INTO local_messages (' +
        'id, thread_id, seq, role, content, stopped, tool_call_count, attachments_json, ' +
        'tool_calls_json, tool_results_json, citations_json, search_state_json, server_diagnostics_json' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'msg_corrupted',
        't_corrupt',
        0,
        'assistant',
        '重要历史回复内容',
        0,
        null,
        '{ corrupt attachments',
        '<<< invalid tool calls json >>>',
        '["broken result json',
        '[{ "url": "not an http url" }]',
        'null_or_corrupt_search_state',
        '{ invalid server diagnostic',
      ]
    );

    // 验证 DAO 读取绝不崩溃抛出异常，基础内容保持完整
    const messages = await dao.listMessages('t_corrupt');
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.id).toBe('msg_corrupted');
    expect(m.content).toBe('重要历史回复内容');
    expect(m.role).toBe('assistant');
    // 所有损坏列安全降级为 undefined
    expect(m.attachments).toBeUndefined();
    expect(m.toolCalls).toBeUndefined();
    expect(m.toolResults).toBeUndefined();
    expect(m.citations).toBeUndefined();
    expect(m.searchState).toBeUndefined();
    expect(m.serverToolDiagnostics).toBeUndefined();
  });
});
