import { describe, expect, it, vi } from 'vitest';
import { ProviderCallCoordinator } from './provider-call';

describe('SessionLoop', () => {
  it('should detect length stopReason and auto-continue', () => {
    const coordinator = new ProviderCallCoordinator({} as any);
    const mockSteering = { resetSteeringCount: vi.fn() };
    const msg: any = { metadata: { stopReason: 'length' } };

    const action = coordinator.handleLengthFinishReason(msg, mockSteering);
    expect(action.type).toBe('escalated');
  });

  it('should expand maxTokens on length truncation', () => {
    const coordinator = new ProviderCallCoordinator({} as any);
    const mockSteering = { resetSteeringCount: vi.fn() };
    const msg: any = { metadata: { stopReason: 'length' } };

    expect(coordinator.maxTokensOverride).toBeUndefined();

    // First escalation: 8192 * 2 = 16384
    coordinator.handleLengthFinishReason(msg, mockSteering);
    expect(coordinator.maxTokensOverride).toBe(16384);

    // Second escalation: 16384 * 2 = 32768
    coordinator.handleLengthFinishReason(msg, mockSteering);
    expect(coordinator.maxTokensOverride).toBe(32768);
  });
});
