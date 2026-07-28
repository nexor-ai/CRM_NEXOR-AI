'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { shouldPromptForUpdate } from '@/lib/app-version';
import { buildCommitUpdateNote, type UpdateStatus } from '@/lib/update-release-notes';
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
const DISMISSED_UPDATE_KEY = 'nexor-crm-dismissed-update';
const DISMISSED_BUILD_KEY = 'nexor-crm-dismissed-build';
const BUILD_CHECK_INTERVAL_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
const UPDATE_COMMAND = 'bash scripts/update.sh';

export function AppUpdatePrompt() {
  // Guarda a versão QUE O SERVIDOR está servindo: é ela que precisa ser
  // gravada na dispensa, não a versão obsoleta embutida neste bundle.
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  const [remote, setRemote] = useState<UpdateStatus | null>(null);
  const lastUpdateCheck = useRef(0);

  // Evento 1: o servidor foi reconstruído. Recarregar a aba é a ação correta.
  const checkBuild = useCallback(async () => {
    try {
      const response = await fetch(`/api/version?ts=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as { version?: string };
      if (!payload.version) return;
      // A dispensa é persistida por versão: quem clicou "Depois" não é
      // interrompido de novo a cada 60s pela MESMA build.
      const dismissed = window.localStorage.getItem(DISMISSED_BUILD_KEY);
      if (shouldPromptForUpdate(CURRENT_BUILD, payload.version, dismissed)) {
        setServerBuild(payload.version);
      }
    } catch {
      // Verificação de versão nunca pode interromper o fluxo do CRM.
    }
  }, []);

  // Evento 2: o repositório recebeu commits que esta instalação não tem.
  // Recarregar não resolve — precisa rodar o script de atualização.
  const checkUpdate = useCallback(async () => {
    const now = Date.now();
    if (now - lastUpdateCheck.current < UPDATE_CHECK_INTERVAL_MS) return;
    lastUpdateCheck.current = now;
    try {
      const response = await fetch('/api/updates', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as UpdateStatus & { error?: string };
      if (payload.error) return;
      // Já atualizou: fecha o aviso e limpa a dispensa, para que a PRÓXIMA
      // atualização volte a ser anunciada normalmente.
      if (!payload.updateAvailable) {
        setRemote(null);
        window.localStorage.removeItem(DISMISSED_UPDATE_KEY);
        return;
      }
      const dismissed = window.localStorage.getItem(DISMISSED_UPDATE_KEY);
      if (dismissed === payload.remoteCommit) return;
      setRemote(payload);
    } catch {
      // Falha de rede é silenciosa por design.
    }
  }, []);

  useEffect(() => {
    void checkBuild();
    void checkUpdate();
    const buildTimer = window.setInterval(() => void checkBuild(), BUILD_CHECK_INTERVAL_MS);
    const updateTimer = window.setInterval(() => void checkUpdate(), UPDATE_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkBuild();
        void checkUpdate(); // já protegido por throttle interno
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(buildTimer);
      window.clearInterval(updateTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkBuild, checkUpdate]);

  function dismissUpdate() {
    if (remote?.remoteCommit) {
      window.localStorage.setItem(DISMISSED_UPDATE_KEY, remote.remoteCommit);
    }
    setRemote(null);
  }

  function dismissRebuild() {
    if (serverBuild) window.localStorage.setItem(DISMISSED_BUILD_KEY, serverBuild);
    setServerBuild(null);
  }

  if (remote) {
    return (
      <UpdateReleaseNotes
        release={buildCommitUpdateNote(remote)}
        remote={remote}
        updateCommand={UPDATE_COMMAND}
        onSkip={dismissUpdate}
      />
    );
  }

  return (
    <Dialog open={serverBuild !== null} onOpenChange={(next) => !next && dismissRebuild()}>
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
          <Button variant="ghost" onClick={dismissRebuild}>
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
