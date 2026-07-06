import { z } from 'zod';

export const EventTypeSchema = z.enum([
  'session_start',
  'session_end',
  'tool_call',
  'tool_response',
  'file_modification',
  'error',
  'metric'
]);

export const ObservabilityEventSchema = z.object({
  timestamp: z.string().datetime(),
  sessionId: z.string().uuid(),
  taskId: z.string().optional(),
  eventType: EventTypeSchema,
  payload: z.record(z.any())
});

export type ObservabilityEvent = z.infer<typeof ObservabilityEventSchema>;
