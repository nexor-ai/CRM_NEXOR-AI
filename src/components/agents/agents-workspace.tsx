'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, Bot, Plus, Settings2, ShieldCheck, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { AiPlayground } from '@/components/agents/ai-playground';
import { AiConfig } from '@/components/settings/ai-config';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Agent = {
  id: string;
  name: string;
  description?: string;
  mode: 'disabled' | 'draft_only' | 'supervised' | 'auto_reply';
  is_default: boolean;
  is_active: boolean;
  daily_reply_cap: number;
  monthly_budget_cents: number;
  ai_agent_bindings?: unknown[];
};

type AgentRun = {
  id: string;
  status: string;
  route_source: string;
  mode: string;
  latency_ms?: number;
  started_at: string;
};

const MODE_LABEL = {
  disabled: 'Desativado',
  draft_only: 'Somente rascunho',
  supervised: 'Supervisionado',
  auto_reply: 'Resposta automática',
} as const;

async function fetchAgents(): Promise<Agent[]> {
  const response = await fetch('/api/ai/agents', { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  return payload.agents ?? [];
}

export function AgentsWorkspace() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const nextAgents = await fetchAgents();
    setAgents(nextAgents);
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchAgents()
      .then((nextAgents) => {
        if (!cancelled) setAgents(nextAgents);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function create() {
    if (!name.trim()) return;

    const response = await fetch('/api/ai/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mode: 'draft_only' }),
    });
    const payload = await response.json();
    if (!response.ok) {
      toast.error(payload.error);
      return;
    }

    setName('');
    toast.success('Agente criado em modo rascunho');
    await refresh();
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-primary">
            <Bot className="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-[.2em]">Operação de IA</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Agentes especializados</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Catálogo, vínculos, limites e auditoria. Novos agentes começam em{' '}
            <strong>somente rascunho</strong>.
          </p>
        </div>
        <Badge variant="outline" className="w-fit border-emerald-500/40 text-emerald-600">
          <ShieldCheck className="mr-1 h-3.5 w-3.5" />
          Auto resposta protegida
        </Badge>
      </header>

      <Tabs defaultValue="catalog">
        <TabsList>
          <TabsTrigger value="catalog"><Bot className="mr-1.5 h-4 w-4" />Catálogo</TabsTrigger>
          <TabsTrigger value="playground"><Sparkles className="mr-1.5 h-4 w-4" />Simulador</TabsTrigger>
          <TabsTrigger value="provider"><Settings2 className="mr-1.5 h-4 w-4" />Provedor</TabsTrigger>
          <TabsTrigger value="runs"><Activity className="mr-1.5 h-4 w-4" />Execuções</TabsTrigger>
        </TabsList>

        <TabsContent value="catalog" className="space-y-4 pt-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Novo agente</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2 sm:flex-row">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Qualificação comercial" />
              <Button onClick={() => void create()}><Plus className="mr-2 h-4 w-4" />Criar em rascunho</Button>
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {loading ? (
              <p className="text-sm text-muted-foreground">Carregando agentes…</p>
            ) : agents.map((agent) => (
              <Card key={agent.id} className={agent.is_default ? 'border-primary/40' : ''}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle className="text-base">{agent.name}</CardTitle>
                    {agent.is_default && <Badge>Padrão</Badge>}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">
                    {agent.description || 'Defina objetivo, persona e critérios de encaminhamento.'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{MODE_LABEL[agent.mode]}</Badge>
                    <Badge variant="secondary">Cap {agent.daily_reply_cap}/dia</Badge>
                    <Badge variant="secondary">{agent.ai_agent_bindings?.length ?? 0} vínculo(s)</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="playground" className="pt-4"><AiPlayground onGoToSetup={() => undefined} /></TabsContent>
        <TabsContent value="provider" className="pt-4"><AiConfig /></TabsContent>
        <TabsContent value="runs" className="pt-4"><RunsPanel /></TabsContent>
      </Tabs>
    </div>
  );
}

function RunsPanel() {
  const [runs, setRuns] = useState<AgentRun[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ai/agents/runs')
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setRuns(payload.runs ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Auditoria recente</CardTitle></CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma execução registrada.</p>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                <div>
                  <strong>{run.status}</strong>
                  <p className="text-xs text-muted-foreground">Rota {run.route_source} · {run.mode}</p>
                </div>
                <span className="text-xs text-muted-foreground">{run.latency_ms ? `${run.latency_ms} ms` : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
