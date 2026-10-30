# ZAP CRM BR — CRM para WhatsApp feito para o mercado brasileiro

Fork do [wacrm](https://github.com/ArnasDon/wacrm) ([ArnasDon](https://github.com/ArnasDon)), mantido por [Bruno Pelatieri](https://github.com/brunopelatieri) em [brunopelatieri/zap-crm-br](https://github.com/brunopelatieri/zap-crm-br). Os créditos pelo core original pertencem ao autor original; texto completo na seção `## Créditos` do `AGENTS.md`, importado a seguir:

@AGENTS.md

Extras só do Claude Code:

- Skills sob demanda em `.claude/skills/`; rules carregadas por path em `.claude/rules/`.
- `permissions.deny` em `.claude/settings.json` (local, não versionado) reforça segredos e `git commit`/`push`; sem ele, vale só o `AGENTS.md`.
- Medir o contexto: `/context` (baseline em `docs/context/status.md`).
