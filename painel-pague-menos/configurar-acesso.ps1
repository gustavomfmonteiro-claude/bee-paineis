# Grava o acesso da API da Bee no .env da VPS (permissão 600) e reinicia só o container deste painel.
# A senha é digitada aqui, sem aparecer na tela, e não fica em nenhum arquivo deste computador.
$ErrorActionPreference = 'Stop'
$usuario = Read-Host 'Usuario da API da Bee [comercialfortaleza]'
if (-not $usuario) { $usuario = 'comercialfortaleza' }
$seg = Read-Host 'Senha (nao aparece ao digitar)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seg)
try { $senha = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$senha = $senha.Trim()   # colar costuma trazer um espaço ou quebra de linha junto
if (-not $senha) { throw 'Senha vazia: nada foi alterado.' }
# Confere antes de enviar: cada envio é uma tentativa de login na API.
if ($senha.Length -ne 12) {
  $ok = Read-Host "Voce digitou $($senha.Length) caracteres, e a senha atual tem 12. Enviar mesmo assim? [s/N]"
  if ($ok -notmatch '^[sS]') { $senha = $null; Write-Host 'Nada foi enviado. Rode o script de novo.'; exit 1 }
}

$conteudo = "BEE_API_BASE_URL=https://api-monitor.beedelivery.com.br/api`nBEE_API_USERNAME=$usuario`nBEE_API_PASSWORD=$senha`nPORT=3070`nKPI_MINUTOS=5`nBUSCA_SEGUNDOS=60`n"
$conteudo | ssh -o BatchMode=yes bee-vps "umask 077; cp -p /opt/painel-pague-menos/.env /opt/painel-pague-menos/.env.bak-acesso-`$(date +%Y%m%d%H%M%S); cat > /opt/painel-pague-menos/.env; chmod 600 /opt/painel-pague-menos/.env; docker restart painel-pague-menos >/dev/null && echo ACESSO_GRAVADO"
$senha = $null; $conteudo = $null
if ($LASTEXITCODE -ne 0) { throw 'Nao consegui gravar o acesso na VPS.' }
Write-Host 'Pronto. O painel esta coletando os dados; pode voltar para o Claude.'
