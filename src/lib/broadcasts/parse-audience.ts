/**
 * Validação da `AudienceConfig` e do mapa de variáveis — a metade
 * CLIENT-SAFE de `parse-input.ts` (SPEC 044 §6.1, §6.3).
 *
 * Extraída daqui porque `draft.ts` (SPEC 070 §3.1) precisa chamar
 * `parseAudienceConfig`/`parseVariableMap` de dentro de
 * `loadBroadcastDraft`, que roda no NAVEGADOR (a RLS de `broadcasts`
 * depende do cliente de sessão). `parse-input.ts` importa
 * `BroadcastError` (`broadcast-core.ts`) e `AbVariantInput`
 * (`broadcast-dispatch.ts`) para `parseAbTest` — dois módulos
 * server-only (`next/server`, nodemailer, via a cadeia de
 * notificações) — e o bundler do Next não faz tree-shaking por export
 * usado: qualquer import estático de `parse-input.ts` num componente
 * cliente arrasta o arquivo inteiro, `parseAbTest` incluído, e quebra
 * o build ("You're importing a module that depends on 'after'").
 *
 * `parse-input.ts` reexporta tudo daqui — os quatro consumidores de
 * servidor (`send`/`cron`/`test-send`/`check-queue`) continuam
 * importando do caminho de sempre, sem mudança.
 */

import {
  type AudienceConfig,
  type CustomFieldOperator,
} from '@/lib/audience/estimate';
import { MAX_DASHBOARD_RECIPIENTS } from '@/lib/broadcasts/limits';
import type { VariableMapping } from '@/lib/whatsapp/broadcast-variables';

const AUDIENCE_TYPES = [
  'all',
  'tags',
  'custom_field',
  'csv',
  'staged',
] as const;

const CUSTOM_FIELD_OPERATORS: CustomFieldOperator[] = [
  'is',
  'is_not',
  'contains',
];

const VARIABLE_TYPES = ['static', 'field', 'custom_field'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

/**
 * Valida uma `AudienceConfig`.
 *
 * Devolve `null` quando a forma não fecha — o chamador responde 400 (ou,
 * no cron, marca o agendamento como falho) em vez de deixar um objeto
 * meio construído chegar ao SQL.
 */
export function parseAudienceConfig(raw: unknown): AudienceConfig | null {
  if (!isRecord(raw)) return null;

  const type = raw.type;
  if (
    typeof type !== 'string' ||
    !(AUDIENCE_TYPES as readonly string[]).includes(type)
  ) {
    return null;
  }

  const audience: AudienceConfig = {
    type: type as AudienceConfig['type'],
    tagIds: stringArray(raw.tagIds),
    excludeTagIds: stringArray(raw.excludeTagIds),
  };

  if (type === 'custom_field') {
    const cf = raw.customField;
    if (!isRecord(cf)) return null;
    if (
      typeof cf.fieldId !== 'string' ||
      typeof cf.value !== 'string' ||
      typeof cf.operator !== 'string' ||
      !CUSTOM_FIELD_OPERATORS.includes(cf.operator as CustomFieldOperator)
    ) {
      return null;
    }
    audience.customField = {
      fieldId: cf.fieldId,
      operator: cf.operator as CustomFieldOperator,
      value: cf.value,
    };
  }

  if (type === 'csv') {
    if (!Array.isArray(raw.csvContacts)) return null;
    // O teto vale já na borda: uma lista maior do que isso é rejeitada
    // antes de virar milhares de linhas em memória no servidor.
    if (raw.csvContacts.length > MAX_DASHBOARD_RECIPIENTS) return null;

    const rows: {
      phone: string;
      name?: string;
      email?: string;
      company?: string;
      tagNames?: string[];
    }[] = [];
    for (const row of raw.csvContacts) {
      if (!isRecord(row) || typeof row.phone !== 'string') continue;
      rows.push({
        phone: row.phone,
        name: typeof row.name === 'string' ? row.name : undefined,
        // SPEC 057 F2/F3 — sem isto, um `POST /api/broadcasts/send` (ou
        // um agendamento persistido) com `audience.type === 'csv'` fora
        // do fluxo de triagem perdia email/company/tagNames em silêncio,
        // mesmo já carregando os campos em `AudienceConfig.csvContacts`.
        email: typeof row.email === 'string' ? row.email : undefined,
        company: typeof row.company === 'string' ? row.company : undefined,
        tagNames: stringArray(row.tagNames),
      });
    }
    if (rows.length === 0) return null;
    audience.csvContacts = rows;
  }

  if (type === 'tags' && !audience.tagIds) return null;

  if (type === 'staged') {
    if (typeof raw.draftId !== 'string' || !raw.draftId) return null;
    audience.draftId = raw.draftId;
  }

  return audience;
}

/** Mesma ideia para o mapeamento de variáveis. `null` = malformado. */
export function parseVariableMap(
  raw: unknown
): Record<string, VariableMapping> | null {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return null;

  const out: Record<string, VariableMapping> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) return null;
    const { type, value: v } = value;
    if (
      typeof type !== 'string' ||
      !(VARIABLE_TYPES as readonly string[]).includes(type) ||
      typeof v !== 'string'
    ) {
      return null;
    }
    out[key] = { type, value: v } as VariableMapping;
  }
  return out;
}
