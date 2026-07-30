/**
 * Canonical Event Model 测试
 */

import { describe, it, expect } from 'vitest';
import {
  RuntimeCanonicalAdapter,
  EventSchemaRegistry,
  createCanonicalEvent,
  createDefaultSchemaRegistry,
  type AdapterContext,
  type ConexCanonicalEvent,
} from './canonical-event';

// ─── Runtime Adapter 测试 ─────────────────────────────────

describe('RuntimeCanonicalAdapter', () => {
  const adapter = new RuntimeCanonicalAdapter();
  const context: AdapterContext = {
    traceId: 'trace-1',
    spanId: 'span-1',
    sessionId: 'session-1',
    runId: 'run-1',
  };

  it('should convert agent-start event to canonical', () => {
    const event = {
      type: 'agent-start',
      sessionId: 'session-1',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const canonical = adapter.toCanonical(event, context);

    expect(canonical.domain).toBe('conversation');
    expect(canonical.eventType).toBe('agent-start');
    expect(canonical.sourceLayer).toBe('runtime');
    expect(canonical.traceId).toBe('trace-1');
    expect(canonical.eventId).toBeDefined();
    expect(canonical.occurredAt).toBeDefined();
  });

  it('should convert tool event to canonical', () => {
    const event = {
      type: 'tool-start',
      sessionId: 'session-1',
      batchId: 'batch-1',
      call: { id: 'call-1' },
    };
    const canonical = adapter.toCanonical(event, context);

    expect(canonical.domain).toBe('tool');
    expect(canonical.eventType).toBe('tool-start');
  });

  it('should convert approval event to canonical', () => {
    const event = {
      type: 'approval-requested',
      sessionId: 'session-1',
      request: { id: 'approval-1' },
    };
    const canonical = adapter.toCanonical(event, context);

    expect(canonical.domain).toBe('approval');
    expect(canonical.eventType).toBe('approval-requested');
  });

  it('should convert checkpoint event to canonical', () => {
    const event = {
      type: 'checkpoint-created',
      sessionId: 'session-1',
      checkpoint: { id: 'cp-1' },
    };
    const canonical = adapter.toCanonical(event, context);

    expect(canonical.domain).toBe('checkpoint');
    expect(canonical.eventType).toBe('checkpoint-created');
  });

  it('should convert provider-diagnostic event to canonical', () => {
    const event = {
      type: 'provider-diagnostic',
      sessionId: 'session-1',
      diagnostic: { phase: 'request-start' },
    };
    const canonical = adapter.toCanonical(event, context);

    expect(canonical.domain).toBe('provider');
    expect(canonical.eventType).toBe('provider-diagnostic');
  });

  it('should round-trip: canonical → layer → canonical preserves payload', () => {
    const original = {
      type: 'agent-end',
      sessionId: 'session-1',
      reason: 'stop',
    };
    const canonical = adapter.toCanonical(original, context);
    const restored = adapter.fromCanonical(canonical);

    expect(restored).toEqual(original);
  });
});

// ─── Schema Registry 测试 ─────────────────────────────────

describe('EventSchemaRegistry', () => {
  it('should register and validate schemas', () => {
    const registry = new EventSchemaRegistry();
    registry.register({
      domain: 'test',
      eventType: 'test-event',
      requiredFields: ['payload.id'],
      fieldTypes: { 'payload.id': 'string' },
    });

    const validEvent: ConexCanonicalEvent = {
      eventId: 'evt-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      sourceLayer: 'runtime',
      occurredAt: '2024-01-01T00:00:00Z',
      domain: 'test',
      eventType: 'test-event',
      payload: { id: '123' },
    };

    const result = registry.validate(validEvent);
    expect(result.valid).toBe(true);
  });

  it('should detect missing required fields', () => {
    const registry = new EventSchemaRegistry();
    registry.register({
      domain: 'test',
      eventType: 'test-event',
      requiredFields: ['payload.id'],
      fieldTypes: { 'payload.id': 'string' },
    });

    const invalidEvent: ConexCanonicalEvent = {
      eventId: 'evt-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      sourceLayer: 'runtime',
      occurredAt: '2024-01-01T00:00:00Z',
      domain: 'test',
      eventType: 'test-event',
      payload: {},
    };

    const result = registry.validate(invalidEvent);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.path).toBe('payload.id');
  });

  it('should detect type mismatches', () => {
    const registry = new EventSchemaRegistry();
    registry.register({
      domain: 'test',
      eventType: 'test-event',
      requiredFields: [],
      fieldTypes: { 'payload.count': 'number' },
    });

    const invalidEvent: ConexCanonicalEvent = {
      eventId: 'evt-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      sourceLayer: 'runtime',
      occurredAt: '2024-01-01T00:00:00Z',
      domain: 'test',
      eventType: 'test-event',
      payload: { count: 'not-a-number' },
    };

    const result = registry.validate(invalidEvent);
    expect(result.valid).toBe(false);
  });

  it('should report unregistered schemas', () => {
    const registry = new EventSchemaRegistry();
    const event: ConexCanonicalEvent = {
      eventId: 'evt-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      sourceLayer: 'runtime',
      occurredAt: '2024-01-01T00:00:00Z',
      domain: 'test',
      eventType: 'unknown-event',
      payload: {},
    };

    const result = registry.validate(event);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('No schema registered');
  });

  it('should list domains and event types', () => {
    const registry = createDefaultSchemaRegistry();
    const domains = registry.listDomains();
    expect(domains).toContain('conversation');
    expect(domains).toContain('tool');
    expect(domains).toContain('approval');

    const convTypes = registry.listEventTypes('conversation');
    expect(convTypes).toContain('agent-start');
    expect(convTypes).toContain('agent-end');
  });
});

// ─── createCanonicalEvent 测试 ────────────────────────────

describe('createCanonicalEvent', () => {
  it('should create event with all required fields', () => {
    const event = createCanonicalEvent({
      domain: 'conversation',
      eventType: 'agent-start',
      payload: { sessionId: 's1' },
      context: {
        traceId: 'trace-1',
        spanId: 'span-1',
        sessionId: 's1',
        runId: 'r1',
      },
      sourceLayer: 'runtime',
    });

    expect(event.eventId).toBeDefined();
    expect(event.traceId).toBe('trace-1');
    expect(event.spanId).toBe('span-1');
    expect(event.domain).toBe('conversation');
    expect(event.eventType).toBe('agent-start');
    expect(event.sourceLayer).toBe('runtime');
    expect(event.occurredAt).toBeDefined();
    expect(event.correlationId).toBe('r1');
  });

  it('should include diagnostics when provided', () => {
    const event = createCanonicalEvent({
      domain: 'diagnostic',
      eventType: 'runtime-error',
      payload: { error: 'test' },
      context: {
        traceId: 'trace-1',
        spanId: 'span-1',
        sessionId: 's1',
      },
      sourceLayer: 'runtime',
      diagnostics: [{ code: 'TEST', severity: 'error', message: 'test error' }],
    });

    expect(event.diagnostics).toHaveLength(1);
    expect(event.diagnostics![0]!.code).toBe('TEST');
  });
});
