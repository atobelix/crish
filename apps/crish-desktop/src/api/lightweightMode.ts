import { getPlatformInfo, type PlatformLevel } from './platformDetect';

export interface LightweightConfig {
  enabled: boolean;
  maxSessions: number;
  maxMessages: number;
  workerCount: number;
  disableHighlight: boolean;
  disableMarkdownCache: boolean;
  disableAnimations: boolean;
  disableTelemetry: boolean;
}

let config: LightweightConfig = {
  enabled: false,
  maxSessions: 50,
  maxMessages: 100,
  workerCount: 2,
  disableHighlight: false,
  disableMarkdownCache: false,
  disableAnimations: false,
  disableTelemetry: false,
};

export function getLightweightConfig(): LightweightConfig {
  return config;
}

export function computeLightweightConfig(platformLevel: PlatformLevel): LightweightConfig {
  if (platformLevel === 0) {
    config = {
      enabled: true,
      maxSessions: 20,
      maxMessages: 20,
      workerCount: 1,
      disableHighlight: true,
      disableMarkdownCache: true,
      disableAnimations: true,
      disableTelemetry: true,
    };
  } else if (platformLevel === 1) {
    config = {
      enabled: true,
      maxSessions: 30,
      maxMessages: 50,
      workerCount: 1,
      disableHighlight: false,
      disableMarkdownCache: true,
      disableAnimations: true,
      disableTelemetry: false,
    };
  }
  return config;
}

export function applyLightweightConfig(): void {
  const platform = getPlatformInfo();
  computeLightweightConfig(platform.level);
  if (config.disableAnimations) {
    document.documentElement.setAttribute('data-reduced-motion', 'true');
  }
}
