// 本地对话协议纯函数测试：端点归一与桌面 wire_protocol.rs 用例同构、
// 请求体 compact 口径、SSE 分帧、chunk 解析、错误分类优先级。
import {
  SseFrameBuffer,
  StreamingToolCallAccumulator,
  applyChatChunk,
  buildChatCompletionsUrl,
  buildChatHeaders,
  buildChatRequestBody,
  buildLocalChatSystemPrompt,
  buildModelsUrl,
  buildWireMessages,
  classifyHttpError,
  extractErrorDetail,
  localChatErrorMessage,
  localModelVisionSupported,
  mergeModelIds,
  parseModelsList,
  providerDefaultModelId,
  providerSpecFromDraft,
  repairOrphanedToolCalls,
  resolveActiveSelection,
  resolveEffectiveThinkingFormat,
  sanitizeAiTitle,
  validateProviderDraft,
  type LocalWireMessage,
  type LocalWireTool,
} from './localChatProtocol';
import type {
  LocalChatMessage,
  LocalModelSpec,
  LocalModelsConfig,
  LocalProviderDraft,
  LocalProviderSpec,
} from '../types/localChat';

describe('buildChatCompletionsUrl（桌面归一规则同构）', () => {
  it('以 /v1 结尾 → 追加 /chat/completions', () => {
    expect(buildChatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
  });
  it('无版本后缀 → 追加 /v1/chat/completions', () => {
    expect(buildChatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    );
  });
  it('已含 /chat/completions → 原样（含尾斜杠归一）', () => {
    expect(
      buildChatCompletionsUrl('https://api.openai.com/v1/chat/completions/')
    ).toBe('https://api.openai.com/v1/chat/completions');
  });
  it('兼容模式前缀保留（dashscope compatible-mode）', () => {
    expect(
      buildChatCompletionsUrl(
        'https://dashscope.aliyuncs.com/compatible-mode/v1'
      )
    ).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    );
  });
  it('buildModelsUrl 与 chat 端点同级', () => {
    expect(buildModelsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/models'
    );
    expect(buildModelsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/models'
    );
  });
});

describe('buildChatHeaders / buildChatRequestBody', () => {
  it('key 非空 → Bearer；key 为空 → 不发 Authorization（桌面同口径）', () => {
    expect(buildChatHeaders('sk-1').Authorization).toBe('Bearer sk-1');
    expect(buildChatHeaders('').Authorization).toBeUndefined();
    expect(buildChatHeaders(null).Authorization).toBeUndefined();
  });
  it('请求体只含 model/messages/stream，永不声明 tools', () => {
    const body = buildChatRequestBody({
      model: 'm1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'stream']);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });
  it('buildWireMessages：系统提示恒首、跳过流式占位与空消息', () => {
    const history: LocalChatMessage[] = [
      { id: '1', role: 'user', content: 'a' },
      { id: '2', role: 'assistant', content: '', streaming: true },
      { id: '3', role: 'assistant', content: 'b' },
      { id: '4', role: 'user', content: '  ' },
    ];
    const wire = buildWireMessages(history);
    expect(wire[0]?.role).toBe('system');
    expect(wire.slice(1)).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
  });
});

describe('SseFrameBuffer', () => {
  it('跨块切帧 + [DONE] + 注释行忽略', () => {
    const buf = new SseFrameBuffer();
    const first = buf.push(': ping\n\ndata: {"a":1}\n\nda');
    expect(first).toEqual([{ type: 'data', data: '{"a":1}' }]);
    const second = buf.push('ta: [DONE]\n\n');
    expect(second).toEqual([{ type: 'done' }]);
  });
  it('CRLF 分隔与 flush 残余帧', () => {
    const buf = new SseFrameBuffer();
    expect(buf.push('data: x\r\n\r\n')).toEqual([{ type: 'data', data: 'x' }]);
    const buf2 = new SseFrameBuffer();
    expect(buf2.push('data: tail')).toEqual([]);
    expect(buf2.flush()).toEqual([{ type: 'data', data: 'tail' }]);
  });
});

describe('applyChatChunk', () => {
  it('正文增量 + finish_reason', () => {
    const d = applyChatChunk(
      JSON.stringify({
        choices: [{ delta: { content: '你好' }, finish_reason: null }],
      })
    );
    expect(d?.contentDelta).toBe('你好');
    expect(d?.finishReason).toBeNull();
    const end = applyChatChunk(
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      })
    );
    expect(end?.finishReason).toBe('stop');
  });
  it('tool_calls 只记名（本地不执行）+ reasoning 探测', () => {
    const d = applyChatChunk(
      JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: '想…',
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'get_weather', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    expect(d?.reasoningDelta).toBe('想…');
    expect(d?.toolCallNames).toEqual(['get_weather']);
    expect(d?.finishReason).toBe('tool_calls');
  });
  it('非法 JSON / 无 choice → null；非流式 message 兜底', () => {
    expect(applyChatChunk('not json')).toBeNull();
    expect(applyChatChunk(JSON.stringify({ choices: [] }))).toBeNull();
    const d = applyChatChunk(
      JSON.stringify({
        choices: [{ message: { content: '整段' }, finish_reason: 'stop' }],
      })
    );
    expect(d?.contentDelta).toBe('整段');
  });
});

describe('classifyHttpError（桌面优先级子集）', () => {
  it('401/403 → auth', () => {
    expect(classifyHttpError(401, '{"error":{"message":"bad key"}}').kind).toBe(
      'auth'
    );
    expect(classifyHttpError(403, '').kind).toBe('auth');
  });
  it('model_not_found 优先于 404 状态码 → modelNotFound', () => {
    const err = classifyHttpError(
      404,
      '{"error":{"code":"model_not_found","message":"model x does not exist"}}'
    );
    expect(err.kind).toBe('modelNotFound');
  });
  it('404 无模型字样 → endpointUnavailable', () => {
    expect(classifyHttpError(404, 'not found').kind).toBe(
      'endpointUnavailable'
    );
  });
  it('429 → rateLimit（携带 Retry-After）', () => {
    const err = classifyHttpError(429, '', 30);
    expect(err.kind).toBe('rateLimit');
    expect(err.retryAfterSec).toBe(30);
    expect(err.retryable).toBe(true);
    expect(localChatErrorMessage(err)).toContain('30');
  });
  it('400 上下文字样 → contextLength；其余 400 → invalidRequest', () => {
    expect(
      classifyHttpError(400, '{"error":{"message":"context_length_exceeded"}}')
        .kind
    ).toBe('contextLength');
    expect(
      classifyHttpError(400, '{"error":{"message":"bad param"}}').kind
    ).toBe('invalidRequest');
  });
  it('402 → quota；5xx → server；413 → payloadTooLarge', () => {
    expect(classifyHttpError(402, '').kind).toBe('quota');
    expect(classifyHttpError(503, '').kind).toBe('server');
    expect(classifyHttpError(413, '').kind).toBe('payloadTooLarge');
  });
  it('extractErrorDetail 取 error.message 并截断', () => {
    expect(
      extractErrorDetail('{"error":{"message":"oops","code":"x"}}')
    ).toContain('oops');
    expect(extractErrorDetail('')).toBe('');
  });
});

describe('草稿与配置组装', () => {
  const draft = (p: Partial<LocalProviderDraft>): LocalProviderDraft => ({
    name: '',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    modelIds: [],
    defaultModelId: '',
    ...p,
  });
  it('validateProviderDraft：缺模型 → modelEmpty；坏 URL → baseUrlInvalid', () => {
    expect(validateProviderDraft(draft({}))).toContain('modelEmpty');
    expect(
      validateProviderDraft(draft({ baseUrl: 'ftp://x', modelIds: ['m'] }))
    ).toContain('baseUrlInvalid');
    expect(validateProviderDraft(draft({ modelIds: ['m'] }))).toEqual([]);
    expect(validateProviderDraft(draft({ defaultModelId: 'solo' }))).toEqual(
      []
    );
  });
  it('providerSpecFromDraft：默认模型置首、名称缺省由主机名派生', () => {
    const spec = providerSpecFromDraft(
      draft({ modelIds: ['a', 'b'], defaultModelId: 'z' })
    );
    expect(spec.models.map((m) => m.id)).toEqual(['z', 'a', 'b']);
    expect(spec.displayName).toBe('api.deepseek.com');
    expect(spec.protocol).toBe('openai/chat');
  });
  it('mergeModelIds / parseModelsList 去重保序', () => {
    expect(mergeModelIds(['a'], ['b', 'a', ' c '])).toEqual(['a', 'b', 'c']);
    expect(
      parseModelsList({ data: [{ id: 'x' }, { id: 'x' }, { id: 'y' }, {}] })
    ).toEqual(['x', 'y']);
    expect(parseModelsList(null)).toEqual([]);
  });
  it('resolveActiveSelection：失效选择返回 null（不擅自替代）', () => {
    const config: LocalModelsConfig = {
      version: 2,
      providers: {
        p1: {
          protocol: 'openai/chat',
          models: [{ id: 'm1' }],
        },
      },
      activeModel: { providerId: 'gone', modelId: 'm1' },
    };
    expect(resolveActiveSelection(config)).toBeNull();
    config.activeModel = { providerId: 'p1', modelId: 'm1' };
    expect(resolveActiveSelection(config)?.modelId).toBe('m1');
  });
});

describe('providerDefaultModelId（L3 收紧：建议项绝不指向已停用模型）', () => {
  function cfg(
    provider: Partial<LocalProviderSpec> & Pick<LocalProviderSpec, 'models'>,
    activeModel: LocalModelsConfig['activeModel'] = null
  ): LocalModelsConfig {
    return {
      version: 2,
      providers: {
        p1: { protocol: 'openai/chat', ...provider },
      },
      activeModel,
    };
  }

  it('活动模型仍启用：优先返回活动模型', () => {
    const config = cfg(
      { models: [{ id: 'm1' }, { id: 'm2' }], defaultModelId: 'm1' },
      { providerId: 'p1', modelId: 'm2' }
    );
    expect(providerDefaultModelId(config, 'p1')).toBe('m2');
  });

  it('活动模型已停用：不返回它，落到显式默认', () => {
    const config = cfg(
      {
        models: [{ id: 'm1' }, { id: 'm2', enabled: false }],
        defaultModelId: 'm1',
      },
      { providerId: 'p1', modelId: 'm2' }
    );
    expect(providerDefaultModelId(config, 'p1')).toBe('m1');
  });

  it('显式默认已停用：跳过它，取首个启用模型', () => {
    const config = cfg({
      models: [{ id: 'm1', enabled: false }, { id: 'm2' }],
      defaultModelId: 'm1',
    });
    expect(providerDefaultModelId(config, 'p1')).toBe('m2');
  });

  it('全部停用：返回 null（绝不拿停用模型兜底）', () => {
    const config = cfg({
      models: [
        { id: 'm1', enabled: false },
        { id: 'm2', enabled: false },
      ],
      defaultModelId: 'm1',
    });
    expect(providerDefaultModelId(config, 'p1')).toBeNull();
  });

  it('供应商不存在：返回 null', () => {
    const config = cfg({ models: [{ id: 'm1' }] });
    expect(providerDefaultModelId(config, 'gone')).toBeNull();
  });
});

describe('sanitizeAiTitle（U4 标题消毒：异常一律 null）', () => {
  it('干净标题原样通过；首尾空白去除', () => {
    expect(sanitizeAiTitle('秋日诗歌创作')).toBe('秋日诗歌创作');
    expect(sanitizeAiTitle('  季度 报告 汇总  ')).toBe('季度 报告 汇总');
  });

  it('剥外层引号（直引号/中文引号/书名式引号）', () => {
    expect(sanitizeAiTitle('"秋天的诗"')).toBe('秋天的诗');
    expect(sanitizeAiTitle('“旅行计划”')).toBe('旅行计划');
    expect(sanitizeAiTitle('「代码评审」')).toBe('代码评审');
  });

  it('多行只取首个非空行；markdown 标记不进标题', () => {
    expect(sanitizeAiTitle('\n**重点** 讨论 `方案`\n这是解释行')).toBe(
      '重点 讨论 方案'
    );
    expect(sanitizeAiTitle('# 周报标题')).toBe('周报标题');
  });

  it('超长硬截断到 16 字（无省略号，标题量级）', () => {
    const long = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸';
    const out = sanitizeAiTitle(long);
    expect(out).toHaveLength(16);
    expect(out).not.toContain('…');
  });

  it('空/纯空白/纯标记 → null（视为生成失败）', () => {
    expect(sanitizeAiTitle('')).toBeNull();
    expect(sanitizeAiTitle('   \n  ')).toBeNull();
    expect(sanitizeAiTitle('**')).toBeNull();
    expect(sanitizeAiTitle('""')).toBeNull();
  });
});

describe('buildChatRequestBody temperature（U4 一次性补全）', () => {
  it('未设 temperature 不写键（compact 口径）；设了才写', () => {
    const base = buildChatRequestBody({
      model: 'm',
      messages: [],
      stream: false,
    });
    expect(base).not.toHaveProperty('temperature');
    const withTemp = buildChatRequestBody({
      model: 'm',
      messages: [],
      stream: false,
      temperature: 0.3,
      maxTokens: 32,
    });
    expect(withTemp.temperature).toBe(0.3);
    expect(withTemp.max_tokens).toBe(32);
    expect(withTemp).not.toHaveProperty('tools');
  });
});

describe('本地附件 wire 组装（图片回放 + 视觉判定）', () => {
  const IMAGE_DATA_URL = 'data:image/png;base64,QUJD';
  const imageMessage: LocalChatMessage = {
    id: 'u1',
    role: 'user',
    content: '看这张图\n\n[附件]\n[图片附件: cat.png]',
    attachments: [
      {
        id: 'a1',
        name: 'cat.png',
        kind: 'image',
        dataUrl: IMAGE_DATA_URL,
        mime: 'image/png',
      },
    ],
  };

  it('vision=true：带图用户消息组为 parts（文本段 + image_url 段）', () => {
    const wire = buildWireMessages([imageMessage], true);
    expect(wire).toHaveLength(2);
    expect(wire[1]?.content).toEqual([
      { type: 'text', text: imageMessage.content },
      {
        type: 'image_url',
        image_url: { url: IMAGE_DATA_URL, detail: 'auto' },
      },
    ]);
  });

  it('vision=false / 缺省：只发文本正文（fail-closed，不直发图片）', () => {
    const off = buildWireMessages([imageMessage], false);
    expect(off[1]?.content).toBe(imageMessage.content);
    const dflt = buildWireMessages([imageMessage]);
    expect(dflt[1]?.content).toBe(imageMessage.content);
  });

  it('buildChatRequestBody：parts 显式序列化为线形字段', () => {
    const body = buildChatRequestBody({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            {
              type: 'image_url',
              image_url: { url: IMAGE_DATA_URL, detail: 'auto' },
            },
          ],
        },
      ],
      stream: true,
    });
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          {
            type: 'image_url',
            image_url: { url: IMAGE_DATA_URL, detail: 'auto' },
          },
        ],
      },
    ]);
  });

  it('localModelVisionSupported：spec modalities 为本地链真源', () => {
    const provider: LocalProviderSpec = {
      protocol: 'openai/chat',
      models: [
        {
          id: 'mv',
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
        { id: 'mt', modalities: { input: ['text'], output: ['text'] } },
        { id: 'mu' },
      ],
    };
    expect(localModelVisionSupported(provider, 'mv')).toBe(true);
    expect(localModelVisionSupported(provider, 'mt')).toBe(false);
    // 未声明 modalities → 未知即 false（fail-closed）
    expect(localModelVisionSupported(provider, 'mu')).toBe(false);
    expect(localModelVisionSupported(provider, 'missing')).toBe(false);
  });
});

describe('动态系统提示词构建（buildLocalChatSystemPrompt）', () => {
  it('未声明工具时：退化为纯文本助手提示，不含工具规范', () => {
    const prompt = buildLocalChatSystemPrompt();
    expect(prompt).toContain('当前未启用任何外部工具');
    expect(prompt).not.toContain('工具调用准则');
    expect(prompt).not.toContain('【引用格式规范】');
  });

  it('声明通用工具时：注入工具能力说明与使用准则，感知时间与网络', () => {
    const prompt = buildLocalChatSystemPrompt({
      nowIsoString: '2026-11-04T12:00:00Z',
      timeZone: 'Asia/Shanghai',
      networkKind: 'WiFi',
      enabledTools: [
        {
          name: 'run_js_sandbox',
          description: '运行 JS 计算精确数据',
        },
      ],
    });
    expect(prompt).toContain('当前设备时间：2026-11-04T12:00:00Z');
    expect(prompt).toContain('时区：Asia/Shanghai');
    expect(prompt).toContain('网络环境：WiFi');
    expect(prompt).toContain('- run_js_sandbox: 运行 JS 计算精确数据');
    expect(prompt).toContain('工具调用准则');
    expect(prompt).toContain('【容错与熔断纪律】');
    // 未含 web 搜索工具时不注入引用规范
    expect(prompt).not.toContain('【引用格式规范】');
  });

  it('启用 web_search / web_fetch 时：强制注入 [cite:id] 引用规范', () => {
    const prompt = buildLocalChatSystemPrompt({
      enabledTools: [
        { name: 'web_search', description: '联网检索最新新闻与事实' },
      ],
    });
    expect(prompt).toContain('【引用格式规范】');
    expect(prompt).toContain('[cite:id]');
  });
});

describe('请求体 tools 动态注入与消息出站（buildChatRequestBody & buildWireMessages）', () => {
  const dummyTool: LocalWireTool = {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  };

  it('传入 tools 时合规序列化进请求体并指定 tool_choice="auto"', () => {
    const body = buildChatRequestBody({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '查一下' }],
      stream: true,
      tools: [dummyTool],
    });
    expect(body.tools).toEqual([dummyTool]);
    expect(body.tool_choice).toBe('auto');
  });

  it('tools 为空数组或 undefined 时严格不写 tools/tool_choice 键', () => {
    const body1 = buildChatRequestBody({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
      tools: [],
    });
    expect(body1).not.toHaveProperty('tools');
    expect(body1).not.toHaveProperty('tool_choice');

    const body2 = buildChatRequestBody({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
    });
    expect(body2).not.toHaveProperty('tools');
    expect(body2).not.toHaveProperty('tool_choice');
  });

  it('buildWireMessages：正确回放带 tool_calls 的 assistant 消息与 role="tool" 消息', () => {
    const history: LocalChatMessage[] = [
      { id: '1', role: 'user', content: '计算 1+1' },
      {
        id: '2',
        role: 'assistant',
        content: '', // 即使 content 为空也不被丢弃！
        toolCalls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'run_js_sandbox',
              arguments: '{"code":"1+1"}',
            },
            status: 'running',
            name: 'run_js_sandbox',
            arguments: '{"code":"1+1"}',
            state: 'executing',
          },
        ],
      },
      {
        id: '3',
        role: 'tool',
        toolCallId: 'call_123',
        content: '{"result":2}',
      },
      {
        id: '4',
        role: 'assistant',
        content: '结果是 2',
      },
    ];

    const wire = buildWireMessages(history);
    expect(wire).toHaveLength(5); // system + user + assistant(tool_calls) + tool + assistant
    expect(wire[1]).toEqual({ role: 'user', content: '计算 1+1' });
    expect(wire[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: {
            name: 'run_js_sandbox',
            arguments: '{"code":"1+1"}',
          },
        },
      ],
    });
    expect(wire[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_123',
      content: '{"result":2}',
    });
    expect(wire[4]).toEqual({
      role: 'assistant',
      content: '结果是 2',
    });
  });

  it('repairOrphanedToolCalls：自动修复异常中断遗留的孤立 tool_call，防止 API 400', () => {
    const brokenWire: LocalWireMessage[] = [
      { role: 'user', content: '搜一下' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'orphan_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"a"}' },
          },
          {
            id: 'orphan_2',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"b"}' },
          },
        ],
      },
      // 只有 orphan_1 得到了响应，orphan_2 缺失（例如进程崩溃中断）
      {
        role: 'tool',
        tool_call_id: 'orphan_1',
        content: 'ok',
      },
    ];

    repairOrphanedToolCalls(brokenWire);
    expect(brokenWire).toHaveLength(4);
    expect(brokenWire[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'orphan_2',
    });
    expect((brokenWire[3] as any).content).toContain(
      'cancelled or interrupted'
    );
  });

  it('buildChatRequestBody：序列化 role="tool" 与带 tool_calls 的 assistant 消息', () => {
    const wire: LocalWireMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'fn1', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: 'result',
      },
    ];

    const body = buildChatRequestBody({
      model: 'm',
      messages: wire,
      stream: true,
    });

    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'fn1', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: 'result',
      },
    ]);
  });
});

describe('流式 tool_calls 增量聚合（applyChatChunk & StreamingToolCallAccumulator）', () => {
  it('极细分片聚合：首帧推 id 与 name，后续多帧逐字推送 arguments', () => {
    const acc = new StreamingToolCallAccumulator();

    // Chunk 1: id 与 name 到达
    const c1 = applyChatChunk(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_calc_99',
                  type: 'function',
                  function: { name: 'run_js_sandbox', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    );
    expect(c1?.toolCallDeltas).toHaveLength(1);
    expect(c1?.toolCallDeltas[0]).toEqual({
      index: 0,
      id: 'call_calc_99',
      name: 'run_js_sandbox',
      argumentsDelta: '',
    });
    acc.pushDeltas(c1!.toolCallDeltas);

    // Chunk 2 - 5: 逐字符传输 arguments JSON 片段: {"code":"1+1"}
    const argPieces = ['{"co', 'de":', '"1+', '1"}'];
    for (const piece of argPieces) {
      const delta = applyChatChunk(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: piece },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
      );
      acc.pushDeltas(delta!.toolCallDeltas);
    }

    expect(acc.hasToolCalls()).toBe(true);
    const finalized = acc.finalize();
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      index: 0,
      id: 'call_calc_99',
      name: 'run_js_sandbox',
      argumentsString: '{"code":"1+1"}',
      isValidJson: true,
      parsedArgs: { code: '1+1' },
    });
  });
});

describe('resolveEffectiveThinkingFormat（思考方言解析与优先级梯队）', () => {
  const dummyBase = {
    displayName: 'Test',
    baseUrl: 'https://api.example.com',
    protocol: 'openai/chat' as const,
  };

  it('优先级 1：模型级 compat.thinkingFormat 显式覆盖一切', () => {
    const provider: LocalProviderSpec = {
      ...dummyBase,
      vendor: 'openai',
      compat: { thinkingFormat: 'openai' },
      models: [],
    };
    const model: LocalModelSpec = {
      id: 'gpt-4o',
      compat: { thinkingFormat: 'deepseek' },
    };
    expect(resolveEffectiveThinkingFormat(provider, model)).toBe('deepseek');

    // 覆盖深层特征命中
    const claudeModel: LocalModelSpec = {
      id: 'claude-3-5-sonnet',
      compat: { thinkingFormat: 'qwen' },
    };
    expect(
      resolveEffectiveThinkingFormat(
        { ...dummyBase, vendor: 'anthropic' },
        claudeModel
      )
    ).toBe('qwen');
  });

  it('优先级 2：供应商级 compat.thinkingFormat 覆盖厂商与模型特征', () => {
    const provider: LocalProviderSpec = {
      ...dummyBase,
      vendor: 'openai',
      compat: { thinkingFormat: 'anthropic' },
      models: [],
    };
    const model: LocalModelSpec = {
      id: 'gpt-4o',
    };
    expect(resolveEffectiveThinkingFormat(provider, model)).toBe('anthropic');

    // model 为 null 时同样生效
    expect(resolveEffectiveThinkingFormat(provider, null)).toBe('anthropic');
  });

  it('优先级 3：厂商 / 模型特征推断 - deepseek 与 r1', () => {
    // 厂商命中
    expect(
      resolveEffectiveThinkingFormat(
        { ...dummyBase, vendor: 'deepseek' },
        { id: 'custom-model' }
      )
    ).toBe('deepseek');
    // 模型 id 包含 deepseek
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'deepseek-chat' })
    ).toBe('deepseek');
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'DeepSeek-V3' })
    ).toBe('deepseek');
    // 模型 id 包含 r1
    expect(
      resolveEffectiveThinkingFormat(dummyBase, {
        id: 'DeepSeek-R1-Distill-Qwen-14B',
      })
    ).toBe('deepseek');
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'r1-reasoner' })
    ).toBe('deepseek');
  });

  it('优先级 3：厂商 / 模型特征推断 - anthropic 与 claude', () => {
    expect(
      resolveEffectiveThinkingFormat(
        { ...dummyBase, vendor: 'anthropic' },
        null
      )
    ).toBe('anthropic');
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'claude-3-7-sonnet' })
    ).toBe('anthropic');
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'Claude-3.5-Haiku' })
    ).toBe('anthropic');
  });

  it('优先级 3：厂商 / 模型特征推断 - google 与 gemini', () => {
    expect(
      resolveEffectiveThinkingFormat({ ...dummyBase, vendor: 'google' }, null)
    ).toBe('gemini');
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'gemini-2.0-flash-exp' })
    ).toBe('gemini');
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'Gemini-1.5-Pro' })
    ).toBe('gemini');
  });

  it('优先级 3：厂商 / 模型特征推断 - qwen', () => {
    expect(resolveEffectiveThinkingFormat(dummyBase, { id: 'qwen-max' })).toBe(
      'qwen'
    );
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'Qwen-2.5-Coder-32B' })
    ).toBe('qwen');
  });

  it('优先级 3：厂商 / 模型特征推断 - glm -> zai', () => {
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'glm-4-plus' })
    ).toBe('zai');
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'chatglm-turbo' })
    ).toBe('zai');
  });

  it('优先级 3：厂商 / 模型特征推断 - openai 与 gpt / o1 / o3', () => {
    expect(
      resolveEffectiveThinkingFormat({ ...dummyBase, vendor: 'openai' }, null)
    ).toBe('openai');
    expect(resolveEffectiveThinkingFormat(dummyBase, { id: 'gpt-4o' })).toBe(
      'openai'
    );
    expect(resolveEffectiveThinkingFormat(dummyBase, { id: 'GPT-4.5' })).toBe(
      'openai'
    );
    expect(
      resolveEffectiveThinkingFormat(dummyBase, { id: 'o1-preview' })
    ).toBe('openai');
    expect(resolveEffectiveThinkingFormat(dummyBase, { id: 'o1-mini' })).toBe(
      'openai'
    );
    expect(resolveEffectiveThinkingFormat(dummyBase, { id: 'o3-mini' })).toBe(
      'openai'
    );
  });

  it('兜底策略：未命中任何特征与无配置时 fallback 为 openai', () => {
    expect(
      resolveEffectiveThinkingFormat(
        { ...dummyBase, vendor: 'custom' },
        { id: 'llama-3.1-70b' }
      )
    ).toBe('openai');
    expect(resolveEffectiveThinkingFormat(dummyBase, null)).toBe('openai');
    expect(resolveEffectiveThinkingFormat(dummyBase, { id: '' })).toBe(
      'openai'
    );
  });
});

describe('resolveActiveSelection（扩展 model 实体规格返回）', () => {
  it('正确返回完整的 model 实体及其规格字段', () => {
    const targetModel: LocalModelSpec = {
      id: 'deepseek-chat',
      displayName: 'DeepSeek-V3',
      enabled: true,
      contextWindow: 65536,
      maxOutputTokens: 8192,
      thinking: {
        supported: true,
        availableTiers: ['off', 'low', 'medium', 'high', 'xhigh'],
        defaultTier: 'xhigh',
      },
      compat: {
        thinkingFormat: 'deepseek',
      },
    };

    const config: LocalModelsConfig = {
      version: 2,
      providers: {
        p_deepseek: {
          vendor: 'deepseek',
          displayName: 'DeepSeek 官方',
          baseUrl: 'https://api.deepseek.com',
          protocol: 'openai/chat',
          enabled: true,
          models: [
            targetModel,
            {
              id: 'deepseek-reasoner',
              displayName: 'DeepSeek-R1',
              enabled: true,
            },
          ],
        },
      },
      activeModel: {
        providerId: 'p_deepseek',
        modelId: 'deepseek-chat',
      },
    };

    const selection = resolveActiveSelection(config);
    expect(selection).not.toBeNull();
    expect(selection?.providerId).toBe('p_deepseek');
    expect(selection?.modelId).toBe('deepseek-chat');
    expect(selection?.provider.displayName).toBe('DeepSeek 官方');
    expect(selection?.model).toEqual(targetModel);
    expect(selection?.model.thinking?.defaultTier).toBe('xhigh');
    expect(selection?.model.compat?.thinkingFormat).toBe('deepseek');
  });

  it('当活动模型 enabled === false 时判定失效返回 null', () => {
    const config: LocalModelsConfig = {
      version: 2,
      providers: {
        p1: {
          protocol: 'openai/chat',
          enabled: true,
          models: [{ id: 'm1', enabled: false }],
        },
      },
      activeModel: { providerId: 'p1', modelId: 'm1' },
    };
    expect(resolveActiveSelection(config)).toBeNull();
  });

  it('当供应商 enabled === false 时判定失效返回 null', () => {
    const config: LocalModelsConfig = {
      version: 2,
      providers: {
        p1: {
          protocol: 'openai/chat',
          enabled: false,
          models: [{ id: 'm1', enabled: true }],
        },
      },
      activeModel: { providerId: 'p1', modelId: 'm1' },
    };
    expect(resolveActiveSelection(config)).toBeNull();
  });
});

describe('buildChatRequestBody 思考推理方言贯通（ThinkingFormat & ThinkingTier）', () => {
  const dummyMessages = [{ role: 'user' as const, content: '你好' }];

  it('设置 thinkingTier: "xhigh" 时生成各方言对应的请求体补丁', () => {
    // OpenAI 方言 (xhigh -> high)
    const openaiBody = buildChatRequestBody({
      model: 'gpt-4o',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'openai',
      thinkingTier: 'xhigh',
    });
    expect(openaiBody.reasoning_effort).toBe('high');

    // DeepSeek 方言 (thinking: { type: "enabled" })
    const deepseekBody = buildChatRequestBody({
      model: 'deepseek-reasoner',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'deepseek',
      thinkingTier: 'xhigh',
    });
    expect(deepseekBody.thinking).toEqual({ type: 'enabled' });

    // Qwen 方言 (enable_thinking: true)
    const qwenBody = buildChatRequestBody({
      model: 'qwen-max',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'qwen',
      thinkingTier: 'xhigh',
    });
    expect(qwenBody.enable_thinking).toBe(true);

    // Anthropic 方言 (thinking: { type: "enabled", budget_tokens: 32768 })
    const anthropicBody = buildChatRequestBody({
      model: 'claude-3-7-sonnet',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'anthropic',
      thinkingTier: 'xhigh',
    });
    expect(anthropicBody.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 32768,
    });

    // Gemini 方言 (thinkingConfig: { thinkingLevel: "high" })
    const geminiBody = buildChatRequestBody({
      model: 'gemini-2.0-flash-thinking-exp',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'gemini',
      thinkingTier: 'xhigh',
    });
    expect(geminiBody.thinkingConfig).toEqual({
      thinkingLevel: 'high',
    });

    // ZAI / GLM 方言 (thinking: { type: "enable" })
    const zaiBody = buildChatRequestBody({
      model: 'glm-4-plus',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'zai',
      thinkingTier: 'xhigh',
    });
    expect(zaiBody.thinking).toEqual({ type: 'enable' });
  });

  it('思考档位为 "off" 时：deepseek 与 qwen 正确合入关闭补丁，其他方言不注入冗余字段', () => {
    // DeepSeek off -> { thinking: { type: 'disabled' } }
    const dsOff = buildChatRequestBody({
      model: 'deepseek-chat',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'deepseek',
      thinkingTier: 'off',
    });
    expect(dsOff.thinking).toEqual({ type: 'disabled' });

    // Qwen off -> { enable_thinking: false }
    const qwenOff = buildChatRequestBody({
      model: 'qwen-plus',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'qwen',
      thinkingTier: 'off',
    });
    expect(qwenOff.enable_thinking).toBe(false);

    // OpenAI off -> 不写入 reasoning_effort
    const openaiOff = buildChatRequestBody({
      model: 'gpt-4o',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'openai',
      thinkingTier: 'off',
    });
    expect(openaiOff).not.toHaveProperty('reasoning_effort');

    // Anthropic off -> 不写入 thinking
    const anthropicOff = buildChatRequestBody({
      model: 'claude-3-5-sonnet',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'anthropic',
      thinkingTier: 'off',
    });
    expect(anthropicOff).not.toHaveProperty('thinking');
  });

  it('未提供 thinkingTier (undefined) 时：完全不注入任何思考相关参数（compactObject 口径）', () => {
    const cleanBody = buildChatRequestBody({
      model: 'gpt-4o',
      messages: dummyMessages,
      stream: true,
      thinkingFormat: 'openai',
    });
    expect(cleanBody).not.toHaveProperty('reasoning_effort');
    expect(cleanBody).not.toHaveProperty('thinking');
    expect(cleanBody).not.toHaveProperty('enable_thinking');
    expect(cleanBody).not.toHaveProperty('thinkingConfig');
  });
});
