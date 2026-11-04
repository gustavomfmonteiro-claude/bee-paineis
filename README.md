# Painel Bee — Radar Operacional local

O Radar Operacional da `torre-operacional` rodando como servidor Node, lendo a API da Bee
(produção) a cada `REFRESH_MINUTES` (padrão 10 min). Somente GET.

```
server.mjs ──a cada 10 min──▶ radar-coletor.mjs ──GET──▶ /orders (3 dias de created_at) + /dashboard?franchiseId=7 + /merchants/{id}
     │                                                       (cache de lojas em cache/cache-lojas.json, 7 dias)
     ├─ cache/ultimo.json   (a página abre com a última coleta)
     └─ http://localhost:3040  (public/radar.html + adaptador SSE)
```

## Rodar

```
docker compose up -d --build
```

Sem Docker (Node 20+): `node server.mjs`. Abrir http://localhost:3040.

Logs: `docker logs -f painel-bee`. Depois de mudar o `.env`: `docker restart painel-bee`.

## Arquivos

- `radar-coletor.mjs` — cópia de `torre-operacional/coletor.mjs` como módulo (`configurar()` + `coletar()`);
  mesmas regras (total = finalizadas + canceladas do dia, OTD da RD por ponta, bairros, D+1/agendadas,
  tipos de entrega, entregadores online). Mudou a regra lá? Copie a mudança para cá.
- `public/radar.html` — cópia de `torre-operacional/radar.template.html` com os textos do ciclo de 10 min.
  A página espera o banco do artefato; o `server.mjs` injeta um adaptador que troca esse banco por
  `/api/eventos` (SSE) e `/api/atualizar`.
- `.env` — URL da API, usuário/senha, intervalo, porta e `CANCELAMENTOS_DIR` (pasta da
  `torre-cancelamentos`, de onde saem os cancelamentos por agente; sem ela essa seção fica vazia).

## Observações

- O login derruba as outras sessões do mesmo usuário (as torres agendadas re-logam sozinhas).
- "Atualizar agora" coleta na hora, no máximo uma vez por minuto; a leitura leva ~2 min.
- Falha na coleta: o painel mantém a última coleta válida e mostra o aviso; nova tentativa no próximo ciclo.
