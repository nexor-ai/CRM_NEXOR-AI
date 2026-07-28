'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { shouldPromptForUpdate, shouldPromptForRelease } from '@/lib/app-version';
import { buildGenericReleaseNote, type RemoteUpdate } from '@/lib/update-release-notes';
import { Button } from '@/components/ui/button';
import { UpdateReleaseNotes } from '@/components/update-release-notes';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const CURRENT_BUILD = process.env.NEXT_PUBLIC_APP_VERSION ?? 'development';
const CURRENT_RELEASE = process.env.NEXT_PUBLIC_APP_RELEASE ?? 'development';
const DISMISSED_RELEASE_KEY = 'nexor-crm-dismissed-release';
const BUILD_CHECK_INTERVAL_MS = 60_000;
const RELEASE_CHECK_INTERVAL_MS = 30 * 60_000;
const UPDATE_COMMAND = 'bash scripts/update.sh';

export function AppUpdatePrompt() {
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [remote, setRemote] = useState<RemoteUpdate | null>(null);
  const lastReleaseCheck = useRef(0);

  // Evento 1: o servidor foi reconstruído. Recarregar a aba é a ação correta.
  const checkBuild = useCallback(async () => {
    try {
      const response = await fetch(`/api/version?ts=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as { version?: string };
      if (!payload.version) return;
      if (shouldPromptForUpdate(CURRENT_BUILD, payload.version, null)) {
        setRebuildOpen(true);
      }
    } catch {
      // Verificação de versão nunca pode interromper o fluxo do CRM.
    }
  }, []);

  // Evento 2: existe release nova no GitHub. Recarregar não resolve — precisa do script.
  const checkRelease = useCallback(async () => {
    const now = Date.now();
    if (now - lastReleaseCheck.current < RELEASE_CHECK_INTERVAL_MS) return;
    lastReleaseCheck.current = now;
    try {
      const response = await fetch('/api/updates', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as RemoteUpdate & { error?: string };
      if (!payload?.version || payload.error) return;
      const dismissed = window.localStorage.getItem(DISMISSED_RELEASE_KEY);
      if (shouldPromptForRelease(CURRENT_RELEASE, payload.version, dismissed)) {
        setRemote(payload);
      }
    } catch {
      // Falha de rede é silenciosa por design.
    }
  }, []);

  useEffect(() => {
    void checkBuild();
    void checkRelease();
    const buildTimer = window.setInterval(() => void checkBuild(), BUILD_CHECK_INTERVAL_MS);
    const releaseTimer = window.setInterval(() => void checkRelease(), RELEASE_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkBuild();
        void checkRelease(); // já protegido por throttle interno
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(buildTimer);
      window.clearInterval(releaseTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkBuild, checkRelease]);

  function dismissRelease() {
    if (remote?.version) {
      window.localStorage.setItem(DISMISSED_RELEASE_KEY, remote.version);
    }
    setRemote(null);
  }

  if (remote) {
    return (
      <UpdateReleaseNotes
        release={buildGenericReleaseNote(remote)}
        remote={remote}
        updateCommand={UPDATE_COMMAND}
        onSkip={dismissRelease}
      />
    );
  }

  return (
    <Dialog open={rebuildOpen} onOpenChange={(next) => !next && setRebuildOpen(false)}>
      <DialogContent showCloseButton={false} className="border-border bg-popover overflow-hidden p-0 sm:max-w-md">
        <div className="relative px-6 pt-6 pb-5">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top_right,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_70%)]" />
          <div className="relative flex items-start gap-4">
            <div className="border-primary/25 bg-primary/10 text-primary grid size-11 shrink-0 place-items-center rounded-xl border shadow-sm">
              <Sparkles className="size-5" aria-hidden="true" />
            </div>
            <DialogHeader className="gap-2 text-left">
              <div className="text-primary flex items-center gap-2 text-xs font-medium tracking-[0.18em] uppercase">
                <Sparkles className="size-3.5" aria-hidden="true" />
                Nova build no servidor
              </div>
              <DialogTitle className="text-lg">Recarregue para continuar</DialogTitle>
              <DialogDescription className="leading-6">
                O NEXOR CRM foi reconstruído neste servidor. Recarregue a página
                para carregar a versão nova.
              </DialogDescription>
            </DialogHeader>
          </div>
        </div>
        <DialogFooter className="border-border bg-muted/40 m-0 rounded-none px-6 py-4">
          <Button variant="ghost" onClick={() => setRebuildOpen(false)}>
            Depois
          </Button>
          <Button onClick={() => window.location.reload()} className="gap-2">
            <RefreshCw className="size-4" aria-hidden="true" />
            Recarregar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
