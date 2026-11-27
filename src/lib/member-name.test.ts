import { describe, expect, it } from 'vitest';
import { MEMBER_NAME_MAX, truncateMemberName } from './member-name';

describe('truncateMemberName', () => {
  it('mantém nomes dentro do teto', () => {
    expect(truncateMemberName('Ana Souza')).toBe('Ana Souza');
  });

  it('aceita exatamente o teto sem reticência', () => {
    const name = 'a'.repeat(MEMBER_NAME_MAX);
    expect(truncateMemberName(name)).toBe(name);
  });

  it('corta acima do teto e a reticência entra na conta', () => {
    const out = truncateMemberName('OLEVINO PEREIRA DEALMEIDA NETO');
    expect(Array.from(out)).toHaveLength(MEMBER_NAME_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe('OLEVINO PEREIRA DEALM…');
  });

  it('não deixa espaço pendurado antes da reticência', () => {
    // 21º caractere é um espaço: não pode sobrar "Fulano …".
    expect(truncateMemberName('Fulano de Tal Silva Pereira', 11)).toBe(
      'Fulano de…'
    );
  });

  it('respeita um teto customizado', () => {
    expect(truncateMemberName('Bruno Pelatieri Goulart', 16)).toBe(
      'Bruno Pelatieri…'
    );
  });

  it('normaliza espaços repetidos e nas pontas', () => {
    expect(truncateMemberName('  Ana   Souza  ')).toBe('Ana Souza');
  });

  it('não parte caractere fora do BMP (emoji) ao meio', () => {
    const out = truncateMemberName('😀'.repeat(30), 5);
    expect(out).toBe('😀😀😀😀…');
  });

  it('devolve string vazia para null, undefined e só espaços', () => {
    expect(truncateMemberName(null)).toBe('');
    expect(truncateMemberName(undefined)).toBe('');
    expect(truncateMemberName('   ')).toBe('');
  });

  it('teto 1 ou menor vira só a reticência', () => {
    expect(truncateMemberName('Ana', 1)).toBe('…');
  });
});
