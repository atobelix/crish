export type TurnEndReason = "stop" | "tool-call" | "max-turns" | "aborted" | "error" | "agent-stop";
export type TurnLoopState = string;
export type TurnLoopContext = Record<string, unknown>;
export type TurnLoopEvent = string;
