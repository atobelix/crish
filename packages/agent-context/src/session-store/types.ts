export class StoreCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreCapacityError';
  }
}

export type AppendResult = {
  totalMessageCount: number;
  totalEstimatedTokens: number;
};
