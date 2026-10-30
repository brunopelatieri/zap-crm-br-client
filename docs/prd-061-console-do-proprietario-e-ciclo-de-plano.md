# PRD 061 — Console do Proprietário e ciclo de vida do plano

> **Status:** **ratificado — D-1 a D-14 aprovadas pelo mantenedor em 2026-08-26.** Nenhuma decisão em aberto; implementação liberada pelas [SPEC 062](./spec-062-console-do-proprietario.md) e [SPEC 063](./spec-063-notificacoes-do-sistema-smtp.md)
> **Data:** 2026-08-26 (revisado no mesmo dia: ratificações + as duas diretrizes das §4.1 e §5.1)
> **Depende de:** [PRD 058](./prd-058-planos-e-quotas.md) (modelo comercial) e
> [SPEC 059](./spec-059-motor-de-quotas.md) (motor de quotas, já implementado)
> **Implementado por:** [SPEC 062](./spec-062-console-do-proprietario.md) (console + bloqueio + ciclo)
> e [SPEC 063](./spec-063-notificacoes-do-sistema-smtp.md) (SMTP + eventos)

---

## 1. O problema, em uma frase

O motor de quotas existe e funciona, mas **operá-lo exige `curl` com um segredo
de servidor** — e o cliente que quer mudar de plano precisa esperar um humano
aprovar. O ZAP CRM BR tem hoje um motor de SaaS sem a cabine de comando e sem
autosserviço.

Três consequências concretas, todas do dia a dia:

| Hoje | Custo |
| --- | --- |
| Trocar o plano de uma conta = montar um `PUT` com `x-admin-secret` | Toda operação comercial passa por terminal; erro de digitação em JSON vira override inválido no banco |
| Cliente pede plano → grava `plan_change_requests` → **espera aprovação** | Fricção máxima no único momento em que o cliente quer pagar mais |
| "Quem são meus clientes?" não tem resposta na tela | Os usuários existem soltos; não há visão de conta como unidade comercial |

Este PRD define o produto que fecha essas três lacunas. As decisões **técnicas**
(identidade do proprietário, schema, enforcement) ficam na SPEC 062; as de
**entrega de aviso** (SMTP, webhook, vencimento), na SPEC 063.

---

## 2. Quem é "o proprietário" — e por que a palavra é ambígua hoje

O repositório usa `owner` para **duas coisas diferentes**, e confundi-las é a
falha de segurança mais provável desta entrega:

| Termo | Quem é | Escopo |
| --- | --- | --- |
| **Proprietário da conta** (`profiles.account_role = 'owner'`) | O dono de UM cliente — quem contratou o ZAP CRM BR para a empresa dele | Só a própria conta. É quem já vê a aba "Retenção" (SPEC 060) |
| **Proprietário da plataforma** (novo) | O mantenedor do deployment — hoje, quem guarda `PLATFORM_ADMIN_SECRET` | **Todas** as contas. É o operador do SaaS |

O console deste PRD é do **proprietário da plataforma**. A SPEC 059 adiou
deliberadamente esse conceito (§11: "painel de super-admin com login") porque
ele cria uma superfície de segurança própria: um bug ali vaza dados entre
clientes. Este PRD assume esse custo, e a SPEC 062 §2 é inteira sobre contê-lo.

Nomenclatura adotada daqui em diante, e que a UI deve seguir em pt-BR:

- **Proprietário** (plataforma) → o console, em `/admin`.
- **Dono da conta** (cliente) → tudo que já existe, em `/settings` e `/plan`.

---

## 3. O que muda para o cliente

### 3.1. Escolher plano deixa de ser um pedido e vira uma compra

Hoje: clicar em "Escolher este plano" grava uma solicitação e mostra "em
análise" até o mantenedor aprovar. **Passa a valer imediatamente** — o plano
troca no clique.

Trade-off aceito, e ele é real: **a troca acontece antes da confirmação do
pagamento.** Um cliente pode subir para o plano Empresarial, usar o mês e não
pagar. A cobrança do ZAP CRM BR não roda aqui dentro (§5.1) — a proteção é
*posterior*, não *prévia*: o proprietário recebe o aviso na hora (§8), vê o
vencimento se aproximar no console e tem os dois botões de bloqueio da §7. É a
mesma aposta de qualquer SaaS com boleto/Pix: fricção zero para vender,
cobrança conciliada depois.

Duas exceções em que continua sendo **solicitação**, não troca:

1. Planos **não públicos** (`is_public = false`) — o "Sob medida" negociado. O
   botão vira "Falar com o time", grava a solicitação e avisa o proprietário.
2. Planos **inativos** (`is_active = false`) — não aparecem para escolha.

### 3.2. Mensal ou anual, escolhido na hora da adesão

O clique em "Escolher este plano" abre um **modal de ciclo** com as duas
opções lado a lado:

```
┌──────────────────────────────────────────────┐
│  Profissional                                │
│                                              │
│  ( ) Mensal   R$ 299,00 / mês                │
│  (•) Anual    R$ 2.990,00 / ano              │
│      Equivale a R$ 249,17/mês · economize    │
│      R$ 598,00 por ano (17%)                 │
│                                              │
│  Vence em 26/08/2027                         │
│  [ Cancelar ]          [ Confirmar troca ]   │
└──────────────────────────────────────────────┘
```

O desconto anual é **definido pelo proprietário** (§5), nunca digitado pelo
cliente. O modal mostra a data de vencimento resultante **antes** de confirmar
— é a informação que o cliente mais reclama de não ter.

### 3.3. Cancelar o plano é um botão do cliente; cancelar a conta não é

"Cancelar plano" agenda o cancelamento para **o fim do período já pago**:

- O cliente mantém tudo até `current_period_end` (ele pagou por aquilo).
- No vencimento, a conta cai para o plano padrão da plataforma (grátis).
- Aparece "Retomar plano" enquanto o cancelamento estiver agendado —
  arrependimento é comum e não pode exigir suporte.
- **Nada é apagado** (D-4 do PRD 058 continua valendo integralmente).

**Excluir a conta permanece manual e exclusivo do proprietário da plataforma.**
Não existe botão de autoexclusão nesta entrega: apagar uma conta é a operação
que não tem desfazer (mesmo princípio da SPEC 060 §1), e ela envolve conversas
de clientes finais que não são do titular.

---

## 4. O que muda para o proprietário da plataforma

Um console web em `/admin`, acessível **só pelo login dele**, cobrindo o que
hoje só existe em `curl`. A API atual continua valendo — o console é uma
segunda porta para a mesma lógica, não um substituto (SPEC 062 §6).

| Tela | O que responde |
| --- | --- |
| **Visão geral** | Quantas contas, quantas bloqueadas, quantas vencem em 7 dias, solicitações abertas, contas em overage |
| **Contas** | A lista de clientes, **cada uma com seus usuários agrupados dentro dela**. Busca por nome/e-mail, filtro por plano, status, bloqueio e vencimento |
| **Conta (detalhe)** | Plano, ciclo, adesão, vencimento, uso × quota, overrides, membros com papel, histórico de eventos e as ações: trocar plano, conceder exceção, bloquear, recontar uso |
| **Planos** | Catálogo: criar/editar, preço, desconto anual, quotas, recursos, público/privado, ativo/aposentado |
| **Retenção** | Padrão global por tipo de canal + a política de cada conta, com prévia antes de salvar (§4.1) |
| **Configurações da plataforma** | Interruptor global de quotas, plano padrão, desconto anual padrão, instruções de pagamento, e-mail de avisos |
| **Solicitações** | Os pedidos de plano sob medida (§3.1) |

**O agrupamento por conta é requisito, não estética.** Uma lista plana de
usuários não responde nenhuma pergunta comercial: cobrança, quota e bloqueio
acontecem por **conta**. O usuário é sempre exibido dentro da conta dele.

### 4.1. A retenção de mensagens muda de dono

**Diretriz do mantenedor (2026-08-26):** a política de retenção (SPEC 060) deixa
de ser do **dono da conta** e passa a ser do **proprietário da plataforma**,
assim que o login dele existir.

Hoje a aba "Retenção" aparece em Configurações para quem tem `account_role =
'owner'` — cada cliente define quanto tempo guarda o próprio histórico. Passa a
ser assim:

| Item | Antes | Depois |
| --- | --- | --- |
| Padrão global (por tipo de canal) | Só `.env`, invisível na tela | `.env` **e** editável no console pelo proprietário |
| Política de uma conta específica | O dono da conta configurava | Só o proprietário da plataforma, no console |
| Ver a política | Dono da conta | Só o proprietário |
| Favoritar mensagem (a estrela) | Agente+ | **Não muda** — é ação operacional, não configuração |
| Aviso "mensagens antigas removidas" na thread | Neutro, sem números | **Não muda** |

**Por que faz sentido.** Retenção deixou de ser preferência do cliente e virou
**característica do plano**: quanto o cliente guarda é parte do que ele contrata,
como contatos e canais. Deixar o dono da conta configurar o próprio limite é o
mesmo que deixá-lo escolher a própria quota. E, do lado do custo, o histórico
ocupa banco do **deployment** — quem paga essa conta é o proprietário da
plataforma, e quem paga a conta decide o teto.

**O que se perde, e é aceito:** o dono da conta perde a visibilidade de que
existe uma política e de quando a última limpeza rodou. A tela do inbox continua
dizendo, de forma neutra e sem números, que mensagens antigas foram removidas —
essa parte da SPEC 060 (§8.3) permanece intacta, e é justamente ela que impede a
thread vazia de parecer bug.

Isso encerra o furo que a SPEC 060 §3.4 deixou reservado ("*reservado: chave do
plano*") pelo lado certo: a política é do operador, e amarrá-la a uma chave de
plano vira uma evolução natural, não uma amarração prematura.

---

## 5. Ciclo de cobrança e desconto anual

### 5.1. Quem cobra é outro sistema — e o que isso significa aqui

**Diretriz do mantenedor (2026-08-26):** a cobrança do ZAP CRM BR é emitida por
**outro sistema**, junto com os demais serviços vendidos ao mesmo cliente.
Gateway de pagamento dentro do CRM continua fora de escopo, e não por falta de
tempo: seria uma segunda cobrança para o mesmo cliente.

Isso **não** dispensa o CRM de conhecer plano e preço. Ele precisa dos dois por
duas razões que nada externo resolve:

1. **Limite por plano** — o motor de quotas (SPEC 059) precisa saber em que
   faixa a conta está para aplicar contatos, usuários e canais;
2. **Plano definido por valor, mensal ou anual** — é o que o cliente vê ao
   escolher, é o que define a data de vencimento e é o que o proprietário
   confere na hora de conciliar com a cobrança que saiu do outro sistema.

O que muda de forma concreta, em relação a um SaaS com gateway próprio:

| Aspecto | Aqui |
| --- | --- |
| Emissão de cobrança | Fora. O CRM nunca gera boleto, Pix ou fatura |
| Confirmação de pagamento | Fora — mas com **porta de entrada pronta** (§5.2) para o sistema externo avisar |
| Preço e ciclo | **Dentro.** Catálogo, valor mensal/anual e desconto vivem no CRM |
| Vencimento | **Dentro**, calculado da data de adesão — sinal para avisar e conciliar |
| Bloqueio por inadimplência | Manual, pelo proprietário (§7) |

### 5.2. O caminho deixado pronto para o futuro

Nada de gateway é implementado agora, mas três pontos de extensão entram já,
porque acrescentá-los depois exigiria migração e retrabalho nas telas:

1. **Referência externa na assinatura** — um campo para guardar o
   identificador da cobrança no outro sistema, e a origem dela
   (`manual` · `external` · `gateway`). É o que permite responder "esta conta
   corresponde a qual fatura lá?" sem planilha paralela.
2. **Rota de renovação idempotente** — o sistema externo de cobrança pode, com
   o segredo de operador que já existe, avisar "esta conta pagou o período" e o
   CRM avança o vencimento sozinho. Serve **hoje** (integração com o sistema de
   cobrança atual) e é exatamente o webhook que um gateway chamaria amanhã.
3. **Status `past_due` já registrado** — a sinalização existe e é o gancho de
   qualquer automação futura de cobrança.

O que **não** entra: pró-rata, retentativa de cobrança, tokenização de cartão,
recibo ao cliente. São consequências de ter o pagamento dentro do sistema, e ele
não está.

| Regra | Valor |
| --- | --- |
| Ciclos oferecidos | **Mensal** e **anual** (o `billing_period` de `plans` já prevê `custom` e `none`; ambos continuam existindo e simplesmente não são ofertados no modal) |
| Preço anual | Derivado: `preço mensal × 12 − desconto` |
| Desconto padrão da plataforma | Definido pelo proprietário em Configurações da plataforma. Recomendação inicial: **17%** (≈ "2 meses grátis", a âncora que o mercado reconhece) |
| Desconto por plano | Sobrepõe o padrão quando preenchido — permite promover um plano específico sem mexer nos outros |
| Data de vencimento | Calculada a partir da **data de adesão**, não do primeiro dia do mês |
| Troca de plano no meio do período | Reinicia o período a partir da troca. **Sem cálculo pró-rata** (§9) |

**Por que sem pró-rata.** Pró-rata exige saber o que foi efetivamente pago, e
não há gateway. Calcular crédito sobre um pagamento que o sistema não viu
produz um número que ninguém consegue conferir. A regra "o período recomeça na
adesão" é a única honesta com a informação disponível — e precisa estar escrita
no modal, não só aqui.

---

## 6. Vencimento — o que acontece quando a data chega

Sem gateway, o vencimento é um **sinal**, não uma cobrança. A sequência
recomendada:

| Momento | O que o sistema faz |
| --- | --- |
| 7 e 1 dia(s) antes | Avisa o **proprietário** (§8). O cliente vê a data no painel "Plano e uso" |
| No vencimento | `status` → `past_due`; avisa o proprietário; **nada é bloqueado** |
| Após a carência (padrão 7 dias) | Avisa de novo, marcando "carência encerrada". **Continua sem bloquear** |
| Bloqueio | **Sempre manual**, pelo console (§7) |

**Por que não bloquear sozinho.** A cobrança é emitida e conciliada em outro
sistema (§5.1), então o CRM **não sabe** se a conta pagou — ele só sabe que a
data passou. Bloquear com base nisso desligaria o atendimento de um cliente que
já pagou, e o custo disso (conversas de clientes finais sem resposta) é muito
maior que o de um mês a mais em aberto. Automatizar o bloqueio só passa a fazer
sentido quando o sistema externo estiver confirmando pagamento pela porta da
§5.2 — aí o CRM sabe, e a decisão muda.

Planos com `billing_period = 'none'` ou preço zero (o `unlimited` semeado pela
migração 067, o plano Grátis) **não vencem** — não têm data e não geram aviso.

---

## 7. Bloqueio: dois switches, dois significados

| Switch | Alcance | Quando usar |
| --- | --- | --- |
| **Bloquear conta** | Toda a conta: nenhum membro entra, os motores param de enviar por ela | Inadimplência confirmada, uso abusivo, encerramento negociado |
| **Bloquear usuário** | Uma pessoa dentro de uma conta | Desligamento sem que o dono da conta tenha removido o acesso; suspeita de uso indevido de uma credencial |

Regras de produto que a SPEC precisa garantir:

1. **Bloqueio é reversível e não apaga nada.** Destravar o switch restaura o
   acesso exatamente como estava.
2. **A pessoa bloqueada vê uma explicação**, não um app quebrado: uma tela com
   o motivo (quando preenchido) e o contato de suporte. Um cliente que vê listas
   vazias abre chamado dizendo "sumiram meus contatos".
3. **A ingestão de mensagens continua** numa conta bloqueada. Bloquear o acesso
   das pessoas é decisão comercial; perder a mensagem do cliente final dela é
   dano a terceiro (mesmo princípio de D-5 do PRD 058).
4. **O proprietário não pode bloquear a si mesmo** nem à própria conta pelo
   console — é o caminho mais curto para se trancar do lado de fora.
5. Bloquear ≠ `status = 'suspended'` do plano. `suspended` é **sinalização
   comercial**; o bloqueio é **efeito real**. Manter os dois separados é o que
   permite marcar "em atraso" sem desligar ninguém.

---

## 8. Avisos: tudo que é plano vira e-mail e webhook

Hoje só existe um aviso (`PLAN_REQUEST_WEBHOOK_URL`, disparado na solicitação
de plano) e nenhum e-mail. Passam a existir **os dois canais para todos os
eventos de plano e conta**, com o mesmo conteúdo:

| Evento | Por quê o proprietário precisa saber |
| --- | --- |
| Conta criada | É o funil de entrada |
| Plano trocado (autosserviço) | Alguém acabou de comprar — é a hora de emitir a cobrança |
| Plano solicitado (sob medida) | Precisa de resposta humana |
| Plano cancelado / cancelamento revertido | Churn, e a chance de reverter |
| Plano renovado | Confirmação do sistema externo de cobrança (§5.2) chegou e o período avançou |
| Vencimento em 7 dias / 1 dia | Janela para cobrar antes de vencer |
| Vencido / carência encerrada | Decisão de bloquear |
| Conta ou usuário bloqueado/desbloqueado | Registro de ação administrativa |
| Quota estourada | Sinal de upgrade — a conta bateu no teto |

O e-mail sai por **SMTP configurado em variáveis de ambiente** (o pedido
explícito do mantenedor) e vai para o endereço de avisos da plataforma. O
webhook continua na variável atual, agora recebendo **todos** os eventos, com
o payload da solicitação preservado para não quebrar workflows n8n existentes.

**Sem SMTP configurado, nada quebra** — o evento continua indo para o webhook e
o console continua mostrando tudo. Aviso é acessório; a operação não pode
depender dele (SPEC 063 §1).

Nesta entrega os avisos vão **para o proprietário**. E-mail transacional para o
cliente final (recibo, aviso de vencimento na caixa dele) é o passo seguinte
natural, e fica registrado na §9.

---

## 9. Fora de escopo (e por quê)

| Item | Por quê não agora |
| --- | --- |
| Gateway de pagamento | A cobrança é emitida por outro sistema, junto dos demais serviços do cliente (§5.1). Os três pontos de extensão da §5.2 entram agora; o gateway em si, não |
| Emissão de fatura/boleto/Pix | Mesma razão. O CRM registra plano e vencimento, não cobra |
| Pró-rata na troca de plano | Depende de saber o que foi pago (§5) |
| E-mail para o cliente final | Exige templates por locale, remetente verificado por domínio e opt-out. A infra da SPEC 063 já nasce pronta para isso |
| Autoexclusão da conta pelo cliente | Operação sem desfazer, envolvendo dados de terceiros (§3.3) |
| Múltiplos operadores de plataforma com papéis | Um proprietário resolve o problema real. Convidar operadores multiplica a superfície de escalonamento de privilégio (SPEC 062 §2) |
| Impersonação ("entrar como o cliente") | Ferramenta de suporte poderosíssima e perigosíssima; merece SPEC própria, com trilha de auditoria obrigatória |
| Relatórios de receita (MRR/ARR/churn) | Só faz sentido com pagamento confirmado no sistema |

---

## 10. Critérios de aceite

1. Um login que **não** é o do proprietário da plataforma recebe 404/403 em
   `/admin` e em toda rota `/api/platform/**` — verificado com sessão real, não
   só pela ausência do link.
2. O proprietário vê todas as contas, cada uma com seus usuários agrupados, e
   consegue chegar de qualquer conta ao seu plano em no máximo dois cliques.
3. Trocar plano, conceder exceção de limite e alterar status pelo console
   produzem exatamente as mesmas linhas em `account_plan_events` que a API
   `/api/admin/**` produz hoje.
4. Bloquear uma conta: nenhum membro dela consegue ler dado nenhum (conferido
   **por SQL**, não só pela tela), todos veem a tela de bloqueio, e as mensagens
   recebidas continuam sendo gravadas.
5. Bloquear um usuário: só ele perde acesso; os colegas seguem trabalhando.
6. Um dono de conta troca de plano pelo modal e a troca vale **na mesma
   requisição** — plano novo, ciclo escolhido, vencimento calculado a partir de
   hoje e evento gravado.
7. Cancelar o plano mantém o acesso até o vencimento, mostra "Retomar plano" e,
   passada a data, rebaixa para o plano padrão sem apagar nada.
8. Cada evento da §8 chega **nos dois canais** (SMTP e webhook) uma única vez —
   sem duplicata quando o cron roda de novo.
9. Sem SMTP no `.env`, a operação inteira funciona e o console diz que o e-mail
   está desligado.
10. A aba "Retenção" **desaparece** de Configurações para o dono da conta, que
    passa a receber `403` nas rotas de retenção e `0` linhas na política via SQL
    com a sessão dele; o proprietário configura padrão global e política por
    conta no console, com prévia antes de salvar.
11. Favoritar mensagem e o aviso de thread esvaziada continuam funcionando
    exatamente como antes para agente e admin.
12. O sistema externo de cobrança consegue renovar o período de uma conta pela
    rota de renovação, e chamá-la duas vezes com o mesmo pagamento não avança o
    vencimento duas vezes.
13. `npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build` verde.

---

## 11. Decisões

**Todas ratificadas pelo mantenedor em 2026-08-26** — D-1 a D-5 na primeira
resposta, D-6 a D-14 na segunda. **Não há decisão de desenho em aberto**: o que
resta antes da F1 é operacional, não de produto (autorizar a migração projeto por
projeto — `vn`, `rs`, `jh` — pela regra do `AGENTS.md`).

A tabela fica como registro do **porquê** de cada escolha: daqui a seis meses,
"por que a troca de plano não pede aprovação?" tem resposta escrita, e mudá-la
passa a ser uma decisão consciente em vez de um ajuste de rotina.

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| **D-1** ✅ | Como o proprietário da plataforma é identificado | **Lista de e-mails no `.env`** (`PLATFORM_OWNER_EMAILS`), sem tabela | Nenhum caminho de escrita no banco cria um super-admin. Promover alguém exige acesso ao servidor — o mesmo nível de confiança do `PLATFORM_ADMIN_SECRET` atual. Tabela de operadores fica para quando houver time |
| **D-2** ✅ | O `x-admin-secret` some quando o console existir? | **Fica** | É a porta de automação (n8n, scripts) — e agora também a porta do sistema externo de cobrança (§5.2). O console é uma segunda porta para a mesma lógica |
| **D-3** ✅ | Troca de plano sem aprovação vale para qualquer plano? | **Só para `is_public AND is_active`** | O "Sob medida" tem preço negociado; deixá-lo no autosserviço é vender por um número que ninguém combinou |
| **D-4** ✅ | Cancelamento tem efeito imediato ou no fim do período? | **Fim do período** | O cliente pagou pelo mês. Imediato transforma "cancelei" em "perdi o que paguei" e gera reclamação garantida |
| **D-5** ✅ | Desconto anual: percentual ou preço anual digitado? | **Percentual** (global, com sobreposição por plano) | Um número por plano em vez de dois, e a promoção sazonal vira uma edição só. O preço exibido continua sendo mostrado em reais, calculado |
| **D-6** ✅ | Desconto anual padrão inicial | **17%** | Equivale à âncora "2 meses grátis". Ajustável na tela a qualquer momento |
| **D-7** ✅ | Vencimento bloqueia automaticamente? | **Não** — só sinaliza e avisa | §6. Revisitar quando houver confirmação de pagamento no sistema |
| **D-8** ✅ | Carência após o vencimento | **7 dias** | Cobre o fim de semana + a demora normal de um Pix conciliado à mão |
| **D-9** ✅ | Bloqueio de conta interrompe a ingestão de mensagens? | **Não** | Dano a terceiro (o cliente final da conta). Coerente com D-5 do PRD 058 |
| **D-10** ✅ | Aviso de quota estourada tem limite de frequência? | **Um por conta, por métrica, por dia** | Uma importação de 5.000 linhas numa conta cheia geraria milhares de avisos idênticos |
| **D-11** ✅ | E-mail do sistema usa SMTP próprio ou o do Supabase Auth? | **SMTP próprio** | O do Supabase é para autenticação (confirmação, recuperação) e tem limites baixos; misturar os dois faz um aviso comercial competir com o e-mail que deixa alguém entrar no sistema |
| **D-12** ✅ | O dono da conta perde a política de retenção **e** a visão dela? | **Perde as duas** | Uma tela só de leitura convida ao chamado "mude isso para mim" e não resolve nada. O aviso neutro na thread (SPEC 060 §8.3) é o que o cliente precisa saber |
| **D-13** ✅ | Padrão global de retenção migra do `.env` para a tela? | **Os dois**: `.env` continua valendo como base, a tela sobrepõe | O `.env` garante que um fork nasce com padrão sem depender de banco; a tela evita redeploy para mudar um número. O **interruptor** (`MESSAGE_RETENTION_ENABLED`) fica só no `.env` — ligar limpeza por clique é o tipo de acidente que não tem desfazer |
| **D-14** ✅ | A renovação vinda do sistema externo usa qual credencial? | **`x-admin-secret`** (`PLATFORM_ADMIN_SECRET`) | Já existe, já é de servidor para servidor, já tem comparação de tempo constante. Um segredo novo por integração é mais uma coisa para vazar |
