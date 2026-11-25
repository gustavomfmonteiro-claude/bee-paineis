# Painel de Controle de Custos · GM Consultoria

Gestão financeira da GM Consultoria em uma página: emissão de NFS-e, entradas e saídas, baixas,
gestão de custos, OCR de notas fiscais e fluxo de caixa.

```
server.mjs ── serve public/ e guarda tudo em dados/dados.json (cópia diária em dados/backup/)
public/index.html ── o painel (funciona também aberto direto no navegador, guardando no próprio navegador)
```

## O que tem

- **Filtro de datas** no topo (de/até, Hoje, 7 e 30 dias, Este mês, Mês anterior, Trimestre, Ano, Tudo) e
  **faixa dos 12 meses** com o resultado, entradas × saídas e nº de notas de cada mês. Clique escolhe o mês;
  Shift+clique junta meses. Tudo na página segue esse período.
- **Visão geral**: entradas, saídas, resultado e margem (contra o período anterior de mesmo tamanho), saldo em caixa,
  notas emitidas, a receber, a pagar, saldo projetado; gráfico de **fluxo de caixa** (realizado ou previsto, por dia
  ou por mês) com saldo acumulado; vencimentos; custos por categoria; receita por cliente.
- **Entradas e saídas**: lançamentos com busca e filtros, edição, repetição mensal, baixa e estorno de baixa.
- **Notas fiscais (NFS-e)**: caminhos rápidos — nota do zero (assistente em 3 passos), repetir a última,
  mensalidades do mês (clientes com serviço mensal sem nota no mês, emitidas em lote), a partir do catálogo de
  serviços e botões de cliente. Calcula ISS (retido ou não), PIS, COFINS, CSLL, IRRF e INSS e o líquido.
  Cada nota vira um "a receber"; fora do Simples, provisiona a guia do ISS. Imprimir/PDF, XML, e-mail, cancelar.
- **OCR de notas**: foto/imagem (Tesseract.js, em português), PDF (texto do PDF; se for escaneado, OCR) e XML de
  NF-e/NFS-e (leitura exata). Preenche fornecedor, CNPJ, número, data, valor, chave e sugere a categoria;
  avisa nota já registrada.
- **Gestão de custos**: custo total, custo/receita, fixos × variáveis, tabela por categoria com variação,
  centros de custo, maiores fornecedores e evolução mensal empilhada.
- **Parte inferior (sempre visível)**: exportação de notas (Excel/CSV, XML em .zip, relatório PDF), lançamentos,
  fluxo de caixa diário e backup; **dar baixa** em lote nos pendentes; **registrar gasto** rápido.
- Atalhos de teclado: `N` nova nota, `R` repetir última, `G` novo gasto.

## Emissão oficial

O painel gera a nota, o espelho para impressão e o XML no layout da DPS (NFS-e Nacional), **sem assinatura**.
Para valer na prefeitura, o XML precisa ser assinado com o certificado A1 da empresa e transmitido ao Emissor
Nacional (ou ao sistema do município), normalmente por uma API de integrador. Esse elo ainda não está ligado.

## Rodar

```bash
node server.mjs            # http://localhost:3110
```

Na VPS, como os outros painéis: `docker compose up -d --build` em `/opt/painel-gm-consultoria`, com `.env` contendo
`PAINEL_SENHA=...` (login básico, usuário `gm` ou `PAINEL_USUARIO`). Os dados ficam em `dados/`, fora do Git.

Na primeira abertura aparecem **dados de exemplo** (marcados com "exemplo"). Preencha os dados do prestador em
Configurações e use "Apagar exemplos" para começar de verdade.
