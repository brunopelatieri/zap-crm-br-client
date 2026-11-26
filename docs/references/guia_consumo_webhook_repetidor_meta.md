# Guia de consumo do webhook do Repetidor da Meta (ZAP CRM BR)

Guia para quem desenvolve um **sistema externo** (n8n, BI, outro helpdesk, um serviço próprio) que vai receber, na URL cadastrada no ZAP CRM BR, o webhook original que a Meta envia para os números oficiais da conta.

| Campo              | Valor                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Público            | Desenvolvedores de sistemas que **recebem** o webhook repetido                                                                                                            |
| Recurso            | Repetidor do webhook da Meta (SPEC 088)                                                                                                                                   |
| Fonte de verdade   | Código: `src/lib/webhooks/meta-relay.ts`, `src/lib/webhooks/sign.ts`, `src/lib/webhooks/deliver.ts`. Contrato resumido: `docs/public-api.md` (seção "Meta webhook relay") |
| Validado em        | Produção em 2026-11-25: entregas reais de `messages` e `statuses` recebidas e a assinatura do "Testar conexão" recalculada à mão                                          |
| Exemplos de código | Node, Python, Go e PowerShell, executados contra o vetor de teste da [seção 11](#11-vetor-de-teste)                                                                       |

---

## 1. O que é e quando usar

A Meta aceita **uma única URL de webhook por número**. O ZAP CRM BR ocupa essa URL e processa tudo (caixa de entrada, automações, status). O **Repetidor** permite que, sem trocar a URL na Meta, o mesmo JSON seja **repassado a um segundo sistema**.

Use o repetidor quando o seu sistema precisa do **JSON original da Meta**: `pricing`, `errors` completos, `context`, `referral`, cartões de contato e qualquer campo que o ZAP CRM não modela.

| Se você precisa de…                                        | Use                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| O JSON **cru** da Meta, dos números oficiais da conta      | **Repetidor da Meta** (este guia)                                         |
| Eventos do ZAP CRM (`message.received`, `contact.created`) | Webhooks de saída da API pública (`/api/v1`, ver `docs/public-api.md`)    |
| **Enviar** mensagens ou consultar dados                    | API pública `/api/v1` (o repetidor é só de leitura e não aceita comandos) |

O repetidor cobre **só números do WhatsApp Cloud API**. O canal por QR Code (Evolution) não é repassado.

## 2. Visão geral do fluxo

```text
WhatsApp ──▶ Meta ──POST──▶ ZAP CRM BR ──▶ processa normalmente (inbox, automações, status)
                                │
                                └──(repetidor, em paralelo)──POST assinado──▶ SEU SISTEMA
```

- A resposta do seu sistema **não** interfere no ZAP CRM nem na Meta. O ZAP CRM já respondeu 200 à Meta antes de repassar.
- O seu sistema **não** se cadastra na Meta, **não** recebe o desafio de verificação (`hub.challenge`) e **não** responde nada para a Meta. Isso continua no ZAP CRM.
- A autenticação é a **assinatura do ZAP CRM** (`X-Wacrm-Signature`). A assinatura da Meta (`X-Hub-Signature-256`) **não** é repassada.

## 3. Como ligar (quem administra o ZAP CRM)

Pelo painel, em **Configurações → Chaves de API → "Repetidor do webhook da Meta"** (papel **admin** ou superior). Não existe endpoint de API para isso.

1. Informe a **URL de destino**: `https://`, endereço público. Endereços internos, `localhost`, redes privadas e URL com usuário e senha são recusados.
2. Salve. O painel mostra a **chave de assinatura uma única vez** (prefixo `whrelay_`). Copie e guarde-a em um cofre de segredos; depois ela não aparece mais.
3. Clique em **Testar conexão**: o seu sistema recebe um payload de exemplo (ver [seção 8](#8-resposta-tempo-falhas-e-volume)). Funciona com o repetidor desligado.
4. **Ligue o "Ativo" e clique em Salvar.** Uma configuração nova nasce **desligada**: sem esse passo nada é repassado.
5. Mande uma mensagem real para o número e confira a chegada no seu sistema.

Outras ações do painel:

- **Gerar nova chave:** a chave anterior **deixa de valer na hora**. Combine a troca com quem opera o receptor.
- **Remover:** apaga a URL e a chave.
- **Desligamento automático:** após **15 falhas seguidas** o repetidor se desliga sozinho e o painel mostra quando. Ligar de novo é sempre manual e zera o contador.

## 4. A requisição que o seu sistema recebe

`POST <sua url>` com `Content-Type: application/json` e estes cabeçalhos (nomes não diferenciam maiúsculas de minúsculas):

| Cabeçalho             | Valor                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `X-Wacrm-Event`       | Sempre `meta.webhook_raw`                                                                                   |
| `X-Wacrm-Delivery-Id` | UUID **novo a cada entrega** (não serve para deduplicar, ver [seção 9](#9-idempotência-ordem-e-duplicatas)) |
| `X-Wacrm-Signature`   | `t=<segundos Unix>,v1=<hex>`, ver [seção 6](#6-verificação-da-assinatura-obrigatória)                       |
| `X-Wacrm-Test`        | `true`, **somente** no "Testar conexão" do painel                                                           |

- **Não** há `X-Hub-Signature-256` nem outro cabeçalho da Meta.
- O `t` é o instante do **envio pelo ZAP CRM**, não o da Meta. O carimbo da Meta está em `timestamp`, dentro do corpo.
- O corpo tem **no máximo 4 MiB**.

### Corpo

É o webhook da Meta, sem envelope do ZAP CRM:

- **Caso normal:** o POST inteiro, **byte a byte**, como a Meta enviou.
- **Caso raro** (um POST da Meta que mistura eventos de contas diferentes): o mesmo objeto, com `entry[]` reduzido às entradas da sua conta e cada `changes[]` reduzido aos seus `changes`. O conteúdo de cada `change` não é alterado.

Nos dois casos é um webhook válido da Meta que contém **só dados da sua conta**.

## 5. O que chega e o que não chega

**Chega**, quando o repetidor está ligado e o POST traz ao menos um `change` com `value.metadata.phone_number_id` de um número **ativo** da sua conta:

- `field: "messages"`, com `messages[]` (mensagens recebidas) e/ou `statuses[]` (`sent`, `delivered`, `read`, `failed`);
- outros campos que tragam `metadata.phone_number_id`, como `calls`.

**Não chega:**

- eventos sem número: `message_template_status_update`, `message_template_quality_update`, `account_update` e demais eventos do WABA;
- números que não são da sua conta, ou cujo canal está desativado ou apagado;
- números de um App da Meta diferente do padrão **sem o App Secret próprio gravado no canal** (o ZAP CRM só repassa o que o App Secret que validou o POST cobre);
- qualquer coisa de outra conta;
- qualquer coisa **enquanto a sua conta estiver bloqueada**;
- entregas acima de **50 por segundo por conta** (ver [seção 8](#8-resposta-tempo-falhas-e-volume)).

## 6. Verificação da assinatura (obrigatória)

**Nunca processe o corpo antes de verificar.** Qualquer um que conheça a URL pode fazer POST nela.

Algoritmo:

1. Leia o corpo como **bytes crus**, antes de qualquer parse de JSON.
2. Extraia `t` e `v1` do cabeçalho `X-Wacrm-Signature`.
3. Rejeite se `t` estiver a mais de **5 minutos** do relógio do seu servidor (proteção contra replay).
4. Calcule `HMAC-SHA256(chave, "<t>." + corpoCru)` e converta para hexadecimal minúsculo.
5. Compare com `v1` **em tempo constante**. Se diferir, responda **401** e não processe.

Erros comuns:

- usar o corpo **reserializado** (`JSON.stringify(JSON.parse(...))`, `json.dumps`). Espaços, ordem de chaves e escapes como `é` e `\/` mudam o hash. Use os bytes recebidos;
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
  const t = Number(parts.t);
  const v1 = (parts.v1 || '').toLowerCase();
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
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
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
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

var hexRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// rawBody: bytes EXATAMENTE como recebidos (antes de json.Unmarshal).
func VerifyWacrmSignature(header string, rawBody []byte, secret string, now time.Time, tolerance time.Duration) bool {
	parts := map[string]string{}
	for _, kv := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(kv, "=")
		parts[strings.TrimSpace(k)] = strings.TrimSpace(v)
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

## 7. Estrutura do corpo e exemplos reais

Os exemplos abaixo são entregas **reais** (versão atual da API da Meta), com telefones, identificadores e o nome trocados por valores fictícios. O corpo que chega é **compacto**, numa linha só; aqui está formatado para leitura. A ordem das chaves é a da Meta (`value` antes de `field`) e **não deve ser pressuposta**.

Regras para ler o payload:

- Itere sempre as listas: `entry[]`, `entry[].changes[]`, `value.messages[]` e `value.statuses[]`. **Um POST pode trazer várias entradas, mudanças, mensagens e status.**
- Identifique o número por `entry[].changes[].value.metadata.phone_number_id` (e `display_phone_number`). Se a conta tem mais de um número oficial, os eventos de todos chegam na mesma URL.
- `entry[].id` é o WABA (conta do WhatsApp Business) segundo a Meta.
- `timestamp` é uma **string** com segundos Unix, instante da Meta.
- Seja tolerante a campos novos: a Meta acrescenta campos (por exemplo `user_id`, `from_user_id`, `recipient_user_id` nos payloads atuais). Ignore o que não conhece e não valide o objeto com um esquema fechado.
- Os tipos de mensagem (`text`, `image`, `audio`, `document`, `interactive`, `reaction` e outros) e o formato completo de `errors` seguem a documentação da Meta. A referência de campos está em `docs/references/example_webhook_whatsapp_meta_cloud_api.md`.
- **Mídia chega só como `id`** (sem URL, sem bytes). Baixar exige um token da Graph API que o repetidor não fornece.

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
2. Responder **qualquer `2xx`** (o corpo da resposta é ignorado).
3. Só então processar. Faça o trabalho pesado **depois** de responder, ou entregue o corpo a uma fila.

**Regras de entrega do ZAP CRM:**

| Regra                 | Comportamento                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Tentativas            | **Uma por POST da Meta**. Não há fila nem retentativa                                         |
| Tempo limite          | **5 segundos**. Estourou, é falha                                                             |
| Redirecionamentos     | **Não são seguidos**. Um `3xx` conta como falha. Cadastre a URL final                         |
| Falha                 | Qualquer resposta que não seja `2xx`, tempo esgotado ou erro de rede                          |
| Contador              | Sucesso zera. **15 falhas seguidas** desligam o repetidor                                     |
| Se o seu sistema cair | Os eventos desse período **se perdem**. Não há reenvio                                        |
| Volume                | Até **50 entregas por segundo por conta**; o excedente é **descartado**, não conta como falha |

**Disparo em massa.** Uma campanha para milhares de contatos gera dezenas de milhares de POSTs de `statuses` (`sent`, `delivered`, `read`). Dimensione o receptor para isso: responda rápido, enfileire e escale. Um receptor lento ou fora do ar pode somar 15 falhas em segundos e desligar o repetidor.

**"Testar conexão".** Envia um webhook de texto de exemplo, assinado como uma entrega real, com `X-Wacrm-Test: true`, `phone_number_id` `"0"` e `wamid.TEST`. **Não** processe esse evento como mensagem real: confira o cabeçalho e responda 200.

## 9. Idempotência, ordem e duplicatas

- **A Meta reenvia** o webhook quando não recebe 200, e cada reenvio vira uma nova entrega para o seu sistema. O mesmo evento pode chegar mais de uma vez. **Deduplique.**
- Chaves de deduplicação:
  - mensagem: `messages[].id`;
  - status: `statuses[].id` **mais** `statuses[].status` (a mesma mensagem passa por `sent`, `delivered` e `read`).
- **Não use `X-Wacrm-Delivery-Id`** para deduplicar: ele muda a cada entrega, inclusive nos reenvios da Meta.
- **Não há garantia de ordem.** As entregas saem em paralelo. Um `read` pode chegar antes de um `delivered`, e um status antes da mensagem correspondente. Ordene pelo `timestamp` do próprio evento e trate status como "o maior estado já visto".
- Guarde as chaves de deduplicação por tempo suficiente (Redis com expiração de algumas horas, ou uma tabela com índice único).

## 10. Receptor de referência (Node.js + Express)

Usa a função `verifyWacrmSignature` da seção 6. O ponto crítico é `express.raw`: com `express.json()` o corpo cru se perde.

```js
const express = require('express');
const { verifyWacrmSignature } = require('./verify');

const app = express();

app.post(
  '/webhooks/zapcrm-meta',
  express.raw({ type: '*/*', limit: '4mb' }), // req.body é um Buffer
  (req, res) => {
    // 1) autenticar
    const ok = verifyWacrmSignature(
      req.get('x-wacrm-signature'),
      req.body,
      process.env.WACRM_RELAY_SECRET // a chave whrelay_… (cofre de segredos)
    );
    if (!ok) return res.sendStatus(401);

    // 2) responder logo (o ZAP CRM espera no máximo 5 s)
    res.sendStatus(200);

    // 3) ignorar o teste do painel
    if (req.get('x-wacrm-test') === 'true') return;

    // 4) processar fora do caminho da resposta
    setImmediate(() => {
      const payload = JSON.parse(req.body.toString('utf8'));
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};
          const phoneNumberId = value.metadata?.phone_number_id;
          for (const m of value.messages ?? []) {
            // deduplicar por m.id e enfileirar
          }
          for (const s of value.statuses ?? []) {
            // deduplicar por s.id + s.status e enfileirar
          }
        }
      }
    });
  }
);

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

Como `t` é de 2026-11-24, **fixe o "agora" em `1795574574`** ao testar (ou desligue a checagem de tolerância só no teste). Casos que a sua implementação precisa tratar:

| Caso                                             | Resultado esperado |
| ------------------------------------------------ | ------------------ |
| Corpo, `t`, chave e cabeçalho do vetor           | válido             |
| Um byte a mais no corpo (por exemplo, um espaço) | inválido           |
| Chave diferente                                  | inválido           |
| "Agora" 301 segundos depois de `t`               | inválido           |
| "Agora" 299 segundos depois de `t`               | válido             |
| Cabeçalho ausente, sem `v1` ou com `v1` truncado | inválido           |

## 12. Segurança e privacidade

- O payload carrega **telefone, nome e texto das mensagens dos contatos**. O seu sistema passa a ser controlador desses dados: aplique a política de privacidade e a LGPD correspondentes.
- Use **HTTPS** com certificado válido. O ZAP CRM recusa destinos que não sejam `https://` ou que não resolvam para um endereço público.
- Guarde a chave em um **cofre de segredos**, nunca no código nem em repositório. Se ela vazar, use **Gerar nova chave** no painel.
- **Não registre o corpo** nem a chave nos logs. Registre só `X-Wacrm-Delivery-Id`, `phone_number_id`, `messages[].id`/`statuses[].id` e o resultado da verificação.
- Verifique a assinatura **antes** de parsear o JSON, limite o corpo a 4 MiB e responda 401 sem detalhes.
- Não confie na origem por IP: a autenticação é a assinatura.
- Mantenha a URL do receptor **sem segredo no caminho** (a segurança vem da chave de assinatura, não de uma URL "secreta").

## 13. Problemas comuns

| Sintoma                                            | Causa provável                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nada chega, e o "Testar conexão" funciona          | O "Ativo" está **desligado** (configuração nova nasce desligada), ou o salvamento não foi feito                                                     |
| Nada chega de um número específico                 | Número desativado ou apagado; número de outro App da Meta **sem o App Secret** gravado no canal; ou o evento não tem `phone_number_id`              |
| Parou de chegar sozinho                            | **15 falhas seguidas** desligaram o repetidor. O painel mostra o aviso. Corrija o receptor e ligue de novo                                          |
| Seu sistema sempre dá 401 na verificação           | Corpo reserializado ou já parseado; chave antiga depois de "Gerar nova chave"; comparação com o cabeçalho errado; relógio com mais de 5 min de erro |
| O "Testar conexão" falha                           | URL não `https`, endereço não público, redirecionamento (`3xx`), resposta que não é `2xx` ou mais de 5 s para responder                             |
| Eventos duplicados                                 | Esperado: a Meta reenvia. Deduplique (seção 9)                                                                                                      |
| Eventos fora de ordem                              | Esperado: sem garantia de ordem. Use o `timestamp` do evento                                                                                        |
| Faltam eventos durante um disparo grande           | Teto de 50 por segundo por conta, ou o receptor estourou o tempo e o contador chegou a 15                                                           |
| Não chega nada enquanto a conta está bloqueada     | Esperado: conta bloqueada não repassa                                                                                                               |
| Chegam eventos de um número que você não reconhece | A conta tem mais de um número oficial. Filtre por `metadata.phone_number_id`                                                                        |

## 14. Checklist do receptor

- [ ] Rota `POST` em `https://`, com certificado válido.
- [ ] Corpo lido **cru** (sem `json()` automático) e limitado a 4 MiB.
- [ ] Assinatura verificada **antes** de qualquer parse, em tempo constante, com tolerância de 5 minutos.
- [ ] Resposta `401` para assinatura inválida e `2xx` rápido (bem abaixo de 5 s) para válida.
- [ ] Processamento depois da resposta, com fila, e dimensionado para picos de `statuses` em disparos.
- [ ] `X-Wacrm-Test: true` tratado como teste, sem efeitos de negócio.
- [ ] Deduplicação por `messages[].id` e por `statuses[].id` + `status`.
- [ ] Sem suposição de ordem; leitura tolerante a campos novos.
- [ ] Filtro por `metadata.phone_number_id` quando a conta tem mais de um número.
- [ ] Chave no cofre de segredos; sem corpo nem chave nos logs.
- [ ] Alerta de monitoramento para o receptor (se ele cair 15 vezes seguidas, o repetidor se desliga).
- [ ] Teste com o vetor da seção 11 e com um "Testar conexão" real.

## 15. Fontes

- Contrato resumido: `docs/public-api.md`, seção "Meta webhook relay (raw WhatsApp events)".
- Especificação: `docs/spec-088-repetidor-do-webhook-da-meta.md`.
- Assinatura: `src/lib/webhooks/sign.ts`. Entrega: `src/lib/webhooks/deliver.ts` e `src/lib/webhooks/meta-relay.ts`.
- Exemplos do webhook da Meta (versão atual): `docs/references/example_webhook_whatsapp_meta_cloud_api.md`.
- Documentação da Meta: WhatsApp Cloud API, Webhooks (formatos completos de `messages`, `statuses` e `errors`).
