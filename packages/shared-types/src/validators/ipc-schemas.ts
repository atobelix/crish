import { z } from "zod";

export const SidecarQueryResponseSchema = z.object({
  id: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type SidecarQueryResponse = z.infer<typeof SidecarQueryResponseSchema>;

export const SessionSummarySchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

export const RunTaskResponseSchema = z.object({
  runId: z.string(),
  status: z.string(),
});
export type RunTaskResponse = z.infer<typeof RunTaskResponseSchema>;

export const SimpleStatusResponseSchema = z.object({
  success: z.boolean(),
});
export type SimpleStatusResponse = z.infer<typeof SimpleStatusResponseSchema>;

export const PlanSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.string(),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

export const ListPlansResponseSchema = z.object({
  plans: z.array(PlanSummarySchema),
});
export type ListPlansResponse = z.infer<typeof ListPlansResponseSchema>;

export const ConnectionStatusResponseSchema = z.object({
  connected: z.boolean(),
  daemonVersion: z.string().optional(),
});
export type ConnectionStatusResponse = z.infer<typeof ConnectionStatusResponseSchema>;
