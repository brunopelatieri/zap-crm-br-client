═══ INÍCIO DO PROMPT ═══

<role>
Você é um Engenheiro de Software Sênior especializado em arquitetura de integrações de
mensageria (WhatsApp), sistemas multi-tenant sobre Postgres com RLS e processamento
assíncrono por cron. Você escreve documentos de produto e de engenharia — PRD e SPEC — que
outra pessoa implementa depois, fase a fase, sem precisar te perguntar nada.
</role>

<context>
O sistema é o **ZAP CRM BR** (Next.js 16 + Supabase + RLS + i18n pt-BR/en). Foi implantado o console do proprietário para gerenciar detlahes das contas o usuário cliente (customer tenant UI) com várias funções relacioando com o gerenciamento da conta.

- **Veja PRD / SPEC console do proprietário em detalhes** —  Veja abaixo (PRD 061 / SPEC 062).
</context>

<documents>
<document>
<source>AGENTS.md</source>
<note>Convenções obrigatórias do repositório — leia primeiro, inteiro.</note>
</document>
<document>
<source>docs/prd-061-console-do-proprietario-e-ciclo-de-plano.md</source>
<note>Console do Proprietário e ciclo de vida do plano.</note>
</document>
<document>
<source>docs/spec-062-console-do-proprietario.md</source>
<note>Console do Proprietário, bloqueio e ciclo de plano.</note>
</document>
</documents>

<task>
Crie um botão de deletar a conta do tenant UI do customer dono da conta e todos os dados relacionado no banco de dados do sistema Zap CRM BR.
Importante: Veja mesmo se tem necessidade de PRD ou até mesmo a SPEC. Acredito que SPEC para não ter erros, precise. Mas me diga se sonnet 5 sem SPEC faz a implementação do botão ou até mesmo um Opus sem SPEC. Eu ajustei o Opus nessa session. Analise direito se Opus der conta. Siga em frente e implemente o botão de deletar. Meu objetivo e economizar o máximo de tokens para essa tarefa. Então me diga qual é o melhor caminha para isso. Levando em conta a excelência na implementação (sempre irrevogável) com o melhor custo benefício.
</task>

<output_format>
Entregue **arquivos** em `docs/`, seguindo a numeração sequencial livre no diretório
(confirme com `ls docs/` ):

- `docs/prd-0NN-<slug>.md` — **somente se** você concluiu no passo 2 que ele se justifica.
- `docs/spec-0NN-<slug>.md` — sempre.


Na resposta do chat (fora dos arquivos), devolva só: as decisões D-1…D-n com sua
recomendação em uma linha cada de qual LLM usar para execução e sessions, o veredito sobre o PRD/SPEC, e a linha do msg de uma linha para `git commit` pronta para o mantenedor rodar.

**Pare depois de escrever os documentos.** Não comece a implementar; o mantenedor ratifica as
decisões primeiro.
</output_format>

═══ FIM DO PROMPT ═══