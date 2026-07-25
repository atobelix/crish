export interface MetricsExporter<T = unknown> {
  export(snapshot: T): Promise<void>;
  readonly name: string;
}
