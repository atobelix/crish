import { type ProviderRegistryV2 } from '../registry-v2';

export function listProviders(
  registry: ProviderRegistryV2,
  options?: { engine?: string; filter?: string }
): Array<{
  id: string;
  name: string;
  engine: string;
  models: number;
  capabilities: string;
}> {
  let defs = registry.listDeclarativeEntries();

  if (options?.engine) {
    defs = defs.filter((d) => d.engine === options.engine);
  }

  if (options?.filter) {
    const lower = options.filter.toLowerCase();
    defs = defs.filter(
      (d) =>
        d.providerId.toLowerCase().includes(lower) ||
        d.metadata.name.toLowerCase().includes(lower)
    );
  }

  return defs.map((d) => ({
    id: d.providerId,
    name: d.metadata.name,
    engine: d.engine,
    models: d.metadata.models.length,
    capabilities: d.metadata.capabilities.join(', '),
  }));
}
