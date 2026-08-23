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
  Plus,
} from 'lucide-react';
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
const DEFAULT_EVOLUTION_BASE_URL =
  process.env.NEXT_PUBLIC_EVOLUTION_API_URL || 'http://127.0.0.1:8080';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'evolution_api_error' | null;
type ConfigItem = WhatsAppConfigType & {
  department_id?: string | null;
  is_default?: boolean;
  department?: { id: string; name: string; is_default: boolean } | null;
};
type DepartmentItem = { id: string; name: string; is_default: boolean };
type AvailableInstance = {
  name: string;
  state: string;
  linked: boolean;
  config_id: string | null;
  department_id: string | null;
  local_connection_state: string | null;
};

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
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshingQr, setRefreshingQr] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<ConfigItem | null>(null);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const [availableInstances, setAvailableInstances] = useState<AvailableInstance[]>([]);
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

  const hydrateForm = useCallback((item: ConfigItem | null) => {
    setConfig(item);
    setEvolutionBaseUrl(item?.evolution_base_url || DEFAULT_EVOLUTION_BASE_URL);
    setEvolutionInstance(item?.evolution_instance || '');
    setAccessToken(item ? MASKED_TOKEN : '');
    setSelectedDepartmentId(item?.department_id || '');
    setQrCode(null);
    setTokenEdited(false);
    setRegistrationProbe(null);
    setConnectionStatus(item?.connection_state === 'open' ? 'connected' : 'disconnected');
  }, []);

  const isRegistered = config?.connection_state === 'open';
  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    connection_state?: string;
    checks: Record<string, boolean | null>;
    errors?: string[];
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);


  const fetchConfig = useCallback(async (_acctId: string) => {
    void _acctId;
    setLoading(true);
    try {
      const [configRes, departmentRes, instancesRes] = await Promise.all([
        fetch('/api/whatsapp/config'),
        fetch('/api/departments'),
        fetch('/api/whatsapp/config/instances'),
      ]);
      const payload = await configRes.json();
      const departmentPayload = await departmentRes.json();
      const instancesPayload = instancesRes.ok ? await instancesRes.json() : { instances: [] };
      if (!configRes.ok && configRes.status !== 409) throw new Error(payload.error || 'config_load_failed');
      const items = (payload.configurations ?? []) as ConfigItem[];
      const departmentItems = (departmentPayload.departments ?? []) as DepartmentItem[];
      setConfigs(items);
      setDepartments(departmentItems);
      setAvailableInstances((instancesPayload.instances ?? []) as AvailableInstance[]);
      setIsCreating(false);
      setIsLinking(false);
      const selected = items.find((item) => item.id === payload.selected_config_id)
        ?? items.find((item) => item.is_default)
        ?? items[0]
        ?? null;
      hydrateForm(selected);
      if (!selected && departmentItems.length > 0) {
        setSelectedDepartmentId((departmentItems.find((item) => item.is_default) ?? departmentItems[0]).id);
      }
      setResetReason(null);
      setStatusMessage(payload.message || '');
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Não foi possível carregar a configuração do WhatsApp');
    } finally {
      setLoading(false);
    }
  }, [hydrateForm]);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!userId || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, userId, accountId, fetchConfig]);

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
        department_id: selectedDepartmentId,
      };
      if (isCreating) payload.create_new = true;
      if (isLinking) payload.link_existing = true;
      else if (config?.id) payload.config_id = config.id;

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
      if (isLinking) {
        toast.success(
          data.connection_state === 'open'
            ? 'Instância existente vinculada ao CRM e já conectada.'
            : 'Instância existente vinculada ao CRM. Use o QR apenas se ela ainda não estiver aberta.',
        );
      } else if (data.registration_skipped) {
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
      if (!config?.id) return;
      const res = await fetch(`/api/whatsapp/config?config_id=${encodeURIComponent(config.id)}&check=true`, { method: 'GET' });
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
      if (!config?.id) return;
      const res = await fetch('/api/whatsapp/config/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_id: config.id }),
      });
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
      if (!config?.id) return;
      const res = await fetch(`/api/whatsapp/config/verify-registration?config_id=${encodeURIComponent(config.id)}`, {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      const instanceOpen = data.connection_state === 'open' || data.checks.instance_open === true;
      setConnectionStatus(instanceOpen ? 'connected' : 'disconnected');
      if (instanceOpen) {
        toast.success(
          data.live
            ? 'Instância e webhook estão operacionais.'
            : 'Instância está aberta. Revise os itens de webhook pendentes no diagnóstico abaixo.',
        );
      } else {
        toast.error('A instância Evolution não está aberta. Atualize o QR/código de pareamento.');
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
      if (!config?.id) return;
      const res = await fetch(`/api/whatsapp/config?config_id=${encodeURIComponent(config.id)}`, { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Não foi possível redefinir a configuração');
        return;
      }

      toast.success('Configuração limpa. Agora você pode inserir suas credenciais de novo.');
      if (accountId) await fetchConfig(accountId);
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

  async function handleDetach() {
    if (!config?.id) return;
    if (!confirm('Remover esta instância apenas do CRM? A instância continuará conectada na Evolution.')) return;
    try {
      setResetting(true);
      const res = await fetch(`/api/whatsapp/config?config_id=${encodeURIComponent(config.id)}&detach=true`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Não foi possível remover a instância do CRM');
        return;
      }
      toast.success('Instância removida do CRM. Ela não foi apagada da Evolution.');
      setConnectionStatus('disconnected');
      setStatusMessage('');
      setQrCode(null);
      setResetReason(null);
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Detach error:', err);
      toast.error('Não foi possível remover a instância do CRM');
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
        description="Gerencie os números e instâncias Evolution por departamento. Nada é conectado ou excluído sem uma ação explícita sua."
      />
      <Card className="mb-6">
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="text-foreground">Instâncias desta conta</CardTitle>
            <CardDescription>Selecione uma instância para editar, testar, verificar o QR ou excluir.</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setIsCreating(true);
              setIsLinking(false);
              hydrateForm(null);
              const fallback = departments.find((item) => item.is_default) ?? departments[0];
              setSelectedDepartmentId(fallback?.id ?? '');
            }}
          >
            <Plus className="size-4" />
            Nova instância
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {configs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => { setIsCreating(false); setIsLinking(false); hydrateForm(item); }}
                className={`rounded-lg border p-4 text-left transition-colors ${!isCreating && config?.id === item.id ? 'border-primary bg-primary/10' : 'border-border bg-muted/40 hover:bg-muted'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <strong className="truncate text-sm text-foreground">{item.evolution_instance || 'Instância sem nome'}</strong>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${item.connection_state === 'open' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                    {item.connection_state === 'open' ? 'Conectada' : 'Desconectada'}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{item.department?.name || 'Departamento não informado'}</p>
                {item.is_default && <span className="mt-2 inline-block rounded bg-primary/15 px-2 py-0.5 text-[10px] text-primary">Padrão da conta</span>}
              </button>
            ))}
            {configs.length === 0 && !isCreating && (
              <p className="text-sm text-muted-foreground">Nenhuma instância configurada.</p>
            )}
          </div>
          {availableInstances.some((item) => !item.linked) && (
            <div className="mt-5 border-t border-border pt-4">
              <p className="text-sm font-medium text-foreground">Instâncias disponíveis na Evolution</p>
              <p className="mt-1 text-xs text-muted-foreground">Vincular registra a instância no CRM sem criá-la, gerar QR ou alterar a Evolution.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {availableInstances.filter((item) => !item.linked).map((item) => (
                  <div key={item.name} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
                      <p className="text-xs text-muted-foreground">Evolution: {item.state}</p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const fallback = departments.find((department) => department.is_default) ?? departments[0];
                        setIsCreating(true);
                        setIsLinking(true);
                        hydrateForm(null);
                        setEvolutionInstance(item.name);
                        setSelectedDepartmentId(fallback?.id ?? '');
                      }}
                    >
                      Vincular
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {isCreating && (
            <p className="mt-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3 text-sm text-foreground">
              {isLinking
                ? 'Preparando o vínculo de uma instância já existente. Nenhuma ação será feita na Evolution até você confirmar.'
                : 'Preparando uma nova instância. A instância padrão atual não será sobrescrita.'}
            </p>
          )}
        </CardContent>
      </Card>
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
              <Label className="text-muted-foreground">Departamento responsável</Label>
              <select
                value={selectedDepartmentId}
                onChange={(event) => setSelectedDepartmentId(event.target.value)}
                className="h-10 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground"
              >
                <option value="" disabled>Selecione um departamento</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}{department.is_default ? ' (padrão)' : ''}
                  </option>
                ))}
              </select>
            </div>
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
                placeholder={DEFAULT_EVOLUTION_BASE_URL}
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
                    <li>Use a URL base da API Evolution liberada pelo operador; nesta instalação, o padrão é carregado automaticamente.</li>
                    <li>Use apenas a origem da API, sem <code className="text-foreground">/manager</code>, caminho, consulta ou fragmento.</li>
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
          {config && !isCreating && (
            <Button
              type="button"
              variant="outline"
              onClick={handleDetach}
              disabled={resetting}
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
            >
              {resetting ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
              Remover do CRM
            </Button>
          )}
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
            disabled={saving || !selectedDepartmentId}
            className="bg-primary hover:bg-primary/90"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {isLinking ? 'Vincular ao CRM' : isCreating ? 'Criar instância' : 'Salvar configuração'}
          </Button>
        </div>


          </CardContent>
        </Card>
      </div>
    </div>
    </section>
  );
}
