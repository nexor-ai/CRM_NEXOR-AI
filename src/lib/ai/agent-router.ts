export type AgentMode = 'disabled' | 'draft_only' | 'supervised' | 'auto_reply';

export interface AgentCandidate {
  agentId: string;
  bindingId: string | null;
  configId: string | null;
  departmentId: string | null;
  isDefault: boolean;
  priority: number;
  active: boolean;
  mode: AgentMode;
}

interface ResolveArgs {
  candidates: AgentCandidate[];
  configId: string | null;
  departmentId: string | null;
  stickyAgentId?: string | null;
}

export function resolveAgentBinding(args: ResolveArgs): AgentCandidate | null {
  const available = args.candidates.filter((candidate) => candidate.active && candidate.mode !== 'disabled');
  if (args.stickyAgentId) {
    const sticky = available.find((candidate) => candidate.agentId === args.stickyAgentId);
    if (sticky) return sticky;
  }

  const rank = (candidate: AgentCandidate): number => {
    if (candidate.configId === args.configId && candidate.departmentId === args.departmentId && candidate.configId && candidate.departmentId) return 4;
    if (candidate.configId === args.configId && candidate.configId && candidate.departmentId === null) return 3;
    if (candidate.departmentId === args.departmentId && candidate.departmentId && candidate.configId === null) return 2;
    if (candidate.isDefault && candidate.configId === null && candidate.departmentId === null) return 1;
    return 0;
  };

  const ranked = available.map((candidate) => ({ candidate, rank: rank(candidate) })).filter(({ rank }) => rank > 0);
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.rank - a.rank || b.candidate.priority - a.candidate.priority || a.candidate.agentId.localeCompare(b.candidate.agentId));
  const winner = ranked[0];
  const tied = ranked.filter(({ rank, candidate }) => rank === winner.rank && candidate.priority === winner.candidate.priority);
  if (tied.length > 1) throw new Error('ambiguous_agent_binding');
  return winner.candidate;
}
