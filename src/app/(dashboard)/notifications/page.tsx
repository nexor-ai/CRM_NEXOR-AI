'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type {
  Notification,
  NotificationCategory,
  NotificationSeverity,
} from '@/types';
import {
  AlertTriangle,
  Bell,
  Bot,
  CheckCheck,
  GitBranch,
  Inbox,
  Loader2,
  Radio,
  Settings,
  Workflow,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const CATEGORY_ICON: Record<NotificationCategory, typeof Bell> = {
  inbox: Inbox,
  pipeline: GitBranch,
  broadcast: Radio,
  automation: Workflow,
  flow: Workflow,
  ai: Bot,
  integration: Settings,
  system: AlertTriangle,
};
const SEVERITY_CLASS: Record<NotificationSeverity, string> = {
  info: 'border-primary/30 bg-primary/5',
  warning: 'border-amber-500/30 bg-amber-500/5',
  error: 'border-red-500/30 bg-red-500/5',
  critical: 'border-red-600/60 bg-red-600/10',
};

export default function NotificationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [category, setCategory] = useState<'all' | NotificationCategory>('all');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error: rpcError } = await supabase.rpc(
      'list_current_notifications',
      { p_limit: 100 }
    );
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setItems((data ?? []) as Notification[]);
    setError(null);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const supabase = createClient();
    const channel = supabase
      .channel('contextual-notifications-page')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications' },
        () => void load()
      )
      .subscribe();
    return () => {
      window.clearTimeout(initial);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const filtered = useMemo(
    () =>
      (items ?? []).filter(
        (item) =>
          (category === 'all' || item.category === category) &&
          (!onlyUnread || !(item.is_read ?? Boolean(item.read_at)))
      ),
    [category, items, onlyUnread]
  );
  const unread = (items ?? []).filter(
    (item) => !(item.is_read ?? Boolean(item.read_at))
  );

  const markRead = useCallback(async (id: string) => {
    const supabase = createClient();
    const { error: readError } = await supabase.rpc('mark_notification_read', {
      p_notification_id: id,
    });
    if (readError) {
      toast.error('Não foi possível marcar a notificação como lida');
      return;
    }
    setItems(
      (previous) =>
        previous?.map((item) =>
          item.id === id ? { ...item, is_read: true } : item
        ) ?? previous
    );
  }, []);

  const markAllRead = useCallback(async () => {
    if (unread.length === 0) return;
    setMarkingAll(true);
    await Promise.all(unread.map((item) => markRead(item.id)));
    setMarkingAll(false);
  }, [markRead, unread]);

  const open = useCallback(
    (item: Notification) => {
      if (!(item.is_read ?? Boolean(item.read_at))) void markRead(item.id);
      const destination =
        item.target_url ??
        (item.conversation_id ? `/inbox?c=${item.conversation_id}` : null);
      if (destination) router.push(destination);
    },
    [markRead, router]
  );

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-destructive text-sm">{error}</p>
        <Button variant="outline" onClick={load}>
          Tentar novamente
        </Button>
      </div>
    );
  }
  if (items === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  const categories = Array.from(
    new Set(items.map((item) => item.category).filter(Boolean))
  ) as NotificationCategory[];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold">
            Central de notificações
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Eventos operacionais relevantes de atendimento, campanhas,
            automações, flows, IA e integrações.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unread.length === 0 || markingAll}
          onClick={markAllRead}
        >
          {markingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCheck className="h-4 w-4" />
          )}
          Marcar todas como lidas
        </Button>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={category === 'all' ? 'default' : 'outline'}
          onClick={() => setCategory('all')}
        >
          Todas
        </Button>
        {categories.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={category === value ? 'default' : 'outline'}
            onClick={() => setCategory(value)}
            className="capitalize"
          >
            {value}
          </Button>
        ))}
        <Button
          size="sm"
          variant={onlyUnread ? 'default' : 'outline'}
          onClick={() => setOnlyUnread((value) => !value)}
        >
          Não lidas ({unread.length})
        </Button>
      </div>

      {filtered.length === 0 ? (
        <div className="border-border bg-muted/40 flex h-48 flex-col items-center justify-center rounded-xl border border-dashed">
          <Bell className="text-primary h-7 w-7" />
          <p className="text-foreground mt-3 text-sm font-medium">
            Nenhuma notificação neste filtro
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((item) => {
            const itemCategory = item.category ?? 'system';
            const severity = item.severity ?? 'info';
            const Icon = CATEGORY_ICON[itemCategory];
            const isUnread = !(item.is_read ?? Boolean(item.read_at));
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => open(item)}
                  className={cn(
                    'hover:border-primary/50 flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                    SEVERITY_CLASS[severity],
                    !isUnread && 'opacity-75'
                  )}
                >
                  <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                    <Icon className="text-primary h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground text-sm font-semibold">
                        {item.title}
                      </span>
                      <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[10px] uppercase">
                        {itemCategory} · {severity}
                      </span>
                      {isUnread && (
                        <span className="bg-primary h-2 w-2 rounded-full" />
                      )}
                    </div>
                    {item.body && (
                      <p className="text-muted-foreground mt-1 text-xs">
                        {item.body}
                      </p>
                    )}
                    <p className="text-muted-foreground/70 mt-1 text-[11px]">
                      {formatDistanceToNow(
                        new Date(item.last_occurred_at ?? item.created_at),
                        { addSuffix: true, locale: ptBR }
                      )}
                      {(item.occurrence_count ?? 1) > 1
                        ? ` · ${item.occurrence_count} ocorrências`
                        : ''}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
