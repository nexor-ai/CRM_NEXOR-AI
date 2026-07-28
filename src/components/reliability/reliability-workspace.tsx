'use client';

import { useEffect, useState } from 'react';
import { Activity, Bot, DatabaseZap, MessageSquareWarning, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type ReliabilityPayload = {
  transcriptions: Array<{ id: string; status: string; attempts: number; error_code?: string }>;
  agent_runs: Array<{ id: string; status: string; latency_ms?: number }>;
  external_operations: Array<{ id: string; status: string; operation_type: string; attempts: number }>;
  webhook_events: Array<{ id: string; status: string; dead_letter_at?: string }>;
  reconcile_checkpoints: Array<{ id?: string; updated_at?: string }>;
  partial_errors: string[];
};

const EMPTY: ReliabilityPayload = {
  transcriptions: [],
  agent_runs: [],
  external_operations: [],
  webhook_events: [],
  reconcile_checkpoints: [],
  partial_errors: [],
};

async function fetchReliability(): Promise<ReliabilityPayload> {
  const response = await fetch('/api/reliability', { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Não foi possível carregar a confiabilidade');
  return { ...EMPTY, ...payload };
}

export function ReliabilityWorkspace() {
  const [data, setData] = useState<ReliabilityPayload>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchReliability()
      .then(setData)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Consulta indisponível'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    fetchReliability()
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Consulta indisponível');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = [
    { label: 'Operações externas', value: data.external_operations.length, icon: DatabaseZap },
    { label: 'Transcrições', value: data.transcriptions.length, icon: Activity },
    { label: 'Execuções de IA', value: data.agent_runs.length, icon: Bot },
    { label: 'Eventos de webhook', value: data.webhook_events.length, icon: MessageSquareWarning },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-primary">
            <Activity className="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-[.2em]">Saúde operacional</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Confiabilidade</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Filas, efeitos externos, agentes e reconciliação por conta. Recuperações exigem justificativa e auditoria.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </Button>
      </header>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center justify-between pt-6">
              <div><p className="text-sm text-muted-foreground">{label}</p><p className="text-3xl font-semibold">{value}</p></div>
              <Icon className="h-6 w-6 text-primary" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <QueueCard title="Operações que exigem atenção" items={data.external_operations.map((item) => ({ id: item.id, label: item.operation_type, status: item.status, detail: `${item.attempts} tentativa(s)` }))} />
        <QueueCard title="Transcrições recentes" items={data.transcriptions.map((item) => ({ id: item.id, label: item.error_code || 'Áudio', status: item.status, detail: `${item.attempts} tentativa(s)` }))} />
      </div>

      {data.partial_errors.length > 0 && (
        <Card><CardHeader><CardTitle className="text-base">Consultas parciais</CardTitle></CardHeader><CardContent className="space-y-2">{data.partial_errors.map((message) => <p key={message} className="text-sm text-muted-foreground">{message}</p>)}</CardContent></Card>
      )}
    </div>
  );
}

function QueueCard({ title, items }: { title: string; items: Array<{ id: string; label: string; status: string; detail: string }> }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum item pendente.</p> : items.slice(0, 8).map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
            <div className="min-w-0"><p className="truncate font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.detail}</p></div>
            <Badge variant="outline">{item.status}</Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}