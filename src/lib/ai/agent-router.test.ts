import { describe, expect, it } from 'vitest';
import { resolveAgentBinding, type AgentCandidate } from './agent-router';

const base: AgentCandidate = {
  agentId: 'default', bindingId: null, configId: null, departmentId: null,
  isDefault: true, priority: 0, active: true, mode: 'draft_only',
};

describe('resolveAgentBinding', () => {
  it('applies sticky → config+department → config → department → default', () => {
    const candidates: AgentCandidate[] = [
      base,
      { ...base, agentId: 'department', bindingId: 'b-dept', departmentId: 'd1', isDefault: false },
      { ...base, agentId: 'config', bindingId: 'b-config', configId: 'c1', isDefault: false },
      { ...base, agentId: 'both', bindingId: 'b-both', configId: 'c1', departmentId: 'd1', isDefault: false },
    ];
    expect(resolveAgentBinding({ candidates, configId: 'c1', departmentId: 'd1' })?.agentId).toBe('both');
    expect(resolveAgentBinding({ candidates, configId: 'c1', departmentId: null })?.agentId).toBe('config');
    expect(resolveAgentBinding({ candidates, configId: null, departmentId: 'd1' })?.agentId).toBe('department');
    expect(resolveAgentBinding({ candidates, configId: null, departmentId: null })?.agentId).toBe('default');
    expect(resolveAgentBinding({ candidates, configId: 'c1', departmentId: 'd1', stickyAgentId: 'department' })?.agentId).toBe('department');
  });

  it('ignores disabled/inactive agents and fails closed on an ambiguous top priority', () => {
    const tied = [
      { ...base, agentId: 'a', bindingId: '1', isDefault: true, priority: 10 },
      { ...base, agentId: 'b', bindingId: '2', isDefault: true, priority: 10 },
    ];
    expect(() => resolveAgentBinding({ candidates: tied, configId: null, departmentId: null })).toThrow('ambiguous_agent_binding');
    expect(resolveAgentBinding({ candidates: [{ ...base, mode: 'disabled' }], configId: null, departmentId: null })).toBeNull();
  });
});
