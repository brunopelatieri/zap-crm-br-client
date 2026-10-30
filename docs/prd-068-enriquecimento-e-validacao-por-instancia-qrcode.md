# PRD 068 — Enriquecimento e validação da base pela instância WhatsApp QRCode

> **Status:** proposta, aguardando ratificação do mantenedor.
> **SPEC de implementação:** [`docs/spec-069-checagem-captacao-e-cascata-de-limites.md`](./spec-069-checagem-captacao-e-cascata-de-limites.md)
> **Antecessores diretos:** [PRD 047](./prd-047-canais-e-whatsapp-qrcode.md) (camada de canais e o canal não oficial), [SPEC 059](./spec-059-motor-de-quotas.md) (motor de quotas), [SPEC 062](./spec-062-console-do-proprietario.md) (console do proprietário).

---

## 0. Por que existe um PRD aqui, e não só uma SPEC

O PRD 047 já decidiu o que é o canal não oficial e já assumiu o risco dele: uma sessão de
WhatsApp pareada por QRCode, que **conversa**, e cujo maior perigo é o banimento do número
(§10.3). Se esta feature fosse só "a instância também consegue perguntar se um número existe",
ela seria um parágrafo de SPEC, e este arquivo não deveria existir.

Não é o caso. Duas das sete peças mudam decisão **de produto**, não de engenharia:

1. **Captação de contatos (R5).** Ler a agenda da instância e trazer essas pessoas para dentro
   do CRM significa passar a tratar dados pessoais de gente que **nunca falou com o CRM** e
   nunca soube que ele existe. Isso é decisão de base legal sob LGPD e de posicionamento do
   produto — não uma escolha de schema. Uma decisão dessas escondida dentro de uma seção
   técnica é uma decisão que ninguém aprovou.
2. **Limites viram alavanca comercial (R7).** Hoje o teto de envio frio é do *deployment*: todo
   cliente da mesma VPS compartilha 60/dia. Passar a resolver por conta transforma um número de
   segurança em item de plano ("Pro: 200 envios frios/dia"), com preço, promessa e
   responsabilidade associados. Quem escolhe esses números é o mantenedor, não a SPEC.

O resto (R1–R4, R6) é engenharia sobre direção já aprovada. Este PRD é, portanto,
deliberadamente **curto**: fecha as duas decisões acima, define público e não-escopo, e passa o
bastão. Se a resposta ao §3 for "não captamos contatos", metade deste documento e a fase F7 da
SPEC caem juntas — e tornar isso barato é justamente o serviço que um PRD presta.

---

## 1. O problema

Uma base de contatos importada de planilha tem três defeitos que só aparecem no disparo:

| Defeito                    | O que acontece hoje                                                                                       | Custo                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Número que não é WhatsApp  | Descobrimos **depois** de falhar o envio — erro 131026 da Meta, ou duas falhas seguidas (SPEC 044 §6.4)    | Cada descoberta custa uma tentativa real: na Cloud API isso é **cobrado**; no canal QR é **risco de reputação**   |
| Contato sem nome nem foto  | Fica `5511999999999` na caixa de entrada                                                                   | Atendimento pior; o agente não reconhece quem está falando                                                       |
| Base morta acumulada       | Números inválidos continuam entrando na audiência de toda campanha                                         | A taxa de falha cresce e, no canal QR, taxa de falha alta é sinal de spam para o classificador do WhatsApp        |

A instância QRCode já pareada resolve os três **antes** do disparo: ela pergunta ao WhatsApp se
o número existe, qual o nome de exibição e qual a foto de perfil — sem enviar mensagem nenhuma
para a pessoa.

## 2. Para quem, e quando compensa

- **Cliente com base fria importada** (planilha de evento, CRM antigo, lista de indicação). É o
  caso principal: a checagem economiza envio e protege reputação.
- **Cliente que atende pelo canal QR** e quer a caixa de entrada com foto e nome, como o
  WhatsApp do celular dele já mostra.
- **Não é para** quem já tem base engajada com opt-in explícito: ali a checagem gasta cota de
  segurança para confirmar o que a própria base já prova.

## 3. Decisão de produto A — captação de contatos (R5) 🔴 precisa de ratificação

A Evolution expõe `GET /user/contacts`: a agenda inteira da sessão pareada. O R5 pede que um
cron noturno traga esses contatos para dentro do CRM, 50 por execução.

**O problema.** Essas pessoas estão na agenda de um telefone. Não pediram para estar num CRM,
não deram opt-in de marketing, e boa parte é contato pessoal do dono do número. Colocá-las
direto em `contacts` significa: (a) elas passam a existir em audiências de campanha por padrão;
(b) consomem a quota de contatos do plano, que é enforçada por **trigger** no Postgres (SPEC
059) — e portanto começa a estourar **às 3 da manhã, sem ninguém vendo**; (c) o CRM passa a
tratar dado pessoal de terceiro sem ato afirmativo de ninguém.

**Opções**

|         | O que é                                                                              | A favor                                                                                                       | Contra                                                                                                             |
| ------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **(a)** | Contato pleno direto em `contacts`, com `opt_in_status = 'unknown'`                  | Zero fricção; o cliente vê a base crescer sozinha                                                             | Quota estourando de madrugada; risco LGPD real; a agenda pessoal do dono do número vira audiência de marketing      |
| **(b)** | **Área de triagem** — tabela própria, promoção explícita para `contacts` por um humano | Ato afirmativo com dono, data e usuário registrados; quota consumida com alguém olhando; o dono escolhe quem vira lead | Uma tela a mais; o cliente pode nunca promover ninguém e concluir que "não funcionou"                               |
| **(c)** | Não captar                                                                           | Nada a decidir, nada a manter                                                                                 | Descarta um requisito que o mantenedor pediu                                                                       |

**Recomendação: (b), triagem.** O custo é uma tela; o benefício é que a decisão de tratar aquele
dado passa a ter dono, data e usuário registrados — que é exatamente o que a LGPD pede e o que
uma auditoria vai procurar. E resolve de graça o problema operacional de quota estourando sem
plateia. Contato promovido nasce com `opt_in_status = 'unknown'` (**nunca** `opted_in` — ninguém
consentiu com coisa alguma) e `created_via = 'harvest'`, para que uma audiência possa excluí-lo
por origem sem depender de etiqueta.

**Se a resposta for (a),** a SPEC precisa ganhar três coisas: pré-checagem de quota antes de
cada lote, notificação de sistema quando o lote for recusado (a SPEC 063 já tem o canal), e um
aviso legal explícito na tela do switch. Diga qual das três opções vale e a F7 é reescrita.

## 4. Decisão de produto B — limites viram item de plano (R7) 🔴 precisa de ratificação

Hoje `EVOLUTION_COLD_SEND_PER_DAY=60` vale para todo mundo no mesmo deployment. Duas contas com
números de maturidade completamente diferente — um com dois anos de uso, outro criado ontem —
recebem o mesmo teto, e não há como diferenciar sem editar `.env` e reiniciar a aplicação (o
que afeta todas as contas de uma vez).

O R7 muda a **origem** do valor, não a política: quem não configurar nada continua com
exatamente 60. Mas ele cria a possibilidade comercial de vender o número maior, e isso exige
três respostas do mantenedor.

**B1 — Os limites de segurança entram no catálogo de planos?**
Recomendação: **sim**, como chaves de quota novas (`evolution_cold_send_per_day` e família),
usando o mesmo `plan_limit()` e o mesmo campo `account_plans.limit_overrides` que já existem.
Um mecanismo só, uma UI só, uma cascata só. O detalhamento técnico (e a colisão de semântica
do "vazio") está na SPEC 069, D-5 e D-6.

**B2 — Existe teto duro que nem o proprietário ultrapassa?**
Recomendação: **sim**. Um `perDay` de 5.000 digitado no painel não fura política comercial —
fura o número do cliente e a reputação da VPS inteira, e o cliente vai (com razão) culpar o
produto. O `.env` passa a ter um teto duro por eixo; o resolvedor **clampa** mesmo se o banco
tiver valor maior; a tela recusa o salvamento explicando o teto. É o mesmo papel que
`EVOLUTION_MAX_INSTANCES_TOTAL` já cumpre no eixo de instâncias desde a SPEC 048.

**B3 — Quais são os números comerciais?** Isto é do mantenedor, não da SPEC. A SPEC entrega o
mecanismo preservando os padrões de hoje; a tabela de "quanto cada plano leva" é decisão de
preço. Ponto de partida para ser rasurado:

| Plano                   | `cold_send_per_day` | `check_per_day` | Captação por instância |
| ----------------------- | ------------------- | --------------- | ---------------------- |
| Free / Trial            | 20                  | 100             | desligada              |
| Starter                 | 60 (o padrão atual) | 300             | 200 contatos           |
| Pro                     | 150                 | 1.000           | 1.000 contatos         |
| **Teto duro (`.env`)**  | 250                 | 2.000           | 2.000 contatos         |

## 5. O que esta feature explicitamente **não** faz

- **Não** dá upload, edição ou troca manual de avatar de contato — em nenhum dos dois tipos de
  canal. A foto ou vem da instância, ou não existe e ficam as iniciais, exatamente como hoje
  (R4). Isso é decisão de produto: um avatar editável vira campo de identidade que o CRM não
  tem como validar, e a primeira consequência é alguém colocar a foto errada num contato real.
- **Não** usa a instância oficial (Cloud API) para checar número. A Meta não expõe isso, e
  simular checagem enviando template é justamente o custo que a feature existe para eliminar.
- **Não** transforma a checagem em garantia de entrega. "O número existe no WhatsApp" e "esta
  pessoa pode receber a sua mensagem" são coisas diferentes: bloqueio, opt-out e política da
  Meta continuam valendo depois da checagem, e a UI não pode sugerir o contrário.
- **Não** promete que checagem em massa é rápida. Ela consome cota de segurança de propósito
  (§6); um cliente com 100 mil contatos vai levar semanas — e isso está correto.

## 6. Risco assumido, explicitamente

Consultar o WhatsApp em lote a partir de uma sessão pareada é comportamento de ferramenta, não
de pessoa. O `whatsmeow` executa a consulta como sincronização de agenda; feita em volume e em
rajada, ela é um dos padrões que o antispam do WhatsApp usa para classificar número
descartável. **A checagem não é de graça, e este documento não vai fingir que é.**

Consequências que a SPEC precisa honrar:

1. Checagem tem **cota própria**, com os mesmos três eixos do envio frio (hora, dia, intervalo
   mínimo) e a mesma rampa de aquecimento. Cota própria — e não a mesma do envio — porque uma
   checagem não pode apagar do dia um envio real que o cliente pagou (SPEC 069, D-1).
2. Os dois switches do R1 nascem **desligados**. Ninguém é inscrito nesse risco por atualização
   de versão.
3. A tela mostra o aviso de risco junto do switch, com a mesma franqueza do banner que a aba
   QRCode já tem (`Settings.whatsappQrcode.riskBannerBody`).
4. Captação **não** consome a cota de envio frio — é leitura da agenda local da sessão, não
   tráfego por contato — mas tem teto próprio, senão vira a mesma rajada com outro nome.

## 7. Sucesso

| Métrica                   | Como medir                                                          | Meta                                                                                        |
| ------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Envios economizados       | contatos marcados `invalid` pela checagem ÷ contatos checados        | > 5% numa base fria importada                                                                |
| Nenhum número banido      | instâncias em `error`/desconectadas por bloqueio, antes × depois     | zero regressão                                                                               |
| Compatibilidade do R7     | deployment sem nenhuma configuração nova                             | limites efetivos **idênticos** aos de hoje, provado por teste automatizado (SPEC 069 §11)    |
| Triagem usada             | contatos captados promovidos ÷ captados                              | se ficar perto de zero por três meses, a captação não paga a própria manutenção — desligue   |

## 8. Fora de escopo (registrado para não voltar como surpresa)

- **Checagem pela API pública `/api/v1`.** Nada impede depois, mas expõe um recurso de risco a
  automação de terceiros; fica para quando houver demanda real e um escopo dedicado.
- **Re-checagem periódica automática da base inteira.** A checagem é sob demanda e por lista.
  Um varredor perpétuo é exatamente o padrão de volume que queremos evitar.
- **Enriquecimento por outras fontes** (Serasa, Receita, redes sociais). Outro produto, outro
  PRD, outra conversa jurídica.
- **Avatar de grupo, recado/status e "visto por último".** `POST /user/info` devolve `Status`;
  não vamos exibir, porque é dado sensível de terceiro sem utilidade de CRM.
- **Checagem no momento do cadastro manual de um contato.** Tentador, mas transforma um
  formulário síncrono em algo que depende da Evolution estar de pé — e o custo de errar isso é
  o cadastro de contato parar de funcionar.
