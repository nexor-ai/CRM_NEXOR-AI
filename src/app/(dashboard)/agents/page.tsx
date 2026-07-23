'use client';

import { useEffect, useState } from 'react';
import { Bot, Sparkles, Settings2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiConfig } from '@/components/settings/ai-config';
import { useAuth } from '@/hooks/use-auth';
import {
  agentDisplayName,
  isAndersonMenttorProfile,
} from '@/lib/ai/agent-presentation';

type Tab = 'playground' | 'setup';

export default function AgentsPage() {
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);
  const [configured, setConfigured] = useState(false);
  const isAndersonMenttor = isAndersonMenttorProfile(profile?.email);
  const displayName = agentDisplayName({
    email: profile?.email,
    configured,
  });

  // Land first-time users on Setup, returning users on the Playground.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) {
          const isConfigured = data?.configured === true;
          setConfigured(isConfigured);
          setTab(isConfigured ? 'playground' : 'setup');
        }
      } catch {
        if (!cancelled) {
          setConfigured(false);
          setTab('setup');
        }
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="text-primary h-6 w-6" />
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {displayName}
        </h1>
        {decided && !configured && (
          <span className="border-border bg-muted text-muted-foreground rounded-full border px-2 py-0.5 text-xs font-medium">
            Não configurado
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Configure o provedor com sua própria chave, defina a identidade e o
        contexto desta conta e simule o atendimento antes de ativar respostas
        automáticas.
      </p>

      {decided && (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="playground">
              <Sparkles className="mr-1.5 h-4 w-4" /> Simulador
            </TabsTrigger>
            <TabsTrigger value="setup">
              <Settings2 className="mr-1.5 h-4 w-4" /> Configuração
            </TabsTrigger>
          </TabsList>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground onGoToSetup={() => setTab('setup')} />
          </TabsContent>

          <TabsContent value="setup" className="mt-4">
            <div className="border-border bg-card/50 mb-4 grid gap-3 rounded-xl border p-4 text-sm sm:grid-cols-2">
              <div>
                <p className="text-foreground font-medium">
                  {isAndersonMenttor
                    ? 'O que ela coleta'
                    : 'Objetivo do agente'}
                </p>
                <p className="text-muted-foreground mt-1">
                  {isAndersonMenttor
                    ? 'Nome, empresa, necessidade, área afetada, urgência e próximo passo recomendado.'
                    : 'Use o contexto da conta para definir função, tom, informações permitidas e critérios de encaminhamento.'}
                </p>
              </div>
              <div>
                <p className="text-foreground font-medium">
                  Limites obrigatórios
                </p>
                <p className="text-muted-foreground mt-1">
                  Não inventa preço, prazo, case ou compromisso; encaminha para
                  uma pessoa quando faltar contexto ou decisão humana.
                </p>
              </div>
            </div>
            <AiConfig />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
