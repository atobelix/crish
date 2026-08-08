import { InvariantViolation } from './InvariantViolation';

export interface CrishService {
  id: string;
  init(): Promise<void>;
  destroy(): Promise<void>;
  health?(): { status: 'ok' | 'degraded' | 'down'; latency: number };
}

class ServiceRegistry {
  private services = new Map<string, CrishService>();

  register(service: CrishService): void {
    if (this.services.has(service.id)) throw new Error(`Service ${service.id} already registered`);
    this.services.set(service.id, service);
  }

  resolve<T extends CrishService>(id: string): T {
    const s = this.services.get(id);
    if (!s) throw new InvariantViolation(`Service ${id} not registered`);
    return s as T;
  }

  async startAll(): Promise<void> {
    for (const [, svc] of this.services) {
      await svc.init();
    }
  }

  async stopAll(): Promise<void> {
    const reversed = [...this.services.values()].reverse();
    for (const svc of reversed) {
      await svc.destroy();
    }
    this.services.clear();
  }

  async healthCheck(): Promise<Record<string, { status: string; latency: number }>> {
    const result: Record<string, { status: string; latency: number }> = {};
    for (const [id, svc] of this.services) {
      const start = performance.now();
      try {
        const h = await svc.health?.();
        result[id] = h ?? { status: 'unknown', latency: performance.now() - start };
      } catch {
        result[id] = { status: 'down', latency: performance.now() - start };
      }
    }
    return result;
  }

  enumerate(): string[] {
    return [...this.services.keys()];
  }
}

export const serviceRegistry = new ServiceRegistry();
