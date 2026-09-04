/**
 * O corte do lote de captação (SPEC 069 §4.9, R5) — módulo PURO.
 *
 * `GET /user/contacts` não pagina (D-14 #2, medido): a agenda inteira
 * chega numa resposta só. O corte para "só um lote por execução" é
 * inteiramente do lado do CRM — este módulo.
 *
 * Três decisões, nesta ordem
 *
 *   1. **Dedupe por `Jid`.** Um contato já presente na triagem
 *      (`evolution_harvested_contacts`) ou já vinculado a um contato
 *      real não entra de novo — `existingJids` é responsabilidade de
 *      quem chama montar (união das duas fontes).
 *   2. **O corte é o MENOR entre `perRun` e o que falta para o teto da
 *      instância** (`remainingCapacity` = `harvest_max_per_instance` −
 *      `harvested_count`), nunca a soma — mesmo raciocínio de
 *      `planCheckBatch`.
 *   3. **Ordem estável por `Jid`.** Sem isso, duas execuções sobre a
 *      mesma agenda (ex.: um novo contato apareceu no meio) poderiam
 *      captar um subconjunto diferente do que a ordem "natural" da
 *      resposta sugeriria — `Jid` é o único campo que não muda entre
 *      chamadas.
 *
 * `capacityReached` é sobre o TETO da instância, não sobre a agenda
 *
 *   `true` só quando este lote consumiu exatamente o que faltava para
 *   `harvest_max_per_instance`. Ficar sem candidato NOVO porque a
 *   agenda acabou (todo mundo já está na triagem) é um estado
 *   diferente — não é "teto atingido", é "nada a fazer agora" — e a UI
 *   (D-8/§8) não deveria dizer "teto atingido" para os dois casos.
 */

export interface HarvestCandidate {
  jid: string;
  found: boolean;
  firstName: string | null;
  fullName: string | null;
  pushName: string | null;
  businessName: string | null;
}

export interface PlanHarvestBatchInput {
  /** A agenda inteira devolvida por `/user/contacts` nesta execução. */
  contacts: HarvestCandidate[];
  /** União de `evolution_harvested_contacts.jid` e `contact_identities.external_id`
   *  já conhecidos desta instância — não captar de novo. */
  existingJids: ReadonlySet<string>;
  perRun: number;
  /** `harvest_max_per_instance` (resolvido pela cascata) menos
   *  `harvested_count` atual. `<= 0` = já no teto. */
  remainingCapacity: number;
}

export interface HarvestBatchPlan {
  toInsert: HarvestCandidate[];
  skippedDuplicate: number;
  capacityReached: boolean;
  /** Último `Jid` considerado, em ordem estável — grava em
   *  `evolution_instances.harvest_cursor` (observabilidade; a
   *  correção do dedupe não depende dele, `existingJids` já garante). */
  cursor: string | null;
}

export function planHarvestBatch({
  contacts,
  existingJids,
  perRun,
  remainingCapacity,
}: PlanHarvestBatchInput): HarvestBatchPlan {
  if (remainingCapacity <= 0) {
    return {
      toInsert: [],
      skippedDuplicate: 0,
      capacityReached: true,
      cursor: null,
    };
  }

  const sorted = [...contacts].sort((a, b) => a.jid.localeCompare(b.jid));
  const fresh = sorted.filter((c) => !existingJids.has(c.jid));
  const skippedDuplicate = sorted.length - fresh.length;

  const limit = Math.max(0, Math.min(perRun, remainingCapacity));
  const toInsert = fresh.slice(0, limit);

  return {
    toInsert,
    skippedDuplicate,
    capacityReached: toInsert.length >= remainingCapacity,
    // Só avança quando algo foi de fato captado — um ciclo que só viu
    // duplicatas não é "progresso", é "nada novo desta vez".
    cursor: toInsert.length > 0 ? toInsert[toInsert.length - 1].jid : null,
  };
}
