/**
 * Validação do corpo de teste A/B vindo de FORA do TypeScript
 * (SPEC 044 §6.6). `parseAudienceConfig`/`parseVariableMap`/`isRecord`
 * moraram aqui até a SPEC 070 — foram extraídas para
 * `parse-audience.ts` porque `draft.ts` (§3.1) precisa delas rodando
 * no NAVEGADOR, e este arquivo importa `BroadcastError`
 * (`broadcast-core.ts`) e `AbVariantInput` (`broadcast-dispatch.ts`),
 * dois módulos server-only que quebram um bundle de cliente. Reexporta
 * as três abaixo para os consumidores de servidor não precisarem trocar
 * de import.
 *
 * Dois consumidores, um validador de A/B
 *
 *   1. `POST /api/broadcasts/send` — o corpo veio pela rede e quem posta
 *      pode mandar o que quiser.
 *   2. `GET /api/broadcasts/cron` — o `audience_filter` veio do JSONB de
 *      `broadcasts`, gravado por nós mesmos… meses antes, por uma versão
 *      anterior deste código. Um agendamento é o único caminho em que um
 *      objeto persistido volta a comandar um envio; confiar nele porque
 *      "nós escrevemos" é confiar na versão do app que já não roda.
 *
 *   Extraído da rota quando o cron apareceu: duas cópias do mesmo
 *   validador divergiriam, e a divergência apareceria como "o disparo
 *   imediato recusou e o agendado deixou passar".
 */

import { AB_DEFAULT_SPLIT_PERCENT } from '@/lib/broadcasts/ab-test';
import {
  isRecord,
  parseAudienceConfig,
  parseVariableMap,
} from '@/lib/broadcasts/parse-audience';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { type AbVariantInput } from '@/lib/whatsapp/broadcast-dispatch';

export { isRecord, parseAudienceConfig, parseVariableMap };

export interface AbTestRequest {
  variant: AbVariantInput;
  /** Fatia da audiência para a variante A (1–99). */
  splitPercent: number;
}

/**
 * Lê a parte de teste A/B do corpo (SPEC 044 §6.6).
 *
 * `null` = não é um teste A/B. Malformado LANÇA, em vez de devolver
 * `null`: os dois consumidores desta função disparam de verdade, e
 * degradar silenciosamente um teste A/B pedido para um disparo simples
 * mandaria a campanha inteira com um único template sem ninguém saber.
 * O mesmo raciocínio do `parseSchedule` da rota de envio, pelo mesmo
 * motivo (um `scheduledAt` inválido nunca vira "enviar agora").
 */
export function parseAbTest(raw: unknown): AbTestRequest | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    throw new BroadcastError('bad_request', "'abTest' must be an object", 400);
  }

  const templateName =
    typeof raw.templateName === 'string' ? raw.templateName.trim() : '';
  if (!templateName) {
    throw new BroadcastError(
      'bad_request',
      "'abTest.templateName' is required",
      400
    );
  }

  const variables = parseVariableMap(raw.variables);
  if (!variables) {
    throw new BroadcastError(
      'bad_request',
      "'abTest.variables' is malformed",
      400
    );
  }

  // Percentual fora da faixa é recusado, não corrigido: um cliente que
  // manda 0 % pediu alguma coisa que este produto não faz, e "corrigir"
  // para 1 % entregaria um teste que ele não pediu.
  const rawSplit = raw.splitPercent;
  let splitPercent = AB_DEFAULT_SPLIT_PERCENT;
  if (rawSplit !== undefined && rawSplit !== null) {
    if (
      typeof rawSplit !== 'number' ||
      !Number.isInteger(rawSplit) ||
      rawSplit < 1 ||
      rawSplit > 99
    ) {
      throw new BroadcastError(
        'bad_request',
        "'abTest.splitPercent' must be an integer between 1 and 99",
        400
      );
    }
    splitPercent = rawSplit;
  }

  return {
    variant: {
      templateName,
      templateLanguage:
        typeof raw.templateLanguage === 'string' && raw.templateLanguage
          ? raw.templateLanguage
          : 'en_US',
      variables,
      headerMediaUrl:
        typeof raw.headerMediaUrl === 'string' ? raw.headerMediaUrl : undefined,
    },
    splitPercent,
  };
}
