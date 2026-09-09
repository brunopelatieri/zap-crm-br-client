import { describe, expect, it } from 'vitest';
import {
  canResendMessage,
  deletionScopeFor,
  deriveResendFilename,
  planDeletion,
  truncatePreview,
  type PlanDeletionInput,
} from './delete';

function baseInput(
  overrides: Partial<PlanDeletionInput> = {}
): PlanDeletionInput {
  return {
    channelType: 'whatsapp_qr',
    senderType: 'agent',
    status: 'delivered',
    providerMessageId: 'wamid.abc',
    deletedAt: null,
    ageHours: 1,
    role: 'agent',
    ...overrides,
  };
}

describe('planDeletion', () => {
  it('recusa viewer com no_permission', () => {
    const plan = planDeletion(baseInput({ role: 'viewer' }));
    expect(plan).toEqual({ action: 'refuse', reason: 'no_permission' });
  });

  it('recusa conta bloqueada com no_permission mesmo para admin', () => {
    const plan = planDeletion(
      baseInput({ role: 'admin', accountBlocked: true })
    );
    expect(plan).toEqual({ action: 'refuse', reason: 'no_permission' });
  });

  it('recusa mensagem do contato com not_outbound', () => {
    const plan = planDeletion(baseInput({ senderType: 'customer' }));
    expect(plan).toEqual({ action: 'refuse', reason: 'not_outbound' });
  });

  it('recusa nothing_to_do quando ja marcada e papel abaixo de admin', () => {
    const plan = planDeletion(
      baseInput({ role: 'agent', deletedAt: '2026-09-01T00:00:00Z' })
    );
    expect(plan).toEqual({ action: 'refuse', reason: 'nothing_to_do' });
  });

  it('recusa nothing_to_do quando ja marcada, revogada com sucesso e papel abaixo de admin', () => {
    const plan = planDeletion(
      baseInput({
        role: 'agent',
        deletedAt: '2026-09-01T00:00:00Z',
        deletionScope: 'revoked',
      })
    );
    expect(plan).toEqual({ action: 'refuse', reason: 'nothing_to_do' });
  });

  it('recusa nothing_to_do quando ja marcada, not_supported e papel abaixo de admin', () => {
    const plan = planDeletion(
      baseInput({
        role: 'agent',
        deletedAt: '2026-09-01T00:00:00Z',
        deletionScope: 'not_supported',
      })
    );
    expect(plan).toEqual({ action: 'refuse', reason: 'nothing_to_do' });
  });

  it('agent PODE tentar de novo (retry) quando ja marcada e a revogacao falhou — achado de code review', () => {
    const plan = planDeletion(
      baseInput({
        role: 'agent',
        deletedAt: '2026-09-01T00:00:00Z',
        deletionScope: 'revoke_failed',
      })
    );
    expect(plan).toMatchObject({
      action: 'delete',
      alreadyMarked: true,
      canPurge: false,
    });
  });

  it('admin pode agir sobre mensagem ja marcada (excluir)', () => {
    const plan = planDeletion(
      baseInput({ role: 'admin', deletedAt: '2026-09-01T00:00:00Z' })
    );
    expect(plan).toMatchObject({
      action: 'delete',
      alreadyMarked: true,
      canPurge: true,
    });
  });

  describe('revoke — QRCode (deleteForEveryone: true)', () => {
    it('revoga quando ha providerMessageId e status entregue', () => {
      const plan = planDeletion(
        baseInput({ channelType: 'whatsapp_qr', status: 'delivered' })
      );
      expect(plan).toMatchObject({ action: 'delete', revoke: true });
    });

    it('nao revoga sem providerMessageId — mas ainda marca', () => {
      const plan = planDeletion(
        baseInput({ channelType: 'whatsapp_qr', providerMessageId: null })
      );
      expect(plan).toMatchObject({ action: 'delete', revoke: false });
    });

    it('nao revoga mensagem status=sending — ainda marca', () => {
      const plan = planDeletion(
        baseInput({ channelType: 'whatsapp_qr', status: 'sending' })
      );
      expect(plan).toMatchObject({ action: 'delete', revoke: false });
    });

    it('nao revoga mensagem status=failed — ainda marca', () => {
      const plan = planDeletion(
        baseInput({ channelType: 'whatsapp_qr', status: 'failed' })
      );
      expect(plan).toMatchObject({ action: 'delete', revoke: false });
    });
  });

  describe('revoke — canal oficial (deleteForEveryone: false)', () => {
    it('nunca revoga, mesmo com providerMessageId e status entregue', () => {
      const plan = planDeletion(
        baseInput({ channelType: 'whatsapp_cloud', status: 'read' })
      );
      expect(plan).toMatchObject({ action: 'delete', revoke: false });
    });
  });

  describe('warnStaleness (D-5)', () => {
    it('nao avisa dentro de 48h', () => {
      const plan = planDeletion(baseInput({ ageHours: 47.9 }));
      expect(plan).toMatchObject({ action: 'delete', warnStaleness: false });
    });

    it('avisa acima de 48h quando vai revogar', () => {
      const plan = planDeletion(baseInput({ ageHours: 48.1 }));
      expect(plan).toMatchObject({ action: 'delete', warnStaleness: true });
    });

    it('nunca avisa quando nao vai revogar (oficial), mesmo velha', () => {
      const plan = planDeletion(
        baseInput({ channelType: 'whatsapp_cloud', ageHours: 100 })
      );
      expect(plan).toMatchObject({ action: 'delete', warnStaleness: false });
    });
  });

  describe('canPurge (D-14)', () => {
    it('agent nao pode excluir', () => {
      const plan = planDeletion(baseInput({ role: 'agent' }));
      expect(plan).toMatchObject({ action: 'delete', canPurge: false });
    });

    it('admin pode excluir', () => {
      const plan = planDeletion(baseInput({ role: 'admin' }));
      expect(plan).toMatchObject({ action: 'delete', canPurge: true });
    });

    it('owner pode excluir', () => {
      const plan = planDeletion(baseInput({ role: 'owner' }));
      expect(plan).toMatchObject({ action: 'delete', canPurge: true });
    });
  });
});

describe('canResendMessage', () => {
  it('texto com conteudo e reenviavel', () => {
    expect(canResendMessage({ content_type: 'text', content_text: 'oi' })).toBe(
      true
    );
  });

  it('texto vazio nao e reenviavel', () => {
    expect(canResendMessage({ content_type: 'text', content_text: null })).toBe(
      false
    );
  });

  it('template e sempre reenviavel', () => {
    expect(canResendMessage({ content_type: 'template' })).toBe(true);
  });

  it('midia com media_path e reenviavel', () => {
    expect(
      canResendMessage({ content_type: 'image', media_path: 'account-1/x.jpg' })
    ).toBe(true);
  });

  it('midia sem media_path nao e reenviavel (D-9)', () => {
    expect(canResendMessage({ content_type: 'image', media_path: null })).toBe(
      false
    );
  });

  it('localizacao e interativo nunca sao reenviaveis', () => {
    expect(canResendMessage({ content_type: 'location' })).toBe(false);
    expect(canResendMessage({ content_type: 'interactive' })).toBe(false);
  });
});

describe('deletionScopeFor', () => {
  it('colapsa not_attempted em not_supported', () => {
    expect(deletionScopeFor('not_attempted')).toBe('not_supported');
  });

  it('mantem os outros tres desfechos como estao', () => {
    expect(deletionScopeFor('revoked')).toBe('revoked');
    expect(deletionScopeFor('not_supported')).toBe('not_supported');
    expect(deletionScopeFor('revoke_failed')).toBe('revoke_failed');
  });
});

describe('truncatePreview (D-15)', () => {
  it('nulo/vazio vira nulo', () => {
    expect(truncatePreview(null)).toBeNull();
    expect(truncatePreview(undefined)).toBeNull();
    expect(truncatePreview('')).toBeNull();
  });

  it('texto curto passa intacto', () => {
    expect(truncatePreview('oi')).toBe('oi');
  });

  it('trunca em exatamente 120 caracteres', () => {
    const long = 'a'.repeat(200);
    const result = truncatePreview(long);
    expect(result).toHaveLength(120);
    expect(result).toBe('a'.repeat(120));
  });
});

describe('deriveResendFilename (D-9/§8 — achado de code review)', () => {
  it('documento cujo content_text parece nome de arquivo usa esse nome', () => {
    expect(
      deriveResendFilename({
        content_type: 'document',
        content_text: 'contrato-revisado.pdf',
      })
    ).toBe('contrato-revisado.pdf');
  });

  it('documento cujo content_text e uma legenda em prosa NAO vira nome de arquivo', () => {
    expect(
      deriveResendFilename({
        content_type: 'document',
        content_text: 'Aqui esta o contrato revisado, da uma olhada',
      })
    ).toBe('document.bin');
  });

  it('documento sem content_text cai no fallback', () => {
    expect(
      deriveResendFilename({ content_type: 'document', content_text: null })
    ).toBe('document.bin');
  });

  it('imagem/video/audio sempre usam o fallback por tipo (content_text e legenda, nunca nome)', () => {
    expect(
      deriveResendFilename({
        content_type: 'image',
        content_text: 'foto.jpg parece nome mas não é',
      })
    ).toBe('image.jpg');
    expect(deriveResendFilename({ content_type: 'video' })).toBe('video.mp4');
    expect(deriveResendFilename({ content_type: 'audio' })).toBe('audio.ogg');
  });
});
