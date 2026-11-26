# Guia de consumo do webhook do Repetidor da Meta (ZAP CRM BR)

Guia para quem desenvolve um **sistema externo** (n8n, BI, outro helpdesk, um serviço próprio) que vai receber, na URL cadastrada no ZAP CRM BR, o webhook original que a Meta envia para os números oficiais da conta.

| Campo              | Valor                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Público            | Desenvolvedores de sistemas que **recebem** o webhook repetido                                                                   |
| Recurso            | Repetidor do webhook da Meta (SPEC 088)                                                                                          |
| Contrato resumido  | `docs/public-api.md`, seção "Meta webhook relay (raw WhatsApp events)"                                                           |
| Validado em        | Produção em 2026-11-25: entregas reais de `messages` e `statuses` recebidas e a assinatura do "Testar conexão" recalculada à mão |
| Exemplos de código | Node, Python, Go e PowerShell, executados contra o vetor de teste da [seção 11](#11-vetor-de-teste)                              |

**Em resumo, o seu receptor deve:** (1) verificar a assinatura sobre os bytes crus; (2) gravar o corpo numa fila **durável**; (3) responder `2xx` em bem menos de 5 segundos; (4) processar a partir da fila, deduplicando. O ZAP CRM **não reenvia**: o que você confirmou com `2xx` e não guardou se perde.

---

## 1. O que é e quando usar

A Meta aceita **uma única URL de webhook por número**. O ZAP CRM BR ocupa essa URL e processa tudo (caixa de entrada, automações, status). O **Repetidor** permite que, sem trocar a URL na Meta, o mesmo JSON seja **repassado a um segundo sistema**.

Use o repetidor quando o seu sistema precisa do **JSON original da Meta**: `pricing`, `errors` completos, `context`, `referral`, cartões de contato e qualquer campo que o ZAP CRM não modela.

| Se você precisa de…                                                                       | Use                                                                       |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| O JSON **cru** da Meta, dos números oficiais da conta                                     | **Repetidor da Meta** (este guia)                                         |
| Eventos do ZAP CRM (`message.received`, `message.status_updated`, `conversation.created`) | Webhooks de saída da API pública (`/api/v1`, ver `docs/public-api.md`)    |
| **Enviar** mensagens ou consultar dados                                                   | API pública `/api/v1` (o repetidor é só de leitura e não aceita comandos) |

O repetidor cobre **só números do WhatsApp Cloud API**. O canal por QR Code (Evolution) não é repassado.

## 2. Visão geral do fluxo

```text
WhatsApp ──▶ Meta ──POST──▶ ZAP CRM BR ──▶ processa normalmente (inbox, automações, status)
                                │
                                └──(repetidor, em paralelo)──POST assinado──▶ SEU SISTEMA
```

- A resposta do seu sistema **não** interfere no processamento do ZAP CRM nem na Meta (o ZAP CRM já respondeu 200 à Meta antes de repassar). Ela só conta para o desligamento automático do repetidor ([seção 8](#8-resposta-tempo-falhas-e-volume)).
- O seu sistema **não** se cadastra na Meta, **não** recebe o desafio de verificação (`hub.challenge`) e **não** responde nada para a Meta. Isso continua no ZAP CRM.
- A autenticação é a **assinatura do ZAP CRM** (`X-Wacrm-Signature`). A assinatura da Meta (`X-Hub-Signature-256`) **não** é repassada.

## 3. Como ligar (quem administra o ZAP CRM)

Pelo painel, em **Configurações → Chaves de API → "Repetidor do webhook da Meta"** (papel **admin** ou superior). Não existe endpoint de API para isso. Há **uma URL por conta**: os eventos de todos os números oficiais da conta vão para ela. Para alimentar vários sistemas, o seu receptor é quem reenvia.

1. Informe a **URL de destino**: `https://`, endereço público. Endereços internos, `localhost`, redes privadas e URL com usuário e senha são recusados.
2. Salve. O painel mostra a **chave de assinatura uma única vez** (prefixo `whrelay_`). Copie e guarde-a em um cofre de segredos; depois ela não aparece mais.
3. Clique em **Testar conexão**: o seu sistema recebe um payload de exemplo (ver [seção 8](#8-resposta-tempo-falhas-e-volume)). Funciona com o repetidor desligado.
4. **Ligue o "Ativo" e clique em Salvar.** Uma configuração nova nasce **desligada**: sem esse passo nada é repassado.
5. Mande uma mensagem real para o número e confira a chegada no seu sistema.

Outras ações do painel:

- **Gerar nova chave:** a chave anterior **deixa de assinar na hora**. Sem um procedimento, as entregas falham com 401 e o repetidor pode se desligar: veja a [seção 8.1](#81-operação-troca-de-chave-de-url-e-deploy-do-receptor).
- **Remover:** apaga a URL e a chave. Criar de novo gera uma chave nova.
- **Trocar a URL** com o repetidor ligado zera o contador de falhas. Entregas em andamento ainda vão para a URL antiga.
- **Desligamento automático:** após **15 falhas seguidas** o repetidor se desliga sozinho e o painel mostra quando. Ligar de novo é sempre manual e zera o contador.
- **Testar conexão** exige a configuração salva e **sem alteração pendente**, e tem limite de 6 por minuto por conta.

## 4. A requisição que o seu sistema recebe

`POST <sua url>` com `Content-Type: application/json` e estes cabeçalhos (nomes não diferenciam maiúsculas de minúsculas):

| Cabeçalho             | Valor                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `X-Wacrm-Event`       | Sempre `meta.webhook_raw`                                                                                   |
| `X-Wacrm-Delivery-Id` | UUID **novo a cada entrega** (não serve para deduplicar, ver [seção 9](#9-idempotência-ordem-e-duplicatas)) |
| `X-Wacrm-Signature`   | `t=<segundos Unix>,v1=<hex>`, ver [seção 6](#6-verificação-da-assinatura-obrigatória)                       |
| `X-Wacrm-Test`        | `true`, **somente** no "Testar conexão" do painel                                                           |

- **Não** há `X-Hub-Signature-256` nem outro cabeçalho da Meta.
- O cabeçalho é exatamente `t=<inteiro>,v1=<64 hexadecimais minúsculos>`, sem espaços. O `t` é o instante do **envio pelo ZAP CRM** (segundos Unix), não o da Meta. O carimbo da Meta está em `timestamp`, dentro do corpo.
- **Só `t` e o corpo entram na assinatura.** Os cabeçalhos `X-Wacrm-Event`, `X-Wacrm-Delivery-Id` e `X-Wacrm-Test` **não** são assinados: não tome decisões de segurança só por eles.
- O corpo é sempre UTF-8, nunca vazio, tem **no máximo 4 MiB** e o `Content-Type` é `application/json` sem `charset`.

### Corpo

É o webhook da Meta, sem envelope do ZAP CRM:

- **Caso normal:** o POST inteiro, **byte a byte**, como a Meta enviou.
- **Corpo reduzido:** quando o POST da Meta traz também algo que não é seu (outra conta, um número seu desativado ou fora do ZAP CRM, um evento sem número), você recebe o mesmo objeto com `entry[]` reduzido às entradas que têm `changes` seus, e cada `changes[]` reduzido aos seus. As demais chaves (de topo e de cada `entry`) e o conteúdo de cada `change` ficam iguais, mas o JSON é **regravado**: espaços e escapes podem diferir do original da Meta. A assinatura vale sobre o corpo que você recebe, nos dois casos.

Todo `change` repassado traz `value.metadata.phone_number_id` de um número da sua conta. O ZAP CRM confere a assinatura da Meta e esse número, mas **não valida o resto do conteúdo**: trate tipos e tamanhos como entrada externa (confira que listas são listas e que campos têm o tipo esperado) e ignore o item que não estiver na forma esperada.

## 5. O que chega e o que não chega

**Chega**, quando o repetidor está ligado e o POST traz ao menos um `change` com `value.metadata.phone_number_id` de um número **da sua conta cujo canal não está desativado**:

- `field: "messages"`, com `messages[]` (mensagens recebidas) e/ou `statuses[]` (`sent`, `delivered`, `read`, `failed`);
- outros campos que tragam `metadata.phone_number_id`, como `calls`.

**Não chega:**

- eventos sem número: `message_template_status_update`, `message_template_quality_update`, `account_update` e demais eventos do WABA;
- números que não são da sua conta, cujo canal está desativado ou apagado, ou que não têm canal (por exemplo, o mesmo número em duas configurações);
- números de um App da Meta diferente do padrão **sem o App Secret próprio gravado no canal** (o ZAP CRM só repassa o que o App Secret que validou o POST cobre; esse número também **não entra no inbox** do ZAP CRM, então é um bom indício no diagnóstico);
- qualquer coisa de outra conta;
- qualquer coisa **enquanto a sua conta estiver bloqueada**;
- entregas acima de **50 por segundo por conta** (ver [seção 8](#8-resposta-tempo-falhas-e-volume)).

## 6. Verificação da assinatura (obrigatória)

**Nunca processe o corpo antes de verificar.** Qualquer um que conheça a URL pode fazer POST nela.

Algoritmo:

1. Se o cabeçalho `X-Wacrm-Signature` estiver ausente ou fora do formato `t=<inteiro>,v1=<64 hex>`, responda **401** sem ler o corpo.
2. Leia o corpo como **bytes crus**, antes de qualquer parse de JSON.
3. Rejeite se `t` estiver a mais de **5 minutos** do relógio do seu servidor (proteção contra replay; mantenha o relógio por NTP).
4. Calcule `HMAC-SHA256(chave, "<t>." + corpoCru)` e converta para hexadecimal minúsculo.
5. Compare com `v1` **em tempo constante**. Se diferir, responda **401** e não processe.

Erros comuns:

- usar o corpo **reserializado** (`JSON.stringify(JSON.parse(...))`, `json.dumps`). Espaços e escapes como `\u00e9` e `\/` mudam o hash (a Meta escapa acentos e barras, e as bibliotecas reescrevem). Use os bytes recebidos;
- o framework já ter consumido o corpo com `express.json()` ou equivalente. Na rota do webhook use leitura **crua** (`express.raw`);
- ler o corpo como texto com outra codificação, ou aparar espaços e quebras de linha;
- comparar com `==` em vez de comparação em tempo constante;
- usar a chave errada (cada conta tem a sua) ou a chave antiga depois de **Gerar nova chave**.

### Node.js

```js
const crypto = require('node:crypto');

/**
 * rawBody: Buffer (ou string) EXATAMENTE como recebido, antes de qualquer JSON.parse.
 */
function verifyWacrmSignature(
  header,
  rawBody,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300
) {
  if (typeof header !== 'string') return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  if (!/^\d+$/.test(parts.t || '')) return false;
  const t = Number(parts.t);
  const v1 = (parts.v1 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false; // anti-replay

  const body = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(rawBody, 'utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.`)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

### Python

```python
import hashlib
import hmac
import re
import time


def verify_wacrm_signature(header, raw_body: bytes, secret: str,
                           now=None, tolerance=300) -> bool:
    """raw_body: bytes EXATAMENTE como recebidos (antes de json.loads)."""
    if not isinstance(header, str):
        return False
    parts = {}
    for kv in header.split(","):
        k, _, v = kv.partition("=")
        parts[k.strip()] = v.strip()
    if not re.fullmatch(r"\d+", parts.get("t", "")):
        return False
    t = int(parts["t"])
    v1 = parts.get("v1", "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", v1):
        return False
    now = int(time.time()) if now is None else now
    if abs(now - t) > tolerance:  # anti-replay
        return False
    expected = hmac.new(
        secret.encode("utf-8"), f"{t}.".encode("utf-8") + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, v1)
```

Em Flask, use `request.get_data()` (bytes crus) **antes** de `request.get_json()`. Em FastAPI, use `await request.body()`.

### Go

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	hexRe    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	digitsRe = regexp.MustCompile(`^[0-9]+$`)
)

// rawBody: bytes EXATAMENTE como recebidos (antes de json.Unmarshal).
func VerifyWacrmSignature(header string, rawBody []byte, secret string, now time.Time, tolerance time.Duration) bool {
	parts := map[string]string{}
	for _, kv := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(kv, "=")
		parts[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	if !digitsRe.MatchString(parts["t"]) {
		return false
	}
	t, err := strconv.ParseInt(parts["t"], 10, 64)
	if err != nil {
		return false
	}
	v1 := strings.ToLower(parts["v1"])
	if !hexRe.MatchString(v1) {
		return false
	}
	if math.Abs(float64(now.Unix()-t)) > tolerance.Seconds() { // anti-replay
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(t, 10) + "."))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(v1))
}
```

No `net/http`, leia com `io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))` e só então chame a função.

### PowerShell (para conferir uma entrega à mão)

Salve o corpo cru **exato** em `body.json`, sem quebra de linha no fim (no `webhook.site`, desmarque "Format" antes de copiar). O tamanho em bytes deve ser igual ao `content-length` da entrega.

```powershell
$key  = Read-Host 'chave do repetidor'
$t    = '<valor de t do cabeçalho>'
$body = [IO.File]::ReadAllText("$PWD\body.json")
$h    = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($key))
($h.ComputeHash([Text.Encoding]::UTF8.GetBytes("$t.$body")) | ForEach-Object { $_.ToString('x2') }) -join ''
```

O resultado deve ser igual ao `v1`. Digite a chave quando o PowerShell perguntar; não a coloque no texto do comando.

### n8n e proxies

- **n8n:** o nó _Webhook_ faz o parse do JSON por padrão, e sem o corpo cru a verificação sempre falha. Ligue a opção de corpo cru (_Raw Body_) e calcule o HMAC-SHA256 (hexadecimal) sobre `"<t>."` mais o corpo recebido, por exemplo com o nó _Crypto_, antes de usar o JSON. Confira os nomes exatos das opções na versão do n8n que você usa.
- **Proxies e gateways** na frente do receptor precisam repassar o corpo **sem alterar** e manter os cabeçalhos `X-Wacrm-*`.

## 7. Estrutura do corpo e exemplos reais

Os exemplos abaixo são entregas **reais** (versão atual da API da Meta), com telefones, identificadores e o nome trocados por valores fictícios. O corpo que chega é **compacto**, numa linha só; aqui está formatado para leitura. A ordem das chaves é a da Meta (`value` antes de `field`) e **não deve ser pressuposta**.

Regras para ler o payload:

- Itere sempre as listas: `entry[]`, `entry[].changes[]`, `value.messages[]` e `value.statuses[]`. **Um POST pode trazer várias entradas, mudanças, mensagens e status.**
- Identifique o número por `entry[].changes[].value.metadata.phone_number_id` (e `display_phone_number`). Se a conta tem mais de um número oficial, os eventos de todos chegam na mesma URL.
- `entry[].id` é o WABA (conta do WhatsApp Business) segundo a Meta.
- `timestamp` vem em segundos Unix, instante da Meta: como **string** em `messages` e `statuses`; em outros campos (como `calls`) pode vir como **número**. Aceite os dois.
- Seja tolerante a campos novos: a Meta acrescenta campos (por exemplo `user_id`, `from_user_id`, `recipient_user_id` nos payloads atuais). Ignore o que não conhece e não valide o objeto com um esquema fechado.
- Os tipos de mensagem (`text`, `image`, `audio`, `document`, `interactive`, `reaction` e outros) e o formato completo de `errors` seguem a documentação da Meta. A referência de campos está em `docs/references/example_webhook_whatsapp_meta_cloud_api.md`.
- O repetidor **não baixa nem anexa mídia**: chega o que a Meta manda (`id`, `mime_type`, `sha256`, legenda). Baixar o arquivo exige um token da Graph API com acesso ao WABA, que o repetidor não fornece.

### Mensagem de texto recebida

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "16505551111",
              "phone_number_id": "123456123"
            },
            "contacts": [
              {
                "profile": { "name": "test user name" },
                "wa_id": "16315551181",
                "user_id": "US.13491208655302741918"
              }
            ],
            "messages": [
              {
                "from": "16315551181",
                "from_user_id": "US.13491208655302741918",
                "id": "wamid.HBgLMTYzMTU1NTExODEVAgASGBYzRUIwMTYxMDY5QzQ0MjExNTQyMEE3AA==",
                "timestamp": "1795576203",
                "text": { "body": "test return 3" },
                "type": "text"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

### Status de entrega (`read`, com `pricing`)

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "16505551111",
              "phone_number_id": "123456123"
            },
            "contacts": [
              {
                "wa_id": "16315551181",
                "user_id": "US.13491208655302741918"
              }
            ],
            "statuses": [
              {
                "id": "wamid.HBgLMTYzMTU1NTExODEVAgARGBI0Njg2Q0U1NjkzQjQ5QTM4MTEA",
                "status": "read",
                "timestamp": "1795576195",
                "recipient_id": "16315551181",
                "recipient_user_id": "US.13491208655302741918",
                "pricing": {
                  "billable": false,
                  "pricing_model": "PMP",
                  "category": "service",
                  "type": "free_customer_service",
                  "subtype": "free_tier"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

O status `failed` traz `errors[]` (por exemplo o código `131042`, problema de pagamento do WABA). Consulte a documentação da Meta para o formato completo.

## 8. Resposta, tempo, falhas e volume

**O que o seu endpoint deve fazer:**

1. Verificar a assinatura (seção 6).
2. Gravar o corpo cru numa **fila ou tabela durável** (Redis Streams, SQS, RabbitMQ, uma tabela com índice único) **e só então** responder **qualquer `2xx`** (o corpo da resposta é ignorado). Isso precisa caber bem abaixo de 5 s.
3. Processar a partir da fila, em outro worker, com `try/catch` por item.

O ZAP CRM **não reenvia**: o que o seu sistema confirmou com `2xx` e guardou só em memória se perde se o processo reiniciar (deploy, falha, falta de memória, autoescala). Em plataformas serverless, não conte com código que roda depois da resposta (use o mecanismo da plataforma, como `waitUntil`, ou grave antes de responder). Se não conseguir gravar, responda `5xx`: é melhor registrar a falha do que confirmar o que não foi guardado.

**Regras de entrega do ZAP CRM:**

| Regra                 | Comportamento                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tentativas            | **Uma por POST da Meta**. Não há fila nem retentativa                                                                                                                                                                    |
| Tempo limite          | **5 segundos**, contados desde o início da conexão (TLS incluído) até a resposta chegar. Estourou, é falha                                                                                                               |
| Redirecionamentos     | **Não são seguidos**. Um `3xx` conta como falha. Cadastre a URL final                                                                                                                                                    |
| Falha                 | Qualquer resposta que não seja `2xx`, tempo esgotado ou erro de rede                                                                                                                                                     |
| Contador              | Sucesso zera. **15 falhas seguidas** desligam o repetidor                                                                                                                                                                |
| Se o seu sistema cair | Os eventos desse período **se perdem**. Não há reenvio                                                                                                                                                                   |
| Volume                | Até **50 entregas por segundo por conta**, contadas por processo do ZAP CRM (em rajadas pode passar disso; não use como limite de dimensionamento). O excedente é **descartado**, não é reenviado e não conta como falha |

**Disparo em massa.** Uma campanha para milhares de contatos gera dezenas de milhares de POSTs de `statuses` (`sent`, `delivered`, `read`). Dimensione o receptor para isso: grave rápido, processe depois e escale. Um receptor lento ou fora do ar pode somar 15 falhas em segundos e desligar o repetidor, e com um receptor lento as conexões simultâneas se acumulam. Acima do teto, os eventos excedentes **não chegam ao seu sistema**: se você precisa de todos os status de um disparo, reconcilie pela API `/api/v1`.

**TLS.** O certificado precisa ser de uma CA pública com a **cadeia intermediária completa**: o cliente do ZAP CRM não busca intermediários, e "abre no navegador" não prova nada. Não há certificado de cliente (mTLS).

**"Testar conexão".** Envia um webhook de texto de exemplo, assinado como uma entrega real, com `X-Wacrm-Test: true`, `phone_number_id` `"0"` e `wamid.TEST`. Como os cabeçalhos `X-Wacrm-*` não entram na assinatura, reconheça o teste também pelo corpo (`phone_number_id` `"0"` e `messages[].id` `wamid.TEST`). Ele não deve ter efeito de negócio.

### 8.1 Operação: troca de chave, de URL e deploy do receptor

- **Gerar nova chave.** A anterior deixa de assinar na hora, e a nova só vale no receptor depois que você a instalar. Até lá toda entrega falha com 401, e com tráfego **15 falhas seguidas** desligam o repetidor em segundos. Entregas que já estavam em andamento ainda chegam assinadas com a chave **antiga** por alguns segundos. Procedimento: gere a chave em horário de pouco movimento; instale-a no receptor **aceitando a antiga e a nova por alguns minutos**; depois confira no painel se o repetidor segue ligado e, se tiver desligado, ligue de novo.
- **Trocar a URL.** Zera o contador de falhas, e as entregas em andamento ainda vão para a URL antiga. Mantenha a URL antiga no ar por alguns segundos.
- **Deploy ou queda do receptor.** Os eventos do período se perdem (não há reenvio). Faça o deploy sem derrubar o endpoint (atualização gradual) e, se precisar reconciliar, use a API `/api/v1`.
- **Monitoramento.** Acompanhe o receptor e o estado do repetidor: ele só volta a ligar manualmente.

## 9. Idempotência, ordem e duplicatas

- **A Meta reenvia** o webhook quando não recebe 200 do ZAP CRM, e cada reenvio vira uma nova entrega para o seu sistema. O mesmo evento pode chegar mais de uma vez. **Deduplique.**
- Chaves de deduplicação, **sempre com o número**, porque o id da Meta não é único entre números:
  - mensagem: `metadata.phone_number_id` + `messages[].id`;
  - status: `metadata.phone_number_id` + `statuses[].id` + `statuses[].status` (a mesma mensagem passa por `sent`, `delivered` e `read`).
- Faça a deduplicação de forma **atômica** (índice único, `INSERT … ON CONFLICT DO NOTHING`, `SET NX` no Redis): duplicatas podem chegar ao mesmo tempo.
- **Não use `X-Wacrm-Delivery-Id`** para deduplicar: ele muda a cada entrega, inclusive nos reenvios da Meta.
- Guarde as chaves por **pelo menos 7 dias** (ou numa tabela com índice único, sem expiração): se o ZAP CRM ficar fora do ar, a Meta pode reenviar ao longo de vários dias (a documentação dela fala em até 7).
- **Não há garantia de ordem.** As entregas saem em paralelo. Um `read` pode chegar antes de um `delivered`, e um status antes da mensagem correspondente. Não confie só no `timestamp` (resolução de segundos, com empates comuns). Para status, use uma escada, que é a regra do próprio ZAP CRM: `sent` < `delivered` < `read`, e só avance. Aceite `failed` apenas se a mensagem ainda não chegou a `delivered` ou `read`. Ignore status que você não conhece em vez de falhar.

## 10. Receptor de referência (Node.js + Express)

Usa a função `verifyWacrmSignature` da seção 6. O ponto crítico é `express.raw`: com `express.json()` o corpo cru se perde. A rota **grava e só então responde**; o processamento fica num worker.

```js
const express = require('express');
const { verifyWacrmSignature } = require('./verify');

const app = express();

// enqueue(buffer): grave o corpo cru numa fila ou tabela DURÁVEL
// (Redis Streams, SQS, RabbitMQ, banco). Só retorne depois de gravar.

app.post(
  '/webhooks/zapcrm-meta',
  express.raw({ type: '*/*', limit: '4mb' }), // req.body é um Buffer
  async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.sendStatus(400); // sem corpo

    // 1) autenticar
    const ok = verifyWacrmSignature(
      req.get('x-wacrm-signature'),
      req.body,
      process.env.WACRM_RELAY_SECRET // a chave whrelay_… (cofre de segredos)
    );
    if (!ok) return res.sendStatus(401);

    // 2) o teste do painel não tem efeito de negócio
    if (req.get('x-wacrm-test') === 'true') return res.sendStatus(200);

    // 3) gravar de forma durável e SÓ ENTÃO responder
    try {
      await enqueue(req.body);
    } catch (err) {
      return res.sendStatus(503); // não confirme o que não foi guardado
    }
    res.sendStatus(200);
  }
);

// Worker: tira da fila, trata cada item isoladamente e deduplica.
async function processJob(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return; // não é JSON: descarte e registre
  }
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (typeof phoneNumberId !== 'string') continue;

      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        if (typeof m?.id !== 'string') continue;
        // INSERT ... ON CONFLICT DO NOTHING em (phoneNumberId, m.id);
        // se já existia, pule; senão, processe
      }
      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        if (typeof s?.id !== 'string' || typeof s?.status !== 'string')
          continue;
        // idem em (phoneNumberId, s.id, s.status)
      }
    }
  }
}

app.listen(3000);
```

## 11. Vetor de teste

Use para testar a sua implementação da verificação **sem** depender do ZAP CRM. A chave abaixo é de exemplo, **não** é de nenhuma conta real.

- **Chave:** `whrelay_chave_de_exemplo_nao_usar`
- **`t`:** `1795574574`
- **Corpo cru** (622 bytes, uma linha, sem quebra de linha no fim):

```text
{"object":"whatsapp_business_account","entry":[{"id":"102290129340398","changes":[{"value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"16505551111","phone_number_id":"123456123"},"contacts":[{"wa_id":"16315551181","user_id":"US.13491208655302741918"}],"statuses":[{"id":"wamid.HBgLMTYzMTU1NTExODEVAgARGBI0Njg2Q0U1NjkzQjQ5QTM4MTEA","status":"read","timestamp":"1795576195","recipient_id":"16315551181","recipient_user_id":"US.13491208655302741918","pricing":{"billable":false,"pricing_model":"PMP","category":"service","type":"free_customer_service","subtype":"free_tier"}}]},"field":"messages"}]}]}
```

- **Cabeçalho esperado:**

```text
X-Wacrm-Signature: t=1795574574,v1=d6c1e362966d31ef3c44b652768837bc8e04a9b96ce72ba36dba11621c1a1f2e
```

O vetor é sintético: o `t` é de 25/11/2026 (UTC), por isso **fixe o "agora" em `1795574574`** ao testar (ou desligue a checagem de tolerância só no teste). Casos que a sua implementação precisa tratar:

| Caso                                             | Resultado esperado |
| ------------------------------------------------ | ------------------ |
| Corpo, `t`, chave e cabeçalho do vetor           | válido             |
| Um byte a mais no corpo (por exemplo, um espaço) | inválido           |
| Chave diferente                                  | inválido           |
| "Agora" 301 segundos depois de `t`               | inválido           |
| "Agora" 299 segundos depois de `t`               | válido             |
| Cabeçalho ausente, sem `v1` ou com `v1` truncado | inválido           |

## 12. Segurança e privacidade

**Fatos do sistema:**

- O payload carrega **telefone, nome e texto das mensagens dos contatos**. Apagar um contato ou uma conversa no ZAP CRM **não apaga** a cópia no seu sistema.
- O ZAP CRM confere a assinatura da Meta e o número, mas **não valida o conteúdo** do corpo. Os cabeçalhos `X-Wacrm-*` **não são assinados** (seções 4 e 8).
- O ZAP CRM recusa destinos que não sejam `https://` ou que não resolvam para um endereço público, e não publica faixa de IP de saída: não use IP como autenticação.
- A URL inteira do receptor aparece no painel para todo admin da conta (os logs do ZAP CRM guardam só o host).

**Boas práticas (recomendações, não fatos do sistema):**

- **LGPD:** a empresa dona da conta continua responsável por esses dados. Se o receptor é operado por terceiro (n8n em nuvem, BI SaaS), formalize-o como operador e confira onde os dados ficam hospedados (transferência internacional). Valide com o encarregado (DPO).
- Defina **retenção e exclusão** no receptor, e atenda pedidos de exclusão do titular. Guarde só os campos de que precisa: não arquive o corpo inteiro sem necessidade.
- Guarde a chave em um **cofre de segredos**, nunca no código nem em repositório. Se ela vazar, use **Gerar nova chave** (procedimento na seção 8.1).
- **Não registre o corpo** nem a chave nos logs. Registre só `X-Wacrm-Delivery-Id`, `phone_number_id`, `messages[].id`/`statuses[].id` e o resultado da verificação.
- Verifique a assinatura **antes** de parsear o JSON, rejeite cedo (sem ler o corpo) quando o cabeçalho faltar ou for malformado, limite o corpo a 4 MiB e responda 401 sem detalhes.
- Mantenha o relógio do servidor por NTP (a tolerância é de 5 minutos). A deduplicação neutraliza o replay dentro dessa janela.
- Não dependa de um caminho "secreto" para autenticar: a autenticação é a assinatura.

## 13. Problemas comuns

**Lado do ZAP CRM (quem administra):**

| Sintoma                                        | Causa provável                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nada chega, e o "Testar conexão" funciona      | O "Ativo" está **desligado** (configuração nova nasce desligada), ou o salvamento não foi feito                                                                                                                                                                                                           |
| Nada chega de um número específico             | Canal desativado ou apagado; número de outro App da Meta **sem o App Secret** gravado no canal (ele também não entra no inbox); número em duas configurações ou sem canal; ou o evento não tem `phone_number_id`                                                                                          |
| Parou de chegar sozinho                        | **15 falhas seguidas** desligaram o repetidor. O painel mostra o aviso com a data. Corrija o receptor e ligue de novo                                                                                                                                                                                     |
| O "Testar conexão" falha                       | Resposta que não é `2xx`, redirecionamento (`3xx`), mais de 5 s para responder, erro de TLS (cadeia incompleta), ou o DNS passou a apontar para endereço privado (`not_public`; hosts `.local`, `.internal` e `.localhost` também). URL sem `https`, com credenciais ou não pública nem chega a ser salva |
| Não chega nada enquanto a conta está bloqueada | Esperado: conta bloqueada não repassa                                                                                                                                                                                                                                                                     |
| Faltam eventos durante um disparo grande       | Teto de 50 por segundo por conta, ou o receptor estourou o tempo e o contador chegou a 15                                                                                                                                                                                                                 |

**Lado do receptor (quem desenvolve):**

| Sintoma                                     | Causa provável                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sempre 401 na verificação                   | Corpo reserializado ou já parseado; chave antiga depois de "Gerar nova chave"; relógio com mais de 5 min de erro; proxy que altera o corpo                                              |
| Resposta 500 em vez de 401                  | POST sem corpo ou sem `Content-Type` com `express.raw`: `req.body` não é `Buffer` (fica `undefined` ou `{}`, conforme a versão do Express). Cheque `Buffer.isBuffer` antes de verificar |
| Eventos duplicados                          | Esperado: a Meta reenvia. Deduplique (seção 9)                                                                                                                                          |
| Eventos fora de ordem                       | Esperado: sem garantia de ordem. Use a escada de status (seção 9)                                                                                                                       |
| Eventos de um número que você não reconhece | A conta tem mais de um número oficial. Filtre por `metadata.phone_number_id`                                                                                                            |
| Eventos sumiram após um deploy ou queda     | Esperado: não há reenvio. Grave de forma durável antes de responder (seção 8)                                                                                                           |

## 14. Checklist do receptor

- [ ] Rota `POST` em `https://`, com certificado válido e cadeia intermediária completa.
- [ ] Corpo lido **cru** (sem `json()` automático), limitado a 4 MiB, com checagem de corpo ausente.
- [ ] Cabeçalho ausente ou malformado rejeitado cedo, sem ler o corpo.
- [ ] Assinatura verificada **antes** de qualquer parse, em tempo constante, com tolerância de 5 minutos.
- [ ] Corpo gravado numa fila **durável** antes de responder `2xx` (bem abaixo de 5 s); `5xx` se não conseguiu gravar.
- [ ] Processamento em worker, com `try/catch` por item e leitura defensiva (listas são listas, tipos conferidos).
- [ ] `X-Wacrm-Test: true` (ou corpo com `phone_number_id` `"0"`) tratado como teste, sem efeitos de negócio.
- [ ] Deduplicação atômica por `phone_number_id` + `messages[].id` e por `phone_number_id` + `statuses[].id` + `status`, com prazo de pelo menos 7 dias.
- [ ] Escada de status (`sent` < `delivered` < `read`), sem suposição de ordem; status desconhecido ignorado.
- [ ] Leitura tolerante a campos novos e `timestamp` aceito como texto ou número.
- [ ] Filtro por `metadata.phone_number_id` quando a conta tem mais de um número.
- [ ] Chave no cofre de segredos, sem corpo nem chave nos logs; procedimento de troca de chave (seção 8.1) conhecido.
- [ ] Política de retenção e exclusão dos dados pessoais.
- [ ] Monitoramento do receptor e do estado do repetidor (15 falhas seguidas desligam).
- [ ] Teste com o vetor da seção 11 e com um "Testar conexão" real.

## 15. Fontes

**Para quem implementa o receptor:**

- Contrato resumido: `docs/public-api.md`, seção "Meta webhook relay (raw WhatsApp events)".
- Exemplos do webhook da Meta (versão atual): `docs/references/example_webhook_whatsapp_meta_cloud_api.md`.
- Documentação da Meta: WhatsApp Cloud API, Webhooks (formatos completos de `messages`, `statuses` e `errors`).

**Para os mantenedores do ZAP CRM (fonte de verdade):**

- Especificação: `docs/spec-088-repetidor-do-webhook-da-meta.md`.
- Assinatura: `src/lib/webhooks/sign.ts`. Entrega: `src/lib/webhooks/deliver.ts` e `src/lib/webhooks/meta-relay.ts`.
- Rota do webhook da Meta e limites do POST: `src/app/api/whatsapp/webhook/route.ts`.
