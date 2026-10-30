# PRD 072 — Excluir a conta: do SQL manual ao botão do titular

> **Emenda declarada ao PRD 061.** A §3.3 daquele documento diz, com todas as
> letras: _"Excluir a conta permanece manual e exclusivo do proprietário da
> plataforma. Não existe botão de autoexclusão nesta entrega"_, e a §9 lista
> "Autoexclusão da conta pelo cliente" como fora de escopo pelo motivo
> "operação sem desfazer, envolvendo dados de terceiros". Este PRD **reverte
> essa decisão** e diz sob quais condições. Nada mais do PRD 061 muda.

**Status:** aguardando ratificação das decisões D-1…D-9 (ver SPEC 073 §2).
**Data:** 2026-09-06.
**SPEC de execução:** [`docs/spec-073-exclusao-da-conta-pelo-titular.md`](./spec-073-exclusao-da-conta-pelo-titular.md).

---

## 1. Por que agora

Três forças, nenhuma delas nova, que juntas mudaram o cálculo:

1. **LGPD art. 18, VI.** O titular tem direito à eliminação dos dados pessoais
   tratados com base no consentimento. Hoje a resposta do produto é "abre um
   chamado e o proprietário roda SQL". Isso funciona enquanto houver dois
   clientes; não funciona como política.
2. **A objeção "dados de terceiros" tem resposta técnica.** O PRD 061 recuou
   porque apagar a conta apagaria junto conversas de clientes finais e os
   **logins dos colegas de equipe**. A segunda metade dessa objeção deixou de
   valer: `remove_account_member()` (migração 018, corrigida na 074) já sabe
   desligar um membro **preservando o login dele** e entregando uma conta
   pessoal vazia com o plano padrão. Desligar todo mundo antes de apagar
   transforma "apagar dados de terceiros" em "devolver a cada um o que é dele".
   A primeira metade — conversas de clientes finais — é justamente o dado que o
   titular é o controlador e tem o direito de eliminar.
3. **O caminho manual é o pior dos mundos.** Um `DELETE` digitado à mão em
   produção, sem exclusão dos arquivos no Storage, sem desligar as instâncias
   Evolution na VPS e sem rastro de auditoria, é mais arriscado do que um
   caminho testado que faz as três coisas na ordem certa.

A SPEC 062 §14 já tinha escrito o preço da entrada: _"uma tela para a operação
sem desfazer precisa de confirmação por digitação do nome, exportação prévia e
carência"_. Este PRD paga dois desses três itens e explica, na §4, por que o
terceiro (carência) é recusado **por honestidade**, não por preguiça.

---

## 2. O que o cliente ganha

Uma seção **"Zona de risco"** em `/settings`, visível **só para o dono da
conta** (`account_role = 'owner'`), com um único botão: **Excluir conta
permanentemente**.

O modal, antes de habilitar o botão:

| Elemento | Por quê |
| --- | --- |
| Inventário do que será apagado (contatos, conversas, mensagens, disparos, canais, membros) | Ninguém confirma o que não consegue medir. Números reais, buscados na hora |
| Links de exportação (contatos — SPEC 051; conversas — SPEC 067) | "Exportação prévia" da SPEC 062 §14, sem inventar mecanismo novo |
| Aviso nominal de quantos colegas serão desligados e o que acontece com eles | Transparência sobre o ponto que travou o PRD 061 |
| Campo "digite o nome exato da conta" | Mesmo padrão de confirmação já usado para excluir instância QRCode |
| Campo "digite sua senha atual" | Sessão sequestrada / notebook aberto não apaga uma empresa inteira |
| Frase "esta ação não tem desfazer" com o resultado explícito: o login do titular deixa de existir | Expectativa correta antes, não descoberta depois |

Depois de confirmar: a conta some, a sessão cai, e a tela seguinte é o login
com um aviso de conclusão.

## 3. O que o proprietário da plataforma ganha

- **Rastro que sobrevive à conta.** `platform_audit_log` grava
  `action = 'account.delete'` com o id, o nome, o e-mail do titular e as
  contagens no `payload`. O `account_id` da linha vira `NULL` (o FK é
  `ON DELETE SET NULL`, SPEC 062 §5) — é exatamente por isso que o payload
  precisa carregar a cópia.
- **Aviso na caixa de entrada.** Evento `account.deleted` na outbox da
  SPEC 063, com o mesmo caminho de e-mail/webhook dos eventos de plano.
- **Uma dívida a menos.** O item "Exclusão de conta pelo console" da SPEC 062
  §14 deixa de ser SQL manual — a rota passa a existir; expor a mesma operação
  dentro de `/admin` vira um botão que chama código já escrito e testado.

## 4. As três decisões de produto que este PRD toma

### 4.1. Sem carência — a exclusão é imediata

A carência (marcar hoje, apagar em 7 dias) só é honesta se **alguém apagar de
fato no sétimo dia**. Quem apagaria seria uma varredura por cron — e o cron
**não está instalado no projeto de produção** (`pg_cron` nunca foi criado; é
armadilha documentada no `AGENTS.md`). Uma conta marcada para exclusão que
nunca é apagada é o pior resultado possível: o cliente acredita que seus dados
sumiram, a base continua inteira, e ninguém percebe porque não há erro.

Entre "imediato e verdadeiro" e "agendado e mentiroso", o produto escolhe o
primeiro. A proteção contra o clique impulsivo passa a ser a **confirmação
dupla** da §2 (nome digitado + senha), não o tempo.

> Quando o cron entrar no ar, a carência volta à mesa — aí ela é uma promessa
> que o sistema consegue cumprir.

### 4.2. O colega perde o acesso à empresa, não a conta dele

Todo membro que não é o titular é desligado **antes** do apagamento e recebe
uma conta pessoal vazia com o plano padrão — o mesmo desfecho de "remover
membro" que já existe na aba Equipe. O titular tem autoridade sobre os dados da
empresa; não tem autoridade para destruir a credencial de outra pessoa.

### 4.3. O login do titular é eliminado junto

Metade de uma exclusão — dados apagados, login sobrevivendo — não é
"eliminação" em nenhuma leitura da LGPD, e deixa um usuário órfão apontando
para uma conta vazia. O `auth.users` do titular é removido depois da conta (a
ordem é obrigatória: a chave estrangeira `accounts.owner_user_id` é
`ON DELETE RESTRICT`). O e-mail volta a ficar livre para um cadastro novo.

---

## 5. Fora de escopo

| Item | Por quê não agora |
| --- | --- |
| Carência / desfazer | §4.1 — depende de cron que não existe no ambiente |
| Exportação automática ("baixe tudo antes de apagar") | Um pacote completo é um job novo, com fila e expiração. As duas exportações que já existem cobrem o essencial e ficam linkadas no modal |
| Botão equivalente dentro de `/admin` | A rota nasce genérica; a tela do console é meia hora de trabalho **depois** que este caminho estiver rodando em produção |
| Transferir a titularidade em vez de excluir | Já existe (`transfer_account_ownership`); o modal apenas menciona a alternativa |
| Anonimização em vez de exclusão | Meio-termo que ninguém pediu e que dobra a superfície de teste |

---

## 6. Como saber que deu certo

- Uma conta de teste com contatos, conversas, mídia, canal QRCode e dois
  colegas desaparece por completo: nenhuma linha em nenhuma das 47 tabelas com
  `account_id`, nenhum objeto nos quatro buckets, nenhuma instância viva na VPS.
- Os dois colegas continuam conseguindo entrar — em contas pessoais vazias.
- O titular não consegue mais entrar, e o e-mail dele aceita um cadastro novo.
- O proprietário da plataforma tem, em `platform_audit_log`, a resposta para
  "que conta era essa e o que ela tinha" — depois de ela não existir mais.
