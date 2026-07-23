'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Loader2,
  Zap,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'evolution_api_error' | null;

// Evolution sometimes returns `qrcode.base64` as a bare base64 PNG payload
// (no `data:` prefix) instead of a ready-to-use data URL. A real QR PNG's
// base64 body uses the full base64 alphabet (+, /, =, mixed case) and runs
// to thousands of characters, so that's what distinguishes it from the
// short pairing-code string that can also appear in `code`/`pairingCode`.
function toQrImageSrc(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('data:') || raw.startsWith('http')) return raw;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length > 100) {
    return `data:image/png;base64,${raw}`;
  }
  return raw;
}

export function WhatsAppConfig() {
  const supabase = createClient();
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshingQr, setRefreshingQr] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  // Guards against re-hydrating the form when the load effect below
  // re-runs for reasons unrelated to actually switching accounts —
  // e.g. Supabase's onAuthStateChange fires a token refresh (new
  // `user` object, profileLoading flips true/false) when the browser
  // tab regains focus. Without this, that churn calls fetchConfig()
  // again and overwrites whatever the user typed but hadn't saved yet.
  const loadedAccountIdRef = useRef<string | null>(null);

  const [evolutionBaseUrl, setEvolutionBaseUrl] = useState('');
  const [evolutionInstance, setEvolutionInstance] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [tokenEdited, setTokenEdited] = useState(false);

  const isRegistered = config?.connection_state === 'open';
  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);


  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      // Load form values from Supabase (shows what's in DB).
      // Switched from `user_id` (which would only match the row's
      // original author) to `account_id` so every member of the
      // account sees the same saved configuration. UNIQUE(account_id)
      // on the table guarantees the .maybeSingle() return type
      // remains accurate.
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      if (data) {
        setConfig(data);
        setEvolutionBaseUrl(data.evolution_base_url || '');
        setEvolutionInstance(data.evolution_instance || '');
        setAccessToken(MASKED_TOKEN);
        setQrCode(null);
        setTokenEdited(false);
      } else {
        setConfig(null);
        setEvolutionBaseUrl('http://127.0.0.1:8080');
        setEvolutionInstance('');
        setAccessToken('');
        setQrCode(null);
        setTokenEdited(false);
      }
      // Clear any stale probe result when reloading the row.
      setRegistrationProbe(null);

      // Then verify health via the API (decrypts token + qrCodegs Evolution)
      if (data) {
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
          } else {
            setConnectionStatus('disconnected');
            setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'evolution_api_error' ? 'evolution_api_error' : null);
            setStatusMessage(payload.message || '');
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Não foi possível carregar a configuração do WhatsApp');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  async function handleSave() {
    if (!evolutionBaseUrl.trim()) {
      toast.error('A URL base da API Evolution é obrigatória');
      return;
    }
    if (!evolutionInstance.trim()) {
      toast.error('O nome da instância Evolution é obrigatório');
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Evolution and encrypts
      // the access_token server-side with ENCRYPTION_KEY. SkipqrCodeg this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      const payload: Record<string, unknown> = {
        evolution_base_url: evolutionBaseUrl.trim(),
        evolution_instance: evolutionInstance.trim(),
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.evolution_api_key = accessToken.trim();
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Não foi possível salvar a configuração');
        setSaving(false);
        return;
      }

      // Evolution uses QR/pairing-code connectivity. The route returns the
      // current instance state and, when needed, a QR payload from
      // GET /instance/connect/:instanceName.
      if (data.registration_skipped) {
        // Credentials saved + verified, but /register was skipped
        // Evolution pairs devices by QR/pairing code. If the instance is not
        // open yet, keep the UI honest and show the QR payload instead of
        // claiming the number is live.
        toast.success(
          'Credenciais salvas. Escaneie o QR/código de pareamento abaixo se a instância ainda não estiver aberta.',
          { duration: 10000 },
        );
        setQrCode(toQrImageSrc(data.qrcode?.base64 || data.qrcode?.code || null));
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Ativo — ${data.phone_info.verified_name} já pode receber eventos.`
            : data.connection_state === 'open'
              ? 'WhatsApp já conectado. Os eventos começarão a chegar em até um minuto.'
              : 'Instância Evolution salva. Escaneie o QR/código de pareamento para concluir a conexão do WhatsApp.',
        );
        // Preserve the QR/pairing payload returned by Evolution so the user
        // can finish the connection from this screen.
        setQrCode(toQrImageSrc(data.qrcode?.base64 || data.qrcode?.code || null));
      }

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Não foi possível salvar a configuração');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? `Conectado a ${payload.phone_info.verified_name}`
            : 'Conexão com a API bem-sucedida'
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'evolution_api_error' ? 'evolution_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'Falha na conexão com a API');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Falha no teste de conexão. Verifique a rede e tente de novo.');
    } finally {
      setTesting(false);
    }
  }

  async function handleRefreshQr() {
    try {
      setRefreshingQr(true);
      const res = await fetch('/api/whatsapp/config/qr', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Não foi possível atualizar o QR code');
        return;
      }

      setQrCode(toQrImageSrc(data.qrcode?.base64 || data.qrcode?.code || null));
      toast.success('QR/código de pareamento atualizado. Escaneie antes que expire.');
    } catch (err) {
      console.error('Refresh QR error:', err);
      toast.error('Não foi possível atualizar o QR code');
    } finally {
      setRefreshingQr(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success('Número totalmente conectado — a Evolution está entregando os eventos.');
      } else {
        toast.error(
          'A instância Evolution ainda não está aberta. Salve a configuração de novo para atualizar o QR/código de pareamento.',
          { duration: 8000 },
        );
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error('Não foi possível acessar o endpoint de verificação.');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!confirm('Isso vai excluir a configuração atual do WhatsApp para você inseri-la de novo. Continuar?')) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Não foi possível redefinir a configuração');
        return;
      }

      toast.success('Configuração limpa. Agora você pode inserir suas credenciais de novo.');
      setConfig(null);
      setEvolutionBaseUrl('');
      setEvolutionInstance('');
      setAccessToken('');
      setQrCode(null);
      setTokenEdited(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Não foi possível redefinir a configuração');
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="Conexão do WhatsApp"
          description="Conecte sua API Evolution do WhatsApp Business. Credenciais, webhook e passos de configuração ficam todos aqui."
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-sqrCode text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Conexão do WhatsApp"
        description="Conecte sua API Evolution do WhatsApp Business. Credenciais, webhook e passos de configuração ficam todos aqui."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  Não foi possível descriptografar o token armazenado
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-sqrCode" />
                      Redefinindo...
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      Redefinir configuração
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status */}
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connectionStatus === 'connected' ? 'Instância conectada' : 'Não conectada'}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? 'A Evolution reporta esta instância do WhatsApp como aberta. Os eventos de webhook são configurados por instância.'
              : statusMessage ||
                'Configure suas credenciais da API Evolution abaixo para conectar sua conta do WhatsApp Business.'}
          </AlertDescription>
        </Alert>

        {/* Evolution connection status — credentials being valid is necessary
            but not sufficient; the instance must be `open` after QR pairing
            before inbound/outbound WhatsApp traffic is reliable. */}
        {config && (
          <Alert
            className={
              isRegistered
                ? 'bg-emerald-950/30 border-emerald-700/50'
                : 'bg-amber-950/30 border-amber-700/50'
            }
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle
                  className={
                    'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                  }
                >
                  {isRegistered
                    ? 'Instância aberta — a Evolution entregará os eventos ao CRM'
                    : 'Instância não aberta — escaneie o QR/código de pareamento'}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border bg-transparent text-foreground hover:bg-muted h-7"
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-sqrCode" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                Verificar conexão do QR
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <>
                  O estado de conexão da Evolution é <strong>aberto</strong>. Clique em <strong>Verificar conexão do QR</strong> se o estado mudar ou os eventos pararem de chegar.
                </>
              ) : (
                <>
                  A Evolution usa pareamento por QR em vez de registro/PIN da Meta. Clique em Salvar configuração para criar/conectar a instância e exibir o QR.
                </>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  Diagnóstico — última execução: {' '}
                  <span className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}>
                    {registrationProbe.live ? 'ativo' : 'inativo'}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-red-400 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {/* API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Credenciais da API</CardTitle>
            <CardDescription className="text-muted-foreground">
              Informe a URL base da API Evolution, o nome da instância e o cabeçalho apikey. Nesta VPS, os valores padrão do servidor já estão configurados.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Nome da instância Evolution</Label>
              <Input
                placeholder="ex.: whatsapp_minha_empresa"
                value={evolutionInstance}
                onChange={(e) => setEvolutionInstance(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">URL base da API Evolution</Label>
              <Input
                placeholder="http://127.0.0.1:8080"
                value={evolutionBaseUrl}
                onChange={(e) => setEvolutionBaseUrl(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">Chave da API Evolution / cabeçalho apikey</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder="Deixe em branco para usar o padrão do servidor, ou cole uma apikey específica"
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-xs text-muted-foreground">
                  A chave da API fica oculta por segurança. Deixe inalterada para manter a chave armazenada, ou cole uma nova para trocá-la.
                </p>
              )}
            </div>

            {qrCode && (
              <div className="rounded-lg border border-border bg-muted p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-2">QR Code / código de pareamento</p>
                {qrCode.startsWith('data:') || qrCode.startsWith('http') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrCode} alt="Evolution WhatsApp QR Code" className="max-w-64 rounded bg-white p-2" />
                ) : (
                  <pre className="whitespace-pre-wrap break-all text-xs">{qrCode}</pre>
                )}
                <p className="mt-2">Escaneie este QR com o WhatsApp. O estado da conexão deve ficar aberto/conectado.</p>
              </div>
            )}

            {!isRegistered && config && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRefreshQr}
                disabled={refreshingQr}
                className="border-border text-foreground hover:bg-muted"
              >
                {refreshingQr ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
                Atualizar QR / código de pareamento
              </Button>
            )}

            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    Confirmar o servidor da API Evolution
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Use a API Evolution local em <code className="text-foreground">http://127.0.0.1:8080</code> a partir do servidor do CRM.</li>
                    <li>O gerenciador/API via Tailscale está disponível em <code className="text-foreground">https://vps-contabo.tail23fa54.ts.net:8080</code>.</li>
                    <li>A autenticação usa o cabeçalho <code className="text-foreground">apikey</code> da Evolution, não tokens da Meta.</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    Escolher ou criar uma instância
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Digite um nome de instância único para esta conta — cada conta/número precisa do seu próprio, nunca reutilize um já conectado a outra conta.</li>
                    <li>Ao salvar, a Evolution chama <code className="text-foreground">POST /instance/create</code> quando necessário.</li>
                    <li>Depois o CRM chama <code className="text-foreground">GET /instance/connect/:instanceName</code> para obter os dados de QR/pareamento.</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    Salvar e escanear o QR
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Preencha a <strong className="text-foreground">URL base da API Evolution</strong> e o <strong className="text-foreground">nome da instância</strong>.</li>
                    <li>Deixe a chave da API em branco para usar o padrão do servidor, ou cole uma chave Evolution específica.</li>
                    <li>Clique em Salvar configuração e escaneie o QR/código de pareamento com o WhatsApp se o estado ainda não estiver aberto.</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    O webhook é configurado automaticamente
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Ao salvar, o CRM chama a Evolution em <code className="text-foreground">/webhook/set/:instanceName</code>.</li>
                    <li>O callback é <strong className="text-foreground">/api/whatsapp/webhook</strong>, protegido com o token de webhook do CRM.</li>
                    <li>Os eventos incluem QR code, atualização de conexão, inserção/atualização de mensagens, envio de mensagens e contatos.</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-border text-foreground hover:bg-muted"
          >
            {testing ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
            Testar conexão
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Salvar configuração
          </Button>
        </div>


          </CardContent>
        </Card>
      </div>
    </div>
    </section>
  );
}
