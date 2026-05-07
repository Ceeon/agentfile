param(
    [ValidateSet("doctor", "status", "diagnose", "install", "run", "build", "update", "reset-dev-data")]
    [string]$Action = "status"
)

$ErrorActionPreference = "Stop"

$DefaultRepoUrl = "https://github.com/Ceeon/agentfile.git"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EmbeddedRepo = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir "..\..\..\.."))

function Write-AgentfileLog {
    param([string]$Message)
    Write-Host "[agentfile-dev] $Message"
}

function Stop-Agentfile {
    param([string]$Message)
    Write-Error "[agentfile-dev] error: $Message"
    exit 1
}

function Test-AgentfileRepo {
    param([string]$Path)
    $taskFile = Join-Path $Path "Taskfile.yml"
    $packageFile = Join-Path $Path "package.json"
    if (!(Test-Path $taskFile) -or !(Test-Path $packageFile)) {
        return $false
    }
    return (Select-String -Path $packageFile -Pattern '"name": "(agentfile|waveterm)"' -Quiet)
}

function Require-Command {
    param([string]$Name)
    if (!(Get-Command $Name -ErrorAction SilentlyContinue)) {
        Stop-Agentfile "missing command: $Name"
    }
}

function Invoke-Checked {
    param(
        [string]$Command,
        [string[]]$Arguments = @()
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

function Test-WindowsAmd64 {
    return $env:OS -eq "Windows_NT" -and (($env:PROCESSOR_ARCHITECTURE -eq "AMD64") -or ($env:PROCESSOR_ARCHITEW6432 -eq "AMD64"))
}

function Get-RunTask {
    if (Test-WindowsAmd64) {
        return "electron:winquickdev"
    }
    return "dev"
}

function Get-BackendTask {
    if (Test-WindowsAmd64) {
        return "build:backend:quickdev:windows"
    }
    return "build:backend"
}

function Get-DevDataPath {
    if ($env:LOCALAPPDATA) {
        return (Join-Path $env:LOCALAPPDATA "waveterm2-dev\Data")
    }
    return "%LOCALAPPDATA%\waveterm2-dev\Data"
}

function Get-DevConfigPath {
    return (Join-Path $HOME ".config\waveterm2-dev")
}

function Ensure-Tools {
    Require-Command git
    Require-Command node
    Require-Command npm
    Require-Command go
    Require-Command task
}

$Repo = $env:AGENTFILE_REPO
$RepoUrl = if ($env:AGENTFILE_REPO_URL) { $env:AGENTFILE_REPO_URL } else { $DefaultRepoUrl }
$CloneDepth = if ($env:AGENTFILE_CLONE_DEPTH) { $env:AGENTFILE_CLONE_DEPTH } else { "1" }
$ConfirmReset = $env:AGENTFILE_CONFIRM_RESET

if (!$Repo) {
    if (Test-AgentfileRepo (Get-Location).Path) {
        $Repo = (Get-Location).Path
    } elseif (Test-AgentfileRepo $EmbeddedRepo) {
        $Repo = $EmbeddedRepo
    } else {
        $Repo = Join-Path $HOME "Desktop\Agentfile"
    }
}

function Ensure-Repo {
    Ensure-Tools
    if (!(Test-Path (Join-Path $Repo ".git"))) {
        Write-AgentfileLog "repo not found: $Repo"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Repo) | Out-Null
        if ($CloneDepth -and $CloneDepth -ne "0") {
            Write-AgentfileLog "cloning $RepoUrl (depth=$CloneDepth)"
            & git clone --depth $CloneDepth $RepoUrl $Repo
            if ($LASTEXITCODE -ne 0) {
                Write-AgentfileLog "shallow clone failed; retrying full clone"
                Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $Repo
                Invoke-Checked git @("clone", $RepoUrl, $Repo)
            }
        } else {
            Write-AgentfileLog "cloning $RepoUrl"
            Invoke-Checked git @("clone", $RepoUrl, $Repo)
        }
    }
    Set-Location $Repo
    if (!(Test-AgentfileRepo (Get-Location).Path)) {
        Stop-Agentfile "not an Agentfile repo: $Repo"
    }
}

function Ensure-ExistingRepo {
    Ensure-Tools
    if (!(Test-Path (Join-Path $Repo ".git"))) {
        Stop-Agentfile "repo not found: $Repo (run install first)"
    }
    Set-Location $Repo
    if (!(Test-AgentfileRepo (Get-Location).Path)) {
        Stop-Agentfile "not an Agentfile repo: $Repo"
    }
}

function Get-DevLogPath {
    return (Join-Path (Get-DevDataPath) "waveapp.log")
}

function Test-RendererUp {
    try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://localhost:5173/" | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Write-RepoStatus {
    $branch = git branch --show-current
    Write-AgentfileLog "branch: $branch"
    $dirty = git status --short
    if ($dirty) {
        Write-AgentfileLog "working tree: dirty"
        $dirty | Select-Object -First 40 | Write-Output
    } else {
        Write-AgentfileLog "working tree: clean"
    }
}

function Write-ProcessStatus {
    Get-Process | Where-Object {
        $_.ProcessName -match "electron|wavesrv|node" -and $_.Path -and $_.Path.StartsWith($Repo)
    } | Select-Object Id, ProcessName, Path | Format-Table -AutoSize
}

function Write-LogStatus {
    $logPath = Get-DevLogPath
    if (!(Test-Path $logPath)) {
        Write-AgentfileLog "log: not found ($logPath)"
        return
    }
    Write-AgentfileLog "log: $logPath"
    Write-AgentfileLog "recent suspicious log lines:"
    Get-Content $logPath -Tail 200 | Select-String -Pattern "error|panic|failed|exception|fatal" | Select-Object -Last 20
}

function Invoke-Doctor {
    Ensure-Tools
    Write-AgentfileLog "node: $(node -v)"
    Write-AgentfileLog "npm: $(npm -v)"
    Write-AgentfileLog "go: $(go version)"
    Write-AgentfileLog "task: $(task --version)"
    Write-AgentfileLog "repo: $Repo"
    Write-AgentfileLog "repo url: $RepoUrl"
    Write-AgentfileLog "dev data: $(Get-DevDataPath)"
    Write-AgentfileLog "dev config: $(Get-DevConfigPath)"
    Write-AgentfileLog "run task: task $(Get-RunTask)"
}

function Invoke-Status {
    Ensure-ExistingRepo
    Invoke-Doctor
    Write-RepoStatus
    if (Test-RendererUp) {
        Write-AgentfileLog "renderer: reachable at http://localhost:5173/"
    } else {
        Write-AgentfileLog "renderer: not reachable at http://localhost:5173/"
    }
    Write-AgentfileLog "processes:"
    Write-ProcessStatus
    Write-LogStatus
}

function Invoke-Diagnose {
    Invoke-Status
    Write-AgentfileLog "building Electron dev bundle"
    Invoke-Checked npm @("run", "build:dev")
}

function Invoke-Install {
    Ensure-Repo
    Write-AgentfileLog "installing npm modules"
    Invoke-Checked npm @("install")
    Write-AgentfileLog "tidying Go modules"
    Invoke-Checked go @("mod", "tidy")
    $backendTask = Get-BackendTask
    Write-AgentfileLog "building backend with: task $backendTask"
    Invoke-Checked task @($backendTask)
}

function Invoke-Run {
    Ensure-Repo
    $runTask = Get-RunTask
    if (Test-RendererUp) {
        Write-AgentfileLog "renderer already reachable at http://localhost:5173/; skipping duplicate dev server"
        Invoke-Status
        return
    }
    Write-AgentfileLog "starting Agentfile dev with: task $runTask"
    Write-AgentfileLog "this uses the local waveterm2-dev data directory"
    & task $runTask
    exit $LASTEXITCODE
}

function Invoke-Build {
    Ensure-Repo
    Write-AgentfileLog "building Electron dev bundle"
    Invoke-Checked npm @("run", "build:dev")
}

function Invoke-Update {
    Ensure-Repo
    $dirty = git status --short
    if ($dirty) {
        $dirty | Select-Object -First 80 | Write-Output
        $total = @($dirty).Count
        if ($total -gt 80) {
            Write-AgentfileLog "... omitted $($total - 80) more dirty paths"
        }
        Stop-Agentfile "working tree is dirty; commit/stash or use another checkout before updating"
    }
    Invoke-Checked git @("pull", "--ff-only")
}

function Invoke-ResetDevData {
    if ($ConfirmReset -ne "1") {
        Stop-Agentfile "set AGENTFILE_CONFIRM_RESET=1 to delete dev data"
    }
    Remove-Item -Force -Recurse -ErrorAction SilentlyContinue (Get-DevDataPath), (Get-DevConfigPath)
    Write-AgentfileLog "deleted waveterm2-dev data/config"
}

switch ($Action) {
    "doctor" { Invoke-Doctor }
    "status" { Invoke-Status }
    "diagnose" { Invoke-Diagnose }
    "install" { Invoke-Install }
    "run" { Invoke-Run }
    "build" { Invoke-Build }
    "update" { Invoke-Update }
    "reset-dev-data" { Invoke-ResetDevData }
}
