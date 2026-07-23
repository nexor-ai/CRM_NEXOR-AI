import { describe, expect, it } from 'vitest';
import { listFlowTemplates } from './templates';
import { validateFlowForActivation } from './validate';

describe('flow quick-start library', () => {
  it('contains exactly eight globally reusable templates with unique slugs', () => {
    const templates = listFlowTemplates();
    expect(templates).toHaveLength(8);
    expect(new Set(templates.map((template) => template.slug)).size).toBe(8);
  });

  it('ships every template with a valid graph', () => {
    for (const template of listFlowTemplates()) {
      const issues = validateFlowForActivation(
        {
          name: template.name,
          entry_node_id: template.entry_node_id,
          trigger_type: template.trigger_type,
          trigger_config: template.trigger_config as Record<string, unknown>,
        },
        template.nodes.map((node) => ({
          ...node,
          config: node.config as Record<string, unknown>,
        }))
      );
      expect(issues, template.slug).toEqual([]);
    }
  });
});
