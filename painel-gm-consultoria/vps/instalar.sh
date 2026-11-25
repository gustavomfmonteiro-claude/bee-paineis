#!/usr/bin/env bash
# Roda NA VPS (chamado pelo publicar-vps.ps1). Idempotente: pode rodar de novo a cada atualização.
#  1. cria o .env na primeira vez (senha do painel e chave do MCP aleatórias)
#  2. sobe/atualiza o contêiner
#  3. põe o endereço gm.<ip>.sslip.io no Caddy do jurflow (com cópia e validação antes de recarregar)
set -euo pipefail
DIR=/opt/painel-gm-consultoria
DOMINIO=gm.179-197-229-171.sslip.io
CADDY=jurflow-caddy
cd "$DIR"
umask 077

NOVO_ENV=0
if [ ! -f .env ]; then
  SENHA=$(openssl rand -base64 18 | tr '+/' '-_' | tr -d '=')
  TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
  printf 'PAINEL_USUARIO=gm\nPAINEL_SENHA=%s\nMCP_TOKEN=%s\nURL_PUBLICA=https://%s\n' "$SENHA" "$TOKEN" "$DOMINIO" > .env
  chmod 600 .env
  NOVO_ENV=1
fi
mkdir -p dados

docker network inspect jurflow-prod_default >/dev/null
# a saída do build vai para um log (o PowerShell 5 trata texto no stderr como erro); só aparece se falhar
if ! docker compose up -d --build >/tmp/painel-gm-compose.log 2>&1; then
  cat /tmp/painel-gm-compose.log
  echo "COMPOSE_FALHOU"
  exit 1
fi
sleep 3
docker exec painel-gm-consultoria wget -qO- http://127.0.0.1:3110/saude >/dev/null && echo "CONTEINER_OK"

# Caddyfile do jurflow: o arquivo montado em /etc/caddy/Caddyfile (ou a pasta /etc/caddy)
ARQ=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY")
if [ -z "$ARQ" ]; then
  PASTA=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$CADDY")
  [ -n "$PASTA" ] && ARQ="$PASTA/Caddyfile"
fi
if [ -z "$ARQ" ] || [ ! -f "$ARQ" ]; then
  echo "CADDY_NAO_ACHADO: acrescente à mão o bloco de Caddyfile.exemplo"
elif grep -q "$DOMINIO" "$ARQ"; then
  echo "CADDY_JA_TINHA"
else
  cp -p "$ARQ" "$ARQ.bak-gm-$(date +%Y%m%d%H%M%S)"
  # ">>" grava no mesmo arquivo (mesmo inode): o Caddyfile é montado como arquivo no contêiner do Caddy
  printf '\n%s {\n    encode gzip\n    reverse_proxy painel-gm-consultoria:3110\n}\n' "$DOMINIO" >> "$ARQ"
  if docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
     && docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "CADDY_OK"
  else
    cp -p "$(ls -t "$ARQ".bak-gm-* | head -1)" "$ARQ"
    echo "CADDY_FALHOU: Caddyfile restaurado; veja docker logs $CADDY"
  fi
fi

. ./.env
echo "PAINEL=https://$DOMINIO"
echo "USUARIO=${PAINEL_USUARIO:-gm}"
[ "$NOVO_ENV" = 1 ] && echo "SENHA=$PAINEL_SENHA"
echo "MCP_TOKEN=$MCP_TOKEN"
