# Painéis Bee Delivery Fortaleza

Painéis operacionais publicados na VPS. Cada pasta tem o próprio README, com regras e como rodar.

| Pasta | Painel | Endereço | Na VPS |
|---|---|---|---|
| `painel-bee/` | Radar Operacional | https://painel.179-197-229-171.sslip.io | `/opt/painel-tempo-real` |
| `painel-pague-menos/` | Pague Menos + Extrafarma | https://pague-menos.179-197-229-171.sslip.io | `/opt/painel-pague-menos` |
| `painel-gm-consultoria/` | Controle de Custos · GM Consultoria (+ MCP) | https://gm.179-197-229-171.sslip.io (a publicar) | `/opt/painel-gm-consultoria` |

Acessos ficam no `.env` de cada painel, fora do Git. Só as pastas liberadas no `.gitignore` da raiz entram no repositório; o restante desta pasta tem dados de clientes e fica de fora.
