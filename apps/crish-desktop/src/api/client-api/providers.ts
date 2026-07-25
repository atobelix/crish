export interface ProviderInfo {
  id: string;
  name: string;
  apiKey: string;
  models: string[];
}

export const providersApi = {
  getProviders: async (): Promise<ProviderInfo[]> => {
    const { isDemoMode } = await import('../appMode');
    if (!isDemoMode()) return [];
    const { clientApiDemo } = await import('../clientApi.demo');
    return clientApiDemo.getProviders();
  },

  updateProviderKey: async (
    id: string,
    apiKey: string
  ): Promise<ProviderInfo[]> => {
    const { isDemoMode } = await import('../appMode');
    if (!isDemoMode()) return [];
    const { clientApiDemo } = await import('../clientApi.demo');
    return clientApiDemo.updateProviderKey(id, apiKey);
  },

  updateProviderModels: async (
    id: string,
    models: string[]
  ): Promise<ProviderInfo[]> => {
    const { isDemoMode } = await import('../appMode');
    if (!isDemoMode()) return [];
    const { clientApiDemo } = await import('../clientApi.demo');
    return clientApiDemo.updateProviderModels(id, models);
  },

  fetchLatestModels: async (id: string): Promise<string[]> => {
    const { isDemoMode } = await import('../appMode');
    if (!isDemoMode()) return [];
    const { clientApiDemo } = await import('../clientApi.demo');
    return clientApiDemo.fetchLatestModels(id);
  },
};
