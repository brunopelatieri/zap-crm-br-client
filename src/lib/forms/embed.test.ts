import { describe, expect, it } from 'vitest';

import {
  buildEmbedSnippet,
  DEFAULT_EMBED_HEIGHT,
  EMBED_RESIZE_MESSAGE_TYPE,
} from './embed';

describe('buildEmbedSnippet', () => {
  const url = 'https://app.example.com/f/captacao';

  it('iframe aponta para o link e usa altura inicial', () => {
    const s = buildEmbedSnippet(url, 'captacao', 'Captação');
    expect(s.iframe).toContain(`src="${url}"`);
    expect(s.iframe).toContain(`height:${DEFAULT_EMBED_HEIGHT}px`);
    expect(s.iframe).toContain('id="zapcrm-form-captacao"');
    expect(s.html).toBe(`${s.iframe}\n${s.script}`);
  });

  it('o script só aceita mensagem da origem do formulário', () => {
    const s = buildEmbedSnippet(url, 'captacao', 'x');
    expect(s.script).toContain('e.origin!=="https://app.example.com"');
    expect(s.script).toContain(JSON.stringify(EMBED_RESIZE_MESSAGE_TYPE));
  });

  it('escapa aspas e sinais no título (sem quebrar o atributo)', () => {
    const s = buildEmbedSnippet(url, 'captacao', 'A "b" <c> & d');
    expect(s.iframe).toContain('title="A &quot;b&quot; &lt;c&gt; &amp; d"');
    expect(s.iframe).not.toContain('<c>');
  });

  it('slug com caractere estranho não vira id perigoso', () => {
    const s = buildEmbedSnippet(url, 'x"><script>', 'x');
    expect(s.iframe).toContain('id="zapcrm-form-xscript"');
  });
});
