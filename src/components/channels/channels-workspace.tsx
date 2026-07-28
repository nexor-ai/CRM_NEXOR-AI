'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileCheck2, PackageCheck, Plus, Radio } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type Channel = { id: string; name: string; target: string; provider: string };
type ManualPackage = { id: string; revision_id: string; exported_at: string };
type Post = {
  id: string;
  title: string;
  status: string;
  current_revision: number;
  channels?: { name: string };
  channel_manual_packages?: ManualPackage[];
};

const LABEL: Record<string, string> = {
  draft: 'Rascunho',
  in_review: 'Em revisão',
  approved: 'Aprovado',
  exported: 'Pacote exportado',
  confirmed: 'Confirmado',
  cancelled: 'Cancelado',
};

async function loadWorkspace(): Promise<{ channels: Channel[]; posts: Post[] }> {
  const [channelResponse, postResponse] = await Promise.all([
    fetch('/api/channels', { cache: 'no-store' }),
    fetch('/api/channels/posts', { cache: 'no-store' }),
  ]);
  const [channelPayload, postPayload] = await Promise.all([
    channelResponse.json(),
    postResponse.json(),
  ]);
  if (!channelResponse.ok || !postResponse.ok) {
    throw new Error(channelPayload.error || postPayload.error || 'Esteira indisponível');
  }
  return { channels: channelPayload.channels ?? [], posts: postPayload.posts ?? [] };
}

export function ChannelsWorkspace() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [channelId, setChannelId] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const data = await loadWorkspace();
    setChannels(data.channels);
    setPosts(data.posts);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadWorkspace()
      .then((data) => {
        if (!cancelled) {
          setChannels(data.channels);
          setPosts(data.posts);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Esteira indisponível');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function createChannel() {
    const response = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, target, provider: 'manual', auto_publish: false }),
    });
    const payload = await response.json();
    if (!response.ok) return toast.error(payload.error);
    setName('');
    setTarget('');
    toast.success('Canal manual criado');
    await load();
  }

  async function createPost() {
    const response = await fetch('/api/channels/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, title, body }),
    });
    const payload = await response.json();
    if (!response.ok) return toast.error(payload.error);
    setTitle('');
    setBody('');
    toast.success('Rascunho enviado para revisão');
    await load();
  }

  async function action(post: Post, actionName: string) {
    const confirmation = actionName === 'confirm'
      ? window.prompt('Descreva onde e quando a publicação manual foi realizada:')
      : 'Publicação revisada por responsável humano';
    if (actionName === 'confirm' && !confirmation) return;

    const latestPackage = post.channel_manual_packages?.at(-1);
    if (actionName === 'confirm' && !latestPackage) {
      toast.error('Exporte o pacote manual antes de confirmar');
      return;
    }

    const response = await fetch(`/api/channels/posts/${post.id}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: actionName,
        note: confirmation,
        confirmation,
        package_id: latestPackage?.id,
      }),
    });
    const payload = await response.json();
    if (!response.ok) return toast.error(payload.error);
    toast.success('Etapa registrada com evidência');
    await load();
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-2 text-primary"><Radio className="h-5 w-5" /><span className="text-xs font-semibold uppercase tracking-[.2em]">Manual assistido</span></div>
        <h1 className="mt-2 text-2xl font-bold">Channels</h1>
        <p className="text-sm text-muted-foreground">Rascunho → revisão imutável → aprovação → pacote manual → confirmação humana. Sem autopublicação.</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle className="text-base">1. Cadastrar destino manual</CardTitle></CardHeader><CardContent className="space-y-3"><Input placeholder="Nome do canal" value={name} onChange={(event) => setName(event.target.value)} /><Input placeholder="Destino externo (sem @newsletter)" value={target} onChange={(event) => setTarget(event.target.value)} /><Button disabled={!name.trim() || !target.trim()} onClick={() => void createChannel()}><Plus className="mr-2 h-4 w-4" />Criar canal</Button></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">2. Preparar publicação</CardTitle></CardHeader><CardContent className="space-y-3"><select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={channelId} onChange={(event) => setChannelId(event.target.value)}><option value="">Selecione o canal</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select><Input placeholder="Título" value={title} onChange={(event) => setTitle(event.target.value)} /><Textarea placeholder="Conteúdo revisável" value={body} onChange={(event) => setBody(event.target.value)} /><Button disabled={!channelId || !title.trim() || !body.trim()} onClick={() => void createPost()}><FileCheck2 className="mr-2 h-4 w-4" />Criar revisão</Button></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Esteira de publicação</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {loading ? <p className="text-sm text-muted-foreground">Carregando…</p> : posts.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma publicação em preparação.</p> : posts.map((post) => (
            <div key={post.id} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="flex items-center gap-2"><strong>{post.title}</strong><Badge variant="outline">{LABEL[post.status] ?? post.status}</Badge></div><p className="text-xs text-muted-foreground">{post.channels?.name} · revisão {post.current_revision}</p></div>
              <div className="flex flex-wrap gap-2">
                {post.status === 'in_review' && <><Button size="sm" variant="outline" onClick={() => void action(post, 'reject')}>Rejeitar</Button><Button size="sm" onClick={() => void action(post, 'approve')}>Aprovar</Button></>}
                {post.status === 'approved' && <Button size="sm" onClick={() => void action(post, 'export')}><PackageCheck className="mr-2 h-4 w-4" />Exportar pacote</Button>}
                {post.status === 'exported' && <Button size="sm" onClick={() => void action(post, 'confirm')}>Confirmar publicação manual</Button>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
