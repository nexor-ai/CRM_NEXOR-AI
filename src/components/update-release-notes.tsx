'use client';

import { useState } from 'react';
import { ArrowUpCircle, Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatReleaseDate, type ReleaseNote, type RemoteUpdate } from '@/lib/update-release-notes';

interface UpdateReleaseNotesProps {
  release: ReleaseNote;
  // Só a URL é consumida aqui; aceitar o formato mínimo deixa o componente
  // servir tanto ao aviso por release quanto ao aviso por commit.
  remote?: (Partial<RemoteUpdate> & { url?: string }) | null;
  updateCommand: string;
  onSkip: () => void;
}

export function UpdateReleaseNotes({
  release,
  remote,
  updateCommand,
  onSkip,
}: UpdateReleaseNotesProps) {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(updateCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && onSkip()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircle className="h-5 w-5" />
            Atualização disponível
          </DialogTitle>
          <DialogDescription>
            {release.version} • {formatReleaseDate(release.date)}
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

          <div className="border-border bg-muted/40 rounded-md border p-4 text-sm">
            <h4 className="mb-2 font-medium">Como atualizar</h4>
            <p className="text-muted-foreground mb-3">
              Abra o terminal do servidor onde o NEXOR CRM está instalado, entre na
              pasta do projeto e execute:
            </p>
            <div className="flex items-center gap-2">
              <code className="bg-background border-border flex-1 overflow-x-auto rounded border px-3 py-2 font-mono text-xs">
                {updateCommand}
              </code>
              <Button variant="outline" size="sm" onClick={copyCommand} className="gap-1 shrink-0">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copiado' : 'Copiar'}
              </Button>
            </div>
            <p className="text-muted-foreground mt-3 text-xs">
              O script atualiza, reconstrói e reinicia os serviços. Se algo falhar, ele
              restaura sozinho a versão anterior.
            </p>
            {remote?.url && (
              <p className="mt-2">
                <a href={remote.url} target="_blank" rel="noreferrer" className="text-primary underline">
                  Ver as mudanças no GitHub
                </a>
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onSkip}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
