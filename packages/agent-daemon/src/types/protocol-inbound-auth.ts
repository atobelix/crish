export interface DaemonCorrelationFields {
  requestId?: string;
  correlationId?: string;
}

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  clientName?: string;
  token?: string;
}

export interface PingMessage {
  type: "ping";
}
