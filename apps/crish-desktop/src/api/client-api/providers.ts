export interface ProviderInfo {
  id: string;
  name: string;
  apiKey: string;
  models: string[];
}

export const providersApi = {
  getProviders: async (): Promise<ProviderInfo[]> => {
    return [];
  },

  updateProviderKey: async (
    _id: string,
    _apiKey: string
  ): Promise<ProviderInfo[]> => {
    return [];
  },

  updateProviderModels: async (
    _id: string,
    _models: string[]
  ): Promise<ProviderInfo[]> => {
    return [];
  },

  fetchLatestModels: async (_id: string): Promise<string[]> => {
    return [];
  },
};

