import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonProviderGatewayController,
  createDaemonProviderRuntimeConfig,
  createDaemonProviderRuntimeConfigFromEnv,
} from './daemon-provider-gateway';
import {
  createTextMessage,
  type ProviderStreamEvent,
} from '@crish/agent-runtime';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function collectProviderEvents(
  stream: AsyncIterable<ProviderStreamEvent>
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('DaemonProviderGatewayController', () => {
  it('plans and materializes the direct api-key provider route', async () => {
    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'sk-direct',
      baseUrl: 'https://gateway.example/v1',
      model: 'mimo-v2.5',
      providerId: 'crish',
    });

    const plan = await controller.planProvider({
      runId: 'run_1',
      cwd: 'C:/workspace',
    });
    expect(plan).toMatchObject({
      ok: true,
      requestedModel: 'mimo-v2.5',
      selectedRoute: {
        providerId: 'crish',
        upstreamModel: 'mimo-v2.5',
        endpointType: 'auto',
        endpointSupport: 'auto',
        streamingSupport: 'streaming',
        credentialSourceType: 'api-key',
        credentialSource: {
          type: 'api-key',
          providerId: 'crish',
          baseUrl: 'https://gateway.example/v1',
        },
      },
      credential: {
        apiKey: 'sk-direct',
        baseUrl: 'https://gateway.example/v1',
      },
      providerPlan: {
        providerOptions: {
          endpoint: 'auto',
          stream: true,
        },
      },
    });

    const provider = await controller.createProvider({
      runId: 'run_1',
      cwd: 'C:/workspace',
    });
    expect(provider.id).toBe('crish');
    expect(JSON.stringify(controller.getStatusSnapshot())).not.toContain(
      'sk-direct'
    );
    expect(controller.getStatusSnapshot()).toMatchObject({
      credentialMode: 'direct',
      readiness: 'ready',
      apiKey: {
        hasApiKey: true,
        source: 'unknown',
        last4: 'rect',
      },
      hasDirectApiKey: true,
      apiKeySource: 'unknown',
      model: 'mimo-v2.5',
      gateway: {
        ready: true,
        selectedEndpointSupport: 'auto',
        selectedStreamingSupport: 'streaming',
        selectedCredentialSource: {
          type: 'api-key',
          providerId: 'crish',
          baseUrl: 'https://gateway.example/v1',
        },
      },
    });
  });

  it('materializes direct providers with Responses-first streaming defaults', async () => {
    const encoder = new TextEncoder();
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
            )
          );
          controller.enqueue(
            encoder.encode(
              'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
            )
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    vi.stubGlobal('fetch', fetchMock);
    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'sk-direct',
      baseUrl: 'https://gateway.example/v1',
      model: 'mimo-v2.5',
      providerId: 'crish',
      diagnostics: false,
    });

    const provider = await controller.createProvider({
      runId: 'run_1',
      cwd: 'C:/workspace',
    });
    const events = await collectProviderEvents(
      provider.stream({
        sessionId: 'session_1',
        cwd: 'C:/workspace',
        messages: [createTextMessage('user', 'hello')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    expect(urls).toEqual(['https://gateway.example/v1/responses']);
    expect(bodies[0]).toMatchObject({
      model: 'mimo-v2.5',
      stream: true,
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    });
    expect(events).toEqual([
      { type: 'text-delta', text: 'ok' },
      { type: 'stop', reason: 'stop' },
    ]);
  });

  it('uses user-prefix system prompt wiring for OpenAI-compatible gateway defaults', async () => {
    const encoder = new TextEncoder();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
            )
          );
          controller.enqueue(
            encoder.encode(
              'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
            )
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    vi.stubGlobal('fetch', fetchMock);
    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'sk-direct',
      baseUrl: 'https://gateway.example/v1',
      model: 'mimo-v2.5',
      providerId: 'crish',
      diagnostics: false,
    });

    const provider = await controller.createProvider({
      runId: 'run_1',
      cwd: 'C:/workspace',
    });
    await collectProviderEvents(
      provider.stream({
        sessionId: 'session_1',
        cwd: 'C:/workspace',
        systemPrompt: 'Keep project rules stable.',
        messages: [createTextMessage('user', 'hello')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    const input = bodies[0]?.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(String(input[0]?.content)).toContain('Keep project rules stable.');
    expect(input[1]).toMatchObject({
      type: 'message',
      role: 'user',
      content: 'hello',
    });
  });

  it('keeps native system prompt wiring for the official OpenAI endpoint', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
          ],
        }),
        {
          headers: { 'content-type': 'application/json' },
        }
      );
    };
    vi.stubGlobal('fetch', fetchMock);
    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'sk-direct',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
      providerId: 'openai',
      stream: false,
      diagnostics: false,
    });

    const provider = await controller.createProvider({
      runId: 'run_1',
      cwd: 'C:/workspace',
    });
    await collectProviderEvents(
      provider.stream({
        sessionId: 'session_1',
        cwd: 'C:/workspace',
        systemPrompt: 'Keep project rules stable.',
        messages: [createTextMessage('user', 'hello')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    const input = bodies[0]?.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({
      type: 'message',
      role: 'system',
      content: 'Keep project rules stable.',
    });
    expect(input[1]).toMatchObject({
      type: 'message',
      role: 'user',
      content: 'hello',
    });
  });

  it('keeps chat-completions as an automatic fallback when Responses is unavailable', async () => {
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (urls.length === 1) {
        return new Response(
          JSON.stringify({
            error: { message: 'Responses endpoint not found' },
          }),
          {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: 'fallback-ok' }, finish_reason: 'stop' },
          ],
        }),
        {
          headers: { 'content-type': 'application/json' },
        }
      );
    };
    vi.stubGlobal('fetch', fetchMock);
    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'sk-direct',
      baseUrl: 'https://gateway.example/v1',
      model: 'mimo-v2.5',
      providerId: 'crish',
      diagnostics: false,
      requestTimeoutMs: 1_000,
    });

    const provider = await controller.createProvider({
      runId: 'run_1',
      cwd: 'C:/workspace',
    });
    const events = await collectProviderEvents(
      provider.stream({
        sessionId: 'session_1',
        cwd: 'C:/workspace',
        messages: [createTextMessage('user', 'hello')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    expect(urls).toEqual([
      'https://gateway.example/v1/responses',
      'https://gateway.example/v1/chat/completions',
    ]);
    expect(bodies[0]).toMatchObject({
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    });
    expect(bodies[1]).toMatchObject({
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    expect(events).toEqual([
      { type: 'text-delta', text: 'fallback-ok' },
      { type: 'stop', reason: 'stop' },
    ]);
  });

  it('propagates disabled streaming into provider requests and status snapshots', async () => {
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'sync-ok' }],
            },
          ],
        }),
        {
          headers: { 'content-type': 'application/json' },
        }
      );
    };
    vi.stubGlobal('fetch', fetchMock);
    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'sk-direct',
      baseUrl: 'https://gateway.example/v1',
      model: 'mimo-v2.5',
      providerId: 'crish',
      stream: false,
      diagnostics: false,
    });

    const plan = await controller.planProvider({
      runId: 'run_sync',
      cwd: 'C:/workspace',
    });
    const provider = await controller.createProvider({
      runId: 'run_sync',
      cwd: 'C:/workspace',
    });
    const events = await collectProviderEvents(
      provider.stream({
        sessionId: 'session_sync',
        cwd: 'C:/workspace',
        messages: [createTextMessage('user', 'hello')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    expect(plan).toMatchObject({
      selectedRoute: {
        endpointSupport: 'auto',
        streamingSupport: 'non-streaming',
      },
      providerPlan: {
        providerOptions: {
          endpoint: 'auto',
          stream: false,
        },
      },
    });
    expect(urls).toEqual(['https://gateway.example/v1/responses']);
    expect(bodies[0]).toMatchObject({ stream: false });
    expect(events).toEqual([
      { type: 'text-delta', text: 'sync-ok' },
      { type: 'stop', reason: 'stop' },
    ]);
    expect(controller.getStatusSnapshot()).toMatchObject({
      endpoint: 'auto',
      stream: false,
      gateway: {
        selectedEndpointSupport: 'auto',
        selectedStreamingSupport: 'non-streaming',
      },
    });
  });

  it('routes direct Responses streaming config through provider-neutral capability requirements', async () => {
    const controller = new DaemonProviderGatewayController(
      {
        credentialMode: 'direct',
        apiKey: 'sk-direct',
        baseUrl: 'https://fallback.example/v1',
        model: 'shared-chat',
        providerId: 'fallback',
        endpoint: 'responses',
        stream: true,
      },
      {
        routes: [
          {
            id: 'chat-nonstream',
            model: 'shared-chat',
            providerId: 'chat-provider',
            endpointSupport: 'chat-completions',
            streamingSupport: 'non-streaming',
            priority: 200,
            credentialSource: { type: 'api-key', apiKey: 'chat-key' },
          },
          {
            id: 'responses-stream',
            model: 'shared-chat',
            providerId: 'responses-provider',
            endpointSupport: 'responses',
            streamingSupport: 'streaming',
            priority: 100,
            credentialSource: {
              type: 'api-key',
              apiKey: 'responses-key',
              metadata: { apiKey: 'metadata-secret' },
            },
          },
        ],
      }
    );

    const plan = await controller.planProvider({
      runId: 'run_responses',
      cwd: 'C:/workspace',
    });

    expect(plan).toMatchObject({
      ok: true,
      capabilityRequest: {
        requiredEndpointSupport: ['responses'],
        requiredStreamingSupport: ['streaming'],
      },
      selectedRoute: {
        routeId: 'responses-stream',
        providerId: 'responses-provider',
        endpointSupport: 'responses',
        streamingSupport: 'streaming',
      },
    });
    expect(plan.routeDecision).toEqual(
      expect.arrayContaining([
        'model_route_selected:responses-stream',
        'model_route_rejection:endpoint:unsupported:responses:1',
        'model_route_rejection:streaming:unsupported:streaming:1',
        'selected_route:responses-stream',
      ])
    );
    expect(controller.getStatusSnapshot()).toMatchObject({
      gateway: {
        routeDecision: expect.arrayContaining([
          'model_route_rejection:endpoint:unsupported:responses:1',
          'model_route_rejection:streaming:unsupported:streaming:1',
        ]),
        selectedEndpointSupport: 'responses',
        selectedStreamingSupport: 'streaming',
      },
    });
    expect(JSON.stringify(controller.getStatusSnapshot())).not.toContain(
      'metadata-secret'
    );
  });

  it('does not select Responses-only streaming routes for explicit chat non-streaming config', async () => {
    const controller = new DaemonProviderGatewayController(
      {
        credentialMode: 'direct',
        apiKey: 'sk-direct',
        baseUrl: 'https://fallback.example/v1',
        model: 'shared-chat',
        providerId: 'fallback',
        endpoint: 'chat-completions',
        stream: false,
      },
      {
        routes: [
          {
            id: 'responses-stream',
            model: 'shared-chat',
            providerId: 'responses-provider',
            endpointSupport: 'responses',
            streamingSupport: 'streaming',
            priority: 200,
            credentialSource: { type: 'api-key', apiKey: 'responses-key' },
          },
          {
            id: 'chat-nonstream',
            model: 'shared-chat',
            providerId: 'chat-provider',
            endpointSupport: 'chat-completions',
            streamingSupport: 'non-streaming',
            priority: 100,
            credentialSource: { type: 'api-key', apiKey: 'chat-key' },
          },
        ],
      }
    );

    const plan = await controller.planProvider();

    expect(plan).toMatchObject({
      ok: true,
      capabilityRequest: {
        requiredEndpointSupport: ['chat-completions'],
        requiredStreamingSupport: ['non-streaming'],
      },
      selectedRoute: {
        routeId: 'chat-nonstream',
        endpointSupport: 'chat-completions',
        streamingSupport: 'non-streaming',
      },
    });
    expect(plan.routeDecision).toEqual(
      expect.arrayContaining([
        'model_route_selected:chat-nonstream',
        'model_route_rejection:endpoint:unsupported:chat-completions:1',
        'model_route_rejection:streaming:unsupported:non-streaming:1',
      ])
    );
  });

  it('materializes the selected route endpoint when auto routing picks a same-name chat route', async () => {
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'chat-ok' }, finish_reason: 'stop' }],
        }),
        {
          headers: { 'content-type': 'application/json' },
        }
      );
    };
    vi.stubGlobal('fetch', fetchMock);
    const controller = new DaemonProviderGatewayController(
      {
        credentialMode: 'direct',
        apiKey: 'sk-direct',
        baseUrl: 'https://fallback.example/v1',
        model: 'shared-chat',
        providerId: 'fallback',
        endpoint: 'auto',
        stream: true,
        diagnostics: false,
      },
      {
        routes: [
          {
            id: 'responses-stream',
            model: 'shared-chat',
            providerId: 'responses-provider',
            endpointSupport: 'responses',
            streamingSupport: 'streaming',
            priority: 100,
            credentialSource: { type: 'api-key', apiKey: 'responses-key' },
          },
          {
            id: 'chat-stream',
            model: 'shared-chat',
            providerId: 'chat-provider',
            endpointSupport: 'chat-completions',
            streamingSupport: 'streaming',
            priority: 200,
            credentialSource: { type: 'api-key', apiKey: 'chat-key' },
          },
        ],
      }
    );

    const plan = await controller.planProvider();
    const provider = await controller.createProvider({
      runId: 'run_auto_chat',
      cwd: 'C:/workspace',
    });
    const events = await collectProviderEvents(
      provider.stream({
        sessionId: 'session_auto_chat',
        cwd: 'C:/workspace',
        messages: [createTextMessage('user', 'hello')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    expect(plan).toMatchObject({
      ok: true,
      selectedRoute: {
        routeId: 'chat-stream',
        endpointSupport: 'chat-completions',
        streamingSupport: 'streaming',
      },
      capabilityRequest: {
        requiredEndpointSupport: ['auto'],
        requiredStreamingSupport: ['streaming'],
      },
    });
    expect(urls).toEqual(['https://fallback.example/v1/chat/completions']);
    expect(bodies[0]).toMatchObject({
      model: 'shared-chat',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(events).toEqual([
      { type: 'text-delta', text: 'chat-ok' },
      { type: 'stop', reason: 'stop' },
    ]);
    expect(controller.getStatusSnapshot()).toMatchObject({
      endpoint: 'auto',
      gateway: {
        selectedRouteId: 'chat-stream',
        selectedEndpointSupport: 'chat-completions',
      },
    });
  });

  it('exposes endpoint and stream capability rejection traces in provider status', async () => {
    const controller = new DaemonProviderGatewayController(
      {
        credentialMode: 'direct',
        apiKey: 'sk-direct',
        baseUrl: 'https://fallback.example/v1',
        model: 'shared-chat',
        providerId: 'fallback',
        endpoint: 'responses',
        stream: true,
      },
      {
        routes: [
          {
            id: 'chat-nonstream',
            model: 'shared-chat',
            providerId: 'chat-provider',
            endpointSupport: 'chat-completions',
            streamingSupport: 'non-streaming',
            credentialSource: {
              type: 'api-key',
              apiKey: 'chat-key',
              headers: { Authorization: 'bearer-secret', 'x-safe': 'ok' },
              metadata: { token: 'token-secret', label: 'chat' },
            },
          },
        ],
      }
    );

    const plan = await controller.planProvider();
    const status = controller.getStatusSnapshot();
    const serialized = JSON.stringify(status);

    expect(plan).toMatchObject({
      ok: false,
      code: 'route_not_found',
    });
    expect(status).toMatchObject({
      readiness: 'ready',
      gateway: {
        ready: true,
        routeDecision: expect.arrayContaining([
          'model_route_selected:none',
          'model_route_rejection:endpoint:unsupported:responses:1',
          'model_route_rejection:streaming:unsupported:streaming:1',
          'model_route_no_selected_candidate',
          'model_route_capability_rejected_all',
          'route_not_found',
        ]),
        selectedEndpointSupport: 'responses',
        selectedStreamingSupport: 'streaming',
      },
      lastDiagnostic: {
        code: 'route_not_found',
      },
    });
    expect(serialized).not.toContain('sk-direct');
    expect(serialized).not.toContain('chat-key');
    expect(serialized).not.toContain('bearer-secret');
    expect(serialized).not.toContain('token-secret');
  });

  it('updates the gateway route for later daemon runs', async () => {
    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'sk-old',
      baseUrl: 'https://old.example/v1',
      model: 'old-model',
      providerId: 'crish',
    });

    controller.update({
      apiKey: 'sk-new',
      baseUrl: 'https://new.example/v1',
      model: 'new-model',
    });

    const plan = await controller.planProvider();
    expect(plan).toMatchObject({
      ok: true,
      requestedModel: 'new-model',
      credential: {
        apiKey: 'sk-new',
        baseUrl: 'https://new.example/v1',
      },
      selectedRoute: {
        upstreamModel: 'new-model',
      },
    });
    expect(controller.getStatusSnapshot()).toMatchObject({
      credentialMode: 'direct',
      readiness: 'ready',
      apiKey: {
        hasApiKey: true,
        source: 'runtime-update',
        last4: '-new',
      },
      apiKeySource: 'runtime-update',
      model: 'new-model',
    });
  });

  it('normalizes environment configuration into the product provider path', () => {
    const config = createDaemonProviderRuntimeConfigFromEnv(
      {
        FLOWBIT_API_KEY: ' flowbit-key ',
        FLOWBIT_ACCOUNT_ID: ' acct_1 ',
        FLOWBIT_API_BASE_URL: ' https://flowbit.example ',
        FLOWBIT_MODEL: ' mimo-v2.5-pro ',
      },
      {
        baseUrl: 'https://default.example',
        model: 'default-model',
        providerId: 'crish',
      }
    );

    expect(config).toMatchObject({
      credentialMode: 'auto',
      apiKey: 'flowbit-key',
      apiKeySource: 'env',
      accountId: 'acct_1',
      baseUrl: 'https://flowbit.example',
      model: 'mimo-v2.5-pro',
    });
  });

  it('uses auto mode to fall back to environment api keys', async () => {
    const config = createDaemonProviderRuntimeConfigFromEnv(
      {
        FLOWBIT_API_KEY: ' env-key-1234 ',
      },
      {
        baseUrl: 'https://default.example',
        model: 'mimo-v2.5',
        providerId: 'crish',
      }
    );
    const controller = new DaemonProviderGatewayController(config);

    const plan = await controller.planProvider();

    expect(plan).toMatchObject({
      ok: true,
      selectedRoute: {
        credentialSourceType: 'api-key',
      },
      credential: {
        apiKey: 'env-key-1234',
      },
    });
    expect(controller.getStatusSnapshot()).toMatchObject({
      credentialMode: 'auto',
      readiness: 'ready',
      apiKey: {
        hasApiKey: true,
        source: 'env',
        last4: '1234',
      },
    });
  });

  it('treats an empty runtime api key update as an explicit clear', async () => {
    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'sk-old-direct',
      baseUrl: 'https://gateway.example/v1',
      model: 'mimo-v2.5',
      providerId: 'crish',
    });

    controller.update({
      credentialMode: 'direct',
      apiKey: '',
    });

    const plan = await controller.planProvider();
    expect(plan).toMatchObject({
      ok: false,
      code: 'provider_credential_missing',
      selectedRoute: {
        credentialSourceType: 'api-key',
      },
    });
    expect(JSON.stringify(controller.getStatusSnapshot())).not.toContain(
      'sk-old-direct'
    );
    expect(controller.getStatusSnapshot()).toMatchObject({
      credentialMode: 'direct',
      readiness: 'missing',
      apiKey: {
        hasApiKey: false,
        source: 'unset',
      },
      hasDirectApiKey: false,
      apiKeySource: 'unset',
    });
  });

  it('resolves provider config precedence as runtime, env, user, workspace, then default', () => {
    const config = createDaemonProviderRuntimeConfig({
      defaults: {
        credentialMode: 'auto',
        apiKey: 'default-key',
        baseUrl: 'https://default.example',
        model: 'default-model',
        providerId: 'crish',
      },
      env: {
        CRISH_API_KEY: 'env-key',
        CRISH_API_BASE_URL: 'https://env.example',
        CRISH_MODEL: 'env-model',
      },
      userConfig: {
        credentialMode: 'direct',
        apiKey: 'user-key',
        baseUrl: 'https://user.example',
        model: 'user-model',
      },
      workspaceConfig: {
        apiKey: 'workspace-key',
        model: 'workspace-model',
      },
      runtimeConfig: {
        credentialMode: 'auto',
        apiKey: '',
        baseUrl: 'https://runtime.example',
      },
    });

    expect(config).toMatchObject({
      credentialMode: 'auto',
      apiKey: undefined,
      apiKeySource: 'unset',
      baseUrl: 'https://runtime.example',
      model: 'env-model',
    });
  });

  it('materializes native Anthropic Messages provider when baseUrl is api.anthropic.com', async () => {
    const urls: string[] = [];
    const requestHeaders: Array<Record<string, string>> = [];
    const bodies: Array<Record<string, unknown>> = [];
    const encoder = new TextEncoder();
    const fetchMock: typeof fetch = async (input, init) => {
      urls.push(String(input));
      requestHeaders.push(init?.headers as Record<string, string>);
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"claude-ok"}}\n\n'
            )
          );
          controller.enqueue(
            encoder.encode(
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
            )
          );
          controller.enqueue(
            encoder.encode('data: {"type":"message_stop"}\n\n')
          );
          controller.close();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    vi.stubGlobal('fetch', fetchMock);

    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-20250514',
      providerId: 'anthropic',
    });

    const provider = await controller.createProvider({
      runId: 'run_ant',
      cwd: 'C:/workspace',
    });
    expect(provider.id).toBe('anthropic');

    const events = await collectProviderEvents(
      provider.stream({
        sessionId: 'session_ant',
        cwd: 'C:/workspace',
        messages: [createTextMessage('user', 'hello')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    expect(urls).toEqual(['https://api.anthropic.com/v1/messages']);
    expect(requestHeaders[0]?.['x-api-key']).toBe('sk-ant-test');
    expect(requestHeaders[0]?.['anthropic-version']).toBe('2023-06-01');
    expect(bodies[0]).toMatchObject({
      model: 'claude-sonnet-4-20250514',
      stream: true,
      max_tokens: expect.any(Number),
    });
    expect(events).toEqual([
      { type: 'text-delta', text: 'claude-ok' },
      {
        type: 'stop',
        reason: 'stop',
        usage: { completionTokens: 1, totalTokens: 1 },
      },
    ]);
  });

  it('materializes native Gemini generateContent provider when baseUrl is generativelanguage.googleapis.com', async () => {
    const urls: string[] = [];
    const requestHeaders: Array<Record<string, string>> = [];
    const bodies: Array<Record<string, unknown>> = [];
    const encoder = new TextEncoder();
    const fetchMock: typeof fetch = async (input, init) => {
      urls.push(String(input));
      requestHeaders.push(init?.headers as Record<string, string>);
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"gemini-ok"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":1,"totalTokenCount":1}}\n\n'
            )
          );
          controller.close();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    vi.stubGlobal('fetch', fetchMock);

    const controller = new DaemonProviderGatewayController({
      credentialMode: 'direct',
      apiKey: 'g-test-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.0-flash',
      providerId: 'gemini',
    });

    const provider = await controller.createProvider({
      runId: 'run_gem',
      cwd: 'C:/workspace',
    });
    expect(provider.id).toBe('gemini');

    const events = await collectProviderEvents(
      provider.stream({
        sessionId: 'session_gem',
        cwd: 'C:/workspace',
        messages: [createTextMessage('user', 'hello')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    expect(urls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
    ]);
    expect(requestHeaders[0]?.['x-goog-api-key']).toBe('g-test-key');
    expect(bodies[0]).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { maxOutputTokens: expect.any(Number) },
    });
    expect(events).toEqual([
      { type: 'text-delta', text: 'gemini-ok' },
      {
        type: 'stop',
        reason: 'stop',
        usage: { completionTokens: 1, totalTokens: 1 },
      },
    ]);
  });
});
