// Settings dictionary part: model & provider (models.*) sub-domain entries, spread into settings.ts.
// Must keep the same key set and interpolation params as zh-CN/settingsModels.ts.

export const settingsPartModels = {
  // ── Model vendor display names (models.vendor.*; referenced by ModelVendorMeta.nameKey) ──
  'models.vendor.deepseek': 'DeepSeek',
  'models.vendor.qwen': 'Qwen (Tongyi Qianwen)',
  'models.vendor.moonshot': 'Moonshot AI (Kimi)',
  'models.vendor.zhipu': 'Zhipu AI (GLM)',
  'models.vendor.minimax': 'MiniMax (Hailuo)',
  'models.vendor.bytedance': 'ByteDance (Doubao)',
  'models.vendor.stepfun': 'StepFun',
  'models.vendor.baichuan': 'Baichuan AI',
  'models.vendor.zeroone': '01.AI',
  'models.vendor.baidu': 'Baidu (ERNIE Bot)',
  'models.vendor.tencent': 'Tencent (Hunyuan)',
  'models.vendor.iflytek': 'iFlytek (Spark)',
  'models.vendor.sensetime': 'SenseTime (SenseNova)',
  'models.vendor.kling': 'Kuaishou (Kling)',
  'models.vendor.siliconflow': 'SiliconFlow',

  // ── Models settings tab overview & global default model (models.*) ──
  'models.addProvider': 'Add Provider',
  'models.globalDefaultModel': 'Global Default Model',
  'models.globalDefaultModelDesc':
    'Optional. When not specified, select a model in chat',

  // ── models.yaml quick-access menu (models.yaml.*) ──
  'models.yaml.configFile': 'Model config file (models.yaml)',
  'models.yaml.editAria':
    'Edit the model config file (models.yaml) in the built-in editor',
  'models.yaml.moreAria': 'Config file shortcuts and open options',
  'models.yaml.menuAria': 'Model config file options',
  'models.yaml.openBuiltin': 'Open in built-in editor',
  'models.yaml.externalEditors': 'External editors',
  'models.yaml.openDefault': 'Open with default app',
  'models.yaml.fileActions': 'File actions',
  'models.yaml.reveal': 'Reveal in file manager',
  'models.yaml.copyPath': 'Copy absolute path',
  'models.yaml.pathCopied': 'Copied the config file path',
  'models.yaml.openFailed': 'Failed to open',
  'models.yaml.revealFailed': 'Failed to reveal in file manager',

  // ── Same-provider self-heal after the default model is disabled (models.selfHeal.*) ──
  'models.selfHeal.switched':
    'The current model was disabled. Switched to {modelId} from the same provider.',
  'models.selfHeal.noModelLeft':
    'The current provider has no available models. Please choose one manually.',

  // ── Global default model cascade select (models.cascade.*) ──
  'models.cascade.fallbackTrigger':
    'No enabled models available (please enable one)',
  'models.cascade.fallbackEmptyMenu': 'No enabled models available',
  'models.cascade.modelListAria': '{name} model list',
  'models.cascade.chooseModel': 'Choose model...',
  'models.cascade.unspecified': 'None',
  'models.cascade.title': 'Select Provider and Model',

  // ── Left provider rail list (models.profileList.*) ──
  'models.profileList.ariaList': 'Provider list',
  'models.profileList.empty': 'No providers configured',
  'models.profileList.missingKey': 'Missing API key',
  'models.profileList.disabled': 'Disabled',
  'models.profileList.ready': 'Configured and enabled',
};
