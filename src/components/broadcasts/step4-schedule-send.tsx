'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Clock3, Loader2, Users, Save, Play } from 'lucide-react';
import {
  BROADCAST_INTERVAL_OPTIONS,
  estimateCampaignMinutes,
} from '@/lib/broadcast-campaign';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
  intervalMinutes: number;
  onIntervalMinutesChange: (value: number) => void;
  scheduledAt: string | null;
  onScheduledAtChange: (value: string | null) => void;
  messageVariations: string[];
  onMessageVariationsChange: (value: string[]) => void;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
  intervalMinutes,
  onIntervalMinutesChange,
  scheduledAt,
  onScheduledAtChange,
  messageVariations,
  onMessageVariationsChange,
}: Step4Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (
          audience.type === 'tags' &&
          audience.tagIds &&
          audience.tagIds.length > 0
        ) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set(
            (contactTags ?? []).map((ct) => ct.contact_id)
          );
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? 'Todos os contatos'
      : audience.type === 'tags'
        ? `Etiquetas (${audience.tagIds?.length ?? 0} selecionadas)`
        : audience.type === 'csv'
          ? 'Envio de CSV'
          : 'Personalizado';

  const estimatedMinutes = estimateCampaignMinutes(
    estimatedReach,
    intervalMinutes
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">Revisar e enviar</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Dê um nome ao disparo, revise os detalhes e envie.
        </p>
      </div>

      <div className="border-primary/20 bg-primary/5 space-y-4 rounded-xl border p-4">
        <div className="flex items-start gap-3">
          <Clock3 className="text-primary mt-0.5 h-4 w-4" />
          <div>
            <p className="text-foreground text-sm font-medium">
              Ritmo sequencial
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              Uma mensagem por ciclo. O intervalo mínimo é 5 minutos e a fila
              continua mesmo com o navegador fechado.
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
              Intervalo entre mensagens
            </label>
            <select
              value={intervalMinutes}
              onChange={(event) =>
                onIntervalMinutesChange(Number(event.target.value))
              }
              className="border-border bg-muted text-foreground h-10 w-full rounded-md border px-3 text-sm"
            >
              {BROADCAST_INTERVAL_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes < 60
                    ? `${minutes} minutos`
                    : minutes === 60
                      ? '1 hora'
                      : minutes < 1440
                        ? `${minutes / 60} horas`
                        : '1 dia'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
              Início opcional
            </label>
            <Input
              type="datetime-local"
              value={scheduledAt ?? ''}
              onChange={(event) =>
                onScheduledAtChange(event.target.value || null)
              }
              className="border-border bg-muted text-foreground"
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Estimativa: {Math.floor(estimatedMinutes / 60)}h{' '}
          {estimatedMinutes % 60}min entre o primeiro e o último contato.
        </p>
      </div>

      <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
        <div>
          <p className="text-foreground text-sm font-medium">
            Variações aprovadas
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            O motor alterna estas versões. Nenhuma IA improvisa durante a
            campanha.
          </p>
        </div>
        {messageVariations.map((variation, index) => (
          <textarea
            key={index}
            value={variation}
            onChange={(event) => {
              const next = [...messageVariations];
              next[index] = event.target.value;
              onMessageVariationsChange(next);
            }}
            rows={3}
            aria-label={`Variação ${index + 1}`}
            className="border-border bg-muted text-foreground w-full rounded-md border p-3 text-sm"
          />
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            onMessageVariationsChange([
              ...messageVariations,
              template.body_text,
            ])
          }
        >
          Adicionar variação
        </Button>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="text-foreground mb-1.5 block text-sm font-medium">
          Nome do disparo
        </label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="ex.: Anúncio de Promoção de Verão"
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
        <p className="text-foreground text-sm font-medium">Resumo</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Modelo</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Público</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Alcance estimado</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="text-primary h-3 w-3 animate-spin" />
              ) : (
                <>
                  <Users className="text-primary h-3.5 w-3.5" />
                  <p className="text-foreground font-medium">
                    {estimatedReach.toLocaleString()}
                  </p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Idioma</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="border-primary/20 bg-primary/5 rounded-xl border p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="text-primary h-4 w-4 animate-spin" />
              <p className="text-foreground text-sm font-medium">
                Enviando disparo...
              </p>
            </div>
            <span className="text-primary text-xs font-medium">
              {progress}%
            </span>
          </div>
          <div className="bg-muted h-1.5 w-full rounded-full">
            <div
              className="bg-primary h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Voltar
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Salvar como rascunho
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!name.trim() || isProcessing}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Play className="h-4 w-4" />
              Criar campanha em fila
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  Confirmar disparo
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Você criará uma fila sequencial para{' '}
                  <span className="text-popover-foreground font-medium">
                    {estimatedReach.toLocaleString()}
                  </span>{' '}
                  contatos usando o modelo{' '}
                  <span className="text-popover-foreground font-medium">
                    {template.name}
                  </span>{' '}
                  . Apenas uma mensagem será liberada a cada{' '}
                  {intervalMinutes} minutos.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSend();
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Play className="h-4 w-4" />
                  Confirmar fila
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
