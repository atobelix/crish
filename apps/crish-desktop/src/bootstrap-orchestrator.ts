import { configService } from './services/ConfigService';

async function bootstrapOrchestrator(): Promise<void> {
  const start = performance.now();

  // Phase 1: Init core config
  await configService.init();

  window.__crish_perf = { ...window.__crish_perf, orchestratorReady: performance.now() };
  console.debug(`[perf] bootstrapOrchestrator: ${performance.now() - start}ms`);
}

export const ready = bootstrapOrchestrator();

