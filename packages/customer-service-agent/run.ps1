<#
.SYNOPSIS
    One-command launcher for the customer service agent demo.

.DESCRIPTION
    Brings up MySQL in Docker, waits for it to become healthy, applies the database
    migration, ingests the knowledge base, then starts the Commerce API, Agent API and
    customer web client and the desk client in their own windows.

    Model credentials are read from the pi coding agent's models.json
    (~/.pi/agent/models.json), so LLM_API_KEY is only needed when that file is absent.

.PARAMETER Stop
    Stop the three services instead of starting them. The MySQL container keeps running.

.PARAMETER SkipSeed
    Skip the database migration and knowledge ingestion. Use this for plain restarts.

.PARAMETER NoBrowser
    Do not open the web client in the default browser.

.EXAMPLE
    .\run.ps1

.EXAMPLE
    .\run.ps1 -SkipSeed -NoBrowser

.EXAMPLE
    .\run.ps1 -Stop

.NOTES
    If PowerShell refuses to run the file, start it with:
        powershell -ExecutionPolicy Bypass -File .\run.ps1

    Output is intentionally ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as
    ANSI, so non-ASCII text in this file would be mangled.

    ErrorActionPreference stays at "Continue" on purpose. docker and docker compose write
    ordinary progress lines such as "Container ... Running" to stderr; with "Stop" those
    become terminating NativeCommandError exceptions and abort the script. Every external
    step therefore checks $LASTEXITCODE explicitly instead.
#>
[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$SkipSeed,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Continue"

$projectRoot = $PSScriptRoot
$mysqlContainer = "pi-customer-service-mysql-1"
$modelsJson = Join-Path $HOME ".pi/agent/models.json"

# Order matters only for readability; the Agent API retries until Commerce is up.
$services = @(
    [pscustomobject]@{ Name = "Commerce API"; NpmScript = "dev:commerce"; Port = 3101 },
    [pscustomobject]@{ Name = "Agent API";    NpmScript = "dev:agent";    Port = 3100 },
    [pscustomobject]@{ Name = "Web client";   NpmScript = "dev:web";      Port = 5173 },
    [pscustomobject]@{ Name = "Desk client";  NpmScript = "dev:desk";     Port = 5134 }
)

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Detail {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Notice {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor Yellow
}

function Stop-WithError {
    param([string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Get-PortOwner {
    param([int]$Port)
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($connection) { return $connection.OwningProcess }
    return $null
}

function Stop-PortOwner {
    param([int]$Port)
    $owner = Get-PortOwner -Port $Port
    if (-not $owner) { return $false }
    & taskkill.exe /PID $owner /T /F 2>$null | Out-Null
    return $true
}

function Wait-ForHttp {
    param([string]$Url, [int]$TimeoutSeconds = 70)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -UseBasicParsing
            if ($response.StatusCode -eq 200) { return $true }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

if ($Stop) {
    Write-Step "Stopping services"
    foreach ($service in $services) {
        if (Stop-PortOwner -Port $service.Port) {
            Write-Detail "$($service.Name) stopped (port $($service.Port))"
        } else {
            Write-Detail "$($service.Name) was not running"
        }
    }
    Write-Detail "MySQL container left running; stop it with: docker compose stop"
    exit 0
}

Write-Step "Checking prerequisites"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-WithError "node was not found on PATH. Install Node.js 22 or newer."
}
$nodeVersion = (& node --version).TrimStart("v")
if ([version]$nodeVersion -lt [version]"22.19.0") {
    Stop-WithError "Node $nodeVersion is too old; 22.19.0 or newer is required."
}
Write-Detail "node $nodeVersion"

& docker info --format "{{.ServerVersion}}" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Stop-WithError "Docker Desktop is not running. Start it and try again."
}
Write-Detail "docker is running"

if (Test-Path $modelsJson) {
    Write-Detail "model credentials: $modelsJson"
} else {
    Write-Notice "No $modelsJson. The Agent API also accepts LLM_API_KEY in its environment."
}

Push-Location $projectRoot
try {
    Write-Step "Starting MySQL"
    & docker compose up -d 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError "docker compose up failed." }

    Write-Step "Waiting for MySQL to report healthy"
    $deadline = (Get-Date).AddSeconds(120)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
        $status = & docker inspect --format "{{.State.Health.Status}}" $mysqlContainer 2>$null
        if ($status -eq "healthy") { $healthy = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $healthy) { Stop-WithError "MySQL did not become healthy within 120s." }
    Write-Detail "mysql is healthy"

    if ($SkipSeed) {
        Write-Step "Skipping migration and knowledge ingestion (-SkipSeed)"
    } else {
        Write-Step "Applying database migration"
        & npm.cmd run db:migrate
        if ($LASTEXITCODE -ne 0) { Stop-WithError "db:migrate failed." }

        Write-Step "Ingesting knowledge base"
        & npm.cmd run knowledge:ingest
        if ($LASTEXITCODE -ne 0) { Stop-WithError "knowledge:ingest failed." }
    }

    Write-Step "Starting services"
    foreach ($service in $services) {
        $owner = Get-PortOwner -Port $service.Port
        if ($owner) {
            Write-Detail "$($service.Name) already listening on $($service.Port) (pid $owner), left alone"
            continue
        }
        # cmd /k keeps the window open when a service exits with an error, so the reason stays readable.
        $launch = "title $($service.Name) :$($service.Port) && npm.cmd run $($service.NpmScript)"
        Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $launch -WorkingDirectory $projectRoot | Out-Null
        Write-Detail "$($service.Name) launching on port $($service.Port)"
    }
} finally {
    Pop-Location
}

Write-Step "Waiting for services to answer"
$commerceReady = Wait-ForHttp -Url "http://127.0.0.1:3101/health"
$agentReady = Wait-ForHttp -Url "http://127.0.0.1:3100/health"
$webReady = Wait-ForHttp -Url "http://127.0.0.1:5173/" -TimeoutSeconds 40
$deskReady = Wait-ForHttp -Url "http://127.0.0.1:5134/" -TimeoutSeconds 40

if (-not $commerceReady) { Write-Notice "Commerce API did not answer on 3101" }
if (-not $agentReady) { Write-Notice "Agent API did not answer on 3100 (check its window for the reason)" }
if (-not $webReady) { Write-Notice "Web client did not answer on 5173" }
if (-not $deskReady) { Write-Notice "Desk client did not answer on 5134" }

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Customer service demo is running" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Web client      http://127.0.0.1:5173   (customer)"
Write-Host "  Desk client     http://127.0.0.1:5134   (operator)"
Write-Host "  Agent API       http://127.0.0.1:3100/health"
Write-Host "  Commerce API    http://127.0.0.1:3101/health"
Write-Host "  MySQL           127.0.0.1:3307   (user pi / password pi)"
Write-Host ""
Write-Host "  Each service runs in its own window; close it or press Ctrl+C there to stop one."
Write-Host "  Stop everything:  .\run.ps1 -Stop"
Write-Host ""

if (-not $NoBrowser -and $webReady) {
    Start-Process "http://127.0.0.1:5173"
}
