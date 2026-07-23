import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/types';

export type TemplateSlug =
  | 'welcome_message'
  | 'out_of_office'
  | 'lead_qualifier'
  | 'follow_up_reminder'
  | 'catalog_request'
  | 'new_contact_onboarding'
  | 'assignment_confirmation'
  | 'daily_reengagement';

export interface TemplateStepSeed {
  step_type: AutomationStepType;
  step_config: AutomationStepConfig;
  branch?: 'yes' | 'no' | null;
  /** Index (within this seed list) of the Condition parent, if nested. */
  parent_index?: number | null;
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug;
  name: string;
  description: string;
  trigger_type: AutomationTriggerType;
  trigger_config: AutomationTriggerConfig;
  steps: TemplateStepSeed[];
}

export const AUTOMATION_TEMPLATES: Record<
  TemplateSlug,
  AutomationTemplateDefinition
> = {
  welcome_message: {
    slug: 'welcome_message',
    name: 'Mensagem de boas-vindas',
    description: 'Responde automaticamente novos contatos com uma saudação.',
    // first_inbound_message (added in PR #33) catches both brand-new
    // contacts AND manually-added/imported contacts on their first-ever
    // reply, which is what a user setting up a "welcome" automation
    // almost always wants. new_contact_created would miss the
    // manually-imported case.
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Olá! 👋 Obrigado por entrar em contato. Retornaremos em breve.",
        },
      },
    ],
  },
  out_of_office: {
    slug: 'out_of_office',
    name: 'Fora do expediente',
    description: 'Responde automaticamente fora do horário para ninguém ficar sem resposta.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '18:00-09:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Obrigado pela sua mensagem! Nossa equipe está offline no momento (9h–18h) e responderá amanhã cedo.',
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  lead_qualifier: {
    slug: 'lead_qualifier',
    name: 'Qualificador de leads',
    description: 'Faz perguntas de qualificação para filtrar leads recebidos.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['preço', 'orçamento', 'comprar'],
      match_type: 'contains',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Ótimo — será um prazer ajudar com valores! Uma pergunta rápida: para quantas pessoas ou licenças você procura?',
        },
      },
      {
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: 'Lembrete de follow-up',
    description: 'Envia um lembrete se o contato não responder em 24 horas.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Passando para saber se ficou alguma dúvida. Estou à disposição!',
        },
      },
    ],
  },
  catalog_request: {
    slug: 'catalog_request',
    name: 'Catálogo e serviços',
    description: 'Responde pedidos de catálogo, serviços ou portfólio.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['catálogo', 'catalogo', 'serviços', 'servicos', 'portfólio'],
      match_type: 'contains',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Claro! Vou encaminhar as opções disponíveis. Para indicar a melhor, qual solução você procura e para quando?',
        },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  new_contact_onboarding: {
    slug: 'new_contact_onboarding',
    name: 'Onboarding de novo contato',
    description: 'Recepciona contatos recém-criados e define a próxima ação.',
    trigger_type: 'new_contact_created',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Olá! Seu contato foi recebido com sucesso. Conte em uma frase como podemos ajudar para direcionarmos seu atendimento.',
        },
      },
    ],
  },
  assignment_confirmation: {
    slug: 'assignment_confirmation',
    name: 'Confirmação de atendimento',
    description:
      'Avisa o cliente quando a conversa é atribuída a um atendente.',
    trigger_type: 'conversation_assigned',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Seu atendimento já foi direcionado a um especialista. Ele continuará por aqui em breve.',
        },
      },
    ],
  },
  daily_reengagement: {
    slug: 'daily_reengagement',
    name: 'Reengajamento diário',
    description: 'Cria uma rotina diária de retomada para contatos elegíveis.',
    trigger_type: 'time_based',
    trigger_config: { schedule: '0 10 * * 1-5', timezone: 'America/Sao_Paulo' },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Olá! Passando para saber se você ainda precisa de ajuda com sua solicitação. Posso retomar de onde paramos.',
        },
      },
    ],
  },
};

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null;
}
