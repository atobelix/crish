export const DAEMON_HANDSHAKE_PROTOCOL_VERSION = 1;

export interface DaemonReadyMessage {
  type: "daemon-ready";
  port: number;
  protocolVersion: number;
  buildHash: string;
  pid?: number;
}

export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: number;
  serverName: string;
  capabilities: string[];
}

export interface PongMessage {
  type: "pong";
}
