import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Auditor imports
import { auditRuntimes } from "./auditor/runtimes.js";
import { discoverProjects } from "./auditor/projects.js";
import { auditMCPServers } from "./auditor/mcp.js";
import { auditDrift } from "./auditor/drift.js";
import { auditSecurityPosture } from "./auditor/security.js";
import { inspectAgentEnvironmentComponents } from "./auditor/agentComponents.js";

// Observability imports
import { createCheckpoint, restoreCheckpoint } from "./observability/checkpoint.js";
import {
  planGuardianAudit,
  reviewAgentActionPlan,
  scoreAgentSurface,
  triageGuardianFindings
} from "./agent/guardian.js";
import {
  createWorkflowId,
  loadWorkflowState,
  saveWorkflowState,
  type GuardianWorkflowCheckpoint,
  type GuardianWorkflowState
} from "./agent/workflowState.js";

// Initialize the MCP server
const server = new Server(
  {
    name: "agentops-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool schemas using Zod
const auditRuntimesSchema = z.object({});
const discoverProjectsSchema = z.object({
  rootPaths: z.array(z.string()),
  maxDepth: z.number().optional()
});
const discoverMCPServersSchema = z.object({});
const auditConfigurationDriftSchema = z.object({
  projectPaths: z.array(z.string()).optional(),
  rootPathsForScan: z.array(z.string()).optional() // Fallback scan if projectPaths not specified
});
const auditSecurityPostureSchema = z.object({
  workspaceRoot: z.string()
});
const createCheckpointSchema = z.object({
  sessionId: z.string(),
  filePath: z.string()
});
const restoreCheckpointSchema = z.object({
  checkpointId: z.string().optional(),
  filePath: z.string().optional()
}).refine(data => data.checkpointId || data.filePath, {
  message: "Either checkpointId or filePath must be provided."
});
const safeCheckpointSchema = z.object({
  filePath: z.string(),
  sessionId: z.string().optional()
});
const restoreLatestSchema = z.object({
  filePath: z.string()
});
const prepareSafeEditSchema = z.object({
  proposedAction: z.string(),
  files: z.array(z.string()).min(1),
  sessionId: z.string().optional(),
  allowWrites: z.boolean().optional(),
  allowShell: z.boolean().optional()
});
const planGuardianAuditSchema = z.object({
  workspaceRoot: z.string(),
  goal: z.string().optional(),
  depth: z.enum(['quick', 'standard', 'deep']).optional(),
  includeOptionalTools: z.boolean().optional()
});
const reviewAgentActionPlanSchema = z.object({
  workspaceRoot: z.string().optional(),
  proposedAction: z.string(),
  files: z.array(z.string()).optional(),
  allowWrites: z.boolean().optional(),
  allowShell: z.boolean().optional()
});
const inspectAgentEnvironmentComponentsSchema = z.object({
  extraRoots: z.array(z.string()).max(5).optional(),
  maxFindings: z.number().int().min(1).max(200).optional(),
  includeInstructions: z.boolean().optional(),
  useCache: z.boolean().optional(),
  cacheTtlMs: z.number().int().min(0).max(300000).optional()
});
const scoreAgentSurfaceSchema = z.object({
  extraRoots: z.array(z.string()).max(5).optional(),
  maxFindings: z.number().int().min(1).max(200).optional()
});
const triageGuardianFindingsSchema = z.object({
  extraRoots: z.array(z.string()).max(5).optional(),
  maxFindings: z.number().int().min(1).max(200).optional()
});

const guardianRunWorkflowSchema = z.object({
  workspaceRoot: z.string(),
  proposedAction: z.string(),
  files: z.array(z.string()).optional(),
  mode: z.enum(['cheap', 'standard', 'deep']).optional(),
  workflowId: z.string().optional(),
  allowWrites: z.boolean().optional(),
  allowShell: z.boolean().optional(),
  createCheckpoints: z.boolean().optional(),
  maxFindings: z.number().int().min(1).max(200).optional(),
  refreshInspector: z.boolean().optional()
});
const guardianRestoreWorkflowSchema = z.object({
  workflowId: z.string()
});

// Helper to format tool responses
function createTextResponse(text: string) {
  return {
    content: [
      {
        type: "text",
        text: text
      }
    ]
  };
}

function createErrorResponse(message: string) {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${message}`
      }
    ],
    isError: true
  };
}

function workflowDepth(mode: 'cheap' | 'standard' | 'deep') {
  if (mode === 'deep') {
    return 'deep';
  }

  return mode === 'standard' ? 'standard' : 'quick';
}

function workflowFindingLimit(mode: 'cheap' | 'standard' | 'deep', maxFindings?: number): number {
  if (maxFindings) {
    return maxFindings;
  }

  return mode === 'cheap' ? 20 : mode === 'standard' ? 50 : 100;
}

function workflowStatus(review: { allowed: boolean; risk: string }, checkpoints: GuardianWorkflowCheckpoint[]) {
  const failedCheckpoint = checkpoints.some(checkpoint => !checkpoint.success);

  if (failedCheckpoint || review.risk === 'high') {
    return 'blocked';
  }

  return review.allowed ? 'ready' : 'needs_user_approval';
}

function workflowNextActions(
  status: 'blocked' | 'needs_user_approval' | 'ready',
  checkpointCount: number
): string[] {
  if (status === 'ready') {
    return [
      checkpointCount > 0
        ? 'Proceed with the proposed action; rollback checkpoints are ready.'
        : 'Proceed only if the touched files are intentionally outside checkpoint scope.',
      'Run verification after the edit and call restore_latest if the result is wrong.'
    ];
  }

  if (status === 'needs_user_approval') {
    return [
      'Ask the user for explicit approval before writing files or running shell commands.',
      'Narrow the proposed action or set allowWrites/allowShell only after approval.'
    ];
  }

  return [
    'Do not proceed yet.',
    'Fix the high-risk finding or failed checkpoint, then rerun guardian_run_workflow.'
  ];
}

function workflowDecision(
  workflowId: string,
  status: 'blocked' | 'needs_user_approval' | 'ready',
  checkpoints: GuardianWorkflowCheckpoint[],
  nextActions: string[]
) {
  const checkpointCreated = checkpoints.some(checkpoint => checkpoint.success);

  return {
    workflowId,
    status,
    checkpointCreated,
    checkpointCount: checkpoints.filter(checkpoint => checkpoint.success).length,
    nextAction: nextActions[0],
    restoreTool: checkpointCreated ? 'guardian_restore_workflow' : 'restore_latest',
    restoreArgs: checkpointCreated ? { workflowId } : undefined
  };
}

// 1. List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "audit_runtimes",
        description: "Check the local system for installed runtimes and tools (Node, Python, Git, Docker, Java).",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "discover_projects",
        description: "Locate active software development projects in target directory paths.",
        inputSchema: {
          type: "object",
          properties: {
            rootPaths: {
              type: "array",
              items: { type: "string" },
              description: "Array of absolute directory paths to scan."
            },
            maxDepth: {
              type: "number",
              description: "Maximum directory depth to search (default 4)."
            }
          },
          required: ["rootPaths"]
        }
      },
      {
        name: "discover_mcp_servers",
        description: "Audit local MCP client configuration files and list registered MCP servers.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "audit_configuration_drift",
        description: "Audit packages and project configuration directories for duplicate naming, old code, and dependency drift.",
        inputSchema: {
          type: "object",
          properties: {
            projectPaths: {
              type: "array",
              items: { type: "string" },
              description: "Direct list of project absolute paths. If not specified, rootPathsForScan will be used to auto-discover projects."
            },
            rootPathsForScan: {
              type: "array",
              items: { type: "string" },
              description: "Paths to scan for projects if direct projectPaths is not provided."
            }
          }
        }
      },
      {
        name: "audit_security_posture",
        description: "Audit agent workspace safety: risky instructions, shell-backed MCP configs, inline secrets, missing checkpoints, and unsafe scripts.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceRoot: {
              type: "string",
              description: "Absolute workspace path to audit."
            }
          },
          required: ["workspaceRoot"]
        }
      },
      {
        name: "safe_checkpoint",
        description: "Create a quick restore point for one file before an agent edit. Friendly wrapper over create_checkpoint with a generated Guardian session id.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Absolute path of the file to back up."
            },
            sessionId: {
              type: "string",
              description: "Optional session id. A Guardian id is generated when omitted."
            }
          },
          required: ["filePath"]
        }
      },
      {
        name: "restore_latest",
        description: "Restore the latest checkpoint for one file. This is the fast recovery button for failed agent edits.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Absolute path of the file to restore from its latest checkpoint."
            }
          },
          required: ["filePath"]
        }
      },
      {
        name: "prepare_safe_edit",
        description: "Review a proposed agent edit and create checkpoints for all target files before any write happens.",
        inputSchema: {
          type: "object",
          properties: {
            proposedAction: {
              type: "string",
              description: "The edit or command the agent wants to perform."
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "Absolute file paths that may be changed."
            },
            sessionId: {
              type: "string",
              description: "Optional session id for all created checkpoints."
            },
            allowWrites: {
              type: "boolean",
              default: false,
              description: "Whether writes were explicitly allowed."
            },
            allowShell: {
              type: "boolean",
              default: false,
              description: "Whether shell execution was explicitly allowed."
            }
          },
          required: ["proposedAction", "files"]
        }
      },
      {
        name: "create_checkpoint",
        description: "Create a micro-checkpoint backup of a file's content in SQLite before modification (supports files up to 10MB).",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Current session UUID."
            },
            filePath: {
              type: "string",
              description: "Absolute path of the file to backup."
            }
          },
          required: ["sessionId", "filePath"]
        }
      },
      {
        name: "restore_checkpoint",
        description: "Restore a file to its state from a previously saved checkpoint.",
        inputSchema: {
          type: "object",
          properties: {
            checkpointId: {
              type: "string",
              description: "Specific checkpoint UUID. If omitted, filePath must be provided to restore latest."
            },
            filePath: {
              type: "string",
              description: "Absolute file path to restore to latest state. Required if checkpointId is omitted."
            }
          }
        }
      },
      {
        name: "score_agent_surface",
        description: "Run the compact agent component inspector and return a simple AI-agent attack-surface score with top risks.",
        inputSchema: {
          type: "object",
          properties: {
            extraRoots: {
              type: "array",
              items: { type: "string" },
              maxItems: 5,
              description: "Optional extra absolute project/config roots to scan."
            },
            maxFindings: {
              type: "number",
              minimum: 1,
              maximum: 200,
              default: 50,
              description: "Maximum inspector findings to score."
            }
          }
        }
      },
      {
        name: "triage_guardian_findings",
        description: "Run the compact agent component inspector and group findings into mustFix, review, informational, and ignored buckets.",
        inputSchema: {
          type: "object",
          properties: {
            extraRoots: {
              type: "array",
              items: { type: "string" },
              maxItems: 5,
              description: "Optional extra absolute project/config roots to scan."
            },
            maxFindings: {
              type: "number",
              minimum: 1,
              maximum: 200,
              default: 50,
              description: "Maximum inspector findings to triage."
            }
          }
        }
      },
      {
        name: "guardian_run_workflow",
        description: "Top-level Guardian agent workflow: plan, inspect, score, review the proposed action, create checkpoints, persist compact workflow state, and return the next action.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceRoot: {
              type: "string",
              description: "Absolute workspace root for the agent workflow."
            },
            proposedAction: {
              type: "string",
              description: "The edit, command, or change the agent wants to perform."
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "Files expected to be changed. These are checkpointed before the action when possible."
            },
            mode: {
              type: "string",
              enum: ["cheap", "standard", "deep"],
              default: "cheap",
              description: "Workflow depth. Cheap mode uses compact inspection and cache by default."
            },
            workflowId: {
              type: "string",
              description: "Optional existing workflow id to resume a compact persisted state."
            },
            allowWrites: {
              type: "boolean",
              default: false,
              description: "Whether the user explicitly allowed file writes."
            },
            allowShell: {
              type: "boolean",
              default: false,
              description: "Whether the user explicitly allowed shell execution."
            },
            createCheckpoints: {
              type: "boolean",
              default: true,
              description: "Create checkpoints for listed files before the action."
            },
            maxFindings: {
              type: "number",
              minimum: 1,
              maximum: 200,
              description: "Maximum inspector findings used by the workflow."
            },
            refreshInspector: {
              type: "boolean",
              default: false,
              description: "Bypass inspector cache for this workflow run."
            }
          },
          required: ["workspaceRoot", "proposedAction"]
        }
      },
      {
        name: "guardian_restore_workflow",
        description: "Restore all files checkpointed by a previous Guardian workflow state.",
        inputSchema: {
          type: "object",
          properties: {
            workflowId: {
              type: "string",
              description: "Workflow id returned by guardian_run_workflow."
            }
          },
          required: ["workflowId"]
        }
      },
      {
        name: "plan_guardian_audit",
        description: "Create a bounded, token-efficient AgentOps Guardian audit plan for an AI coding-agent workspace. This plans tool calls; it does not run background monitoring.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceRoot: {
              type: "string",
              description: "Workspace root to audit."
            },
            goal: {
              type: "string",
              description: "Optional audit goal or user concern."
            },
            depth: {
              type: "string",
              enum: ["quick", "standard", "deep"],
              default: "standard",
              description: "Controls how many optional checks are planned."
            },
            includeOptionalTools: {
              type: "boolean",
              default: false,
              description: "Include optional diagnostics such as drift and encoding checks."
            }
          },
          required: ["workspaceRoot"]
        }
      },
      {
        name: "review_agent_action_plan",
        description: "Review a proposed agent action against safety guardrails before running shell commands or editing files.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceRoot: {
              type: "string",
              description: "Optional workspace root for context."
            },
            proposedAction: {
              type: "string",
              description: "The command, edit plan, or action the agent wants to perform."
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "Files the action intends to modify."
            },
            allowWrites: {
              type: "boolean",
              default: false,
              description: "Whether file writes have been explicitly allowed."
            },
            allowShell: {
              type: "boolean",
              default: false,
              description: "Whether shell execution has been explicitly allowed."
            }
          },
          required: ["proposedAction"]
        }
      },
      {
        name: "inspect_agent_environment_components",
        description: "Read-only scan of local AI-agent components: MCP servers, model providers, plugins, hooks, extensions, processes, and installed apps. Runs only when requested and returns compact findings by default.",
        inputSchema: {
          type: "object",
          properties: {
            extraRoots: {
              type: "array",
              items: { type: "string" },
              maxItems: 5,
              description: "Optional extra absolute project/config roots to scan."
            },
            maxFindings: {
              type: "number",
              minimum: 1,
              maximum: 200,
              default: 50,
              description: "Maximum findings to return. The inspector still reports total count."
            },
            includeInstructions: {
              type: "boolean",
              default: false,
              description: "Include verbose backup-first remediation instructions. Disabled by default to save tokens."
            },
            useCache: {
              type: "boolean",
              default: true,
              description: "Reuse a fresh in-memory inspector result when available."
            },
            cacheTtlMs: {
              type: "number",
              minimum: 0,
              maximum: 300000,
              default: 30000,
              description: "Inspector cache TTL in milliseconds. Use 0 for a fresh scan."
            }
          }
        }
      },
    ]
  };
});

// 2. Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "audit_runtimes": {
        auditRuntimesSchema.parse(args);
        const result = await auditRuntimes();
        return createTextResponse(JSON.stringify(result, null, 2));
      }

      case "discover_projects": {
        const parsed = discoverProjectsSchema.parse(args);
        const result = await discoverProjects(parsed.rootPaths, parsed.maxDepth);
        return createTextResponse(JSON.stringify(result, null, 2));
      }

      case "discover_mcp_servers": {
        discoverMCPServersSchema.parse(args);
        const result = await auditMCPServers();
        return createTextResponse(JSON.stringify(result, null, 2));
      }

      case "audit_configuration_drift": {
        const parsed = auditConfigurationDriftSchema.parse(args);
        let projects = [];
        if (parsed.projectPaths) {
          // Wrap direct paths into ProjectInfo shells for drift check
          projects = parsed.projectPaths.map(p => ({
            path: p,
            name: p.split("/").pop() || "project",
            type: p.includes("package.json") ? "nodejs" : "unknown" as any,
            mainFiles: [],
            lastModified: new Date().toISOString()
          }));
        } else if (parsed.rootPathsForScan) {
          projects = await discoverProjects(parsed.rootPathsForScan);
        } else {
          return createErrorResponse("Either projectPaths or rootPathsForScan must be specified.");
        }
        const result = await auditDrift(projects);
        return createTextResponse(JSON.stringify(result, null, 2));
      }

      case "audit_security_posture": {
        const parsed = auditSecurityPostureSchema.parse(args);
        const result = await auditSecurityPosture(parsed.workspaceRoot);
        return createTextResponse(JSON.stringify(result, null, 2));
      }

      case "create_checkpoint": {
        const parsed = createCheckpointSchema.parse(args);
        const result = await createCheckpoint(parsed.sessionId, parsed.filePath);
        return createTextResponse(JSON.stringify(result, null, 2));
      }

      case "restore_checkpoint": {
        const parsed = restoreCheckpointSchema.parse(args);
        const result = await restoreCheckpoint(parsed.checkpointId, parsed.filePath);
        return createTextResponse(JSON.stringify(result, null, 2));
      }



      case "inspect_agent_environment_components": {
        const parsed = inspectAgentEnvironmentComponentsSchema.parse(args);
        const result = await inspectAgentEnvironmentComponents(parsed);
        return createTextResponse(JSON.stringify(result, null, 2));
      }
      case "guardian_run_workflow": {
        const parsed = guardianRunWorkflowSchema.parse(args);
        const mode = parsed.mode || 'cheap';
        const workflowId = parsed.workflowId || createWorkflowId();
        const previousState = parsed.workflowId
          ? await loadWorkflowState(parsed.workflowId)
          : undefined;
        const files = parsed.files || [];
        const plan = planGuardianAudit({
          workspaceRoot: parsed.workspaceRoot,
          goal: parsed.proposedAction,
          depth: workflowDepth(mode)
        });
        const inspectionReport = await inspectAgentEnvironmentComponents({
          extraRoots: [parsed.workspaceRoot],
          maxFindings: workflowFindingLimit(mode, parsed.maxFindings),
          includeInstructions: false,
          useCache: !parsed.refreshInspector,
          cacheTtlMs: parsed.refreshInspector ? 0 : 30000
        });
        const surfaceScore = scoreAgentSurface(inspectionReport.findings);
        const triage = triageGuardianFindings(inspectionReport.findings);
        const review = reviewAgentActionPlan({
          workspaceRoot: parsed.workspaceRoot,
          proposedAction: parsed.proposedAction,
          files,
          allowWrites: parsed.allowWrites,
          allowShell: parsed.allowShell
        });
        const checkpoints: GuardianWorkflowCheckpoint[] = [];

        if (parsed.createCheckpoints !== false && files.length > 0) {
          for (const filePath of files) {
            try {
              const checkpoint = await createCheckpoint(workflowId, filePath);
              checkpoints.push({
                filePath,
                success: Boolean((checkpoint as any).success),
                checkpointId: (checkpoint as any).checkpointId,
                error: (checkpoint as any).success ? undefined : (checkpoint as any).error || 'Checkpoint was not created.'
              });
            } catch (err: any) {
              checkpoints.push({
                filePath,
                success: false,
                error: err?.message || String(err)
              });
            }
          }
        }

        const status = workflowStatus(review, checkpoints);
        const now = new Date().toISOString();
        const completedSteps = [
          'plan',
          'inspect',
          'score',
          'triage',
          'review',
          ...(files.length > 0 && parsed.createCheckpoints !== false ? ['checkpoint'] : []),
          'persist_state'
        ];
        const nextActions = workflowNextActions(status, checkpoints.filter(checkpoint => checkpoint.success).length);
        const decision = workflowDecision(workflowId, status, checkpoints, nextActions);
        const state: GuardianWorkflowState = {
          workflowId,
          createdAt: previousState?.createdAt || now,
          updatedAt: now,
          workspaceRoot: parsed.workspaceRoot,
          mode,
          status,
          proposedAction: parsed.proposedAction,
          completedSteps,
          nextActions,
          review,
          surfaceScore,
          inspection: {
            cached: inspectionReport.cached,
            findingCount: inspectionReport.findingCount,
            returnedCount: inspectionReport.returnedCount,
            truncated: inspectionReport.truncated,
            summary: inspectionReport.summary,
            topRisks: surfaceScore.topRisks.slice(0, 5),
            mustFixCount: triage.mustFix.length,
            reviewCount: triage.review.length
          },
          checkpoints
        };
        const statePath = await saveWorkflowState(state);

        return createTextResponse(JSON.stringify({
          decision,
          workflowId,
          resumed: Boolean(previousState),
          statePath,
          status,
          mode,
          completedSteps,
          nextActions: state.nextActions,
          review,
          surfaceScore,
          inspection: state.inspection,
          checkpoints,
          plan: {
            agent: plan.agent,
            mode: plan.mode,
            steps: plan.steps.map(step => ({
              order: step.order,
              tool: step.tool,
              required: step.required,
              tokenMode: step.tokenMode
            }))
          }
        }, null, 2));
      }

      case "guardian_restore_workflow": {
        const parsed = guardianRestoreWorkflowSchema.parse(args);
        const state = await loadWorkflowState(parsed.workflowId);

        if (!state) {
          return createErrorResponse(`Workflow state not found: ${parsed.workflowId}`);
        }

        const restoreResults = [];

        for (const checkpoint of state.checkpoints.filter(checkpoint => checkpoint.success)) {
          try {
            const result = await restoreCheckpoint(checkpoint.checkpointId, checkpoint.filePath);
            restoreResults.push({
              filePath: checkpoint.filePath,
              checkpointId: checkpoint.checkpointId,
              ...result
            });
          } catch (err: any) {
            restoreResults.push({
              filePath: checkpoint.filePath,
              checkpointId: checkpoint.checkpointId,
              success: false,
              error: err?.message || String(err)
            });
          }
        }

        const restoredCount = restoreResults.filter(result => result.success).length;
        const now = new Date().toISOString();
        const updatedState: GuardianWorkflowState = {
          ...state,
          updatedAt: now,
          status: restoredCount === restoreResults.length ? 'ready' : 'blocked',
          completedSteps: [...state.completedSteps, 'restore'],
          nextActions: restoredCount === restoreResults.length
            ? ['Workflow files were restored. Re-run verification before continuing.']
            : ['Some workflow files failed to restore. Inspect restoreResults before continuing.']
        };
        const statePath = await saveWorkflowState(updatedState);

        return createTextResponse(JSON.stringify({
          workflowId: parsed.workflowId,
          statePath,
          restoredCount,
          requestedRestoreCount: restoreResults.length,
          success: restoreResults.length > 0 && restoredCount === restoreResults.length,
          restoreResults,
          nextActions: updatedState.nextActions
        }, null, 2));
      }

      case "plan_guardian_audit": {
        const parsed = planGuardianAuditSchema.parse(args);
        const result = planGuardianAudit(parsed);
        return createTextResponse(JSON.stringify(result, null, 2));
      }
      case "review_agent_action_plan": {
        const parsed = reviewAgentActionPlanSchema.parse(args);
        const result = reviewAgentActionPlan(parsed);
        return createTextResponse(JSON.stringify(result, null, 2));
      }
      case "safe_checkpoint": {
        const parsed = safeCheckpointSchema.parse(args);
        const sessionId = parsed.sessionId || `guardian-${Date.now()}`;
        const result = await createCheckpoint(sessionId, parsed.filePath);
        return createTextResponse(JSON.stringify({
          ...result,
          sessionId,
          restoreHint: result.checkpointId
            ? `Use restore_checkpoint with checkpointId=${result.checkpointId}, or restore_latest with filePath=${parsed.filePath}.`
            : undefined
        }, null, 2));
      }
      case "restore_latest": {
        const parsed = restoreLatestSchema.parse(args);
        const result = await restoreCheckpoint(undefined, parsed.filePath);
        return createTextResponse(JSON.stringify(result, null, 2));
      }
      case "prepare_safe_edit": {
        const parsed = prepareSafeEditSchema.parse(args);
        const review = reviewAgentActionPlan({
          proposedAction: parsed.proposedAction,
          files: parsed.files,
          allowWrites: parsed.allowWrites,
          allowShell: parsed.allowShell
        });
        const sessionId = parsed.sessionId || `guardian-${Date.now()}`;
        const checkpoints = [];

        for (const filePath of parsed.files) {
          checkpoints.push({
            filePath,
            ...(await createCheckpoint(sessionId, filePath))
          });
        }

        return createTextResponse(JSON.stringify({
          sessionId,
          review,
          checkpoints
        }, null, 2));
      }
      case "score_agent_surface": {
        const parsed = scoreAgentSurfaceSchema.parse(args);
        const report = await inspectAgentEnvironmentComponents({
          extraRoots: parsed.extraRoots,
          maxFindings: parsed.maxFindings,
          includeInstructions: false
        });
        const result = scoreAgentSurface(report.findings);
        return createTextResponse(JSON.stringify({
          inspected: {
            findingCount: report.findingCount,
            returnedCount: report.returnedCount,
            truncated: report.truncated
          },
          ...result
        }, null, 2));
      }
      case "triage_guardian_findings": {
        const parsed = triageGuardianFindingsSchema.parse(args);
        const report = await inspectAgentEnvironmentComponents({
          extraRoots: parsed.extraRoots,
          maxFindings: parsed.maxFindings,
          includeInstructions: false
        });
        const result = triageGuardianFindings(report.findings);
        return createTextResponse(JSON.stringify({
          inspected: {
            findingCount: report.findingCount,
            returnedCount: report.returnedCount,
            truncated: report.truncated
          },
          ...result
        }, null, 2));
      }
      default:
        return createErrorResponse(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return createErrorResponse(`Invalid arguments: ${err.message}`);
    }
    return createErrorResponse(err.message || "An unexpected error occurred.");
  }
});

// Run server using stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AgentOps MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main:", error);
  process.exit(1);
});
