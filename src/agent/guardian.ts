export type GuardianAuditDepth = 'quick' | 'standard' | 'deep';
export type GuardianRisk = 'low' | 'medium' | 'high';

export interface GuardianAuditPlanInput {
  workspaceRoot: string;
  goal?: string;
  depth?: GuardianAuditDepth;
  includeOptionalTools?: boolean;
}

export interface GuardianAuditStep {
  order: number;
  tool: string;
  purpose: string;
  required: boolean;
  tokenMode: 'compact' | 'verbose-on-demand';
  suggestedArgs: Record<string, unknown>;
}

export interface GuardianAuditPlan {
  agent: string;
  mode: 'on-demand' | 'background';
  goal: string;
  workspaceRoot: string;
  depth: GuardianAuditDepth;
  steps: GuardianAuditStep[];
  economyRules: string[];
}

export interface AgentActionReviewInput {
  workspaceRoot?: string;
  proposedAction: string;
  files?: string[];
  allowWrites?: boolean;
  allowShell?: boolean;
}

export interface AgentActionReview {
  risk: GuardianRisk;
  allowed: boolean;
  requiresCheckpoint: boolean;
  reasons: string[];
  recommendedNextSteps: string[];
}

export interface AgentSurfaceFinding {
  host?: string;
  name?: string;
  kind?: string;
  status?: string;
  risk?: GuardianRisk | string;
  path?: string;
  evidence?: string;
}

export interface AgentSurfaceScore {
  score: number;
  risk: GuardianRisk;
  summary: {
    total: number;
    high: number;
    medium: number;
    low: number;
    enabled: number;
  };
  topRisks: AgentSurfaceFinding[];
  recommendations: string[];
}

export interface GuardianFindingTriage {
  mustFix: AgentSurfaceFinding[];
  review: AgentSurfaceFinding[];
  informational: AgentSurfaceFinding[];
  ignored: AgentSurfaceFinding[];
}

const DANGEROUS_PATTERNS = [
  {
    risk: 'high' as const,
    pattern: /\b(rm\s+-rf|git\s+clean\s+-fd|Remove-Item\b.*-Recurse|del\s+\/s)\b/i,
    reason: 'Destructive delete command detected.'
  },
  {
    risk: 'high' as const,
    pattern: /\b(curl|wget|irm|iwr)\b.*(\||;).*\b(bash|sh|iex|Invoke-Expression)\b/i,
    reason: 'Remote script execution pattern detected.'
  },
  {
    risk: 'medium' as const,
    pattern: /\b(git\s+push|npm\s+publish|docker\s+push|gh\s+release)\b/i,
    reason: 'Publishing or remote side-effect command detected.'
  },
  {
    risk: 'medium' as const,
    pattern: /\b(token|secret|password|api[_-]?key)\b/i,
    reason: 'Sensitive credential-related text detected.'
  }
];

export function planGuardianAudit(input: GuardianAuditPlanInput): GuardianAuditPlan {
  const depth = input.depth || 'standard';
  const goal = input.goal || 'Inspect this AI coding-agent workspace safely and cheaply.';
  const steps: GuardianAuditStep[] = [
    {
      order: 1,
      tool: 'inspect_agent_environment_components',
      purpose: 'Find active AI-agent components: MCP servers, model providers, plugins, hooks, extensions, and related local components.',
      required: true,
      tokenMode: 'compact',
      suggestedArgs: { maxFindings: depth === 'quick' ? 20 : 50, includeInstructions: false }
    },
    {
      order: 2,
      tool: 'audit_runtimes',
      purpose: 'Build a cheap runtime baseline for Node, Python, Docker, Git, and Java.',
      required: true,
      tokenMode: 'compact',
      suggestedArgs: {}
    },
    {
      order: 3,
      tool: 'discover_mcp_servers',
      purpose: 'Inspect configured MCP servers directly when the component inspector finds MCP-related risk.',
      required: depth !== 'quick',
      tokenMode: 'compact',
      suggestedArgs: {}
    },
    {
      order: 4,
      tool: 'audit_security_posture',
      purpose: 'Scan workspace rules, package scripts, and configs for risky instructions or secrets.',
      required: depth !== 'quick',
      tokenMode: 'compact',
      suggestedArgs: { workspaceRoot: input.workspaceRoot }
    }
  ];

  if (depth === 'deep' || input.includeOptionalTools) {
    steps.push(
      {
        order: steps.length + 1,
        tool: 'audit_configuration_drift',
        purpose: 'Look for duplicate, stale, or mismatched project configuration.',
        required: false,
        tokenMode: 'compact',
        suggestedArgs: { rootPathsForScan: [input.workspaceRoot] }
      }
    );
  }

  return {
    agent: 'AgentOps Guardian',
    mode: 'on-demand',
    goal,
    workspaceRoot: input.workspaceRoot,
    depth,
    steps,
    economyRules: [
      'Run only after an explicit user request.',
      'Prefer compact outputs and ask for verbose instructions only for selected findings.',
      'Do not scan whole drives by default.',
      'Create checkpoints before file-changing operations.',
      'Use deterministic tool findings before spending model tokens on interpretation.'
    ]
  };
}

export function reviewAgentActionPlan(input: AgentActionReviewInput): AgentActionReview {
  const text = input.proposedAction;
  const reasons: string[] = [];
  let risk: GuardianRisk = 'low';

  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(text)) {
      reasons.push(rule.reason);
      if (rule.risk === 'high') {
        risk = 'high';
      } else if (risk !== 'high') {
        risk = 'medium';
      }
    }
  }

  const touchesFiles = Boolean(input.files?.length);
  if (touchesFiles && !input.allowWrites) {
    reasons.push('File writes were proposed but allowWrites is not enabled.');
    if (risk !== 'high') {
      risk = 'medium';
    }
  }

  if (/\b(npm|pnpm|yarn|pip|python|py|node|powershell|cmd|bash|sh)\b/i.test(text) && !input.allowShell) {
    reasons.push('Shell command execution was proposed but allowShell is not enabled.');
    if (risk !== 'high') {
      risk = 'medium';
    }
  }

  const requiresCheckpoint = touchesFiles || risk !== 'low';
  const allowed = risk === 'low' || (input.allowWrites === true && input.allowShell === true);

  return {
    risk,
    allowed,
    requiresCheckpoint,
    reasons,
    recommendedNextSteps: [
      ...(requiresCheckpoint ? ['Create a checkpoint before continuing.'] : []),
      ...(risk === 'high' ? ['Ask the user for explicit approval and narrow the command scope.'] : []),
      ...(reasons.length === 0 ? ['Proceed with compact tool output and avoid broad scans.'] : [])
    ]
  };
}

export function scoreAgentSurface(findings: AgentSurfaceFinding[]): AgentSurfaceScore {
  const high = findings.filter(finding => finding.risk === 'high').length;
  const medium = findings.filter(finding => finding.risk === 'medium').length;
  const low = findings.filter(finding => finding.risk === 'low').length;
  const enabled = findings.filter(finding => finding.status === 'enabled').length;
  const score = Math.max(0, 100 - high * 20 - medium * 8 - enabled * 2);
  const risk: GuardianRisk = score < 55 ? 'high' : score < 80 ? 'medium' : 'low';
  const topRisks = findings
    .filter(finding => finding.risk === 'high' || finding.risk === 'medium')
    .slice(0, 10);
  const recommendations: string[] = [];

  if (high > 0) {
    recommendations.push('Review high-risk enabled providers, hooks, and MCP servers first.');
  }

  if (medium > 0) {
    recommendations.push('Confirm medium-risk plugins and MCP commands are expected and trusted.');
  }

  if (enabled > 5) {
    recommendations.push('Consider disabling unused agent components to reduce the active attack surface.');
  }

  if (recommendations.length === 0) {
    recommendations.push('No urgent agent-surface action found. Keep compact audits on demand.');
  }

  return {
    score,
    risk,
    summary: {
      total: findings.length,
      high,
      medium,
      low,
      enabled
    },
    topRisks,
    recommendations
  };
}

export function triageGuardianFindings(findings: AgentSurfaceFinding[]): GuardianFindingTriage {
  return {
    mustFix: findings.filter(finding => finding.risk === 'high'),
    review: findings.filter(finding => finding.risk === 'medium'),
    informational: findings.filter(finding => finding.risk === 'low'),
    ignored: findings.filter(finding => !finding.risk || finding.status === 'disabled')
  };
}
