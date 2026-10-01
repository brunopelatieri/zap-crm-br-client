import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';

const ID = '3f2b8c1e-aaaa-bbbb-cccc-1234567890ab';

describe('Select — rótulo do item selecionado', () => {
  it('mostra o rótulo (não o ID) no trigger, com o conteúdo ainda fechado', () => {
    const html = renderToString(
      <Select value={ID}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="other">Outro</SelectItem>
          <SelectItem value={ID}>Plano Pro</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(html).toContain('Plano Pro');
    expect(html).not.toContain(`>${ID}<`);
  });

  it('encontra itens gerados por .map() e dentro de fragmentos', () => {
    const rows = [
      { id: ID, name: 'Canal A' },
      { id: 'x2', name: 'Canal B' },
    ];
    const html = renderToString(
      <Select value="x2">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <>
            {rows.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </>
        </SelectContent>
      </Select>
    );
    expect(html).toContain('Canal B');
  });

  it('`items` explícito continua tendo prioridade', () => {
    const html = renderToString(
      <Select value="a" items={[{ value: 'a', label: 'Explícito' }]}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Do filho</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(html).toContain('Explícito');
  });
});
