# Publica (ou atualiza) o Painel GM Consultoria + MCP na VPS da Hostinger, pelo mesmo acesso SSH "bee-vps"
# dos outros painéis. Rode no PowerShell, dentro desta pasta:   .\publicar-vps.ps1
# Na primeira vez cria a senha do painel e a chave do MCP; a chave fica também em ~\.gm_mcp_token.
$ErrorActionPreference = 'Stop'
$pasta = $PSScriptRoot
$destino = '/opt/painel-gm-consultoria'
$pacote = Join-Path $env:TEMP 'painel-gm-consultoria.tgz'

ssh -o BatchMode=yes bee-vps "echo ok" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Sem acesso SSH a bee-vps. Confira o ~\.ssh\config usado nos outros paineis.' }

Write-Host 'Empacotando...'
tar -czf $pacote -C $pasta --exclude=dados --exclude=.env --exclude=node_modules package.json server.mjs regras.mjs mcp.mjs Dockerfile docker-compose.yml .dockerignore Caddyfile.exemplo vps public
if ($LASTEXITCODE -ne 0) { throw 'Falha ao empacotar.' }

Write-Host 'Enviando para a VPS...'
scp -q $pacote bee-vps:/tmp/painel-gm-consultoria.tgz
if ($LASTEXITCODE -ne 0) { throw 'Falha no envio.' }
Remove-Item $pacote

Write-Host 'Instalando (docker compose + Caddy)...'
# O tar do Windows grava atributos (SCHILY.fflags) e permissoes do Windows: o tar da VPS ignora os dois,
# e o chmod deixa os arquivos como 644/755 (o .env e a pasta dados continuam fechados).
$extrair = "tar --warning=no-unknown-keyword --no-same-owner --no-same-permissions -xzf /tmp/painel-gm-consultoria.tgz -C $destino"
$saida = ssh -o BatchMode=yes bee-vps "mkdir -p $destino && $extrair && rm /tmp/painel-gm-consultoria.tgz && chmod -R u+w,go-w $destino && sed -i 's/\r$//' $destino/vps/instalar.sh && bash $destino/vps/instalar.sh"
if ($LASTEXITCODE -ne 0) { $saida; throw 'A instalacao falhou na VPS.' }

$valores = @{}
foreach ($l in $saida) { if ($l -match '^([A-Z_]+)=(.*)$') { $valores[$Matches[1]] = $Matches[2] } else { Write-Host "  $l" } }
$token = $valores['MCP_TOKEN']
[IO.File]::WriteAllText((Join-Path $env:USERPROFILE '.gm_mcp_token'), $token)

Write-Host ''
Write-Host "Painel:   $($valores['PAINEL'])   (usuario $($valores['USUARIO']))"
if ($valores['SENHA']) { Write-Host "Senha:    $($valores['SENHA'])   <- anote; ela nao aparece de novo (fica no .env da VPS)" }
Write-Host ''
Write-Host 'Conector do claude.ai (Configuracoes > Conectores > Adicionar conector personalizado):'
Write-Host "  Nome: GM Consultoria"
Write-Host "  URL:  $($valores['PAINEL'])/mcp/$token"
Write-Host ''
Write-Host 'Claude Code:'
Write-Host "  claude mcp add --transport http -s user gm-consultoria $($valores['PAINEL'])/mcp --header `"Authorization: Bearer $token`""
