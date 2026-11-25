# Prompt master — Painel GM Consultoria + MCP + VPS

> Cole este texto numa sessão do Claude Code **no computador do Gustavo** (Windows, com o acesso SSH `bee-vps`),
> aberta na pasta do repositório `bee-paineis`. Ou diga: *"leia e execute `painel-gm-consultoria/PROMPT-MASTER.md`
> da branch `claude/zealous-gauss-j775o6`"*.

---

Você vai colocar no ar, testar de ponta a ponta e deixar pronto para uso pessoal o **Painel de Controle de Custos ·
GM Consultoria**, com o **servidor MCP próprio** (para lançar notas fiscais pelo chat do Claude) rodando na **VPS da
Hostinger** usada pelos outros painéis, e com o **painel publicado no claude.ai** ligado a esse MCP.

Responda sempre em português do Brasil, com frases curtas e diretas.

## 1. Contexto

- **Dono e único usuário:** Gustavo, sócio da GM Consultoria (consultoria empresarial em Fortaleza/CE). Uso pessoal:
  uma senha do painel, uma chave do MCP, conector na conta pessoal do Claude, sem compartilhar com organização.
- **Repositório:** `gustavomfmonteiro-claude/bee-paineis`. Tudo deste projeto está em `painel-gm-consultoria/`, na
  branch **`claude/zealous-gauss-j775o6`** (já enviada ao GitHub). Os outros painéis (`painel-bee`, `painel-pague-menos`,
  `painel-black`) são da Bee Delivery: **não mexa neles**.
- **`.gitignore` da raiz** só libera as pastas listadas (`!/painel-gm-consultoria/` já está lá). Nunca versione `.env`,
  `dados/`, chaves ou dados de clientes.
- **VPS (Hostinger):** IP `179.197.229.171`, acesso pelo alias SSH **`bee-vps`** (já configurado no `~\.ssh\config` do
  Windows; os scripts `painel-pague-menos/*.ps1` usam o mesmo). Cada painel fica em `/opt/<nome>` e roda em Docker
  Compose, sem portas publicadas, atrás do **Caddy do jurflow** (contêiner `jurflow-caddy`, rede externa
  `jurflow-prod_default`). Endereços no formato `https://<nome>.179-197-229-171.sslip.io` (certificado automático do Caddy).
  **Atenção:** esse Caddy atende produção de outros sistemas (jurflow e os painéis da Bee). Qualquer mudança nele tem
  de ter cópia do Caddyfile, `caddy validate` antes do `reload` e volta da cópia se falhar.
- **Endereço deste painel:** `https://gm.179-197-229-171.sslip.io` · pasta na VPS `/opt/painel-gm-consultoria` ·
  contêiner `painel-gm-consultoria` · porta interna `3110`.
- **Painel no claude.ai (artifact):** https://claude.ai/artifact/6umu1PBkUXo9mS8tbK78De (fonte em
  `painel-gm-consultoria/artifact/painel-claude-ai.html`). Procura o conector com o nome exato **`GM Consultoria`**.

## 2. Regras de trabalho

1. **Peça OK antes** de: mexer na VPS (primeira publicação e cada mudança no Caddy), apagar dados, abrir pull request
   ou fazer merge. Depois do OK para publicar, pode rodar o script de publicação de novo sem perguntar.
2. **Não invente dados da empresa.** CNPJ, inscrição municipal, regime, endereço, serviços, clientes e valores vêm do
   Gustavo. Pergunte numa lista só, de uma vez.
3. **Segredos:** a senha do painel e a chave do MCP nunca vão para o Git, para commits, PRs ou issues. Mostre-as ao
   Gustavo uma vez, no fim, e diga onde ficam (`/opt/painel-gm-consultoria/.env` na VPS e `~\.gm_mcp_token` no Windows).
   Trate a URL do conector (`/mcp/<chave>`) como senha.
4. **Sem dependências npm** no servidor (Node 22, módulos nativos). Bibliotecas da página vêm de CDN com versão fixa.
5. Commits na branch `claude/zealous-gauss-j775o6`, mensagens em português. Push com `git push -u origin <branch>`.
6. Relate o que foi testado e o que não foi, com a saída real. Não diga que algo funciona sem ter visto funcionar.

## 3. O que já existe (confira antes de reescrever)

```
painel-gm-consultoria/
├── server.mjs            serve public/, /api/dados (com revisão), /api/rev, /mcp, /saude; login básico (PAINEL_SENHA)
├── mcp.mjs               servidor MCP (Streamable HTTP, respostas JSON, sem sessão, JSON-RPC 2.0) — 20 ferramentas
├── regras.mjs            guarda de dados (fila de escrita, revisão, backup diário) e cálculos (NFS-e, ISS, retenções, XML)
├── public/index.html     o painel (página única, sem build)
├── artifact/painel-claude-ai.html   versão publicada no claude.ai (db, downloads, sample, mcp)
├── Dockerfile, docker-compose.yml (VPS), docker-compose.local.yml (localhost:3110)
├── exemplo.env, Caddyfile.exemplo
├── publicar-vps.ps1      publicação pelo bee-vps (empacota, scp, roda vps/instalar.sh)
├── vps/instalar.sh       na VPS: .env na 1ª vez, docker compose up, bloco no Caddy com validação, imprime acessos
├── conectar/mcp.json, conectar/claude_desktop_config.json
└── README.md
```

O que já foi testado na sessão em nuvem: servidor e MCP com `curl` (as ferramentas principais), Claude Code conectado
ao MCP local ("Connected"), painel atualizando sozinho com lançamento feito pelo MCP, 409 de conflito, contêiner Docker
local com senha, `vps/instalar.sh` rodado num ambiente que imita a VPS (rede + `jurflow-caddy` falsos; idempotente),
artifact com o conector simulado. **Nunca rodou:** `publicar-vps.ps1` no Windows, a VPS de verdade, o conector no
claude.ai, o artifact com o conector real.

## 4. Passo a passo

### Fase 0 — Preparar
1. `git fetch origin claude/zealous-gauss-j775o6` e `git checkout claude/zealous-gauss-j775o6` (ou `git pull` se já estiver nela).
   Se a branch não existir, **reconstrua tudo pela especificação da seção 6** e siga.
2. Leia `painel-gm-consultoria/README.md`, `server.mjs`, `mcp.mjs`, `regras.mjs` e `vps/instalar.sh`.
3. Confirme o acesso: `ssh -o BatchMode=yes bee-vps "hostname; docker ps --format '{{.Names}}' | head -20"`.
   Veja se `jurflow-caddy` existe e onde está montado o Caddyfile
   (`docker inspect -f '{{json .Mounts}}' jurflow-caddy`). Se algo diferir do que o `instalar.sh` espera, ajuste o script.
4. Pergunte ao Gustavo, de uma vez: razão social, nome fantasia, CNPJ, inscrição municipal, regime (Simples, Presumido,
   Real, MEI), endereço/CEP, e-mail e telefone, alíquota de ISS, série e próximo número de nota (se já emite notas),
   saldo inicial do caixa e a data dele, prazo padrão de recebimento, serviços que vende (nome, item da LC 116, valor,
   se é mensal) e clientes recorrentes (nome, CNPJ/CPF, e-mail, serviço, valor). O que ele não souber agora fica
   para depois; não trave o resto.

### Fase 1 — Testar localmente (rápido)
1. `node painel-gm-consultoria/server.mjs` com `MCP_TOKEN=teste` e `PORTA=3110` no ambiente; confira `/saude`,
   `initialize`, `tools/list` e uma chamada `resumo_financeiro` no `/mcp` (curl com `Authorization: Bearer teste`).
2. Pare o servidor e apague a pasta `dados/` criada no teste.

### Fase 2 — Publicar na VPS (pedir OK antes)
1. Mostre o plano em 4 linhas e peça OK.
2. Rode `powershell -ExecutionPolicy Bypass -File .\painel-gm-consultoria\publicar-vps.ps1`. O script nunca rodou no
   Windows: se falhar (tar/scp/ssh, fim de linha CRLF, PowerShell 5 x 7), corrija o script, faça commit e rode de novo.
   Ele deve terminar mostrando `CONTEINER_OK`, `CADDY_OK` (ou `CADDY_JA_TINHA`), o endereço, a senha e a chave.
3. Verifique de fora:
   - `curl -sI https://gm.179-197-229-171.sslip.io/` → 401 (pede senha); com `-u gm:<senha>` → 200.
   - `curl -s https://gm.179-197-229-171.sslip.io/saude` → `{"ok":true}`.
   - `curl -s https://gm.179-197-229-171.sslip.io/mcp/<chave> -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → lista de ferramentas.
   - Sem chave → 401. `/.well-known/oauth-protected-resource` → 404.
   - Os outros endereços do Caddy continuam respondendo como antes (`painel.`, `pague-menos.`, `black.` …).
4. Atualize a linha do painel no `README.md` da raiz (tire o "(a publicar)") e faça commit.

### Fase 3 — Dados reais antes de abrir o painel
Importante: se o painel da VPS for aberto no navegador com o servidor ainda vazio, ele grava **dados de exemplo**.
Para começar limpo, crie os dados **pelo MCP primeiro**:
1. Ligue o MCP no Claude Code desta máquina (escopo do usuário):
   `claude mcp add --transport http -s user gm-consultoria https://gm.179-197-229-171.sslip.io/mcp --header "Authorization: Bearer <chave>"`
   e confirme com `claude mcp list` (deve aparecer **Connected**). As ferramentas ficam disponíveis numa sessão nova;
   se não aparecerem nesta, use `curl` para os passos abaixo.
2. `atualizar_empresa` com os dados da Fase 0; `salvar_servico` para cada serviço; `salvar_cliente` para cada cliente.
3. `resumo_financeiro` deve vir com `dados_de_exemplo: false`.

### Fase 4 — Conectar o claude.ai e o painel publicado
1. Oriente o Gustavo (você não consegue fazer isso por ele): claude.ai → Configurações → Conectores → **Adicionar
   conector personalizado** → Nome **`GM Consultoria`** (exatamente) → URL `https://gm.179-197-229-171.sslip.io/mcp/<chave>`.
   Depois, numa conversa, ativar o conector no menu de ferramentas.
2. Peça para ele abrir https://claude.ai/artifact/6umu1PBkUXo9mS8tbK78De, autorizar o conector quando o claude.ai
   pedir e confirmar que o selo no topo mostra **"salvo na VPS"** e os dados reais da Fase 3.
3. Se o artifact precisar de ajuste e esta sessão tiver a ferramenta de Artifacts, republique a partir de
   `artifact/painel-claude-ai.html` **no mesmo link** (passe a URL) mantendo as capacidades
   `db`, `downloads`, `sample {images:true}` e `mcp` com o servidor `GM Consultoria` e as ferramentas
   `painel_revisao`, `painel_obter`, `painel_salvar`. Sem essa ferramenta, só faça commit do arquivo e avise.
4. (Opcional) Claude Desktop pelo arquivo: `conectar/claude_desktop_config.json` (usa `mcp-remote`, precisa de Node).

### Fase 5 — Teste de ponta a ponta (critérios de aceite)
Faça cada item e mostre o resultado; apague no fim os lançamentos de teste (com `excluir_lancamento`/`cancelar_nfse`).
- [ ] Pelo MCP, `registrar_nota_entrada` com um XML de NF-e de teste → gasto criado com fornecedor, CNPJ, número,
      valor e categoria sugerida; a mesma nota de novo → recusada como repetida.
- [ ] `emitir_nfse` com `simular=true` → prévia com ISS, retenções e líquido; depois a emissão real → número sequencial,
      "a receber" criado; `ver_nfse` traz o XML.
- [ ] `dar_baixa` com `numero_nfse` → recebida; `resumo_financeiro` e `fluxo_caixa` refletem.
- [ ] Painel da VPS aberto no navegador: o que foi lançado pelo MCP aparece sozinho em até 15 s.
- [ ] Lançamento feito no painel da VPS aparece no `listar_lancamentos` do MCP.
- [ ] Painel do claude.ai com o conector: mostra os mesmos dados; um gasto lançado nele aparece na VPS.
- [ ] Exportações do painel da VPS: CSV de notas, .zip de XML, relatório, backup JSON.
- [ ] Backup diário em `/opt/painel-gm-consultoria/dados/backup/` existe após a primeira gravação do dia.

### Fase 6 — Fechar
1. Commit e push de tudo o que mudou. PR para `main` **só se o Gustavo pedir**.
2. Resumo final para o Gustavo: endereço, usuário, senha, URL do conector, o que foi testado (com resultado), o que
   ficou pendente e por quê. Lembre que a NFS-e **ainda não tem validade fiscal** (ver seção 7).

## 5. Como o Gustavo vai usar no dia a dia
- *"Registra essa nota"* com a foto, o PDF ou o XML anexado → `registrar_nota_entrada` (o Claude lê a imagem e passa
  os campos; com XML, passa o XML inteiro).
- *"Emite a nota de consultoria de novembro para a Construtora X, R$ 12.500, com retenção de IR"* → `emitir_nfse`
  com `simular=true`, mostra o cálculo, emite depois do "pode emitir".
- *"Paguei o aluguel hoje no Pix"* → `listar_lancamentos` + `dar_baixa`.
- *"Como fechou outubro?"*, *"quanto falta receber?"*, *"onde estou gastando mais?"* → `resumo_financeiro`,
  `fluxo_caixa`, `custos_por_categoria`.

## 6. Especificação (para conferir ou reconstruir)

### 6.1 Painel (`public/index.html`)
- Página única, tema escuro tecnológico (fundo `#05070f` com grade sutil; destaques ciano `#22d3ee` e violeta
  `#8b5cf6`; entradas `#34d399`, saídas `#fb7185`, pendentes `#fbbf24`; fontes Space Grotesk e JetBrains Mono).
  Título: **"Painel de Controle de Custos · GM Consultoria"**. Funciona no celular, sem rolagem lateral.
- **Filtro de datas** (de/até; Hoje, 7 dias, 30 dias, Este mês, Mês anterior, Trimestre, Ano, Tudo) e **faixa dos 12
  meses** com o resultado do mês, barrinhas entradas × saídas e nº de notas/lançamentos; clique escolhe o mês,
  Shift+clique junta meses. Tudo na página segue o período.
- **Abas:**
  - Visão geral: KPIs (entradas, saídas, resultado e margem vs período anterior, saldo em caixa, notas emitidas e
    ticket médio, a receber, a pagar, saldo projetado), gráfico SVG de **fluxo de caixa** (realizado/previsto; por dia
    até 62 dias, senão por mês; saldo acumulado), vencimentos, custos por categoria, receita por cliente, últimas notas.
  - Entradas e saídas: tabela com busca e filtros, novo/editar, repetir por N meses, baixa, desfazer baixa, excluir.
  - Notas fiscais: **caminhos rápidos** (nova nota em 3 passos: tomador → serviço e valores → revisão; repetir
    última; mensalidades do mês em lote; a partir do catálogo; botões por cliente), lista de NFS-e com imprimir,
    XML, copiar, cancelar.
  - OCR de notas: soltar foto/PDF/XML; XML lido no navegador; PDF com texto via pdf.js; foto e PDF escaneado via
    Tesseract.js (na VPS) ou via Claude (`sample`, no artifact); conferência dos campos marcados; aviso de duplicata.
  - Gestão de custos: custo total, custo/receita, fixos × variáveis, média/dia, tabela por categoria com variação,
    centros de custo, maiores fornecedores, evolução mensal empilhada (5 maiores categorias).
  - Configurações: dados do prestador, catálogo de serviços, clientes, categorias e centros, backup/restauração,
    apagar exemplos, apagar tudo.
- **Parte inferior fixa em todas as abas:** exportar notas (CSV com BOM e `;`, XML em .zip via JSZip, relatório
  para imprimir), lançamentos CSV, fluxo diário CSV, backup JSON; **dar baixa em lote** (pendentes até o fim do
  período, atrasados primeiro); **registrar gasto** rápido.
- Atalhos: `N` nova nota, `R` repetir última, `G` novo gasto.
- Persistência: `GET /api/dados` (404 = vazio → gera exemplo e grava), `PUT /api/dados {dados, rev}` (409 se a revisão
  mudou → recarrega e avisa), `GET /api/rev` a cada 15 s (recarrega se o Claude mudou algo). Cópia no `localStorage`.

### 6.2 Modelo de dados (`dados/dados.json`)
```
{ versao, rev, demo,
  empresa: { razao, fantasia, cnpj, im, regime: simples|presumido|real|mei, endereco, cep, municipio, uf, ibge,
             email, fone, aliqISS, serie, proxNum, saldoInicial, prazo, obs },
  clientes: [{ id, nome, doc, email, municipio, uf, endereco, servicoId, valor }],
  servicos: [{ id, nome, codigo (LC 116), cnae, descricao, valor, aliq, recorrente }],
  notas:    [{ id, numero, serie, emissao, competencia, venc, status: emitida|cancelada, clienteId, toma{...},
               servicoId, codigo, cnae, descricao, obs, issRetido, retPct{pis,cofins,csll,ir,inss}, valor, deducoes,
               desconto, aliq, base, iss, ret{...}, totalRet, liquido, prest{...}, codVerif, lancId, origem }],
  lanc:     [{ id, tipo: entrada|saida, data (competência), venc, descricao, categoria, centro, contraparte, cnpj,
               doc, chave, valor, status: pago|pendente, pagoEm, forma, origem: manual|ocr|xml|nfse|mcp|mcp-nota, notaId }],
  categorias: { saida: [...], entrada: [...] }, centros: [...] }
```
Datas `AAAA-MM-DD`, fuso America/Fortaleza. "Atrasado" = pendente com vencimento antes de hoje.

### 6.3 Regras de cálculo da NFS-e (iguais na página e em `regras.mjs`)
- base = valor − deduções − desconto incondicionado; ISS = base × alíquota.
- Retenções sobre o valor (padrões): PIS 0,65%, COFINS 3%, CSLL 1%, IRRF 1,5%, INSS 11%.
- líquido = valor − desconto − retenções − (ISS, se retido pelo tomador).
- Emitir cria o lançamento de **entrada pendente** com o líquido e vencimento (emissão + prazo). Fora do Simples/MEI e
  sem retenção, cria também a **saída pendente "ISS NFS-e n"** com vencimento no dia 10 do mês seguinte à competência.
- Cancelar marca a nota como cancelada e remove os lançamentos ligados.
- XML no layout **DPS da NFS-e Nacional**, `tpAmb=2`, **sem assinatura**.

### 6.4 Servidor (`server.mjs`)
- `/saude` (livre), `/.well-known/*` → 404 (livre), `/mcp` e `/mcp/<chave>` (chave do MCP), resto com login básico
  (`PAINEL_USUARIO`, padrão `gm`; `PAINEL_SENHA`).
- Chave do MCP: `MCP_TOKEN` do `.env`; sem ela, gera em `dados/mcp-token.txt`. Comparação em tempo constante.
- Toda escrita passa por uma **fila única** (painel e MCP nunca gravam juntos), incrementa `rev`, grava atômico
  (`.tmp` + rename) e guarda **um backup por dia** em `dados/backup/`.
- Variáveis: `PORTA` (3110), `PAINEL_USUARIO`, `PAINEL_SENHA`, `MCP_TOKEN`, `URL_PUBLICA`, `TZ=America/Fortaleza`.

### 6.5 MCP (`mcp.mjs`)
Streamable HTTP só com POST (GET → 405), respostas `application/json`, notificações → 202, lotes aceitos. Versões
`2025-06-18`, `2025-03-26`, `2024-11-05`. `initialize` devolve `instructions` explicando entrada × saída e o fluxo
"simular antes de emitir". Cada resultado vai em `content` (texto JSON) e `structuredContent`; erros de uso com
`isError: true` e mensagem clara em português. Anotações `readOnlyHint`/`destructiveHint` corretas.

| Ferramenta | Faz |
|---|---|
| `resumo_financeiro` | totais do período, margem, saldo em caixa, a receber/pagar, atrasados, NFS-e emitidas, `dados_de_exemplo` |
| `listar_lancamentos` | por competência; filtros tipo, situação, busca, limite; devolve ids |
| `registrar_lancamento` | entrada/saída avulsa; categoria sugerida; `repetir_meses` (2–24) |
| `registrar_nota_entrada` | nota de fornecedor por campos ou **XML** (NF-e/NFC-e/NFS-e, lido por regex); recusa duplicata (chave, ou nº + CNPJ) salvo `permitir_repetida` |
| `emitir_nfse` | por `cliente_id` ou dados do tomador; `servico_id` ou código/descrição/valor; retenções em % (`true` = padrão); `simular` |
| `listar_notas` | `tipo: saida` (NFS-e) ou `entrada` (notas de fornecedores, sem as provisões de ISS) |
| `ver_nfse` / `cancelar_nfse` | detalhe + XML / cancelamento |
| `dar_baixa` / `desfazer_baixa` / `excluir_lancamento` | por ids ou `numero_nfse`; data, forma, valor pago |
| `fluxo_caixa` / `custos_por_categoria` | realizado/previsto, dia/mês / categorias, centros, fornecedores, vs período anterior |
| `listar_cadastros` / `salvar_cliente` / `salvar_servico` / `atualizar_empresa` | cadastros |
| `painel_revisao` / `painel_obter` / `painel_salvar` | uso interno do artifact do claude.ai (`painel_salvar` recusa com "conflito" se a revisão mudou) |

### 6.6 Painel no claude.ai (`artifact/painel-claude-ai.html`)
Mesma página, adaptada ao visualizador do claude.ai: sem `confirm/prompt` (confirmação dentro da página), sem
`window.open`/impressão (espelho e relatório saem como .html que imprime ao abrir), downloads pela capacidade
`downloads` (XML sempre dentro de .zip), OCR de foto pela capacidade `sample` (Claude lê a imagem e devolve JSON),
e-mail como texto para copiar. Fonte dos dados, nesta ordem: conector **`GM Consultoria`** (`painel_obter`/
`painel_salvar`, conferência de `painel_revisao` a cada 20 s, conflito → recarrega) → banco do artifact (`db`, JSON
em partes de 200 mil caracteres) → navegador. Mostra aviso específico por código de erro do conector.

### 6.7 Implantação
- `Dockerfile`: `node:22-alpine`, copia `package.json server.mjs regras.mjs mcp.mjs public/`, `HEALTHCHECK` em `/saude`.
- `docker-compose.yml` (VPS): rede externa `jurflow-prod_default`, volume `./dados:/app/dados`, `env_file: .env`.
- Bloco do Caddy: `gm.179-197-229-171.sslip.io { encode gzip; reverse_proxy painel-gm-consultoria:3110 }`.
- `vps/instalar.sh` idempotente: cria `.env` (senha e chave aleatórias) só na 1ª vez; `docker compose up -d --build`;
  acha o Caddyfile pelo `docker inspect` do `jurflow-caddy`; acrescenta o bloco se faltar, com cópia, `validate` e
  `reload`, restaurando a cópia se falhar; imprime `PAINEL=`, `USUARIO=`, `SENHA=` (só na 1ª vez), `MCP_TOKEN=`.

## 7. Fora do escopo agora (pergunte antes de começar qualquer um)
- **Emissão oficial da NFS-e:** assinar a DPS com o certificado A1 e transmitir ao Emissor Nacional/Prefeitura de
  Fortaleza, direto ou por um integrador de NFS-e. Precisa de decisão do Gustavo (integrador, custo, certificado).
- Backup fora da VPS (ex.: cópia diária para outro lugar).
- Junção automática em conflito painel × Claude (hoje a alteração do painel é recusada e ele pede para refazer).
- Imagem de capa do artifact (pode ser escolhida no menu Compartilhar do claude.ai).
