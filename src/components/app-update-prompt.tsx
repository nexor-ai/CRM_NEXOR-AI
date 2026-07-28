'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { shouldPromptForUpdate } from '@/lib/app-version';
import { getReleaseNote, buildGenericReleaseNote, type RemoteUpdate } from '@/lib/update-release-notes';
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

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'development';
const DISMISSED_KEY = 'nexor-crm-dismissed-version';
const CHECK_INTERVAL_MS = 60_000;
const GITHUB_CHECK_INTERVAL_MS = 5 * 60_000;

export function AppUpdatePrompt() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'release-notes' | 'generic'>('generic');
  const [release, setRelease] = useState<ReturnType<typeof getReleaseNote>>(null);
  const [remote, setRemote] = useState<RemoteUpdate | null>(null);

  const promptIfNewer = useCallback(
    (availableVersion: string, nextMode: 'release-notes' | 'generic', nextRelease: ReturnType<typeof getReleaseNote>, nextRemote: RemoteUpdate | null) => {
      if (!availableVersion || availableVersion === 'development') return;
      if (CURRENT_VERSION === 'development') return;
      if (availableVersion === CURRENT_VERSION) return;
      const dismissed = window.sessionStorage.getItem(DISMISSED_KEY);
      if (dismissed === availableVersion) return;

      setMode(nextMode);
      setRelease(nextRelease);
      setRemote(nextRemote);
      setOpen(true);
    },
    []
  );

  const checkLocalVersion = useCallback(async () => {
    try {
      const response = await fetch(`/api/version?ts=${Date.now()}`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        version?: string;
        release?: string;
      };
      if (!payload.version) return;
      const releaseNote = getReleaseNote(payload.release ?? payload.version);
      promptIfNewer(payload.version, releaseNote ? 'release-notes' : 'generic', releaseNote, null);
    } catch {
      // Version checks must never interrupt the CRM workflow.
    }
  }, [promptIfNewer]);

  const checkGitHubLatest = useCallback(async () => {
    try {
      const response = await fetch('/api/updates?ts=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as RemoteUpdate & { error?: string };
      if (!payload?.version || payload.error) return;
      const releaseNote = buildGenericReleaseNote(payload);
      promptIfNewer(payload.version, 'generic', releaseNote, payload);
    } catch {
      // Internet/release check failures stay silent.
    }
  }, [promptIfNewer]);

  useEffect(() => {
    const initialCheck = window.setTimeout(() => void checkLocalVersion(), 0);
    const interval = window.setInterval(() => void checkLocalVersion(), CHECK_INTERVAL_MS);
    const githubInterval = window.setInterval(() => void checkGitHubLatest(), GITHUB_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkLocalVersion();
        void checkGitHubLatest();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(initialCheck);
      window.clearInterval(interval);
      window.clearInterval(githubInterval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkLocalVersion, checkGitHubLatest]);

  function updateNow() {
    window.location.reload();
  }

  function updateLater() {
    if (mode === 'generic' && remote?.version) {
      window.sessionStorage.setItem(DISMISSED_KEY, remote.version);
    }
    setOpen(false);
  }

  const effectiveRelease = release ?? (mode === 'generic' && remote ? buildGenericReleaseNote(remote) : null);

  if (open && effectiveRelease) {
    return (
      <UpdateReleaseNotes
        release={effectiveRelease}
        remote={mode === 'generic' ? remote : undefined}
        onUpdate={updateNow}
        onSkip={updateLater}
      />
    );
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
              <Sparkles className="size-5" aria-hidden="true" />
            </div>
            <DialogHeader className="gap-2 text-left">
              <div className="text-primary flex items-center gap-2 text-xs font-medium tracking-[0.18em] uppercase">
                <Sparkles className="size-3.5" aria-hidden="true" />
                Atualização disponível
              </div>
              <DialogTitle className="text-lg">Nova versão do NEXOR CRM</DialogTitle>
              <DialogDescription className="leading-6">
                O repositório oficial já tem uma versão mais nova. Recarregue para
                aplicar e veja as instruções de atualização do clone.
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
