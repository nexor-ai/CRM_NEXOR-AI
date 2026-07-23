import { describe, expect, it } from 'vitest';
import { AUTOMATION_TEMPLATES } from './templates';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from './validate';

function expand(slug: keyof typeof AUTOMATION_TEMPLATES) {
  const template = AUTOMATION_TEMPLATES[slug];
  return template.steps.map((step) => ({
    step_type: step.step_type,
    step_config: step.step_config as Record<string, unknown>,
  }));
}

describe('automation quick-start library', () => {
  it('contains exactly eight globally reusable templates', () => {
    expect(Object.keys(AUTOMATION_TEMPLATES)).toHaveLength(8);
  });

  it('ships every template with an activatable trigger and steps', () => {
    for (const template of Object.values(AUTOMATION_TEMPLATES)) {
      expect(
        validateTriggerForActivation(
          template.trigger_type,
          template.trigger_config
        ),
        template.slug
      ).toEqual([]);
      expect(
        validateStepsForActivation(expand(template.slug)),
        template.slug
      ).toEqual([]);
    }
  });
});
