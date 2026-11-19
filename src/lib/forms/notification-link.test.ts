import { describe, expect, it } from 'vitest';

import { notificationHref } from './notification-link';

describe('notificationHref', () => {
  it('abre a resposta no painel lateral', () => {
    expect(notificationHref({ form_id: 'f1', form_response_id: 'r1' })).toBe(
      '/forms/f1/respostas?r=r1'
    );
  });
  it('resposta apagada: a lista de respostas do formulário', () => {
    expect(notificationHref({ form_id: 'f1', form_response_id: null })).toBe(
      '/forms/f1/respostas'
    );
  });
  it('formulário apagado ou aviso antigo: lista de formulários', () => {
    expect(notificationHref({})).toBe('/forms');
    expect(notificationHref({ form_id: null })).toBe('/forms');
  });
});
