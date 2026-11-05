# Painel Pague Menos + Extrafarma — Bee Delivery Fortaleza

Demanda operacional do grupo: OTD de 15 min em cada ponta, aceite, cancelamentos, finalizações, rankings
de lojas, orientação de ajustes, detalhe das lojas prioritárias (678, 7300, 933, 495, 890, 7362 e 839), entregas buscando nessas
lojas e ranking de entregadores de 933, 495 e 7362. Somente GET na API da Bee.

```
server.mjs ──a cada minuto───▶ /orders abertos das 4 lojas prioritárias: buscando e em andamento (só em memória)
     ├────a cada 5 min───────▶ /orders de hoje, só das lojas do grupo (lojas-pmef.json), + /orders/{id} por cancelamento novo
     ├────às 04:00───────────▶ /orders de ontem na franquia inteira (fecha o dia e descobre loja nova)
     ├─ cache/dias/AAAA-MM-DD.json   (por loja, por hora, cancelamentos e entregadores)
     ├─ cache/entregadores.json      (30 dias de entregadores de 933, 495 e 7362)
     ├─ cache/motivos.json           (motivo já lido não é pedido de novo)
     ├─ cache/uso.json               (requisições por leitura e acumulado do dia)
     └─ public/index.html            (atualiza sozinha via SSE)
relatorio.mjs (neste PC, só às 23:00) ──lê /api/dados──▶ PDF em Gustavo IA\relatorios pague menos
```

## Regras

- **Dia**: pedidos criados das 00:00 às 23:59 (Fortaleza). O dia corrente fica parcial até virar o dia.
- **Em andamento**: status 20, 25, 28, 30, 35 e 40, com o rótulo da API; tempo na etapa a partir do último carimbo.
- **Evolução**: lojas e bandeiras ganhando ou perdendo demanda, por dia (contra o mesmo dia da semana anterior ou o dia anterior), semana e mês, desde 01/01/2026, só com dias fechados. O passado vem de `cache/evolucao-base.json`, importado do Painel de Evolução por `importar-evolucao.py` (janeiro e fevereiro saem dos extratos, porque a API só guarda pedidos desde 01/03); os dias novos vêm das leituras deste painel, sem requisição extra.
- **Até 3 km**: botão em cada entrega aberta das lojas prioritárias. Lista entregadores online a até 3 km da coleta (linha reta, GPS do `/dashboard`) com ID, nome completo e CPF. O CPF fica só em memória, vai mascarado sem login no painel e é lido em segundo plano, porque a API limita o cadastro: os cartões aparecem na hora e a página completa sozinha. A consulta só aceita entregas da última leitura. O botão de WhatsApp só envia em entrega buscando, pelo Radar.
- **Buscando**: status 10. Endereço completo só com o login ativo; sem ele, só bairro e cidade. Nada disso vai para o disco.
- **Entregadores**: entregas finalizadas por loja, pela data de criação do pedido; guarda só id e nome.
- **Grupo**: franquia FORTALEZA/CE com PAGUE MENOS ou EXTRAFARMA no nome da loja.
- **OTD**: ponta 1 da criação à chegada na loja; ponta 2 da saída à chegada no cliente; 15 min cada.
  Geral: soma das pontas até 30 min, a mesma regra do Radar. Base: finalizadas com os dois tempos.
- **Aceite**: do início da busca ao aceite, nos pedidos aceitos, finalizados ou não. Pedido de integração com `searching` nulo já
  nasce com entregador (cerca de 39% do grupo em 03/11), não passa por busca e fica de fora, contado como "sem busca".
- **Alerta sonoro**: na página, a cada leitura (uma por minuto) enquanto houver entrega das lojas prioritárias sem entregador. Precisa de um clique para o navegador liberar o áudio.
- **Dificuldade de aceite**: parcela que passou de 5 min até o aceite ou foi cancelada sem aceite, sem contar o que outra
  transportadora aceitou primeiro (loja com 10 pedidos ou mais).
- **Operacional**: motivo de falta de entregador ou atraso/problema do entregador, a classificação da torre Pague Menos
  (`montar.py`), que segue o "Motivo Bee" do Power BI.
- **Orientações**: regras em `analise.mjs`, cada uma com o número que a acionou. Apontam onde agir, não a causa.

## Rodar

VPS: `docker compose up -d --build` em `/opt/painel-pague-menos` (https://pague-menos.179-197-229-171.sslip.io).
Local: `node server.mjs`, com o `.env` nesta pasta. Teste sem produção: `node teste/api-simulada.mjs` e
`BEE_API_BASE_URL=http://localhost:3071/api` nas variáveis.

- `configurar-acesso.ps1`: grava usuário e senha da API no `.env` da VPS (permissão 600) e reinicia só este container.
- `configurar-senha-painel.ps1`: cria o login do painel (na VPS ficam só os hashes) e o acesso do relatório (`~\.bee_painel_pm_token`). Rodar de novo troca os dois.
- `agendar-relatorio.ps1`: cria a tarefa do Windows das 23:00. Se o PC estiver desligado, ela roda quando ele ligar.

## Observações

- `.env`: `BEE_API_BASE_URL`, `BEE_API_USERNAME`, `BEE_API_PASSWORD`, `PORT`, `KPI_MINUTOS`, `BUSCA_SEGUNDOS`, `PAINEL_USUARIO`, `PAINEL_SENHA_SAL`, `PAINEL_SENHA_HASH`, `PAINEL_TOKEN_HASH`.
- O login derruba outras sessões do mesmo usuário. `Paineloperacional` também é usado pelo Radar (`painel-tempo-real`,
  coleta a cada 5 min e alerta a cada minuto), e os dois re-logam sozinhos. A solução definitiva é um usuário de API só deste painel.
- `lojas-pmef.json`: ids de merchant do cadastro (`torre-pague-menos-extrafarma/lojas-cadastro.csv`).
