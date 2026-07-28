'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Loader2, Pencil, Plus, Smartphone, Trash2, UsersRound } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';

interface Member { user_id: string; full_name: string; email: string | null }
interface Config {
  id: string;
  evolution_instance: string | null;
  phone_number_id: string | null;
  connection_state: string | null;
  disabled_at: string | null;
}
interface Department {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  department_memberships: Array<{ user_id: string }>;
  whatsapp_config: Config[];
}

export function DepartmentsSettings() {
  const { canEditSettings } = useAuth();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Department | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [configIds, setConfigIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const configs = useMemo(() => {
    const byId = new Map<string, Config>();
    departments.forEach((department) => department.whatsapp_config.forEach((config) => byId.set(config.id, config)));
    return [...byId.values()];
  }, [departments]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [departmentResponse, memberResponse] = await Promise.all([
        fetch('/api/departments', { cache: 'no-store' }),
        fetch('/api/account/members', { cache: 'no-store' }),
      ]);
      if (!departmentResponse.ok || !memberResponse.ok) throw new Error('load_failed');
      const departmentPayload = (await departmentResponse.json()) as { departments: Department[] };
      const memberPayload = (await memberResponse.json()) as { members: Member[] };
      setDepartments(departmentPayload.departments);
      setMembers(memberPayload.members);
    } catch (error) {
      console.error('[DepartmentsSettings] load error:', error);
      toast.error('Não foi possível carregar os departamentos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openCreate() {
    setEditing(null);
    setName('');
    setDescription('');
    setMemberIds([]);
    setConfigIds([]);
  }

  function openEdit(department: Department) {
    setEditing(department);
    setName(department.name);
    setDescription(department.description ?? '');
    setMemberIds(department.department_memberships.map((item) => item.user_id));
    setConfigIds(department.whatsapp_config.map((item) => item.id));
  }

  const toggle = (id: string, values: string[], update: (next: string[]) => void) =>
    update(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);

  async function save() {
    if (!name.trim()) return toast.error('Informe o nome do departamento');
    setSaving(true);
    try {
      const creating = editing === null;
      const response = await fetch(creating ? '/api/departments' : `/api/departments/${editing?.id}`, {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          creating
            ? { name, description }
            : { name, description, memberIds, whatsappConfigIds: configIds },
        ),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'save_failed');
      toast.success(creating ? 'Departamento criado' : 'Departamento atualizado');
      setEditing(undefined);
      await load();
    } catch (error) {
      toast.error(error instanceof Error && error.message !== 'save_failed' ? error.message : 'Não foi possível salvar');
    } finally {
      setSaving(false);
    }
  }

  async function remove(department: Department) {
    if (!window.confirm(`Excluir o departamento “${department.name}”?`)) return;
    const response = await fetch(`/api/departments/${department.id}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return toast.error(payload.error || 'Não foi possível excluir');
    toast.success('Departamento excluído');
    await load();
  }

  if (loading) return <div className="flex justify-center py-14"><Loader2 className="size-6 animate-spin text-primary" /></div>;

  return (
    <section className="animate-in fade-in-50 space-y-5 duration-200">
      <SettingsPanelHead
        title="Departamentos"
        description="Organize a equipe e os números do WhatsApp por área. Administradores continuam com visão global."
        action={canEditSettings ? <Button onClick={openCreate}><Plus className="size-4" />Novo departamento</Button> : undefined}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        {departments.map((department) => (
          <Card key={department.id}>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  <Building2 className="size-4 text-primary" />{department.name}
                  {department.is_default ? <Badge variant="secondary">Padrão</Badge> : null}
                </CardTitle>
                {department.description ? <p className="mt-1 text-sm text-muted-foreground">{department.description}</p> : null}
              </div>
              {canEditSettings ? (
                <div className="flex gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={`Editar ${department.name}`} onClick={() => openEdit(department)}><Pencil className="size-4" /></Button>
                  <Button size="icon-sm" variant="ghost" disabled={department.is_default} aria-label={`Excluir ${department.name}`} onClick={() => void remove(department)}><Trash2 className="size-4" /></Button>
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-sm font-medium"><UsersRound className="size-4" />{department.department_memberships.length} membro(s)</div>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-sm font-medium"><Smartphone className="size-4" />{department.whatsapp_config.length} número(s)</div>
                {department.whatsapp_config.map((config) => <p key={config.id} className="mt-1 truncate text-xs text-muted-foreground">{config.evolution_instance || config.phone_number_id || 'Instância sem nome'}</p>)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={editing !== undefined} onOpenChange={(open) => { if (!open) setEditing(undefined); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar departamento' : 'Novo departamento'}</DialogTitle>
            <DialogDescription>Defina a área e, ao editar, associe membros e números.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label htmlFor="department-name">Nome</Label><Input id="department-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="department-description">Descrição</Label><Input id="department-description" value={description} maxLength={240} onChange={(event) => setDescription(event.target.value)} /></div>
            {editing ? (
              <>
                <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Membros</legend>{members.map((member) => <label key={member.user_id} className="flex items-center gap-3 rounded-lg border p-3 text-sm"><Checkbox checked={memberIds.includes(member.user_id)} disabled={editing.is_default} onCheckedChange={() => toggle(member.user_id, memberIds, setMemberIds)} /><span className="min-w-0"><span className="block truncate font-medium">{member.full_name || 'Membro'}</span><span className="block truncate text-xs text-muted-foreground">{member.email}</span></span></label>)}</fieldset>
                <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Números do WhatsApp</legend>{configs.length ? configs.map((config) => <label key={config.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm"><Checkbox checked={configIds.includes(config.id)} onCheckedChange={() => toggle(config.id, configIds, setConfigIds)} /><span>{config.evolution_instance || config.phone_number_id || 'Instância sem nome'}</span></label>) : <p className="text-sm text-muted-foreground">Nenhum número configurado.</p>}</fieldset>
              </>
            ) : null}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setEditing(undefined)}>Cancelar</Button><Button disabled={saving} onClick={() => void save()}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}Salvar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
