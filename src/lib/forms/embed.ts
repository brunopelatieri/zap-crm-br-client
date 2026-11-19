// ============================================================
// Snippet de embed do formulário (PRD 084 D-13, SPEC 085 §4.3).
//
// O formulário só abre dentro de `<iframe>` em origens cadastradas
// (`settings.embed_origins`, E-12). O snippet traz o `<iframe>` e um
// `<script>` que redimensiona a altura quando a página pública avisa com
// `postMessage({ type: 'zapcrm-form-resize', height })`.
//
// F2: o snippet já nasce neste formato; quem EMITE o `postMessage` é a
// página pública (F3). Enquanto ela não emite, o iframe fica na altura
// inicial (`DEFAULT_EMBED_HEIGHT`).
//
// Puro (sem `node:`); a origem do `postMessage` é conferida no script.
// ============================================================

export const EMBED_RESIZE_MESSAGE_TYPE = 'zapcrm-form-resize';
export const DEFAULT_EMBED_HEIGHT = 640;

export interface EmbedSnippet {
  iframe: string;
  script: string;
  /** `iframe` + `script`, pronto para colar. */
  html: string;
}

function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** `url` = link genérico `https://app/f/<slug>`; `slug` só rotula o `id`/`title`. */
export function buildEmbedSnippet(
  url: string,
  slug: string,
  title: string
): EmbedSnippet {
  const safeId = `zapcrm-form-${slug.replace(/[^a-z0-9-]/gi, '')}`;
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    origin = '';
  }

  const iframe =
    `<iframe id="${safeId}" src="${attr(url)}" title="${attr(title)}" ` +
    `style="width:100%;height:${DEFAULT_EMBED_HEIGHT}px;border:0" ` +
    `loading="lazy" allow="clipboard-write"></iframe>`;

  // JSON.stringify em strings controladas (origem e id) — sem `</script>`.
  const script =
    `<script>window.addEventListener('message',function(e){` +
    `if(e.origin!==${JSON.stringify(origin)})return;` +
    `var d=e.data;if(!d||d.type!==${JSON.stringify(EMBED_RESIZE_MESSAGE_TYPE)})return;` +
    `var f=document.getElementById(${JSON.stringify(safeId)});` +
    `if(f&&typeof d.height==='number')f.style.height=d.height+'px';});</script>`;

  return { iframe, script, html: `${iframe}\n${script}` };
}
