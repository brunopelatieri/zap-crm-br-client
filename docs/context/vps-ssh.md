# Acesso SSH à VPS de produção (agente)

> Domínio de deploy. Mapa: [`INDEX.md`](./INDEX.md). Stack, imagem e variáveis: [`deploy-docker.md`](./deploy-docker.md). Este arquivo é **versionado**: não coloque nele IP, senha nem passphrase.

A VPS Contabo (Docker Swarm + Portainer + Traefik, rede `bru`) roda o `zapcrm_app`, o Evolution Go e **outros projetos do mantenedor** (NexWei, Bizu Hub, SeaweedFS, Postgres de outra stack, portal-docs). O acesso é o mesmo do projeto NexWei: chave SSH, usuário `root`.

**Host, impressão digital da chave e a lista de contêineres** ficam em `docs/deploy/server_contabo.md` (local, fora do Git, **sem segredo**; este é o único arquivo de `docs/deploy/` que o agente pode ler sem pedido, junto com o que o mantenedor liberar na hora). O arquivo veio do projeto NexWei: as menções a `.env.local`, `DEPLOY_VPS_*` e `npm run deploy:vps` **não existem neste projeto**.

## Como o agente conecta

1. Ferramenta **PowerShell**, com o `ssh.exe` do Windows (`$env:SystemRoot\System32\OpenSSH\ssh.exe`). O `ssh` do Git Bash não enxerga o agente do Windows.
2. A chave `nexwei_vps` (`$env:USERPROFILE\.ssh\nexwei_vps`) já precisa estar no agente: confira com `ssh-add.exe -l`. Se não estiver, o **mantenedor** roda `ssh-add $env:USERPROFILE\.ssh\nexwei_vps` (pede a passphrase). **O agente nunca digita senha nem passphrase.**
3. Sempre com `-n -o BatchMode=yes -o ConnectTimeout=15 -o IdentitiesOnly=yes -i <chave>` e `timeout` em todo comando remoto.
4. Leia o host do `server_contabo.md` em uma variável do PowerShell (`Select-String`), sem digitá-lo em comando nem repeti-lo em conversa.
5. Para script com aspas, escreva um `.sh` com fim de linha LF no scratchpad, converta em base64 e rode `echo <b64> | base64 -d | timeout 120 bash` no servidor (receita completa no `server_contabo.md`).

## Escopo e limites

- **Só leitura por padrão.** Escrita (`docker service update`, edição de arquivo, reinício, deploy) só com pedido explícito do mantenedor **para aquela ação**.
- **Só o que é do ZAP**: serviços `zapcrm_app_*`, `evolution_go_*`, `portal-docs_*` e o `traefik_traefik` (para ler labels e log). Não toque em `nexwei_*`, `bizu_hub_*`, `postgres_postgres` nem `seaweedfs_*`.
- **Nunca** imprima `docker service inspect` inteiro nem `docker exec … env`: o `Spec.TaskTemplate.ContainerSpec.Env` leva os segredos da stack. Para labels use `--format '{{json .Spec.Labels}}'` (não leva env).
- `docker service logs` já travou nesta VPS: envolva em `timeout 30`.
- A stack é gerida pelo **Portainer** (nome da stack `zapcrm_app`, serviço `zapcrm_app_zapcrm_app`). Mudar label por `docker service update` cria deriva: o próximo "Update the stack" desfaz. A fonte de verdade é o editor da stack no Portainer.
- Pendência do proprietário: o `sshd` ainda aceita senha e não existe usuário só de leitura (ver `server_contabo.md`).
