// 本地对话协议纯函数测试：端点归一与桌面 wire_protocol.rs 用例同构、
// 请求体 compact 口径、SSE 分帧、chunk 解析、错误分类优先级。
import {
  SseFrameBuffer,
  applyChatChunk,
  buildChatCompletionsUrl,
  buildChatHeaders,
  buildChatRequestBody,
  buildModelsUrl,
  buildWireMessages,
  classifyHttpError,
  extractErrorDetail,
  localChatErrorMessage,
  mergeModelIds,
  parseModelsList,
  providerSpecFromDraft,
  resolveActiveSelection,
  sanitizeAiTitle,
  validateProviderDraft,
} from './localChatProtocol';
import type {
  LocalChatMessage,
  LocalModelsConfig,
  LocalProviderDraft,
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
