import { describe, expect, it } from 'vitest';
import {
  MASK_ADDRESS,
  MASK_CARD,
  MASK_CEP,
  MASK_CNPJ,
  MASK_CPF,
  MASK_DOCUMENT,
  MASK_EMAIL,
  MASK_LINK_WA,
  MASK_NAME,
  MASK_PHONE,
  MASK_PLATE,
  isValidCpf,
  maskAndLimit,
  maskPersonalData,
} from './mask';

// Synthetic data only: none of these numbers or names belongs to anyone.
const PHONES = [
  '(11) 98765-4321',
  '+55 11 98765-4321',
  '+5511987654321',
  '55 (11) 9 8765-4321',
  '11 98765 4321',
  '11987654321',
  '011 98765-4321',
  '98765-4321',
  '(21) 3456-7890',
  '2134567890',
  '0800 123 4567',
  '11 9 8765 4321',
  '+55.11.98765.4321',
];

describe('maskPersonalData — telefone', () => {
  it.each(PHONES)('mascara %s', (phone) => {
    expect(maskPersonalData(`meu zap é ${phone}, pode chamar`)).toBe(
      `meu zap é ${MASK_PHONE}, pode chamar`
    );
  });

  it('não deixa um dígito do número no texto', () => {
    for (const phone of PHONES) {
      const out = maskPersonalData(`ligue ${phone}`);
      expect(out).not.toMatch(/\d{3}/);
    }
  });

  it('mascara dois números no mesmo texto', () => {
    expect(
      maskPersonalData('fixo (11) 3456-7890 ou celular (11) 98765-4321')
    ).toBe(`fixo ${MASK_PHONE} ou celular ${MASK_PHONE}`);
  });

  it('mantém preço, quantidade e horário (menos de 8 dígitos)', () => {
    const text = 'O plano custa R$ 1.299,00, são 12 parcelas às 10:30 do dia 5';
    expect(maskPersonalData(text)).toBe(text);
  });

  it('mantém data escrita com ponto ou barra', () => {
    expect(maskPersonalData('vence em 10.12.2026')).toBe('vence em 10.12.2026');
    expect(maskPersonalData('vence em 10/12/2026')).toBe('vence em 10/12/2026');
  });
});

describe('maskPersonalData — CPF, CNPJ, cartão e CEP', () => {
  it('CPF com pontuação, válido ou não', () => {
    expect(maskPersonalData('cpf 529.982.247-25 ok')).toBe(
      `cpf ${MASK_CPF} ok`
    );
    expect(maskPersonalData('cpf 111.222.333-44 ok')).toBe(
      `cpf ${MASK_CPF} ok`
    );
  });

  it('CPF sem pontuação e válido vira [cpf]; inválido vira telefone (ambíguo)', () => {
    expect(maskPersonalData('cpf 52998224725')).toBe(`cpf ${MASK_CPF}`);
    expect(maskPersonalData('cpf 11122233344')).toBe(`cpf ${MASK_PHONE}`);
  });

  it('CPF com espaços no lugar dos pontos', () => {
    expect(maskPersonalData('529 982 247 25')).toMatch(/^\[/);
    expect(maskPersonalData('529 982 247 25')).not.toMatch(/\d/);
  });

  it('CNPJ com e sem pontuação', () => {
    expect(maskPersonalData('cnpj 11.222.333/0001-81')).toBe(
      `cnpj ${MASK_CNPJ}`
    );
    expect(maskPersonalData('cnpj 11222333000181')).toBe(`cnpj ${MASK_CNPJ}`);
  });

  it('cartão com espaços e com traços', () => {
    expect(maskPersonalData('cartão 4111 1111 1111 1111 vence')).toBe(
      `cartão ${MASK_CARD} vence`
    );
    expect(maskPersonalData('4111-1111-1111-1111')).toBe(MASK_CARD);
  });

  it('CEP com hífen', () => {
    expect(maskPersonalData('moro no CEP 01310-100')).toBe(
      `moro no CEP ${MASK_CEP}`
    );
  });

  it('CPF válido: isValidCpf', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('52998224726')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('123')).toBe(false);
  });
});

describe('maskPersonalData — e-mail', () => {
  it('mascara e-mail simples, com ponto, com + e subdomínio', () => {
    expect(maskPersonalData('é maria.silva@exemplo.com.br mesmo')).toBe(
      `é ${MASK_EMAIL} mesmo`
    );
    expect(maskPersonalData('joao+loja@mail.exemplo.org')).toBe(MASK_EMAIL);
    expect(maskPersonalData('MARIA@EXEMPLO.COM')).toBe(MASK_EMAIL);
  });

  it('não deixa @ nem o domínio', () => {
    expect(maskPersonalData('fale com ana@empresa.com.br hoje')).not.toMatch(
      /@|empresa/
    );
  });
});

describe('maskPersonalData — links', () => {
  it('link do WhatsApp com número some inteiro', () => {
    expect(maskPersonalData('me chama em https://wa.me/5511987654321 ok')).toBe(
      `me chama em ${MASK_LINK_WA} ok`
    );
    expect(
      maskPersonalData('https://api.whatsapp.com/send?phone=5511987654321')
    ).toBe(MASK_LINK_WA);
  });

  it('link da loja mantém a página e perde a query', () => {
    expect(
      maskPersonalData('veja https://loja.exemplo/p/123?email=a@b.com&t=999')
    ).toBe('veja https://loja.exemplo/p/123?…');
  });

  it('dado pessoal no caminho ou na parte de usuário do link é mascarado', () => {
    expect(
      maskPersonalData('https://app.exemplo.com/clientes/11987654321')
    ).toBe(`https://app.exemplo.com/clientes/${MASK_PHONE}`);
    expect(
      maskPersonalData('veja https://x.com/u/maria@exemplo.com/perfil')
    ).toBe(`veja https://x.com/u/${MASK_EMAIL}/perfil`);
    expect(maskPersonalData('https://x.com/cpf/52998224725')).toBe(
      `https://x.com/cpf/${MASK_CPF}`
    );
    expect(
      maskPersonalData('https://usuario:senha@host.exemplo.com/a')
    ).not.toContain('senha@');
  });

  it('número dentro do caminho do link não vira telefone', () => {
    expect(maskPersonalData('https://loja.exemplo/pedido/123456789')).toBe(
      'https://loja.exemplo/pedido/123456789'
    );
  });
});

describe('maskPersonalData — nome', () => {
  it('mascara o nome do contato por palavra inteira, sem acento e sem caixa', () => {
    expect(
      maskPersonalData('Oi, aqui é a josé. José da Silva falando', {
        knownNames: ['José da Silva'],
      })
    ).toBe(`Oi, aqui é a ${MASK_NAME}. ${MASK_NAME} da ${MASK_NAME} falando`);
  });

  it('ignora palavra curta do nome (da, de)', () => {
    expect(
      maskPersonalData('o prazo da entrega', { knownNames: ['Ana da Silva'] })
    ).toBe('o prazo da entrega');
  });

  it('não mascara pedaço de outra palavra', () => {
    expect(
      maskPersonalData('Anastácia chegou, a Ana também', {
        knownNames: ['Ana'],
      })
    ).toBe(`Anastácia chegou, a ${MASK_NAME} também`);
  });

  it('a frase comum que começa igual NÃO perde palavras (só nome próprio é mascarado)', () => {
    for (const text of [
      'sou cliente antigo da loja',
      'Sou a favor da troca',
      "i'm looking for shoes today",
      'I am not sure about the size',
      'Sou o gerente da unidade',
      'meu nome é o que está no pedido',
    ]) {
      expect(maskPersonalData(text)).toBe(text);
    }
  });

  it('apresentação ("meu nome é …") mascara sem precisar de nome conhecido', () => {
    expect(maskPersonalData('Olá, meu nome é Carla Mendes e quero saber')).toBe(
      `Olá, meu nome é ${MASK_NAME} e quero saber`
    );
    expect(maskPersonalData('Me chamo Pedro')).toBe(`Me chamo ${MASK_NAME}`);
  });
});

describe('maskPersonalData — propriedades', () => {
  it('é idempotente', () => {
    const text =
      'Maria Souza (11) 98765-4321 maria@x.com cpf 529.982.247-25 https://wa.me/5511987654321';
    const once = maskPersonalData(text, { knownNames: ['Maria Souza'] });
    expect(maskPersonalData(once, { knownNames: ['Maria Souza'] })).toBe(once);
  });

  it('texto sem dado pessoal passa intacto', () => {
    const text = 'Qual o prazo de entrega para São Paulo? Aceitam Pix?';
    expect(maskPersonalData(text)).toBe(text);
  });

  it('entrada vazia ou inválida devolve vazio', () => {
    expect(maskPersonalData('')).toBe('');
    expect(maskPersonalData(undefined as unknown as string)).toBe('');
  });

  it('um caractere de controle no texto não forja o escudo do link', () => {
    const forged = `${String.fromCharCode(1)}0${String.fromCharCode(2)}`;
    const out = maskAndLimit(`oi ${forged} https://a.com/x`, 200);
    expect(out).toBe('oi 0 https://a.com/x');
  });
});

describe('maskAndLimit', () => {
  it('corta no limite, de preferência numa palavra', () => {
    const out = maskAndLimit('palavra '.repeat(50), 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith('palavra')).toBe(true);
  });

  it('mascara antes de cortar', () => {
    expect(maskAndLimit('ligue 11 98765-4321', 100)).toBe(
      `ligue ${MASK_PHONE}`
    );
  });
});

describe('maskPersonalData — endereço, placa, RG e UUID', () => {
  it.each([
    ['Rua das Flores, 123, apto 45', 'moro na Rua das Flores, 123, apto 45 ok'],
    ['Av. Paulista 1578', 'moro na Av. Paulista 1578 ok'],
    ['Avenida Brasil, 500', 'moro na Avenida Brasil, 500 ok'],
    ['Rua 7 de Setembro, 100', 'moro na Rua 7 de Setembro, 100 ok'],
    [
      'Travessa Bela Vista 12 bloco B',
      'moro na Travessa Bela Vista 12 bloco B ok',
    ],
    ['Tv. do Sol, 9', 'moro na Tv. do Sol, 9 ok'],
    ['Alameda Santos nº 20', 'moro na Alameda Santos nº 20 ok'],
    ['Rodovia BR 116', 'moro na Rodovia BR 116 ok'],
    ['Estrada do Café 300 casa 2', 'moro na Estrada do Café 300 casa 2 ok'],
    ['R. Augusta 77', 'moro na R. Augusta 77 ok'],
    ['Praça da Sé 1', 'moro na Praça da Sé 1 ok'],
    ['rua das flores 123', 'moro na rua das flores 123 ok'],
  ])('mascara o endereço %s', (_addr, text) => {
    const out = maskPersonalData(text);
    expect(out).toBe(`moro na ${MASK_ADDRESS} ok`);
    expect(out).not.toMatch(/\d/);
  });

  it('o complemento logo depois do número vai junto', () => {
    expect(maskPersonalData('Rua das Flores 123 apto 45, centro')).toBe(
      `${MASK_ADDRESS}, centro`
    );
  });

  it('rua sem número e frase comum ficam intactas', () => {
    const text = 'A rua é bonita. Tenho 2 filhos e 3 gatos, total 5 itens.';
    expect(maskPersonalData(text)).toBe(text);
  });

  it('CEP junto do endereço continua virando [cep]', () => {
    expect(maskPersonalData('Av. Brasil 500, 01310-100')).toBe(
      `${MASK_ADDRESS}, ${MASK_CEP}`
    );
  });

  it.each(['ABC-1234', 'ABC1234', 'BRA2E19', 'BRA-2E19'])(
    'mascara a placa %s (palavra inteira)',
    (plate) => {
      expect(maskPersonalData(`o carro ${plate} quebrou`)).toBe(
        `o carro ${MASK_PLATE} quebrou`
      );
    }
  );

  it('placa: minúscula, palavra maior e texto comum não são placa', () => {
    expect(maskPersonalData('abc-1234')).toBe('abc-1234');
    expect(maskPersonalData('XABC1234')).toBe('XABC1234');
    expect(maskPersonalData('ABC12345')).toBe('ABC12345');
    expect(maskPersonalData('Pedido ABC123 enviado')).toBe(
      'Pedido ABC123 enviado'
    );
  });

  it('RG com pontuação vira [documento]', () => {
    expect(maskPersonalData('RG 12.345.678-9 ok')).toBe(
      `RG ${MASK_DOCUMENT} ok`
    );
    expect(maskPersonalData('RG 12.345.678-X ok')).toBe(
      `RG ${MASK_DOCUMENT} ok`
    );
  });

  it('UUID passa inteiro, sozinho e dentro de link', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(maskPersonalData(`deal ${id} criado`)).toBe(`deal ${id} criado`);
    expect(maskPersonalData(`veja https://a.com/deals/${id}`)).toBe(
      `veja https://a.com/deals/${id}`
    );
    expect(maskPersonalData(`${id} e 11987654321`)).toBe(
      `${id} e ${MASK_PHONE}`
    );
  });

  it('continua idempotente com as marcas novas', () => {
    const text =
      'Rua das Flores, 123, apto 45, placa BRA2E19, RG 12.345.678-9, id 123e4567-e89b-12d3-a456-426614174000';
    const once = maskPersonalData(text);
    expect(maskPersonalData(once)).toBe(once);
  });
});
