import type { MessageTemplate } from '@/types';

export const MIN_BROADCAST_INTERVAL_MINUTES = 5;
export const MAX_BROADCAST_INTERVAL_MINUTES = 24 * 60;
export const BROADCAST_INTERVAL_OPTIONS = [
  5, 10, 15, 30, 60, 120, 240, 480, 1440,
] as const;

export interface BroadcastScheduleConfig {
  intervalMinutes: number;
  scheduledAt?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  timezone?: string;
  dailyLimit?: number | null;
}

export interface CampaignTemplatePreset {
  slug: string;
  name: string;
  description: string;
  category: MessageTemplate['category'];
  language: string;
  variations: string[];
  recommendedIntervalMinutes: number;
}

export function normalizeBroadcastInterval(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return MIN_BROADCAST_INTERVAL_MINUTES;
  return Math.min(
    MAX_BROADCAST_INTERVAL_MINUTES,
    Math.max(MIN_BROADCAST_INTERVAL_MINUTES, Math.round(parsed))
  );
}

export function estimateCampaignMinutes(
  recipients: number,
  intervalMinutes: number
): number {
  if (recipients <= 1) return 0;
  return (recipients - 1) * normalizeBroadcastInterval(intervalMinutes);
}

export const CAMPAIGN_TEMPLATE_PRESETS: CampaignTemplatePreset[] = [
  {
    slug: 'institutional_intro',
    name: 'Apresentação institucional',
    description: 'Primeiro contato profissional e objetivo.',
    category: 'Marketing',
    language: 'pt_BR',
    recommendedIntervalMinutes: 10,
    variations: [
      'Olá, {{1}}. Sou da equipe {{2}}. Posso compartilhar rapidamente como ajudamos empresas a melhorar processos e atendimento?',
      'Oi, {{1}}. Aqui é da {{2}}. Identificamos uma oportunidade de tornar algumas rotinas mais eficientes. Faz sentido conversarmos?',
      'Olá, {{1}}. Represento a {{2}} e gostaria de entender se automação e IA estão entre as prioridades da sua empresa neste momento.',
    ],
  },
  {
    slug: 'consultative_first_contact',
    name: 'Primeiro contato consultivo',
    description: 'Abordagem baseada em diagnóstico, sem promessa comercial.',
    category: 'Marketing',
    language: 'pt_BR',
    recommendedIntervalMinutes: 15,
    variations: [
      'Olá, {{1}}. Qual atividade repetitiva mais consome tempo da sua equipe hoje?',
      'Oi, {{1}}. Se você pudesse eliminar um gargalo operacional nesta semana, qual seria?',
      'Olá, {{1}}. Estamos mapeando desafios de operação em empresas como a sua. Qual processo merece atenção primeiro?',
    ],
  },
  {
    slug: 'needs_diagnosis',
    name: 'Diagnóstico de necessidade',
    description: 'Coleta o principal problema antes de propor solução.',
    category: 'Utility',
    language: 'pt_BR',
    recommendedIntervalMinutes: 15,
    variations: [
      'Olá, {{1}}. Para direcionar melhor o atendimento: seu desafio principal está em vendas, atendimento, processos ou dados?',
      'Oi, {{1}}. O que você precisa melhorar primeiro: velocidade, qualidade, custo ou controle da operação?',
      'Olá, {{1}}. Para entendermos seu cenário, qual resultado concreto sua empresa busca alcançar agora?',
    ],
  },
  {
    slug: 'meeting_invite',
    name: 'Convite para reunião',
    description: 'Convite simples para uma conversa de diagnóstico.',
    category: 'Utility',
    language: 'pt_BR',
    recommendedIntervalMinutes: 20,
    variations: [
      'Olá, {{1}}. Podemos reservar uma conversa breve para mapear seu cenário e avaliar se conseguimos ajudar?',
      'Oi, {{1}}. Faz sentido marcarmos 20 minutos para entender a operação e identificar oportunidades práticas?',
      'Olá, {{1}}. Se for útil, podemos agendar um diagnóstico inicial sem compromisso. Qual período funciona melhor?',
    ],
  },
  {
    slug: 'no_reply_followup',
    name: 'Follow-up sem resposta',
    description: 'Retomada respeitosa sem pressão.',
    category: 'Utility',
    language: 'pt_BR',
    recommendedIntervalMinutes: 30,
    variations: [
      'Olá, {{1}}. Retomando nosso contato: este assunto ainda faz sentido para você?',
      'Oi, {{1}}. Passando apenas para confirmar se vale continuar esta conversa ou se prefere retomarmos em outro momento.',
      'Olá, {{1}}. Não quero insistir fora de hora. Quer que eu encerre por agora ou agende uma retomada?',
    ],
  },
  {
    slug: 'contact_reactivation',
    name: 'Reativação de contato',
    description: 'Retoma uma relação anterior com contexto.',
    category: 'Marketing',
    language: 'pt_BR',
    recommendedIntervalMinutes: 30,
    variations: [
      'Olá, {{1}}. Faz algum tempo desde nosso último contato. Houve alguma mudança nas prioridades da sua empresa?',
      'Oi, {{1}}. Estamos retomando algumas conversas para entender novos desafios. Como está seu cenário hoje?',
      'Olá, {{1}}. Gostaria de saber se o tema que conversamos anteriormente voltou a ser prioridade.',
    ],
  },
  {
    slug: 'service_presentation',
    name: 'Apresentação de serviço',
    description: 'Apresenta uma capacidade sem inventar preço ou prazo.',
    category: 'Marketing',
    language: 'pt_BR',
    recommendedIntervalMinutes: 15,
    variations: [
      'Olá, {{1}}. A {{2}} atua com consultoria, automação e agentes de IA aplicados à operação. Qual dessas frentes é mais relevante para você?',
      'Oi, {{1}}. Ajudamos empresas a estruturar processos e implementar IA de forma prática. Existe alguma área que você quer avaliar?',
      'Olá, {{1}}. Trabalhamos com diagnóstico, automação e agentes especializados. Posso entender seu contexto antes de sugerir um caminho?',
    ],
  },
  {
    slug: 'interest_confirmation',
    name: 'Confirmação de interesse',
    description: 'Confirma intenção antes de avançar comercialmente.',
    category: 'Utility',
    language: 'pt_BR',
    recommendedIntervalMinutes: 10,
    variations: [
      'Olá, {{1}}. Você gostaria de avançar para um diagnóstico mais detalhado?',
      'Oi, {{1}}. Este tema ainda está entre suas prioridades? Se sim, organizo o próximo passo.',
      'Olá, {{1}}. Posso encaminhar sua demanda para uma conversa com um especialista da equipe?',
    ],
  },
];
