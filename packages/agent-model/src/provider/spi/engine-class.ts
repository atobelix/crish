import type { Engine } from '../types';

export interface EngineClass {
  readonly id: string;
  createEngine(): Engine;
}
