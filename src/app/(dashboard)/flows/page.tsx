'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  MessageSquare,
  PlayCircle,
  PauseCircle,
  Archive,
  HelpCircle,
  UserPlus,
  FileText,
  CalendarCheck,
  Wrench,
  ShoppingBag,
  Megaphone,
  Star,
} from 'lucide-react';

import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Flows list page.
 *
 * Open to every authenticated user. Flows is in soft-GA — the "Beta"
 * chip in the header is the only remaining signal that the surface
 * is new. The previous per-account beta gate was removed in PR #134.
 */

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'archived';
  trigger_type: 'keyword' | 'first_inbound_message' | 'manual';
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_LABELS: Record<FlowRow['status'], string> = {
  draft: 'Rascunho',
  active: 'Ativo',
  archived: 'Arquivado',
};

const STATUS_COLORS: Record<FlowRow['status'], string> = {
  draft: 'border-border bg-muted text-muted-foreground',
  active: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300',
  archived: 'border-border bg-muted/50 text-muted-foreground',
};

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon:
    | 'MessageSquare'
    | 'HelpCircle'
    | 'UserPlus'
    | 'CalendarCheck'
    | 'Wrench'
    | 'ShoppingBag'
    | 'Megaphone'
    | 'Star';
  trigger_type: string;
  node_count: number;
}

const TEMPLATE_ICONS = {
  MessageSquare,
  HelpCircle,
  UserPlus,
  CalendarCheck,
  Wrench,
  ShoppingBag,
  Megaphone,
  Star,
} as const;

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = useCan('send-messages');
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes] = await Promise.all([
          fetch('/api/flows'),
          fetch('/api/flows/templates'),
        ]);
        if (!flowsRes.ok) {
          throw new Error(`Não foi possível carregar os fluxos: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error("Não foi possível carregar os fluxos.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: 'keyword',
          trigger_config: { keywords: [] },
        }),
      });
      if (!res.ok) throw new Error(`Falha ao criar: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName('');
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error("Não foi possível criar o fluxo.");
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Clone failed: ${res.status}`);
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Clone failed';
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(flow: FlowRow) {
    const yes = window.confirm(
      `Delete "${flow.name}"? Any active runs will end immediately.`
    );
    if (!yes) return;
    try {
      const res = await fetch(`/api/flows/${flow.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Falha ao excluir: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success('Fluxo excluído.');
    } catch (err) {
      console.error(err);
      toast.error("Não foi possível excluir o fluxo.");
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-foreground text-2xl font-semibold">Fluxos</h1>
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-300 uppercase">
              Beta
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Crie conversas do WhatsApp com ramificações e botões. Úteis para
            menus, FAQs e triagem antes de um humano assumir.
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="criar fluxos"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Novo fluxo
        </GatedButton>
      </header>

      {templates.length > 0 && (
        <section aria-labelledby="flow-template-library" className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2
                id="flow-template-library"
                className="text-foreground text-sm font-semibold"
              >
                Biblioteca quick-start
              </h2>
              <p className="text-muted-foreground mt-1 text-xs">
                Clone um fluxo pronto e ajuste mensagens, regras e
                encaminhamento.
              </p>
            </div>
            <span className="text-muted-foreground text-xs">8 modelos</span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {templates.map((t) => {
              const Icon = TEMPLATE_ICONS[t.icon] ?? FileText;
              return (
                <button
                  key={t.slug}
                  type="button"
                  onClick={() => handleUseTemplate(t.slug)}
                  disabled={creating || !canCreate}
                  className="border-border bg-card hover:border-primary/50 flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon className="text-primary h-5 w-5" />
                  <span className="text-foreground text-sm font-semibold">
                    {t.name}
                  </span>
                  <span className="text-muted-foreground text-xs leading-relaxed">
                    {t.description}
                  </span>
                  <span className="text-muted-foreground mt-auto pt-1 text-[11px]">
                    {t.node_count} nós
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {flows.length === 0 ? (
        <EmptyState
          onCreate={() => setCreateOpen(true)}
          canCreate={canCreate}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {flows.map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              onEdit={() => router.push(`/flows/${flow.id}`)}
              onDelete={() => handleDelete(flow)}
            />
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Criar um novo fluxo</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Comece por um modelo ou crie do zero.
            </DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                Comece por um modelo
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((t) => {
                  const Icon = TEMPLATE_ICONS[t.icon] ?? FileText;
                  return (
                    <button
                      key={t.slug}
                      type="button"
                      onClick={() => handleUseTemplate(t.slug)}
                      disabled={creating}
                      className="border-border bg-background hover:border-primary/40 hover:bg-muted flex flex-col gap-2.5 rounded-lg border p-4 text-left transition-colors disabled:opacity-50"
                    >
                      <Icon className="text-primary h-5 w-5" />
                      <span className="text-popover-foreground text-sm font-semibold">
                        {t.name}
                      </span>
                      <span className="text-muted-foreground text-xs leading-relaxed">
                        {t.description}
                      </span>
                      <span className="border-border text-muted-foreground mt-auto border-t pt-2 text-[11px]">
                        {t.node_count} {t.node_count === 1 ? 'nó' : 'nós'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="border-border space-y-2 border-t pt-4">
            <p className="text-muted-foreground text-xs tracking-wide uppercase">
              Ou comece do zero
            </p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="ex.: Menu de boas-vindas"
              className="bg-muted"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Criar fluxo em branco
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({
  onCreate,
  canCreate,
}: {
  onCreate: () => void;
  canCreate: boolean;
}) {
  return (
    <div className="border-border bg-card/50 flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="bg-muted flex h-14 w-14 items-center justify-center rounded-full">
        <Workflow className="text-muted-foreground h-6 w-6" />
      </div>
      <h2 className="text-foreground mt-4 text-base font-medium">
        Nenhum fluxo ainda
      </h2>
      <p className="text-muted-foreground mt-1 max-w-md text-sm">
        Crie sua primeira conversa — um menu de boas-vindas, uma consulta de
        pedido, um bot de FAQ. Os clientes tocam nos botões; o bot os leva à
        resposta certa (ou ao atendente certo).
      </p>
      <GatedButton
        canAct={canCreate}
        gateReason="criar fluxos"
        onClick={onCreate}
        className="mt-5"
      >
        <Plus className="h-4 w-4" />
        Criar seu primeiro fluxo
      </GatedButton>
    </div>
  );
}

function FlowCard({
  flow,
  onEdit,
  onDelete,
}: {
  flow: FlowRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const triggerSummary = describeTrigger(flow);
  const StatusIcon =
    flow.status === 'active'
      ? PlayCircle
      : flow.status === 'archived'
        ? Archive
        : PauseCircle;
  return (
    <div className="border-border bg-card hover:border-border flex flex-col rounded-lg border p-4 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="text-primary h-4 w-4 shrink-0" />
          <h3 className="text-foreground truncate text-sm font-semibold">
            {flow.name}
          </h3>
        </div>
        <Badge
          variant="outline"
          className={cn(
            'shrink-0 gap-1 text-[10px]',
            STATUS_COLORS[flow.status]
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {STATUS_LABELS[flow.status]}
        </Badge>
      </div>

      <p className="text-muted-foreground mt-2 line-clamp-2 text-xs">
        {flow.description || triggerSummary}
      </p>

      <div className="text-muted-foreground mt-4 flex items-center gap-3 text-[11px]">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          {flow.execution_count} {flow.execution_count === 1 ? 'execução' : 'execuções'}
        </span>
      </div>

      <div className="border-border mt-4 flex items-center justify-end gap-2 border-t pt-3">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          Editar
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Excluir
        </Button>
      </div>
    </div>
  );
}

function describeTrigger(flow: FlowRow): string {
  if (flow.trigger_type === 'keyword') {
    const keywords = Array.isArray(flow.trigger_config.keywords)
      ? (flow.trigger_config.keywords as string[])
      : [];
    if (keywords.length === 0) return 'Dispara por palavra-chave (nenhuma definida)';
    return `Dispara em: ${keywords.join(', ')}`;
  }
  if (flow.trigger_type === 'first_inbound_message') {
    return 'Dispara na primeira mensagem recebida do contato';
  }
  return 'Gatilho manual';
}
