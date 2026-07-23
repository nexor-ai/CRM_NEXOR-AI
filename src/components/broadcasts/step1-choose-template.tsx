'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Loader2, FileText, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { CAMPAIGN_TEMPLATE_PRESETS } from '@/lib/broadcast-campaign';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({
  selectedTemplate,
  onSelect,
  onNext,
  onBack,
}: Step1Props) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const supabase = createClient();
        // Only APPROVED templates can be sent via Meta — anything else
        // would 400 at broadcast time. Hide them rather than letting
        // the user pick a template that will fail.
        const { data, error: fetchError } = await supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED')
          .order('created_at', { ascending: false });

        if (fetchError) throw fetchError;
        setTemplates(data ?? []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Falha ao carregar os modelos'
        );
      } finally {
        setLoading(false);
      }
    }

    fetchTemplates();
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-foreground text-lg font-semibold">
            Escolha um modelo
          </h2>
          <Button
            variant="outline"
            onClick={() => router.push('/settings?tab=templates')}
          >
            Criar modelo do WhatsApp
          </Button>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          Os oito modelos rápidos funcionam diretamente pela Evolution. Use o
          botão para criar modelos personalizados.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-foreground text-sm font-medium">
            Modelos rápidos NEXOR
          </p>
          <span className="text-muted-foreground text-xs">8 modelos</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {CAMPAIGN_TEMPLATE_PRESETS.map((preset) => {
            const matching = templates.find((template) =>
              template.name
                .toLowerCase()
                .includes(preset.slug.replaceAll('-', '_'))
            );
            const selectable: MessageTemplate =
              matching ??
              ({
                id: `preset:${preset.slug}`,
                user_id: '',
                name: preset.slug,
                category: preset.category,
                language: preset.language,
                body_text: preset.variations[0],
                status: 'APPROVED',
                created_at: new Date(0).toISOString(),
              } satisfies MessageTemplate);
            return (
              <button
                key={preset.slug}
                type="button"
                onClick={() => onSelect(selectable)}
                className={`hover:border-primary/40 rounded-xl border p-4 text-left transition-colors ${
                  selectedTemplate?.id === selectable.id
                    ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                    : 'border-border bg-card/50'
                }`}
              >
                <p className="text-foreground text-sm font-medium">
                  {preset.name}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {preset.description}
                </p>
                <p className="text-primary mt-2 text-[11px]">
                  {preset.variations.length} variações prontas · modelo local
                  Evolution
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="border-border bg-card/50 flex h-48 flex-col items-center justify-center rounded-xl border">
          <FileText className="text-muted-foreground mb-2 h-8 w-8" />
          <p className="text-muted-foreground text-sm">
            Nenhum modelo disponível.
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            Crie um modelo em Configurações primeiro.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor =
              categoryColors[template.category] ?? categoryColors.Utility;

            return (
              <button
                key={template.id}
                onClick={() => onSelect(template)}
                className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                    : 'border-border bg-card/50 hover:border-border hover:bg-card'
                }`}
              >
                <div className="flex items-start justify-between">
                  <h3 className="text-foreground text-sm font-medium">
                    {template.name}
                  </h3>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                  >
                    {template.category}
                  </span>
                </div>
                <p className="text-muted-foreground line-clamp-3 text-xs">
                  {template.body_text}
                </p>
                <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
                  <span>{template.language ?? 'en_US'}</span>
                  {/* Status is omitted on purpose — every template
                      shown here is already filtered to APPROVED,
                      so the chip carried no information. */}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="border-border flex items-center justify-between border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          Back
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedTemplate}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
