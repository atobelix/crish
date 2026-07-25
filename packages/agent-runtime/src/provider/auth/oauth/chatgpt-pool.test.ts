import { describe, it } from 'vitest';

describe('ChatGPTAccountPool', () => {
  it.todo('should deduplicate concurrent refresh requests via single-flight');
  it.todo('should not increment errorCount on transient network errors');
});
