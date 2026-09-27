param(
    [string]$WorkspacePath = (Get-Location).Path,
    [string]$StateDir = "",
    [string]$C2cJs = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { throw "WorkspacePath cannot be empty." }
$WorkspacePath = (Resolve-Path -LiteralPath $WorkspacePath).Path

if ([string]::IsNullOrWhiteSpace($StateDir)) {
    if (-not [string]::IsNullOrWhiteSpace($env:C2C_STATE_DIR)) { $StateDir = $env:C2C_STATE_DIR }
    elseif (Test-Path -LiteralPath "D:\app_home\codex-with-chatgpt-state") { $StateDir = "D:\app_home\codex-with-chatgpt-state" }
}
if ([string]::IsNullOrWhiteSpace($StateDir)) { throw "C2C state directory is unresolved." }
$env:C2C_STATE_DIR = $StateDir

if ([string]::IsNullOrWhiteSpace($C2cJs)) {
    if (-not [string]::IsNullOrWhiteSpace($env:C2C_CLI_JS)) { $C2cJs = $env:C2C_CLI_JS }
    elseif (Test-Path -LiteralPath "D:\app_home\codex-with-chatgpt\bin\c2c.js") { $C2cJs = "D:\app_home\codex-with-chatgpt\bin\c2c.js" }
}
if ([string]::IsNullOrWhiteSpace($C2cJs) -or -not (Test-Path -LiteralPath $C2cJs)) {
    throw "C2C CLI is unresolved."
}

$script:NodeExe = (Get-Command node -ErrorAction Stop).Source
$script:C2cCommand = (Resolve-Path -LiteralPath $C2cJs).Path

function Invoke-C2C {
    param([Parameter(Mandatory = $true)][string[]]$C2CArgs)

    $lines = & $script:NodeExe $script:C2cCommand @C2CArgs
    $exitCode = $LASTEXITCODE
    $text = ($lines -join [Environment]::NewLine).Trim()
    if ($exitCode -ne 0) { throw "C2C command failed ($exitCode): $text" }
    return $text
}

function Invoke-C2CJson {
    param([Parameter(Mandatory = $true)][string[]]$C2CArgs)
    $text = Invoke-C2C -C2CArgs $C2CArgs
    return ($text | ConvertFrom-Json)
}

function Get-RecoverySessionSnapshot {
    param([Parameter(Mandatory = $true)]$SessionResult)
    $saved = $SessionResult.session
    return [ordered]@{
        url = $saved.url
        projectUrl = $saved.projectUrl
        workflowMode = $saved.workflowMode
        checkpoint = $saved.checkpoint
        connectorName = $saved.connectorName
        taskId = $saved.taskId
        iteration = $saved.iteration
        lastState = $saved.lastState
    }
}

function Test-RecoverySessionPreserved {
    param(
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$After,
        [switch]$AllowConnectorNameChange
    )
    $beforeSnapshot = Get-RecoverySessionSnapshot $Before
    $afterSnapshot = Get-RecoverySessionSnapshot $After
    if ($AllowConnectorNameChange) {
        $beforeSnapshot.Remove("connectorName")
        $afterSnapshot.Remove("connectorName")
    }
    $beforeJson = ConvertTo-Json -InputObject $beforeSnapshot -Depth 20 -Compress
    $afterJson = ConvertTo-Json -InputObject $afterSnapshot -Depth 20 -Compress
    return $beforeJson -ceq $afterJson
}
