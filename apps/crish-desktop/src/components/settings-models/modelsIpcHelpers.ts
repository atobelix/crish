import type { ModelCapabilityKey } from '../../api/modelCatalogTypes';
import type { ModelProtocol } from '../../api/modelsCatalogTypes';

export interface AddModelDraft {
  modelId: string;
  displayName: string;
  contextLength: string;
  maxOutputTokens?: string;
  caps: Record<ModelCapabilityKey, boolean>;
  thinkingLevel?: string;
  protocol?: ModelProtocol;
  modalities?: {
    input: string[];
    output: string[];
  };
  thinkingEnabled?: boolean;
  thinkingMap?: Record<string, string>;
  pricing?: {
    currency: 'USD' | 'CNY';
    input?: string;
    output?: string;
    cacheRead?: string;
    cacheWrite?: string;
  };
}

export function emptyAddDraft(): AddModelDraft {
  return {
    modelId: '',
    displayName: '',
    contextLength: '',
    maxOutputTokens: '',
    caps: {
      tools: true,
      image: false,
      video: false,
      reasoning: false,
    },
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
    thinkingEnabled: false,
  };
}

export interface ConfigDraft {
  displayName: string;
  contextLength: string;
  maxOutputTokens?: string;
  caps: Record<ModelCapabilityKey, boolean>;
  thinkingLevel?: string;
  protocol?: ModelProtocol;
  modalities?: {
    input: string[];
    output: string[];
  };
  thinkingEnabled?: boolean;
  thinkingMap?: Record<string, string>;
  pricing?: {
    currency: 'USD' | 'CNY';
    input?: string;
    output?: string;
    cacheRead?: string;
    cacheWrite?: string;
  };
}

/**
 * 废止 gravestone：禁止 LocalStorage setter 与价表写入。
 * 生产写核是 modelsCatalogStore.updateModel，见 useModelConfigSession.saveConfig。
 */
export function applyMetaForModel(
  _profileId: string,
  _modelId: string,
  _draft: ConfigDraft
): never {
  throw new Error(
    'applyMetaForModel 已废止：配置真源为 modelsCatalogStore.updateModel，禁止 LocalStorage setter'
  );
}
