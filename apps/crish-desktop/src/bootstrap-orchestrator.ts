import { serviceRegistry } from './services/ServiceRegistry';
import { configService } from './services/ConfigService';
import { registerConfigSchemas } from './services/config-schema';

async function bootstrapOrchestrator(): Promise<void> {
  const start = performance.now();

  // Phase 1: Init core config
  await configService.init();
  registerConfigSchemas();

  // Phase 2: Register boot services
  // (future: register services with serviceRegistry)

  // Phase 3: Start all registered services
  await serviceRegistry.startAll();

  window.__crish_perf = { ...window.__crish_perf, orchestratorReady: performance.now() };
  console.debug(`[perf] bootstrapOrchestrator: ${performance.now() - start}ms`);
}

export const ready = bootstrapOrchestrator();
