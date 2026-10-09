# Prisma — Painel de tarefas

> **Painel:** <https://script.google.com/macros/s/AKfycbwJLaxf6T9DADYzttqVzCn1v3ERzH3N9fAImRKFIh7hXKZvHrNu80dPwXUBxV23RYvUXg/exec>  
> Abre só logado em **chapa.poli.prisma@gmail.com** (de preferência numa janela anônima ou perfil do Chrome só com essa conta).

Painel de tarefas da **Chapa Prisma (Grêmio Politécnico)**. Tudo gira em torno de **chapa.poli.prisma@gmail.com**:

- você cadastra **nome e e-mail** de todos os envolvidos;
- cria uma tarefa, define **prioridade** (cores), **prazo**, **responsáveis** e o **tipo de arquivo esperado**;
- os responsáveis recebem **automaticamente um e-mail** com o que fazer;
- quem responde **COMEÇAR** aparece como *trabalhando*;
- quem **responde o e-mail para chapa.poli.prisma@gmail.com com o arquivo** faz a tarefa ir sozinha para **Verificar**: o anexo é salvo no Drive e a pessoa recebe uma confirmação;
- você confere e clica em **Aprovar e concluir**, ou **Devolver com ajustes** (vai um e-mail com o que mudar);
- também dá para mandar **mensagens avulsas** para uma pessoa só (ou várias).

| Prioridade | Cor | Quando usar |
|---|---|---|
| Urgente | Coral `#E8906A` | hoje ou amanhã |
| Alta | Âmbar `#E0B44E` | esta semana |
| Média | Céu `#5BB4E0` | próximas semanas |
| Baixa | Cinza `#B9BDCB` | quando der |

Status: **A fazer → Em andamento → Verificar → Concluída**. No quadro dá para arrastar cartões entre colunas.

---

## Como funciona por baixo

É um **Google Apps Script** rodando na própria conta chapa.poli.prisma@gmail.com. Não há servidor nem custo:

| Peça | Onde fica |
|---|---|
| Painel (site) | App da Web do Apps Script (`index.html`) |
| Envio de e-mails | Gmail da conta da chapa (`GmailApp`) |
| Leitura das entregas | Varredura da caixa de entrada a cada 5 min (gatilho) + botão **Verificar caixa** |
| Banco de dados | Planilha Google *“Prisma — Tarefas (banco de dados)”*, criada automaticamente |
| Arquivos entregues | Pasta *“Prisma — Entregas”* no Drive, uma subpasta por tarefa |

Cada e-mail de tarefa sai com o assunto `[PRISMA T-012] Título`. A varredura procura respostas com esse código, verifica a extensão dos anexos contra o tipo esperado e:

- **anexo no formato certo** → salva no Drive, registra a entrega, muda para **Verificar** e responde “Recebido!”;
- **anexo no formato errado** → responde explicando o formato esperado (status não muda);
- **“entregue”/“feito” sem anexo**, quando há arquivo esperado → responde pedindo o anexo;
- **COMEÇAR** (ou *comecei, iniciando, aceito, ciente*) → marca a pessoa como trabalhando;
- tarefa **sem arquivo** → basta responder **ENTREGUE** (ou *feito, pronto, concluído*);
- qualquer outra resposta → aparece na aba **Atividade**.

---

## Instalação (uns 10 minutos)

> Faça tudo **logado em chapa.poli.prisma@gmail.com**. É essa conta que envia e recebe os e-mails.

### Opção A — pelo navegador

1. Acesse <https://script.google.com> → **Novo projeto**. Renomeie para `Prisma — Tarefas`.
2. Em **Configurações do projeto** (engrenagem), marque **“Mostrar arquivo de manifesto appsscript.json”**.
3. No editor:
   - abra `Código.gs`, apague tudo e cole o conteúdo de [`Code.gs`](Code.gs);
   - abra `appsscript.json` e cole o conteúdo de [`appsscript.json`](appsscript.json);
   - clique em **+ → HTML**, nomeie **`index`** (sem `.html`) e cole o conteúdo de [`index.html`](index.html).
4. Salve. No topo, escolha a função **`setup`** e clique em **▶ Executar**.
   - Autorize o acesso. Como o app é seu, o Google mostra *“app não verificado”* → **Avançado → Acessar Prisma — Tarefas (não seguro)** → **Permitir**.
   - O `setup` cria a planilha, a pasta de entregas e o gatilho de varredura a cada 5 minutos.
5. **Implantar → Nova implantação** → tipo **App da Web**:
   - *Executar como*: **Eu (chapa.poli.prisma@gmail.com)**
   - *Quem pode acessar*: **Somente eu**
   - **Implantar** e copie a URL. Esse é o painel. Salve nos favoritos.

### Opção B — com o `clasp` (linha de comando)

```bash
npm install -g @google/clasp
clasp login                 # entre com chapa.poli.prisma@gmail.com
clasp create --type standalone --title "Prisma — Tarefas" --rootDir .
clasp push
clasp open                  # rode `setup` no editor e depois implante como App da Web (passos 4 e 5 acima)
```

### Atualizar depois de mudar o código

Cole/`clasp push` os arquivos e em **Implantar → Gerenciar implantações → ✏️ → Versão: Nova versão → Implantar**. A URL continua a mesma.

---

## Quem pode usar o painel

O painel fica com acesso **“Somente eu”**, ou seja, só abre logado na conta da chapa. Quem coordena as tarefas entra com essa conta (um perfil separado no Chrome facilita). Os demais membros **não precisam abrir o painel**: eles recebem tudo por e-mail e respondem por e-mail.

## Limites do Gmail gratuito

- **100 destinatários por dia** para e-mails enviados por script (cada responsável de cada tarefa conta 1, assim como as confirmações automáticas). O painel mostra quantos restam no dia.
- Anexos de até 25 MB por e-mail. Para arquivos maiores, peça um link do Drive (crie a tarefa sem arquivo ou aceite `.txt`).
- A varredura olha os últimos 45 dias de e-mails com “PRISMA” no assunto.

Ajustes ficam no topo do `Code.gs`, em `CONFIG`: intervalo da varredura, resposta automática de confirmação, nome do remetente.

## Ver antes de instalar

Abra o `index.html` direto no navegador: ele entra em **modo demonstração**, com dados de exemplo salvos só no seu navegador e e-mails simulados. O botão **Verificar caixa** simula uma resposta por e-mail.

## Arquivos

| Arquivo | O quê |
|---|---|
| `Code.gs` | Backend: API do painel, envio de e-mails, varredura da caixa de entrada, planilha e Drive |
| `index.html` | O painel (HTML, CSS e JS num arquivo só) + modo demonstração |
| `appsscript.json` | Manifesto: fuso de São Paulo, app da web executado pela conta da chapa |
