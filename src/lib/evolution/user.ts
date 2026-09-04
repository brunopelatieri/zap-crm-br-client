/**
 * Os quatro endpoints de enriquecimento/validação da instância QRCode
 * (SPEC 069 F3 — R2, R3, R4, R5): `/user/check`, `/user/info`,
 * `/user/avatar`, `/user/contacts`.
 *
 * Medido contra o servidor real em 2026-09-03 (D-14), instância
 * `bruno` — não copiado da referência sem confirmar. O que a medição
 * mudou em relação ao que a SPEC assumia:
 *
 *   1. **`/user/check` não devolve nem o objeto plano nem o array cru**
 *      que `contact-identity.ts` cogitava — devolve
 *      `{"data":{"Users":[{Query,IsInWhatsapp,JID,RemoteJID,LID,
 *      VerifiedName}]},"message":"success"}`. `unwrap()` já desembrulha
 *      `data`; falta pegar a chave `Users`. Esta é a forma PRIMÁRIA que
 *      os parsers abaixo assumem; as duas alternativas antigas
 *      continuam aceitas por trás dela (defesa em profundidade, não
 *      porque foram confirmadas).
 *
 *   2. **A ordem da resposta NÃO bate com a ordem do pedido.** Um lote
 *      de 3 números voltou com o 2º e 3º trocados. Todo pareamento
 *      responsta↔pedido tem que casar por `Query`/`JID`, nunca por
 *      índice do array — `matchCheckResult` existe por isso.
 *
 *   3. **`/user/check` aceita lote** (testado com 3 números numa
 *      chamada só, resposta em ~1s). `/user/info` e `/user/avatar`
 *      **NÃO foram confirmados em lote nem individualmente com
 *      sucesso** — as duas únicas chamadas de teste (contra o PRÓPRIO
 *      número da instância) ficaram penduradas por ~75 s e voltaram
 *      `500 {"error":"... info query timed out"}`. Isso é
 *      provavelmente autoconsulta — o protocolo do WhatsApp não
 *      sincroniza "quem eu sou" do mesmo jeito que sincroniza um
 *      terceiro — mas não foi possível confirmar contra um contato de
 *      verdade sem uma consulta a mais que o teste não devia fazer sem
 *      necessidade (§6 da SPEC: checagem tem custo de reputação, não é
 *      de graça). Os parsers de `/user/info` e `/user/avatar` seguem a
 *      postura mais defensiva possível — múltiplas formas aceitas,
 *      nunca lançam por formato inesperado — e `EVOLUTION_INFO_AVATAR_
 *      TIMEOUT_MS` (novo, `src/lib/limits/registry.ts`) existe
 *      exatamente por causa do achado nº 2: usar o timeout genérico de
 *      15 s abortaria ANTES do próprio servidor Evolution desistir, e
 *      usar os 75 s medidos travaria o lote inteiro atrás de UM contato
 *      ruim. O padrão (20 s) é uma aposta deliberada no meio-termo,
 *      registrada na SPEC como o que é: uma aposta, não uma medição.
 *
 *   4. **`/user/avatar` usa o body `{"number": "...", "preview": true}`**
 *      — `number` STRING, não array (diferente de check/info). Não
 *      confirmado o sucesso; a referência documenta
 *      `{"success":true,"avatar":"base64..."}` sem envelope `data`, e é
 *      essa forma que o parser tenta primeiro.
 *
 *   5. **`/user/contacts` não pagina.** 1144 contatos (~146 KB) num
 *      payload só, em ~150 ms — rápido porque lê o cache local
 *      sincronizado, ao contrário de `/user/info`/`/user/avatar`, que
 *      parecem ir à rede. Confirma D-14 #2 (sem paginação do lado do
 *      servidor) mas não descarta que uma agenda muito maior seja mais
 *      lenta — `harvest.ts` (F7) corta do lado do CRM mesmo assim.
 *      Confirma D-14 #1 (escopo por TOKEN): o token da instância
 *      devolveu só a agenda daquela instância.
 *
 *   Não medido, e não medido de propósito (D-14 #6): comportamento com
 *   instância DESCONECTADA. Testar isso exigiria derrubar uma sessão
 *   real em uso — não é um teste que se faz sem avisar quem depende
 *   dela. Mantém a postura defensiva da SPEC: erro de rede/timeout vira
 *   `channel_unavailable` (`errorKindForStatus`, `client.ts`), tratado
 *   como "não consome tentativa" no cron (§7.1 ponto 2).
 */

import { evolutionRequest, unwrap } from './client';
import type { EvolutionConfig } from './config';
import { asRecord, pickBoolean, pickKey, pickString } from './payload';

// ------------------------------------------------------------
// POST /user/check
// ------------------------------------------------------------

export interface WhatsappCheckResult {
  /** Como o servidor ecoou o número pedido — inclui `+` e `@s.whatsapp.net`. */
  query: string;
  isInWhatsapp: boolean;
  jid: string | null;
  lid: string | null;
  verifiedName: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return asRecord(v) !== null;
}

/**
 * As três formas que já foram cogitadas ou medidas para `/user/check`
 * e `/user/info` (mesmo schema de request, `CheckUser`, por isso um
 * extrator só serve às duas):
 *
 *   1. `{Users:[...]}` dentro de `data` — MEDIDO (`/user/check`).
 *   2. Array cru no nível de `data`/topo — hipótese original de
 *      `contact-identity.ts`, mantida por segurança.
 *   3. Objeto plano único (`{Query,IsInWhatsapp,...}`) — idem, para o
 *      caso de um pedido com um único número devolver sem array.
 */
function extractCheckItems(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);

  const data = unwrap(raw);
  const usersValue = pickKey(data, 'Users', 'users');
  if (Array.isArray(usersValue)) return usersValue.filter(isRecord);

  // Objeto plano: só conta se tiver cara de resultado de checagem, para
  // não confundir um envelope vazio (`{}` de `unwrap` num payload que
  // não bateu com nada) com "um resultado".
  if (pickKey(data, 'IsInWhatsapp', 'isInWhatsapp') !== undefined) {
    return [data];
  }

  return [];
}

function parseCheckItem(rec: Record<string, unknown>): WhatsappCheckResult {
  return {
    query: pickString(rec, 'Query', 'query') ?? '',
    isInWhatsapp: pickBoolean(rec, 'IsInWhatsapp', 'isInWhatsapp') ?? false,
    jid: pickString(rec, 'JID', 'jid'),
    lid: pickString(rec, 'LID', 'lid'),
    verifiedName: pickString(rec, 'VerifiedName', 'verifiedName'),
  };
}

/**
 * `POST /user/check` — a chamada que NÃO envia mensagem (PRD 068 §6;
 * SPEC 069 D-1). Aceita lote: um número por telefone pedido, em
 * qualquer ordem de resposta (achado nº 2 do cabeçalho).
 */
export async function checkWhatsappUsers(
  config: EvolutionConfig,
  instanceToken: string,
  numbers: string[]
): Promise<WhatsappCheckResult[]> {
  if (numbers.length === 0) return [];
  const raw = await evolutionRequest(config, '/user/check', {
    method: 'POST',
    key: instanceToken,
    body: { number: numbers },
  });
  return extractCheckItems(raw).map(parseCheckItem);
}

/**
 * Casa um resultado ao número pedido por DÍGITOS, não por índice
 * (achado nº 2). `phoneDigits` é o telefone só-dígitos que foi pedido;
 * `Query`/`JID` chegam com `+`, `@s.whatsapp.net` e às vezes sem `+` —
 * comparar só os dígitos absorve as três grafias de uma vez.
 */
export function matchCheckResult(
  results: WhatsappCheckResult[],
  phoneDigits: string
): WhatsappCheckResult | null {
  const wanted = onlyDigits(phoneDigits);
  if (!wanted) return null;
  return (
    results.find(
      (r) =>
        onlyDigits(r.query) === wanted || onlyDigits(r.jid ?? '') === wanted
    ) ?? null
  );
}

function onlyDigits(s: string): string {
  return s.replace(/\D/g, '');
}

// ------------------------------------------------------------
// POST /user/info
// ------------------------------------------------------------

export interface WhatsappUserInfo {
  query: string;
  jid: string | null;
  verifiedName: string | null;
  /** Recado do WhatsApp (`Status`) — SPEC 069 §8 (PRD 068 §8) NÃO exibe
   *  isto em lugar nenhum; capturado só porque a Evolution devolve
   *  junto, não porque vira UI. */
  status: string | null;
  /** ID da foto de perfil no WhatsApp — muda quando a foto muda; a
   *  Evolution não documenta uso direto disto, mantido por completude. */
  pictureId: string | null;
}

function parseInfoItem(rec: Record<string, unknown>): WhatsappUserInfo {
  return {
    query: pickString(rec, 'Query', 'query') ?? '',
    jid: pickString(rec, 'JID', 'jid'),
    verifiedName: pickString(rec, 'VerifiedName', 'verifiedName'),
    status: pickString(rec, 'Status', 'status'),
    pictureId: pickString(rec, 'PictureID', 'pictureId', 'pictureID'),
  };
}

/**
 * `POST /user/info` — NÃO confirmado com sucesso (cabeçalho, achado
 * nº 3). `timeoutMs` é OBRIGATÓRIO aqui, ao contrário do resto do
 * módulo: o padrão de `evolutionRequest` (`config.requestTimeoutMs`,
 * 15 s) é curto demais para o que foi medido (falha em ~75 s), e usar
 * os 75 s travaria o lote inteiro atrás de um contato problemático. O
 * chamador (`check-run.ts`) decide o valor via a cascata de limites.
 *
 * Lança `EvolutionApiError` em falha/timeout — não engole o erro aqui,
 * porque "info indisponível" e "checagem indisponível" são decisões
 * diferentes de quem chama (D-13: falha de avatar/info não deve
 * derrubar o veredito de `/user/check`, que já foi aplicado antes).
 */
export async function fetchWhatsappUserInfo(
  config: EvolutionConfig,
  instanceToken: string,
  numbers: string[],
  timeoutMs: number
): Promise<WhatsappUserInfo[]> {
  if (numbers.length === 0) return [];
  const raw = await evolutionRequest(config, '/user/info', {
    method: 'POST',
    key: instanceToken,
    body: { number: numbers },
    timeoutMs,
  });
  return extractCheckItems(raw).map(parseInfoItem);
}

// ------------------------------------------------------------
// POST /user/avatar
// ------------------------------------------------------------

export interface WhatsappAvatarResult {
  /** Base64 cru, sem prefixo `data:`. */
  base64: string;
}

/**
 * `POST /user/avatar` — NÃO confirmado com sucesso (cabeçalho, achado
 * nº 3/4). Devolve `null` quando o contato não tem foto (a Evolution
 * não distingue isso de "não achei" na referência); lança
 * `EvolutionApiError` em falha de transporte/timeout, mesma razão do
 * `/user/info`.
 *
 * ⚠️ **Não confia em nenhum campo de tipo MIME declarado.** A resposta
 * não traz um — e mesmo que trouxesse, a armadilha da 040/`upload-
 * media.ts` (tipo com parâmetro rejeitado como string literal pelo
 * bucket) já ensinou a não confiar em declaração de terceiro. Quem
 * chama detecta o tipo pelos BYTES (`avatar.ts`, D-14 #4).
 */
export async function fetchWhatsappAvatar(
  config: EvolutionConfig,
  instanceToken: string,
  number: string,
  { preview = true, timeoutMs }: { preview?: boolean; timeoutMs: number }
): Promise<WhatsappAvatarResult | null> {
  const raw = await evolutionRequest(config, '/user/avatar', {
    method: 'POST',
    key: instanceToken,
    body: { number, preview },
    timeoutMs,
  });

  // Forma da referência: {success, avatar} SEM envelope `data`.
  const direct = asRecord(raw);
  const directAvatar = direct ? pickString(direct, 'avatar', 'Avatar') : null;
  if (directAvatar) return { base64: directAvatar };

  // Defesa em profundidade: se um dia vier envelopado.
  const unwrapped = unwrap(raw);
  const wrappedAvatar = pickString(unwrapped, 'avatar', 'Avatar');
  if (wrappedAvatar) return { base64: wrappedAvatar };

  return null;
}

// ------------------------------------------------------------
// GET /user/contacts
// ------------------------------------------------------------

export interface EvolutionContactRow {
  jid: string;
  found: boolean;
  firstName: string | null;
  fullName: string | null;
  pushName: string | null;
  businessName: string | null;
}

/**
 * `GET /user/contacts` — MEDIDO: `{"data":[{Jid,Found,FirstName,
 * FullName,PushName,BusinessName}],"message":"success"}`, sem
 * paginação (D-14 #2), escopado pelo TOKEN da instância (D-14 #1 —
 * confirmado com o token de `bruno`: devolveu só a agenda daquela
 * instância). Item sem `Jid` é descartado — sem ele não há como
 * deduplicar contra `evolution_harvested_contacts` (chave
 * `account_id, channel_id, jid`).
 */
export async function listWhatsappContacts(
  config: EvolutionConfig,
  instanceToken: string,
  timeoutMs?: number
): Promise<EvolutionContactRow[]> {
  const raw = await evolutionRequest(config, '/user/contacts', {
    method: 'GET',
    key: instanceToken,
    timeoutMs,
  });

  const items = extractContactsArray(raw);
  const rows: EvolutionContactRow[] = [];
  for (const item of items) {
    const rec = asRecord(item);
    if (!rec) continue;
    const jid = pickString(rec, 'Jid', 'JID', 'jid');
    if (!jid) continue;
    rows.push({
      jid,
      found: pickBoolean(rec, 'Found', 'found') ?? false,
      firstName: pickString(rec, 'FirstName', 'firstName'),
      fullName: pickString(rec, 'FullName', 'fullName'),
      pushName: pickString(rec, 'PushName', 'pushName'),
      businessName: pickString(rec, 'BusinessName', 'businessName'),
    });
  }
  return rows;
}

/**
 * `unwrap()` não serve para este endpoint: ele existe para "extrair um
 * OBJETO de `body.data`" e devolve `{}` quando `data` é um array (é o
 * caso daqui — `unwrap` foi escrito pensando nos endpoints de
 * gerenciamento de instância, todos objeto). `/user/contacts` é
 * `{data:[...]}\`; a lista mora direto em `body.data`.
 */
function extractContactsArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const rec = asRecord(raw);
  const data = rec ? pickKey(rec, 'data') : undefined;
  return Array.isArray(data) ? data : [];
}
