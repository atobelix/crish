import { describe, it, expect } from 'vitest';
import { processAIRequest, AIRequest } from '../../services/ai/mockAiService';

describe('Synthetic AI Service Interface Contract (Features 36-41)', () => {
  it('Feature 36: should handle expand action and return augmented text', async () => {
    const req: AIRequest = { action: 'expand', text: 'Tiptap is a rich text editor framework.' };
    const res = await processAIRequest(req);

    expect(res.success).toBe(true);
    expect(res.result).toContain('Tiptap is a rich text editor framework.');
    expect(res.result).toContain('[AI Expanded Details]');
  });

  it('Feature 36: should handle shorten action correctly', async () => {
    const req: AIRequest = {
      action: 'shorten',
      text: 'This is a very long sentence that needs to be shortened significantly for summary purposes.',
    };
    const res = await processAIRequest(req);

    expect(res.success).toBe(true);
    expect(res.result.length).toBeLessThan(req.text.length);
    expect(res.result).toContain('...');
  });

  it('Feature 36: should handle translate action with target language parameter', async () => {
    const req: AIRequest = {
      action: 'translate',
      text: 'Hello world',
      targetLanguage: 'Chinese',
    };
    const res = await processAIRequest(req);

    expect(res.success).toBe(true);
    expect(res.result).toContain('[Translated to Chinese]');
  });

  it('Feature 37: should handle summarize action and return citations', async () => {
    const req: AIRequest = { action: 'summarize', text: 'Document body text here...' };
    const res = await processAIRequest(req);

    expect(res.success).toBe(true);
    expect(res.result).toContain('Executive Summary:');
    expect(res.citations).toBeDefined();
    expect(res.citations?.length).toBeGreaterThan(0);
  });

  it('Feature 38: should handle Q&A queries and include line citations', async () => {
    const req: AIRequest = { action: 'qa', text: 'What is the serializer mechanism?' };
    const res = await processAIRequest(req);

    expect(res.success).toBe(true);
    expect(res.result).toContain('Based on document context');
    expect(res.citations).toBeDefined();
  });

  it('Feature 40: should handle review action and return diffs array', async () => {
    const req: AIRequest = { action: 'review', text: 'Test content to review.' };
    const res = await processAIRequest(req);

    expect(res.success).toBe(true);
    expect(res.diffs).toBeDefined();
    expect(res.diffs?.some((d) => d.type === 'add')).toBe(true);
  });

  it('Feature 41: should return responses within synthetic latency limit (<300ms)', async () => {
    const start = performance.now();
    const req: AIRequest = { action: 'continue', text: 'Starting text' };
    await processAIRequest(req);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(300);
  });
});
