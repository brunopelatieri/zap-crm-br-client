// Formas que `GET /api/forms/[id]/responses` e `GET /api/contacts/[id]/form-responses`
// devolvem (SPEC 085 §7.1, F4). Só tipos: nada de runtime aqui.

import type {
  AnswersSnapshot,
  FieldType,
  ResponseSource,
  ResponseStatus,
} from '@/lib/forms/types';

export interface ResponseRow {
  id: string;
  form_id: string;
  contact_id: string;
  status: ResponseStatus;
  source: ResponseSource;
  form_version: number;
  answers: AnswersSnapshot;
  score: number | null;
  band_key: string | null;
  upload_bytes: number;
  deal_id: string | null;
  utm: Record<string, string> | null;
  locale: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  contacts?: { id: string; name: string | null; phone: string | null } | null;
  deals?: { id: string; title: string } | null;
  forms?: { id: string; name: string; slug: string } | null;
}

export interface BlockMeta {
  key: string;
  label: string;
  type: FieldType;
  options: { id: string; label: string }[];
}

export interface BandMeta {
  key: string;
  label: string;
}

export interface ResponsesPage {
  responses: ResponseRow[];
  total: number;
  page: number;
  pageSize: number;
  form: { id: string; name: string; slug: string; status: string };
  fields: BlockMeta[];
  bands: BandMeta[];
}

export interface ContactResponsesPayload {
  responses: ResponseRow[];
  fieldOrders: Record<string, string[]>;
}
