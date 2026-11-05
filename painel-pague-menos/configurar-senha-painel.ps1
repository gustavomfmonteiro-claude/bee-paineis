# Cria o login de quem abre o painel. Na VPS ficam só os hashes, em .env com permissão 600.
# A senha é digitada aqui, sem aparecer na tela, e não fica em nenhum arquivo deste computador.
# Também gera o acesso do relatório das 23:00, salvo em ~\.bee_painel_pm_token.
$ErrorActionPreference = 'Stop'

function Ler-Senha($texto) {
  $seg = Read-Host $texto -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seg)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Em-Hex($bytes) { return (-join ($bytes | ForEach-Object { $_.ToString('x2') })) }

$usuario = Read-Host 'Usuario para entrar no painel [bee]'
if (-not $usuario) { $usuario = 'bee' }
if ($usuario -notmatch '^[A-Za-z0-9._-]{3,40}$') { throw 'Use so letras, numeros, ponto, hifen ou sublinhado, de 3 a 40 caracteres.' }

$senha = Ler-Senha 'Escolha a senha do painel, com 10 caracteres ou mais (nao aparece ao digitar)'
if ($senha.Length -lt 10) { $senha = $null; throw 'Senha curta: nada foi alterado.' }
$repete = Ler-Senha 'Digite a mesma senha de novo'
if ($senha -cne $repete) { $senha = $null; $repete = $null; throw 'As senhas nao conferem: nada foi alterado.' }
$repete = $null

$aleatorio = [Security.Cryptography.RandomNumberGenerator]::Create()
$sal = New-Object byte[] 16; $aleatorio.GetBytes($sal)
$bytes = [Text.Encoding]::UTF8.GetBytes($senha)
$kdf = New-Object Security.Cryptography.Rfc2898DeriveBytes($bytes, $sal, 200000, [Security.Cryptography.HashAlgorithmName]::SHA256)
$hash = Em-Hex $kdf.GetBytes(32)
[Array]::Clear($bytes, 0, $bytes.Length); $senha = $null

$bytesToken = New-Object byte[] 32; $aleatorio.GetBytes($bytesToken)
$token = Em-Hex $bytesToken
$sha = [Security.Cryptography.SHA256]::Create()
$hashToken = Em-Hex $sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($token))

$linhas = "PAINEL_USUARIO=$usuario`nPAINEL_SENHA_SAL=$(Em-Hex $sal)`nPAINEL_SENHA_HASH=$hash`nPAINEL_TOKEN_HASH=$hashToken`n"
$linhas | ssh -o BatchMode=yes bee-vps "umask 077; cd /opt/painel-pague-menos && { grep -v '^PAINEL_' .env > .env.novo; cat >> .env.novo; cat .env.novo > .env; rm -f .env.novo; chmod 600 .env; docker restart painel-pague-menos >/dev/null && echo SENHA_GRAVADA; }"
if ($LASTEXITCODE -ne 0) { throw 'Nao consegui gravar o login na VPS.' }

$arq = Join-Path $env:USERPROFILE '.bee_painel_pm_token'
[IO.File]::WriteAllText($arq, $token)
icacls $arq /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
$token = $null
Write-Host 'Pronto. O painel agora pede usuario e senha; pode voltar para o Claude.'
