param(
    [Parameter(Mandatory = $true)][string]$TargetProfile,
    [string]$WorkspacePath = "",
    [string]$StateDir = "",
    [string]$C2cJs = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($TargetProfile)) { throw "TargetProfile cannot be empty." }

if ([string]::IsNullOrWhiteSpace($C2cJs)) {
    if (-not [string]::IsNullOrWhiteSpace($env:C2C_CLI_JS)) { $C2cJs = $env:C2C_CLI_JS }
    elseif (Test-Path -LiteralPath "D:\app_home\codex-with-chatgpt\bin\c2c.js") { $C2cJs = "D:\app_home\codex-with-chatgpt\bin\c2c.js" }
}
if ([string]::IsNullOrWhiteSpace($C2cJs) -or -not (Test-Path -LiteralPath $C2cJs)) {
    throw "C2C CLI is unresolved."
}

$script:NodeExe = (Get-Command node -ErrorAction Stop).Source
$script:C2cCommand = (Resolve-Path -LiteralPath $C2cJs).Path

$previousResolveWorkspace = $env:C2C_PROFILE_RESOLVE_WORKSPACE
$previousResolveState = $env:C2C_PROFILE_RESOLVE_STATE
$env:C2C_PROFILE_RESOLVE_WORKSPACE = $WorkspacePath
$env:C2C_PROFILE_RESOLVE_STATE = $StateDir
$resolvedLines = & $script:NodeExe $script:C2cCommand 'control-target' 'resolve' '--profile' $TargetProfile '--json'
$resolveExitCode = $LASTEXITCODE
$env:C2C_PROFILE_RESOLVE_WORKSPACE = $previousResolveWorkspace
$env:C2C_PROFILE_RESOLVE_STATE = $previousResolveState
$resolvedText = ($resolvedLines -join [Environment]::NewLine).Trim()
if ($resolveExitCode -ne 0) { throw "Target profile resolution failed ($resolveExitCode): $resolvedText" }
$resolvedTarget = $resolvedText | ConvertFrom-Json
if ($resolvedTarget.ok -ne $true -or -not $resolvedTarget.profile) { throw "Target profile resolution failed closed." }
$profileWorkspace = (Resolve-Path -LiteralPath $resolvedTarget.profile.targetWorkspaceRoot).Path
$profileState = [System.IO.Path]::GetFullPath([string]$resolvedTarget.profile.targetStateDir)
if (-not [string]::IsNullOrWhiteSpace($WorkspacePath)) {
    $requestedWorkspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
    if (-not [string]::Equals($requestedWorkspace, $profileWorkspace, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "RECOVERY_TARGET_BINDING_MISMATCH: WorkspacePath differs from TargetProfile."
    }
}
if (-not [string]::IsNullOrWhiteSpace($StateDir)) {
    $requestedState = [System.IO.Path]::GetFullPath($StateDir)
    if (-not [string]::Equals($requestedState, $profileState, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "RECOVERY_TARGET_BINDING_MISMATCH: StateDir differs from TargetProfile."
    }
}
$WorkspacePath = $profileWorkspace
$StateDir = $profileState
$script:TargetProfile = $resolvedTarget.profile.profileId
$env:C2C_RECOVERY_WORKSPACE_ID = $resolvedTarget.profile.workspaceId
$env:C2C_STATE_DIR = $StateDir

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
