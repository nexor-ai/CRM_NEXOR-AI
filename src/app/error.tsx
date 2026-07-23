'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', error);
  }, [error]);

  return (
    <main className="bg-background text-foreground flex min-h-screen items-center justify-center px-6 py-12">
      <section className="border-border bg-card w-full max-w-lg rounded-2xl border p-8 shadow-2xl shadow-black/10">
        <div className="bg-destructive/10 text-destructive mb-6 flex h-12 w-12 items-center justify-center rounded-xl">
          <AlertTriangle aria-hidden="true" className="h-6 w-6" />
        </div>
        <p className="text-muted-foreground mb-2 text-sm font-medium">
          CRM NEXOR AI
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Não foi possível carregar esta área
        </h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          O erro foi detectado nesta página. Tente carregar a área novamente;
          se persistir, volte ao painel sem perder sua sessão.
        </p>
        {error.digest && (
          <p className="text-muted-foreground mt-2 text-xs">
            Referência: <code>{error.digest}</code>
          </p>
        )}
        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={reset}
            className="bg-primary text-primary-foreground inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition hover:opacity-90"
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4" />
            Tentar novamente
          </button>
          <Link
            href="/dashboard"
            className="border-border hover:bg-muted inline-flex h-10 items-center justify-center rounded-lg border px-4 text-sm font-medium transition"
          >
            Voltar ao painel
          </Link>
        </div>
      </section>
    </main>
  );
}
