# Painel de Controle de Custos · GM Consultoria

Gestão financeira da GM Consultoria, para **uso pessoal** (um dono, uma senha, uma chave): emissão de NFS-e,
notas de entrada, entradas e saídas, baixas, custos, OCR de notas e fluxo de caixa. Os lançamentos podem ser
feitos **pelo chat do Claude**, por um servidor MCP próprio que roda no mesmo contêiner do painel.

```
Claude (claude.ai, Desktop ou Code) ──MCP──┐
                                           ▼
navegador ── painel (public/index.html) ── server.mjs ── dados/dados.json  (cópia diária em dados/backup/)
                                           │
                                 mcp.mjs + regras.mjs (as mesmas regras de cálculo da página)
```

| Arquivo | Para quê |
|---|---|
| `server.mjs` | Serve o painel, `/api/dados` (com revisão) e `/mcp` |
| `mcp.mjs` | Servidor MCP (Streamable HTTP, respostas JSON, sem dependências) com as ferramentas abaixo |
| `regras.mjs` | Guarda dos dados e cálculos (ISS, retenções, NFS-e, XML) |
| `public/index.html` | O painel |
| `docker-compose.yml` | VPS, atrás do Caddy do jurflow |
| `docker-compose.local.yml` | No seu computador, em `http://localhost:3110` |
| `exemplo.env` | Modelo do `.env` |
| `Caddyfile.exemplo` | Bloco do Caddy para `gm.179-197-229-171.sslip.io` |
| `conectar/` | JSON prontos para ligar o Claude ao MCP |

## Subir no Docker

1. Na VPS, copie a pasta para `/opt/painel-gm-consultoria` e crie o `.env` a partir do `exemplo.env`:

   ```bash
   cp exemplo.env .env
   ```

   Gere a chave do MCP e cole em `MCP_TOKEN`:

   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

2. Suba o contêiner:

   ```bash
   docker compose up -d --build
   ```

3. Acrescente o bloco do `Caddyfile.exemplo` ao Caddyfile do `jurflow-caddy` e recarregue o Caddy:

   ```bash
   docker exec jurflow-caddy caddy reload --config /etc/caddy/Caddyfile
   ```

4. Confira: `https://gm.179-197-229-171.sslip.io` pede a senha do painel (usuário `gm`), e
   `docker logs painel-gm-consultoria` mostra o endereço do MCP.

No seu computador, sem a VPS: mesmo `.env`, e `docker compose -f docker-compose.local.yml up -d --build`
(painel e MCP em `http://localhost:3110`; o conector do claude.ai precisa de um endereço público, então nesse caso
use o Claude Code ou o Claude Desktop).

## Conectar ao Claude

A chave (`MCP_TOKEN`) vai no cabeçalho `Authorization: Bearer <chave>` ou, onde não dá para mandar cabeçalho, no
próprio endereço: `https://gm.179-197-229-171.sslip.io/mcp/<chave>`. Trate esse endereço como senha.

**claude.ai (web e celular) e Claude Desktop, como conector pessoal**
Configurações → Conectores → Adicionar conector personalizado → nome `GM Consultoria`, URL
`https://gm.179-197-229-171.sslip.io/mcp/<chave>`. Depois, em cada conversa, ative o conector no menu de ferramentas.

**Claude Code** (`conectar/mcp.json`, vira o `.mcp.json` do projeto; a chave vem da variável `GM_MCP_TOKEN`):

```bash
claude mcp add --transport http -s user gm-consultoria https://gm.179-197-229-171.sslip.io/mcp --header "Authorization: Bearer SUA_CHAVE"
```

**Claude Desktop pelo arquivo de configuração** (`claude_desktop_config.json`): use `conectar/claude_desktop_config.json`,
que liga pelo `mcp-remote` (precisa do Node.js no computador). Troque `COLE_AQUI_O_MCP_TOKEN` pela chave.

## Ferramentas do MCP

| Ferramenta | O que faz |
|---|---|
| `registrar_nota_entrada` | Nota de fornecedor (gasto): campos lidos da foto/PDF ou o **XML** da NF-e/NFS-e; recusa nota repetida |
| `emitir_nfse` | Nota de saída: calcula ISS e retenções; `simular=true` mostra a prévia sem gravar |
| `listar_notas` | Notas de saída (NFS-e) ou de entrada (fornecedores) do período |
| `ver_nfse` / `cancelar_nfse` | Detalhe com XML (layout DPS) / cancelamento |
| `registrar_lancamento` | Entrada ou saída avulsa, com repetição mensal |
| `listar_lancamentos` / `dar_baixa` / `desfazer_baixa` / `excluir_lancamento` | Consulta, pagamento/recebimento e correções |
| `resumo_financeiro` / `fluxo_caixa` / `custos_por_categoria` | Números do mês ou de um período |
| `listar_cadastros` / `salvar_cliente` / `salvar_servico` / `atualizar_empresa` | Cadastros usados na emissão |

Exemplos no chat: *"registra essa nota"* (com a foto ou o XML anexado), *"emite a nota de consultoria de novembro
para a Construtora Horizonte, R$ 12.500, com retenção de IR"*, *"quanto falta receber este mês?"*,
*"dá baixa no aluguel, paguei hoje no Pix"*.

## Painel e Claude ao mesmo tempo

O painel confere a cada 15 s se o Claude lançou algo e recarrega sozinho. Toda gravação passa por uma fila no
servidor e carrega a revisão dos dados: se você alterar algo no painel no mesmo instante em que o Claude gravou, o
servidor recusa a gravação do painel, o painel recarrega e avisa para refazer a última alteração.

## O que tem no painel

- **Filtro de datas** e faixa dos 12 meses com os números de cada mês; tudo segue esse período.
- **Visão geral**, **Entradas e saídas**, **Notas fiscais** (caminhos rápidos de emissão), **OCR de notas**
  (foto, PDF, XML), **Gestão de custos** e **Configurações**.
- **Parte inferior**: exportação (Excel/CSV, XML em .zip, relatório), dar baixa em lote e registro rápido de gasto.
- Na primeira abertura aparecem **dados de exemplo**; apague em Configurações. Atalhos: `N` nova nota, `R` repetir, `G` gasto.

## Emissão oficial

O painel e o MCP geram a nota, o espelho e o XML no layout da DPS (NFS-e Nacional), **sem assinatura**. Para valer na
prefeitura, o XML precisa ser assinado com o certificado A1 da empresa e transmitido ao Emissor Nacional (ou ao
sistema do município), normalmente por uma API de integrador. Esse elo ainda não está ligado.
