import { describe, expect, it } from 'vitest';

import {
  QUOTA_KEYS,
  SAFETY_QUOTA_KEYS,
  USAGE_QUOTA_KEYS,
} from '@/lib/plans/types';
import {
  ACCOUNT_CONFIGURABLE_LIMIT_KEYS,
  COLD_SEND_LIMIT_KEYS,
  INSTANCE_CONFIGURABLE_LIMIT_KEYS,
  LIMIT_ENTRIES,
  getLimitEntry,
  isIntegerLimit,
} from './registry';

/**
 * O registro é a fonte de verdade do §3 da SPEC 069, e o §3 abre
 * dizendo que **um limite que não está na tabela é um limite que
 * continua escondido no código**. Estes testes são o que impede a
 * tabela e o código de divergirem sem ninguém perceber.
 */
describe('registro de limites — completude', () => {
  it('tem as 22 entradas do §3.1 + §3.2, mais a do achado da F3 (timeout info/avatar)', () => {
    expect(LIMIT_ENTRIES).toHaveLength(23);
  });

  it('nenhuma chave repetida', () => {
    const keys = LIMIT_ENTRIES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('nenhuma variável de ambiente repetida', () => {
    const vars = LIMIT_ENTRIES.map((e) => e.envVar);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('toda entrada tem padrão de código — é a regra 1 do §3.4 no tipo', () => {
    for (const e of LIMIT_ENTRIES) {
      expect(e.codeDefault).toBeDefined();
      if (isIntegerLimit(e)) {
        expect(Number.isInteger(e.codeDefault)).toBe(true);
        expect(e.codeDefault).toBeGreaterThanOrEqual(0);
      } else {
        expect(typeof e.codeDefault).toBe('string');
      }
    }
  });

  it('todo envVar segue o prefixo EVOLUTION_', () => {
    for (const e of LIMIT_ENTRIES) {
      expect(e.envVar).toMatch(/^EVOLUTION_[A-Z0-9_]+$/);
    }
  });

  it('teto duro do tipo max nunca é menor que o padrão de código', () => {
    // Um teto abaixo do padrão significaria que o deployment nasce
    // configurado acima do próprio limite — e o primeiro override de
    // conta seria clampado para BAIXO do que já vale.
    for (const e of LIMIT_ENTRIES) {
      if (isIntegerLimit(e) && e.hardCap?.kind === 'max') {
        expect(e.hardCap.codeDefault).toBeGreaterThanOrEqual(e.codeDefault);
      }
    }
  });

  it('piso nunca é maior que o padrão de código', () => {
    for (const e of LIMIT_ENTRIES) {
      if (isIntegerLimit(e) && e.hardCap?.kind === 'min') {
        expect(e.hardCap.codeDefault).toBeLessThanOrEqual(e.codeDefault);
      }
    }
  });

  it('os cinco eixos de ColdSendLimits apontam para entradas existentes', () => {
    for (const key of Object.values(COLD_SEND_LIMIT_KEYS)) {
      expect(getLimitEntry(key), key).toBeDefined();
    }
  });
});

/**
 * O teste de contrato que o cabeçalho de `plans/types.ts` promete:
 * `SAFETY_QUOTA_KEYS` é enumerada à mão para manter `QuotaKey` uma
 * união fechada, e é ISTO que impede a lista manual de descolar do
 * registro. Marcar `accountConfigurable: true` numa entrada nova sem
 * acrescentar a chave lá falha aqui, alto, com o nome da chave.
 */
describe('contrato registro ↔ QUOTA_KEYS (SPEC 069 D-5)', () => {
  it('toda chave accountConfigurable do registro está em QUOTA_KEYS', () => {
    const quota = new Set<string>(QUOTA_KEYS);
    const faltando = ACCOUNT_CONFIGURABLE_LIMIT_KEYS.filter(
      (k) => !quota.has(k)
    );
    expect(faltando).toEqual([]);
  });

  it('toda SAFETY_QUOTA_KEY é uma entrada accountConfigurable do registro', () => {
    const configuravel = new Set(ACCOUNT_CONFIGURABLE_LIMIT_KEYS);
    const sobrando = SAFETY_QUOTA_KEYS.filter((k) => !configuravel.has(k));
    expect(sobrando).toEqual([]);
  });

  it('uso e segurança não se sobrepõem, exceto por channels_whatsapp_qr', () => {
    // `channels_whatsapp_qr` é a única chave que é as duas coisas: um
    // recurso que se conta (uso) e um teto que o registro resolve.
    const uso = new Set<string>(USAGE_QUOTA_KEYS);
    expect(SAFETY_QUOTA_KEYS.filter((k) => uso.has(k))).toEqual([]);
    expect(ACCOUNT_CONFIGURABLE_LIMIT_KEYS.filter((k) => uso.has(k))).toEqual([
      'channels_whatsapp_qr',
    ]);
  });

  it('QUOTA_KEYS = uso + segurança, sem repetição', () => {
    expect(QUOTA_KEYS).toHaveLength(
      USAGE_QUOTA_KEYS.length + SAFETY_QUOTA_KEYS.length
    );
    expect(new Set<string>(QUOTA_KEYS).size).toBe(QUOTA_KEYS.length);
  });

  it('nenhuma chave de segurança entrou na lista de uso do cliente (§15.3)', () => {
    // A barra de uso do cliente é montada sobre USAGE_QUOTA_KEYS. Se
    // um `evolution_*` vazasse para cá, o cliente leria o freio de
    // segurança como algo que comprou e pode gastar.
    for (const key of USAGE_QUOTA_KEYS) {
      expect(key.startsWith('evolution_')).toBe(false);
    }
  });
});

describe('níveis declarados batem com o §3.1/§3.2', () => {
  it('os dois timeouts e o teto da VPS não são configuráveis por conta', () => {
    for (const key of [
      'evolution_request_timeout_ms',
      'evolution_media_request_timeout_ms',
      'evolution_max_instances_total',
    ]) {
      const e = getLimitEntry(key);
      expect(e?.accountConfigurable, key).toBe(false);
      expect(e?.instanceConfigurable, key).toBe(false);
    }
  });

  it('os cinco eixos de envio frio e os quatro de checagem são configuráveis nos dois níveis', () => {
    for (const key of [
      ...Object.values(COLD_SEND_LIMIT_KEYS),
      'evolution_check_per_hour',
      'evolution_check_per_day',
      'evolution_check_min_interval_seconds',
      'evolution_check_batch_size',
    ]) {
      const e = getLimitEntry(key);
      expect(e?.accountConfigurable, key).toBe(true);
      expect(e?.instanceConfigurable, key).toBe(true);
    }
  });

  it('toda chave instanceConfigurable também é accountConfigurable', () => {
    // O contrário existe (channels_whatsapp_qr), mas uma chave que a
    // instância pode sobrescrever e a conta não criaria uma cascata em
    // que o nível de baixo não tem de quem herdar.
    for (const key of INSTANCE_CONFIGURABLE_LIMIT_KEYS) {
      expect(getLimitEntry(key)?.accountConfigurable, key).toBe(true);
    }
  });
});
