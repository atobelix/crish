import { describe, expect, it, vi } from 'vitest';
import { ProviderCallCoordinator } from './provider-call';

describe('provider-call', () => {
  it('should trigger continue prompt on length finish reason', () => {
    const dummyConsumer: any = {};
    const coordinator = new ProviderCallCoordinator(dummyConsumer);
    const mockSteering = { resetSteeringCount: vi.fn() };
    const msg: any = { metadata: { stopReason: 'length' } };

    const result = coordinator.handleLengthFinishReason(msg, mockSteering);

    expect(result.type).toBe('escalated');
    if (result.type === 'escalated') {
      expect(result.nudgeText).toContain('truncated');
    }
    expect(mockSteering.resetSteeringCount).toHaveBeenCalled();
  });
});
