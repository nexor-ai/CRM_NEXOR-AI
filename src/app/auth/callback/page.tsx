"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { parseAuthCallbackHash } from "@/lib/auth/auth-callback";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [message, setMessage] = useState("Confirmando sua sessão…");

  useEffect(() => {
    let cancelled = false;

    async function complete() {
      const tokens = parseAuthCallbackHash(window.location.hash);
      if (!tokens) {
        setMessage("O link de acesso é inválido ou já expirou. Solicite um novo link.");
        return;
      }

      const { error } = await createClient().auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });
      if (cancelled) return;
      if (error) {
        setMessage("Não foi possível concluir a sessão. Solicite um novo link.");
        return;
      }

      // The fragment contains credentials; clear it before any navigation.
      window.history.replaceState(null, "", window.location.pathname);
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(next?.startsWith("/") ? next : "/dashboard");
      router.refresh();
    }

    void complete();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <p className="text-sm text-muted-foreground">{message}</p>
    </main>
  );
}
