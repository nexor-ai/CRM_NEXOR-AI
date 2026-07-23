'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { shouldPromptForUpdate } from '@/lib/app-version';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'development';
const DISMISSED_KEY = 'nexor-crm-dismissed-version';
const CHECK_INTERVAL_MS = 60_000;

export function AppUpdatePrompt() {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const checkForUpdate = useCallback(async () => {
    try {
      const response = await fetch(`/api/version?ts=${Date.now()}`, {
        cache: 'no-store',
      });
      if (!response.ok) return;

      const payload = (await response.json()) as { version?: string };
      const nextVersion = payload.version?.trim();
      if (!nextVersion) return;

      const dismissed = window.sessionStorage.getItem(DISMISSED_KEY);
      if (shouldPromptForUpdate(CURRENT_VERSION, nextVersion, dismissed)) {
        setAvailableVersion(nextVersion);
        setOpen(true);
      }
    } catch {
      // Version checks must never interrupt the CRM workflow.
    }
  }, []);

  useEffect(() => {
    const initialCheck = window.setTimeout(() => void checkForUpdate(), 0);
    const interval = window.setInterval(
      () => void checkForUpdate(),
      CHECK_INTERVAL_MS
    );
    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkForUpdate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(initialCheck);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkForUpdate]);

  function updateNow() {
    window.location.reload();
  }

  function updateLater() {
    if (availableVersion) {
      window.sessionStorage.setItem(DISMISSED_KEY, availableVersion);
    }
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && updateLater()}>
      <DialogContent
        showCloseButton={false}
        className="border-border bg-popover overflow-hidden p-0 sm:max-w-md"
      >
        <div className="relative px-6 pt-6 pb-5">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top_right,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_70%)]" />
          <div className="relative flex items-start gap-4">
            <div className="border-primary/25 bg-primary/10 text-primary grid size-11 shrink-0 place-items-center rounded-xl border shadow-sm">
              <RefreshCw className="size-5" aria-hidden="true" />
            </div>
            <DialogHeader className="gap-2 text-left">
              <div className="text-primary flex items-center gap-2 text-xs font-medium tracking-[0.18em] uppercase">
                <Sparkles className="size-3.5" aria-hidden="true" />
                Atualização disponível
              </div>
              <DialogTitle className="text-lg">
                Nova versão do NEXOR CRM
              </DialogTitle>
              <DialogDescription className="leading-6">
                Há melhorias prontas no servidor. Atualize a interface para usar
                a versão mais recente sem perder seu trabalho salvo.
              </DialogDescription>
            </DialogHeader>
          </div>
        </div>
        <DialogFooter className="border-border bg-muted/40 m-0 rounded-none px-6 py-4">
          <Button variant="ghost" onClick={updateLater}>
            Depois
          </Button>
          <Button onClick={updateNow} className="gap-2">
            <RefreshCw className="size-4" aria-hidden="true" />
            Atualizar agora
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
