param(
    [string]$WorkspacePath = (Get-Location).Path,
    [string]$StateDir = "",
    [string]$C2cJs = "",
    [ValidateSet("start", "restart")][string]$Action = "start",
    [ValidateSet("standard", "capable")][string]$RunContext = "standard",
    [bool]$CapableContextAttempted = $false
)

. "$PSScriptRoot\_common.ps1" -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs

$statusScript = Join-Path $PSScriptRoot 'c2c-status.ps1'
$preflightText = if ($Action -eq 'restart') {
    & $statusScript -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RunContext $RunContext -CapableContextAttempted $CapableContextAttempted -AuthorizeRestart
} else {
    & $statusScript -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RunContext $RunContext -CapableContextAttempted $CapableContextAttempted
}
$preflight = $preflightText | ConvertFrom-Json
$actionAllowed = if ($Action -eq 'restart') {
    $preflight.nextAction -eq 'RESTART_BRIDGE_IN_CAPABLE_CONTEXT' -and
        $preflight.probe.bridgeStatus -eq 'healthy' -and
        $preflight.probe.bridgeProbe.classification -eq 'RESTRICTED_BRIDGE_CONTEXT' -and
        $preflight.probe.localProbe.classification -eq 'CAPABLE'
} else {
    @('START_BRIDGE_AND_TUNNEL', 'START_TUNNEL') -contains $preflight.nextAction
}
if (-not $actionAllowed) { $preflight | ConvertTo-Json -Depth 30 -Compress; return }

$before = Invoke-C2CJson -C2CArgs @('session', '--workspace', $WorkspacePath, '--json')
$commandResult = $null
$errorText = $null
try {
    if ($Action -eq "restart") {
        $commandResult = Invoke-C2C -C2CArgs @('restart', '--workspace', $WorkspacePath, '--tunnel')
    }
    else {
        $commandResult = Invoke-C2CJson -C2CArgs @('start', '--workspace', $WorkspacePath, '--tunnel', '--json')
    }
}
catch {
    $errorText = $_.Exception.Message
}
$after = Invoke-C2CJson -C2CArgs @('session', '--workspace', $WorkspacePath, '--json')
$preserved = Test-RecoverySessionPreserved -Before $before -After $after

if (-not $preserved) {
    $blockedText = & $statusScript -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs `
        -RecoveryState $preflight.state -TransitionEvent 'SESSION_PRESERVATION_FAILED'
    $blocked = $blockedText | ConvertFrom-Json
    [ordered]@{
        ok = $false
        state = $blocked.state
        nextAction = $blocked.nextAction
        sessionPreserved = $false
        facts = $blocked.planFacts
    } | ConvertTo-Json -Depth 20 -Compress
    return
}

if ($errorText) {
    $errorCode = if ($Action -eq 'restart' -or $errorText -match 'EPERM') { 'EPERM' } else { 'START_FAILED' }
    $workspace = Invoke-C2CJson -C2CArgs @('workspace', '--workspace', $WorkspacePath, '--json')
    $probe = Invoke-C2CJson -C2CArgs @('recovery-probe', '--workspace', $WorkspacePath, '--json')
    $facts = [ordered]@{
        workspace = [ordered]@{ workspaceId = $workspace.workspaceId; name = $workspace.name }
        session = Get-RecoverySessionSnapshot $before
        bridgeStatus = $probe.bridgeStatus
        localProbe = $probe.localProbe
        bridgeProbe = $probe.bridgeProbe
        bridgeProbeError = $probe.bridgeProbeError
        executionContext = $RunContext
        capableContextAttempted = $CapableContextAttempted
        localActionResult = [ordered]@{ ok = $false; errorCode = $errorCode }
    }
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $facts -Depth 30 -Compress)))
    $next = Invoke-C2CJson -C2CArgs @('recovery-plan', '--workspace', $WorkspacePath, '--facts-base64', $encoded, '--json')
    [ordered]@{
        ok = $false
        state = $next.state
        nextAction = $next.nextAction
        humanActionRequired = $false
        errorCode = $errorCode
        sessionPreserved = $preserved
        facts = $next.facts
    } | ConvertTo-Json -Depth 20 -Compress
    return
}

& $statusScript -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RunContext $RunContext -CapableContextAttempted $CapableContextAttempted
