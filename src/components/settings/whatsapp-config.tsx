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
      toast.error('Failed to load WhatsApp configuration');
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
      toast.error('Evolution API Base URL is required');
      return;
    }
    if (!evolutionInstance.trim()) {
      toast.error('Evolution instance name is required');
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
        toast.error(data.error || 'Failed to save configuration');
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
          'Credentials saved. Scan the QR/pairing payload below if the instance is not open yet.',
          { duration: 10000 },
        );
        setQrCode(toQrImageSrc(data.qrcode?.base64 || data.qrcode?.code || null));
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Live — ${data.phone_info.verified_name} can now receive events.`
            : data.connection_state === 'open'
              ? 'WhatsApp already connected. Events will start flowing within a minute.'
              : 'Evolution instance saved. Scan the QR/pairing payload to finish connecting WhatsApp.',
        );
        // Preserve the QR/pairing payload returned by Evolution so the user
        // can finish the connection from this screen.
        setQrCode(toQrImageSrc(data.qrcode?.base64 || data.qrcode?.code || null));
      }

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
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
            ? `Connected to ${payload.phone_info.verified_name}`
            : 'API connection successful'
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'evolution_api_error' ? 'evolution_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'API connection failed');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
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
        toast.error(data.error || 'Failed to refresh QR code');
        return;
      }

      setQrCode(toQrImageSrc(data.qrcode?.base64 || data.qrcode?.code || null));
      toast.success('QR/pairing payload refreshed. Scan it before it expires.');
    } catch (err) {
      console.error('Refresh QR error:', err);
      toast.error('Failed to refresh QR code');
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
        toast.success('Number is fully wired — Evolution is delivering events.');
      } else {
        toast.error(
          'Evolution instance is not open yet. Save the configuration again to refresh the QR/pairing payload.',
          { duration: 8000 },
        );
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error('Could not reach the verification endpoint.');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete the current WhatsApp config so you can re-enter it. Continue?')) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }

      toast.success('Configuration cleared. You can now re-enter your credentials.');
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
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="WhatsApp connection"
          description="Connect your Evolution WhatsApp Business API. Credentials, webhook, and setup steps all live here."
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
        title="WhatsApp connection"
        description="Connect your Evolution WhatsApp Business API. Credentials, webhook, and setup steps all live here."
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
                  Stored token can&apos;t be decrypted
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
                      Resetting...
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      Reset Configuration
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
              {connectionStatus === 'connected' ? 'Instance connected' : 'Not connected'}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? 'Evolution reports this WhatsApp instance as open. Webhook events are configured per instance.'
              : statusMessage ||
                'Configure your Evolution API credentials below to connect your WhatsApp Business account.'}
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
                    ? 'Instance open — Evolution will deliver events to WACRM'
                    : 'Instance not open — scan QR/pairing payload'}
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
                Check QR connection
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <>
                  Evolution connection state is <strong>open</strong>. Click <strong>Check QR connection</strong> if the connection state changes or events stop arriving.
                </>
              ) : (
                <>
                  Evolution uses QR pairing instead of Meta registration/PIN. Click Save Configuration to create/connect the instance and display the QR payload.
                </>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  Diagnostic — last run: {' '}
                  <span className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}>
                    {registrationProbe.live ? 'live' : 'not live'}
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
            <CardTitle className="text-foreground">API Credentials</CardTitle>
            <CardDescription className="text-muted-foreground">
              Enter the Evolution API base URL, instance name, and apikey header. On this VPS the default server-side values are already configured.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Evolution instance name</Label>
              <Input
                placeholder="e.g. my_company_whatsapp"
                value={evolutionInstance}
                onChange={(e) => setEvolutionInstance(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">Evolution API base URL</Label>
              <Input
                placeholder="http://127.0.0.1:8080"
                value={evolutionBaseUrl}
                onChange={(e) => setEvolutionBaseUrl(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">Evolution API key / apikey header</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder="Leave blank to use the server default, or paste a specific apikey"
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
                  API key is hidden for security. Leave it unchanged to keep the stored key, or paste a new one to rotate it.
                </p>
              )}
            </div>

            {qrCode && (
              <div className="rounded-lg border border-border bg-muted p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-2">QR Code / pairing payload</p>
                {qrCode.startsWith('data:') || qrCode.startsWith('http') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrCode} alt="Evolution WhatsApp QR Code" className="max-w-64 rounded bg-white p-2" />
                ) : (
                  <pre className="whitespace-pre-wrap break-all text-xs">{qrCode}</pre>
                )}
                <p className="mt-2">Scan this QR with WhatsApp. The connection state should become open/connected.</p>
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
                Refresh QR / pairing payload
              </Button>
            )}

            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    Confirm Evolution API server
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Use the local Evolution API at <code className="text-foreground">http://127.0.0.1:8080</code> from the CRM server.</li>
                    <li>The Tailscale manager/API is available at <code className="text-foreground">https://vps-contabo.tail23fa54.ts.net:8080</code>.</li>
                    <li>Authentication uses the Evolution <code className="text-foreground">apikey</code> header, not Meta tokens.</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    Choose or create an instance
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Type a unique instance name for this account — each account/number needs its own, never reuse one that&apos;s already connected to a different account.</li>
                    <li>Saving calls Evolution <code className="text-foreground">POST /instance/create</code> when needed.</li>
                    <li>Then the CRM calls <code className="text-foreground">GET /instance/connect/:instanceName</code> to obtain QR/pairing data.</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    Save and scan QR
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Fill <strong className="text-foreground">Evolution API base URL</strong> and <strong className="text-foreground">instance name</strong>.</li>
                    <li>Leave the API key blank to use the server default, or paste a specific Evolution key.</li>
                    <li>Click Save Configuration and scan the QR/pairing payload with WhatsApp if the state is not already open.</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    Webhook is configured automatically
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>On save, the CRM calls Evolution <code className="text-foreground">/webhook/set/:instanceName</code>.</li>
                    <li>The callback is <strong className="text-foreground">/api/whatsapp/webhook</strong> protected with the CRM webhook token.</li>
                    <li>Events include QR code, connection update, message upsert/update, send message and contacts.</li>
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
            Test Connection
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save Configuration
          </Button>
        </div>


          </CardContent>
        </Card>
      </div>
    </div>
    </section>
  );
}
