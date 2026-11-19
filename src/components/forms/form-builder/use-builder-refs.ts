'use client';

// ============================================================
// Listas que o construtor oferece em seletores: etiquetas, campos
// personalizados, funis (com etapas) e membros da conta. Lidas com o client
// de SESSÃO (RLS), como as demais telas; nenhuma é segredo e nenhuma sai da
// conta (o `apply-mapping`/`apply-band` do envio refiltram por `account_id`).
// ============================================================

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';

export interface RefTag {
  id: string;
  name: string;
}
export interface RefCustomField {
  id: string;
  field_name: string;
}
export interface RefPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string; position: number }[];
}
export interface RefMember {
  user_id: string;
  full_name: string | null;
}

export interface BuilderRefs {
  tags: RefTag[];
  customFields: RefCustomField[];
  pipelines: RefPipeline[];
  members: RefMember[];
  loading: boolean;
}

const EMPTY: BuilderRefs = {
  tags: [],
  customFields: [],
  pipelines: [],
  members: [],
  loading: true,
};

export function useBuilderRefs(): BuilderRefs {
  const [refs, setRefs] = useState<BuilderRefs>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const [tags, fields, pipelines, stages, members] = await Promise.all([
          supabase.from('tags').select('id, name').order('name'),
          supabase
            .from('custom_fields')
            .select('id, field_name')
            .order('field_name'),
          supabase.from('pipelines').select('id, name').order('name'),
          supabase
            .from('pipeline_stages')
            .select('id, name, position, pipeline_id')
            .order('position'),
          supabase
            .from('profiles')
            .select('user_id, full_name')
            .order('full_name'),
        ]);
        if (cancelled) return;
        const stageRows = (stages.data ?? []) as {
          id: string;
          name: string;
          position: number;
          pipeline_id: string;
        }[];
        setRefs({
          tags: (tags.data ?? []) as RefTag[],
          customFields: (fields.data ?? []) as RefCustomField[],
          pipelines: (
            (pipelines.data ?? []) as { id: string; name: string }[]
          ).map((p) => ({
            ...p,
            stages: stageRows
              .filter((s) => s.pipeline_id === p.id)
              .map(({ id, name, position }) => ({ id, name, position })),
          })),
          members: (members.data ?? []) as RefMember[],
          loading: false,
        });
      } catch (err) {
        console.error('[forms] builder refs failed:', err);
        if (!cancelled) setRefs({ ...EMPTY, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return refs;
}
