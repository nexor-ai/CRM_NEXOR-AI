export const ANDERSON_MENTTOR_EMAIL = 'andersonmenttor@gmail.com';

export function isAndersonMenttorProfile(
  email: string | null | undefined
): boolean {
  return email?.trim().toLowerCase() === ANDERSON_MENTTOR_EMAIL;
}

export function agentDisplayName(args: {
  email: string | null | undefined;
  configured: boolean;
}): string {
  if (isAndersonMenttorProfile(args.email) && args.configured) {
    return 'Secretária de IA NEXOR';
  }
  return 'Agente de IA';
}
