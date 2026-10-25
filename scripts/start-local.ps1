param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$corePath = Split-Path -Parent $PSScriptRoot
$systemPath = Join-Path (Split-Path -Parent $corePath) 'agendaspro-system'
$nodePath = (Get-Command node).Source
$logPath = Join-Path $corePath 'logs'
New-Item -ItemType Directory -Path $logPath -Force | Out-Null
Push-Location $corePath
try {
    docker compose up -d --wait
    if ($LASTEXITCODE) { throw 'Não foi possível iniciar o MariaDB.' }
    npm run db:migrate
    if ($LASTEXITCODE) { throw 'Falha na migração.' }
    if (-not $SkipBuild) {
        Push-Location $systemPath
        try {
            npm run build
            if ($LASTEXITCODE) { throw 'Falha na compilação da interface.' }
        } finally { Pop-Location }
    }
    $processes = @{}
    $processFile = Join-Path $corePath '.local-processes.json'
    if (Test-Path -LiteralPath $processFile) {
        $processes = Get-Content -Raw -LiteralPath $processFile | ConvertFrom-Json -AsHashtable
    }
    if (-not (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) {
        $apiProcess = Start-Process -FilePath $nodePath -ArgumentList 'server.js' -WorkingDirectory $corePath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logPath 'api.log') -RedirectStandardError (Join-Path $logPath 'api-error.log') -PassThru
        $processes.api = $apiProcess.Id
    }
    if (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)) {
        $webProcess = Start-Process -FilePath $nodePath -ArgumentList '.output/server/index.mjs' -WorkingDirectory $systemPath -Environment @{ PORT = '8080'; HOST = '127.0.0.1'; NUXT_PUBLIC_API_BASE = 'http://localhost:3001' } -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logPath 'web.log') -RedirectStandardError (Join-Path $logPath 'web-error.log') -PassThru
        $processes.web = $webProcess.Id
    }
    $processes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $corePath '.local-processes.json')
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/health' -TimeoutSec 5
            $web = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/entrar' -UseBasicParsing -TimeoutSec 5
            if ($health.database -eq 'ok' -and $web.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw "Os serviços não ficaram prontos. Consulte $logPath." }
    Write-Output 'Sistema disponível em http://localhost:8080 — API e MariaDB conectados.'
} finally { Pop-Location }
