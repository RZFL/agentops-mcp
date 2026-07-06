import fs from 'fs/promises';
import path from 'path';
import { getSessionsDir } from './store.js';
import { ObservabilityEvent } from './schema.js';

export interface SessionSummary {
  sessionId: string;
  name: string;
  created: string;
  durationMs: number;
  status: 'active' | 'success' | 'failure';
  totalToolCalls: number;
  toolCallsCount: Record<string, number>;
  totalErrors: number;
  errors: string[];
  filesModified: { filePath: string; changeType: 'created' | 'modified' | 'deleted' }[];
}

export async function analyzeSession(sessionId: string): Promise<SessionSummary | null> {
  const sessionFile = path.join(getSessionsDir(), `${sessionId}.jsonl`);

  try {
    const content = await fs.readFile(sessionFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const events: ObservabilityEvent[] = lines.map(line => JSON.parse(line));
    
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];

    let name = 'Unnamed Session';
    if (firstEvent.eventType === 'session_start' && firstEvent.payload.name) {
      name = firstEvent.payload.name;
    }

    let status: SessionSummary['status'] = 'active';
    if (lastEvent.eventType === 'session_end') {
      status = lastEvent.payload.status || 'success';
    }

    const start = new Date(firstEvent.timestamp).getTime();
    const end = new Date(lastEvent.timestamp).getTime();
    const durationMs = end - start;

    const toolCallsCount: Record<string, number> = {};
    let totalToolCalls = 0;
    const errors: string[] = [];
    const filesMap = new Map<string, 'created' | 'modified' | 'deleted'>();

    for (const event of events) {
      if (event.eventType === 'tool_call') {
        const toolName = event.payload.toolName || 'unknown';
        toolCallsCount[toolName] = (toolCallsCount[toolName] || 0) + 1;
        totalToolCalls++;
      } else if (event.eventType === 'error') {
        errors.push(event.payload.message || 'Unknown error');
      } else if (event.eventType === 'file_modification') {
        const filePath = event.payload.filePath;
        const changeType = event.payload.changeType || 'modified';
        if (filePath) {
          filesMap.set(filePath, changeType);
        }
      }
    }

    const filesModified = Array.from(filesMap.entries()).map(([filePath, changeType]) => ({
      filePath,
      changeType
    }));

    return {
      sessionId,
      name,
      created: firstEvent.timestamp,
      durationMs,
      status,
      totalToolCalls,
      toolCallsCount,
      totalErrors: errors.length,
      errors,
      filesModified
    };
  } catch {
    return null;
  }
}
