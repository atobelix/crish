import { describe, expect, it } from 'vitest';
import {
  StaticProviderRouteCatalog,
  createProviderGateway,
} from './provider-gateway';

describe('ProviderGateway — supplementary edge cases', () => {
  it('rejects planRoute when model is empty', async () => {
    const gateway = createProviderGateway();
    const plan = await gateway.planRoute({ model: '' });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe('model_required');
  });

  it('rejects planRoute when model is only whitespace', async () => {
    const gateway = createProviderGateway();
    const plan = await gateway.planRoute({ model: '   ' });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe('model_required');
  });

  it('returns route_not_found when no routes match', async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: 'gpt',
          model: 'gpt-4',
          providerId: 'openai',
          credentialSource: { type: 'api-key', apiKey: 'key' },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: 'nonexistent' });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe('route_not_found');
  });

  it('matches routes by alias', async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: 'alias-route',
          model: 'gpt-4',
          aliases: ['gpt-4-turbo'],
          providerId: 'openai',
          credentialSource: { type: 'api-key', apiKey: 'key' },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: 'gpt-4-turbo' });
    expect(plan.ok).toBe(true);
    expect(plan.selectedRoute?.routeId).toBe('alias-route');
  });

  it('selects by priority descending', async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: 'low',
          model: 'chat',
          providerId: 'a',
          priority: 1,
          credentialSource: { type: 'api-key', apiKey: 'a' },
        },
        {
          id: 'high',
          model: 'chat',
          providerId: 'b',
          priority: 100,
          credentialSource: { type: 'api-key', apiKey: 'b' },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: 'chat' });
    expect(plan.selectedRoute?.routeId).toBe('high');
  });

  it('falls back by routing weight when priority is equal', async () => {
    const gateway = createProviderGateway({
      now: () => 1000,
      routes: [
        {
          id: 'light-a',
          model: 'chat',
          providerId: 'a',
          priority: 100,
          routingWeight: 50,
          credentialSource: { type: 'api-key', apiKey: 'a' },
        },
        {
          id: 'heavy-b',
          model: 'chat',
          providerId: 'b',
          priority: 100,
          routingWeight: 200,
          credentialSource: { type: 'api-key', apiKey: 'b' },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: 'chat' });
    expect(plan.selectedRoute?.routeId).toBe('heavy-b');
  });

  it('skips disabled routes', async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: 'disabled-route',
          model: 'chat',
          providerId: 'a',
          status: 'disabled',
          credentialSource: { type: 'api-key', apiKey: 'a' },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: 'chat' });
    expect(plan.ok).toBe(false);
  });

  it('includes disabled routes when query requests it', async () => {
    const catalog = new StaticProviderRouteCatalog([
      {
        id: 'disabled-route',
        model: 'chat',
        providerId: 'a',
        status: 'disabled',
        credentialSource: { type: 'api-key', apiKey: 'a' },
      },
    ]);
    const routes = catalog.listRoutes({ includeDisabled: true, model: 'chat' });
    expect(routes).toHaveLength(1);
  });

  it('lists routes filtered by providerId', async () => {
    const catalog = new StaticProviderRouteCatalog([
      {
        id: 'r1',
        model: 'chat',
        providerId: 'a',
        credentialSource: { type: 'api-key', apiKey: 'a' },
      },
      {
        id: 'r2',
        model: 'chat',
        providerId: 'b',
        credentialSource: { type: 'api-key', apiKey: 'b' },
      },
    ]);
    expect(catalog.listRoutes({ providerId: 'a' })).toHaveLength(1);
    expect(catalog.listRoutes({ providerId: 'c' })).toHaveLength(0);
  });

  it('addRoute throws on duplicate id', () => {
    const catalog = new StaticProviderRouteCatalog([
      {
        id: 'dup',
        model: 'chat',
        providerId: 'a',
        credentialSource: { type: 'api-key', apiKey: 'a' },
      },
    ]);
    expect(() =>
      catalog.addRoute({
        id: 'dup',
        model: 'other',
        providerId: 'b',
        credentialSource: { type: 'api-key', apiKey: 'b' },
      })
    ).toThrow('already exists');
  });

  it('addRoute throws on empty id', () => {
    const catalog = new StaticProviderRouteCatalog([]);
    expect(() =>
      catalog.addRoute({
        id: '',
        model: 'chat',
        providerId: 'a',
        credentialSource: { type: 'api-key', apiKey: 'a' },
      })
    ).toThrow('route id is required');
  });

  it('concurrent planRoute calls both succeed', async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: 'concurrent',
          model: 'chat',
          providerId: 'a',
          credentialSource: { type: 'api-key', apiKey: 'a' },
        },
      ],
    });
    const [p1, p2] = await Promise.all([
      gateway.planRoute({ model: 'chat' }),
      gateway.planRoute({ model: 'chat' }),
    ]);
    expect(p1.ok).toBe(true);
    expect(p2.ok).toBe(true);
  });

  it('normalizes credential source headers clone', async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: 'headers-test',
          model: 'chat',
          providerId: 'a',
          credentialSource: {
            type: 'api-key',
            apiKey: 'key',
            headers: { Authorization: 'Bearer secret' },
          },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: 'chat' });
    expect(plan.credential!.headers).toEqual({
      Authorization: 'Bearer secret',
    });
  });

  it('planRoute carries modelRouteDecision through to plan', async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: 'decision-test',
          model: 'chat',
          providerId: 'a',
          credentialSource: { type: 'api-key', apiKey: 'key' },
        },
      ],
    });
    const decision = {
      candidates: [] as unknown[],
      rejections: [] as unknown[],
      request: {
        required: [] as unknown[],
        preferred: [] as unknown[],
        avoid: [] as unknown[],
        requiredEndpointSupport: [] as unknown[],
        requiredStreamingSupport: [] as unknown[],
      },
      trace: [] as string[],
      policy: {
        allowProviders: [] as string[],
        denyProviders: [] as string[],
        preferModelIds: [] as string[],
        avoidModelIds: [] as string[],
        weights: {
          requiredCapability: 0,
          preferredCapability: 0,
          missingPreferredPenalty: 0,
          avoidCapabilityPenalty: 0,
          health: 0,
          availability: 0,
          cost: 0,
          latency: 0,
          context: 0,
          priority: 0,
          preferredModel: 0,
          avoidedModelPenalty: 0,
        },
      },
    };
    const plan = await gateway.planRoute({
      model: 'chat',
      modelRouteDecision: decision as any,
    });
    expect(plan.modelRouteDecision).toBe(decision);
  });

  it('returns route_not_found when model_route_capability_rejected_all with endpoint requirement', async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: 'responses-only',
          model: 'chat',
          providerId: 'a',
          credentialSource: { type: 'api-key', apiKey: 'key' },
        },
      ],
    });
    const decision = {
      candidates: [] as unknown[],
      rejections: [] as unknown[],
      request: {
        required: [] as string[],
        preferred: [] as string[],
        avoid: [] as string[],
        requiredEndpointSupport: ['responses'],
        requiredStreamingSupport: [] as string[],
      },
      trace: [] as string[],
      policy: {
        allowProviders: [] as string[],
        denyProviders: [] as string[],
        preferModelIds: [] as string[],
        avoidModelIds: [] as string[],
        weights: {
          requiredCapability: 0,
          preferredCapability: 0,
          missingPreferredPenalty: 0,
          avoidCapabilityPenalty: 0,
          health: 0,
          availability: 0,
          cost: 0,
          latency: 0,
          context: 0,
          priority: 0,
          preferredModel: 0,
          avoidedModelPenalty: 0,
        },
      },
    } as any;
    const plan = await gateway.planRoute({
      model: 'chat',
      modelRouteDecision: decision,
    });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe('route_not_found');
  });
});
