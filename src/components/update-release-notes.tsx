'use client';

import { RefreshCw, ArrowUpCircle, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  formatReleaseDate,
  type ReleaseNote,
  buildGenericReleaseNote,
  type RemoteUpdate,
} from '@/lib/update-release-notes';

interface UpdateReleaseNotesProps {
  release: ReleaseNote;
  remote?: RemoteUpdate | null;
  onUpdate: () => void;
  onSkip: () => void;
}

export function UpdateReleaseNotes({ release, remote, onUpdate, onSkip }: UpdateReleaseNotesProps) {
  const hasUpdateSteps = Boolean(remote?.changelog?.trim());

  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && onSkip()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircle className="h-5 w-5" />
            Atualização disponível
          </DialogTitle>
          <DialogDescription>
            Versão {release.version} • {formatReleaseDate(release.date)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <h4 className="mb-2 font-medium">O que há de novo:</h4>
            <ul className="space-y-1">
              {release.changes.map((change) => (
                <li key={change} className="flex items-start gap-2 text-sm">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  <span>{change}</span>
                </li>
              ))}
            </ul>
          </div>

          {release.breaking && (
            <div className="rounded-md border border-amber-700/30 bg-amber-900/20 p-3">
              <p className="text-sm font-medium text-amber-200">
                ⚠️ Esta atualização inclui mudanças que podem afetar
                funcionalidades existentes
              </p>
            </div>
          )}

          {hasUpdateSteps && (
            <div className="rounded-md border border-border bg-muted/40 p-4 text-sm">
              <h4 className="mb-2 font-medium">Como atualizar seu clone:</h4>
              <ol className="list-inside list-decimal space-y-1 text-muted-foreground">
                <li>Abra a pasta do NEXOR CRM na sua VPS/servidor.</li>
                <li>Execute: git pull</li>
                <li>Execute: npm install</li>
                <li>Execute: npm run build</li>
                <li>Execute: npm run start:prod</li>
              </ol>
              {remote?.url && (
                <p className="mt-2">
                  <a
                    href={remote.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    Abrir release no GitHub
                  </a>
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onSkip}>
            Depois
          </Button>
          <Button onClick={onUpdate} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Recarregar e aplicar agora
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
