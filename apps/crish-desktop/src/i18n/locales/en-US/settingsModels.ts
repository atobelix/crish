// Settings dictionary part: model & provider (models.*) sub-domain entries, spread into settings.ts.
// Must keep the same key set and interpolation params as zh-CN/settingsModels.ts.

export const settingsPartModels = {
  // ── Models settings tab overview & global default model (models.*) ──
  'models.addProvider': 'Add Provider',
  'models.globalDefaultModel': 'Global Default Model',
  'models.globalDefaultModelDesc':
    'Optional. When not specified, select a model in chat',
  'models.globalDefaultModelSharedNote':
    'This is the same setting as the model selected at the top of the chat composer; changing it in either place takes effect in both',

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
  // ── Probe and form validation (models.probe.*) ──
  'models.probe.vendorNameEmpty': 'Vendor name cannot be empty',
  // ── Field-level validation (models.field.*, shared by the F7 form family) ──
  'models.field.positiveInteger': 'Enter a positive whole number',
  'models.field.modelIdRequired': 'Enter a model ID',
  'models.field.baseUrlInvalid':
    'Enter a valid URL starting with http:// or https://',
  'models.probe.vendorNameSaveFailed': 'Failed to save vendor name',
  'models.probe.handshakeOk':
    'Provider handshake successful (URL and credentials verified, click "Fetch" to add models)',
  'models.probe.checkFailed': 'Connection check failed: {error}',
};
