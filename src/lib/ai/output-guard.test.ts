import { describe, expect, it } from 'vitest';
import { extractLinks, findDisallowedLinks } from './output-guard';

const PROMPT = [
  'Business context and instructions:',
  'Nosso site é https://www.lojaexemplo.com.br e o catálogo fica em https://lojaexemplo.com.br/catalogo.',
  'Agendamentos: agenda.lojaexemplo.com.br/marcar',
].join('\n');

describe('extractLinks', () => {
  it('finds scheme, www and bare-domain links and drops trailing punctuation', () => {
    expect(
      extractLinks(
        'Veja https://a.example/x?y=1. Ou www.b.com.br/c, e também loja.com.br!'
      )
    ).toEqual(['https://a.example/x?y=1', 'www.b.com.br/c', 'loja.com.br']);
  });

  it('does not take an e-mail address, a price or a decimal for a link', () => {
    expect(
      extractLinks(
        'Escreva para vendas@loja.com.br. Custa R$ 1.500,00 ou 3.5 kg.'
      )
    ).toEqual([]);
  });

  it('stays fast on hostile input', () => {
    const hostile =
      'a.'.repeat(50_000) + 'zzz ' + 'http://' + 'x'.repeat(50_000);
    const t0 = Date.now();
    extractLinks(hostile);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('findDisallowedLinks (SPEC 089 F8)', () => {
  it('a reply without links passes', () => {
    expect(findDisallowedLinks('Oi! Custa R$ 129.', [PROMPT])).toEqual([]);
  });

  it('the same link the business wrote passes (scheme, www and trailing slash aside)', () => {
    expect(
      findDisallowedLinks(
        'Confira lojaexemplo.com.br/catalogo/ e https://agenda.lojaexemplo.com.br/marcar.',
        [PROMPT]
      )
    ).toEqual([]);
  });

  it('a bare site whose host the business wrote passes', () => {
    expect(
      findDisallowedLinks('Acesse www.lojaexemplo.com.br', [PROMPT])
    ).toEqual([]);
  });

  it('exfiltration: a known host with a templated query or path is held', () => {
    expect(
      findDisallowedLinks(
        'Clique: https://lojaexemplo.com.br/?e=maria@x.com&t=vip',
        [PROMPT]
      )
    ).toHaveLength(1);
    expect(
      findDisallowedLinks('https://lojaexemplo.com.br/maria@x.com', [PROMPT])
    ).toHaveLength(1);
  });

  it('a host the business never wrote is held', () => {
    expect(
      findDisallowedLinks('Pague em https://pix-rapido.example/abc', [PROMPT])
    ).toEqual(['https://pix-rapido.example/abc']);
    expect(findDisallowedLinks('Veja evil.com', [PROMPT])).toEqual([
      'evil.com',
    ]);
  });

  it('a bare domain with any country TLD is caught (WhatsApp links it)', () => {
    for (const t of [
      'Acesse evil.ru/?e=maria@x.com',
      'Veja loja.de/x',
      'site.pt',
      'pague.fr/pix',
    ]) {
      expect(findDisallowedLinks(t, [PROMPT])).toHaveLength(1);
    }
    // Ordinary sentences, prices and measures are left alone.
    expect(
      findDisallowedLinks(
        'Obrigado. Volte sempre! Custa R$ 1.500,00 e pesa 3.5kg, v1.2.',
        [PROMPT]
      )
    ).toEqual([]);
    // Accepted false positive: no space after the period reads as a domain
    // (the reply is held and a human takes over).
    expect(findDisallowedLinks('Obrigado.Volte sempre', [PROMPT])).toEqual([
      'Obrigado.Volte',
    ]);
  });

  // Adversarial pass of the F8: these passed with a list of TLDs.
  it('any alphabetic TLD, an IPv4 literal, `_` and Unicode domains are caught', () => {
    for (const t of [
      'exfil.de/?e=ana@x.com',
      'EXFIL.IN/c?d=11987654321',
      'exfil.click/abc',
      '203.0.113.5/x?d=1',
      'пример.рф/x',
      'foo_exfil.com/x',
      'evil.ru:8080/x',
    ]) {
      expect(findDisallowedLinks(t, [PROMPT]).length).toBeGreaterThan(0);
    }
  });

  it('a port or user info on a trusted host is not the bare site', () => {
    expect(
      findDisallowedLinks('https://lojaexemplo.com.br:11987/', [PROMPT])
    ).toHaveLength(1);
    expect(
      findDisallowedLinks('https://ana%40x.com:senha@lojaexemplo.com.br/', [
        PROMPT,
      ])
    ).toHaveLength(1);
  });

  it('a host that only appears inside a longer host is not trusted', () => {
    expect(
      findDisallowedLinks('https://lojaexemplo.com.br.evil.com', [PROMPT])
    ).toHaveLength(1);
  });

  it('with no trusted text every link is held', () => {
    expect(findDisallowedLinks('www.lojaexemplo.com.br', [])).toHaveLength(1);
  });
});
