'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/** Recalculates from the contextual feed after every realtime event.
 * This is deliberately idempotent: duplicate events and reconnects cannot
 * over-increment or under-decrement the sidebar badge. */
export function useUnreadNotifications(): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc('list_current_notifications', {
      p_limit: 200,
    });
    if (error) return;
    setCount(
      (data ?? []).filter(
        (item: { is_read?: boolean; read_at?: string | null }) =>
          !(item.is_read ?? Boolean(item.read_at))
      ).length
    );
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const supabase = createClient();
    const channel = supabase
      .channel('notifications-unread-contextual')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications' },
        () => void refresh()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notification_reads' },
        () => void refresh()
      )
      .subscribe();
    return () => {
      window.clearTimeout(initial);
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  return count;
}
