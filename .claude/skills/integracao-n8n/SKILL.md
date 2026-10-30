---
name: integracao-n8n
description: Workflow n8n e ingestão externa de contatos (n8n_automation/). Use ao editar, importar, exportar ou versionar workflow; credenciais sempre <REDACTED>, nunca a service_role real.
---

# Integração n8n

## Quando usar

Ao alterar o workflow de ingestão de contatos, reimportá-lo numa instância n8n, exportá-lo de volta para o repositório ou desenhar nova integração externa.

## Como funciona

1. **Onde fica** (`n8n_automation/`): `README.md` (visão, payload, segurança), `SPEC_contact_ingestion_workflow.md` (contrato, decisões e bugs de n8n já achados — leia antes de mexer), `workflow_contact_ingestion.json` (export do workflow) e `supabase_schema_contatos.txt` (DDL das tabelas envolvidas).
2. **Credencial.** No JSON versionado, `supabase_anon_service_role` é `<REDACTED>`; o valor real existe só no node `CONFIG` dentro do n8n. Ao reimportar, repreencha no n8n; ao exportar de volta, **redija antes de salvar** na pasta.
3. **Confira antes de entregar** (não imprima o conteúdo):

   ```bash
   grep -c 'REDACTED' n8n_automation/workflow_contact_ingestion.json   # ≥ 1
   grep -nE 'eyJ[A-Za-z0-9_-]{20,}' n8n_automation/*.json              # deve sair vazio
   ```

4. **Nunca** peça, leia ou cole a `service_role` no chat. Se o usuário a colar, avise que deve ser rotacionada no painel do Supabase.
5. **Contrato do dado.** Telefone gravado só em dígitos com DDI, sem `+` nem máscara (`normalizeContactPhone`); dedup por `phone_normalized`. O `CONFIG` é single-tenant (`account_id` e `user_id` fixos) — multi-conta exige lookup dinâmico.
6. **Ingestão nova** pela API do CRM (chave escopada, funil por `webhook_id`) segue a SPEC 055 e `docs/context/api-publica-webhooks.md`; mudar tabela do banco é outro fluxo (skill `nova-migracao-supabase`).
7. **Git.** A pasta está no `.gitignore` deste checkout (`git check-ignore -v n8n_automation/README.md`); a sincronia com o repositório de distribuição é manual do mantenedor — entregue o comando, não o execute.

Detalhe: `n8n_automation/README.md` e `docs/context/contatos-audiencia.md` (seção n8n).

## Exemplos

- "Reimportar o workflow em outro n8n" → importar o JSON, abrir o node `CONFIG`, colar a chave real **lá**, rotacionar a chave se a instância for de terceiros.
- "Exportei uma versão nova do workflow" → passo 2, rodar as duas checagens do passo 3 e só então considerar o arquivo pronto.
- "Quero ingerir leads de um formulário" → decidir entre o workflow existente e o webhook de entrada (passo 6).
