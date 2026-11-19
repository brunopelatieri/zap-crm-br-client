// ============================================================
// Estado do construtor (SPEC 085 §4.3, F2) — funções PURAS.
//
// A tela guarda os blocos como `DraftField[]` (o formato do
// `FormFieldInput` + um `cid` de cliente, que existe antes de o bloco ter
// `id` no banco). Tudo que mexe na lista — inserir, mover, apagar,
// renomear chave, fixar o bloco de identidade — mora aqui, e não no
// componente, para ser testado sem navegador (AGENTS.md: lógica de
// negócio em `src/lib/`).
//
// Sem Supabase, sem `node:`: importável do cliente.
// ============================================================

import {
  CHOICE_FIELD_TYPES,
  INPUT_FIELD_TYPES,
  type FieldOption,
  type FieldType,
  type FieldValidation,
  type FormField,
  type FormFieldInput,
} from './types';

/** Bloco em edição: `id` só existe se o bloco já foi gravado. */
export type DraftField = FormFieldInput & { cid: string };

export function newCid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `cid-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function toDraft(f: FormField | FormFieldInput): DraftField {
  const { id, ...rest } = f as FormFieldInput;
  return {
    ...rest,
    ...(id ? { id } : {}),
    cid: id ?? newCid(),
  };
}

/** O que a rota `PUT …/fields` recebe: sem `cid`, `id` só dos já gravados. */
export function toPayload(d: DraftField): FormFieldInput {
  const { cid, ...rest } = d;
  void cid;
  return rest;
}

export function renumber(fields: readonly DraftField[]): DraftField[] {
  return fields.map((f, i) => (f.position === i ? f : { ...f, position: i }));
}

// ------------------------------------------------------------
// Chaves
// ------------------------------------------------------------

export const KEY_MAX = 40;

/** `Qual é o seu nome?` → `qual_e_o_seu_nome` (acento tirado, só `[a-z0-9_]`). */
export function keyFromLabel(label: string, fallback = 'field'): string {
  const base = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, KEY_MAX)
    .replace(/_+$/g, '');
  return base || fallback;
}

/** Garante unicidade com sufixo numérico, respeitando o teto de 40. */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = base.slice(0, KEY_MAX) || 'field';
  if (!used.has(root)) return root;
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`;
    const candidate = `${root.slice(0, KEY_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${root.slice(0, KEY_MAX - 7)}_${Date.now().toString(36).slice(-6)}`;
}

// ------------------------------------------------------------
// Blocos novos
// ------------------------------------------------------------

export function newOptionId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; n < 1000; n++) {
    const id = `opt_${n}`;
    if (!used.has(id)) return id;
  }
  return `opt_${Date.now().toString(36)}`;
}

export interface NewFieldTexts {
  /** Rótulo inicial do bloco (já no idioma do formulário/da tela). */
  label: string;
  /** Rótulos das opções iniciais de uma escolha (`yes_no` ignora). */
  options?: string[];
}

/**
 * Bloco novo com os padrões do tipo (SPEC §4.1): escolha com duas
 * opções, `yes_no` com as opções fixas `yes`/`no`, nota de 1 a 5,
 * consentimento obrigatório, arquivo de 1 anexo.
 */
export function createDraftField(
  type: FieldType,
  texts: NewFieldTexts,
  existingKeys: Iterable<string>
): DraftField {
  const key = uniqueKey(keyFromLabel(texts.label, type), existingKeys);
  let options: FieldOption[] | null = null;
  const validation: FieldValidation = {};
  let required = false;

  if (type === 'yes_no') {
    options = [
      { id: 'yes', label: texts.options?.[0] ?? 'Yes', points: 0 },
      { id: 'no', label: texts.options?.[1] ?? 'No', points: 0 },
    ];
  } else if (CHOICE_FIELD_TYPES.includes(type)) {
    const labels = texts.options?.length ? texts.options : ['A', 'B'];
    options = [];
    for (const label of labels) {
      options.push({
        id: newOptionId(options.map((o) => o.id)),
        label,
        points: 0,
      });
    }
  }
  if (type === 'rating') validation.scale = 5;
  if (type === 'file_upload') validation.max_files = 1;
  if (type === 'consent') required = true;

  return {
    cid: newCid(),
    key,
    position: 0,
    type,
    label: texts.label,
    description: null,
    required,
    is_identity: false,
    options,
    validation,
    media: null,
    mapping: null,
    show_if: null,
  };
}

// ------------------------------------------------------------
// Identidade (PRD D-2): o `phone` com `is_identity` é o primeiro bloco COM
// ENTRADA (SPEC §4.2 item 4). Antes dele só pode haver declaração.
// ------------------------------------------------------------

export function identityOf(fields: readonly DraftField[]): DraftField | null {
  return fields.find((f) => f.is_identity) ?? null;
}

/** Recoloca o bloco de identidade logo antes do primeiro bloco com entrada. */
export function pinIdentity(fields: readonly DraftField[]): DraftField[] {
  const idx = fields.findIndex((f) => f.is_identity);
  if (idx === -1) return renumber(fields);
  const firstInput = fields.findIndex(
    (f) => !f.is_identity && INPUT_FIELD_TYPES.includes(f.type)
  );
  if (firstInput === -1 || firstInput > idx) return renumber(fields);
  const out = [...fields];
  const [identity] = out.splice(idx, 1);
  out.splice(firstInput, 0, identity);
  return renumber(out);
}

/**
 * Garante o bloco de telefone de identidade (usado ao ligar "aceitar
 * link genérico"). Se já há um, só o fixa no lugar certo.
 */
export function ensureIdentity(
  fields: readonly DraftField[],
  texts: { label: string; description?: string | null }
): DraftField[] {
  if (identityOf(fields)) return pinIdentity(fields);
  const phone: DraftField = {
    ...createDraftField(
      'phone',
      { label: texts.label },
      fields.map((f) => f.key)
    ),
    key: uniqueKey(
      'phone',
      fields.map((f) => f.key)
    ),
    description: texts.description ?? null,
    required: true,
    is_identity: true,
  };
  const firstInput = fields.findIndex((f) =>
    INPUT_FIELD_TYPES.includes(f.type)
  );
  const at = firstInput === -1 ? fields.length : firstInput;
  const out = [...fields];
  out.splice(at, 0, phone);
  return renumber(out);
}

// ------------------------------------------------------------
// Lista
// ------------------------------------------------------------

export function insertDraft(
  fields: readonly DraftField[],
  field: DraftField,
  index?: number
): DraftField[] {
  const at =
    index === undefined || index < 0 || index > fields.length
      ? fields.length
      : index;
  const out = [...fields];
  out.splice(at, 0, field);
  return pinIdentity(out);
}

export function moveDraft(
  fields: readonly DraftField[],
  from: number,
  to: number
): DraftField[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= fields.length ||
    to >= fields.length
  ) {
    return renumber(fields);
  }
  const out = [...fields];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return pinIdentity(out);
}

/** Blocos que dependem do bloco `key` (`show_if` ou `jump_to`). */
export function dependentsOf(
  fields: readonly DraftField[],
  key: string
): DraftField[] {
  return fields.filter(
    (f) =>
      f.key !== key &&
      (f.show_if?.field_key === key ||
        (f.options ?? []).some((o) => o.jump_to === key))
  );
}

/** Apaga o bloco e limpa quem apontava para ele (a referência quebrada não vira erro de publicação). */
export function removeDraft(
  fields: readonly DraftField[],
  cid: string
): DraftField[] {
  const target = fields.find((f) => f.cid === cid);
  if (!target) return renumber(fields);
  const rest = fields
    .filter((f) => f.cid !== cid)
    .map((f) => {
      let next = f;
      if (f.show_if?.field_key === target.key)
        next = { ...next, show_if: null };
      if ((f.options ?? []).some((o) => o.jump_to === target.key)) {
        next = {
          ...next,
          options: (f.options ?? []).map((o) =>
            o.jump_to === target.key ? { ...o, jump_to: null } : o
          ),
        };
      }
      return next;
    });
  return renumber(rest);
}

/** Troca a `key` do bloco e atualiza `show_if`/`jump_to` que a citavam. */
export function renameKey(
  fields: readonly DraftField[],
  cid: string,
  nextKey: string
): DraftField[] {
  const target = fields.find((f) => f.cid === cid);
  if (!target || target.key === nextKey) return [...fields];
  const prev = target.key;
  return fields.map((f) => {
    let next = f;
    if (f.cid === cid) next = { ...next, key: nextKey };
    if (f.show_if?.field_key === prev) {
      next = { ...next, show_if: { ...f.show_if, field_key: nextKey } };
    }
    if ((f.options ?? []).some((o) => o.jump_to === prev)) {
      next = {
        ...next,
        options: (next.options ?? []).map((o) =>
          o.jump_to === prev ? { ...o, jump_to: nextKey } : o
        ),
      };
    }
    return next;
  });
}

/** `true` se a `key` é válida para o CHECK do banco e não repete. */
export function isKeyAvailable(
  fields: readonly DraftField[],
  cid: string,
  key: string
): boolean {
  return (
    /^[a-z0-9_]{1,40}$/.test(key) &&
    !fields.some((f) => f.cid !== cid && f.key === key)
  );
}

/** Tipos cujas opções pontuam / que têm `jump_to`. */
export const JUMP_FIELD_TYPES: readonly FieldType[] = [
  'single_select',
  'dropdown',
  'yes_no',
];

/**
 * Maior pontuação possível com as regras atuais (para o owner calibrar as
 * faixas). Escolha única/lista/sim-não: a melhor opção; múltipla: soma das
 * opções com pontos positivos; número/nota: a melhor faixa de pontos.
 * Bloco que o `show_if` esconde conta como se aparecesse (teto, não média).
 */
export function maxPossibleScore(fields: readonly DraftField[]): number {
  let total = 0;
  for (const f of fields) {
    if (f.type === 'multi_select') {
      total += (f.options ?? []).reduce(
        (n, o) => n + Math.max(0, o.points ?? 0),
        0
      );
    } else if (
      f.type === 'single_select' ||
      f.type === 'dropdown' ||
      f.type === 'yes_no'
    ) {
      total += Math.max(0, ...(f.options ?? []).map((o) => o.points ?? 0));
    } else if (f.type === 'number' || f.type === 'rating') {
      total += Math.max(
        0,
        ...(f.validation?.points_ranges ?? []).map((r) => r.points)
      );
    }
  }
  return total;
}

export function hasPointsOptions(type: FieldType): boolean {
  return CHOICE_FIELD_TYPES.includes(type);
}

export function hasPointsRanges(type: FieldType): boolean {
  return type === 'number' || type === 'rating';
}
