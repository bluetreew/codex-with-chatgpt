param(
    [string]$WorkspacePath = (Get-Location).Path,
    [string]$StateDir = "",
    [string]$C2cJs = "",
    [ValidateSet("standard", "capable")][string]$RunContext = "standard",
    [bool]$CapableContextAttempted = $false,
    [string]$RecoveryState = "",
    [string]$TransitionEvent = "",
    [string]$ActualConnectorName = "",
    [string]$RequestedMcpUrl = "",
    [switch]$ConnectorConfirmed,
    [ValidateSet("LOCAL_DIAGNOSIS", "ENDPOINT_COMPARE", "POST_RECOVERY_VERIFY")][string]$Phase = "",
    [string]$WorkspaceInfoName = "",
    [string]$WorkspaceInfoId = "",
    [string]$SavedChatUrlAfter = "",
    [string]$CheckId = "",
    [string]$ReplyCheckId = "",
    [switch]$StartNewRecovery,
    [switch]$AuthorizeRestart
)

. "$PSScriptRoot\_common.ps1" -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs

$sessionResult = Invoke-C2CJson -C2CArgs @('session', '--workspace', $WorkspacePath, '--json')
$workspace = Invoke-C2CJson -C2CArgs @('workspace', '--workspace', $WorkspacePath, '--json')
$bridgeStatus = Invoke-C2CJson -C2CArgs @('status', '--workspace', $WorkspacePath, '--json')
$doctor = Invoke-C2CJson -C2CArgs @('doctor', '--workspace', $WorkspacePath, '--no-fix', '--json')
$probe = Invoke-C2CJson -C2CArgs @('recovery-probe', '--workspace', $WorkspacePath, '--json')

$facts = [ordered]@{
    workspace = [ordered]@{ workspaceId = $workspace.workspaceId; name = $workspace.name }
    session = Get-RecoverySessionSnapshot $sessionResult
    doctor = $doctor
    bridgeStatus = $probe.bridgeStatus
    localProbe = $probe.localProbe
    bridgeProbe = $probe.bridgeProbe
    bridgeProbeError = $probe.bridgeProbeError
    executionContext = $RunContext
    capableContextAttempted = $CapableContextAttempted
}
if ($RecoveryState) { $facts['recoveryState'] = $RecoveryState }
if ($TransitionEvent) { $facts['transitionEvent'] = $TransitionEvent }
if ($ActualConnectorName) { $facts['actualConnectorName'] = $ActualConnectorName }
if ($RequestedMcpUrl) { $facts['requestedMcpUrl'] = $RequestedMcpUrl }
if ($ConnectorConfirmed) { $facts['connectorConfirmed'] = $true }
if ($Phase) { $facts['phase'] = $Phase }
if ($WorkspaceInfoName -or $WorkspaceInfoId) {
    $facts['workspaceInfo'] = [ordered]@{ workspaceName = $WorkspaceInfoName; workspaceId = $WorkspaceInfoId }
    $facts['checkRoundTrip'] = [ordered]@{ checkId = $CheckId; replyCheckId = $ReplyCheckId; workspaceName = $WorkspaceInfoName; workspaceId = $WorkspaceInfoId }
}
if ($SavedChatUrlAfter) { $facts['savedChatUrlAfter'] = $SavedChatUrlAfter }
if ($Phase -eq 'POST_RECOVERY_VERIFY') { $facts['sessionAfter'] = Get-RecoverySessionSnapshot $sessionResult }
$steps = @()
$plan = $null
for ($stepIndex = 0; $stepIndex -lt 3; $stepIndex++) {
    $factsJson = ConvertTo-Json -InputObject $facts -Depth 30 -Compress
    $factsBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($factsJson))
    $planArgs = @('recovery-plan', '--workspace', $WorkspacePath, '--facts-base64', $factsBase64, '--json')
    if ($StartNewRecovery -and $stepIndex -eq 0) { $planArgs += '--new-run' }
    if ($AuthorizeRestart -and $stepIndex -eq 0) { $planArgs += '--authorize-restart' }
    $plan = Invoke-C2CJson -C2CArgs $planArgs
    $steps += $plan
    if ($plan.nextAction -ne 'COMPARE_ENDPOINT') { break }
    $facts['phase'] = 'ENDPOINT_COMPARE'
}

[ordered]@{
    ok = $plan.ok
    state = $plan.state
    nextAction = $plan.nextAction
    humanActionRequired = $plan.humanActionRequired
    workspace = $facts.workspace
    session = $facts.session
    bridge = $doctor.report.bridge
    localMcp = $doctor.report.mcp
    oauth = $doctor.report.oauth
    tunnel = $doctor.report.tunnel
    publicEndpoint = if ($doctor.report.tunnel.ok -eq $true) { 'PASS' } else { 'FAIL' }
    currentMcpUrl = $doctor.chatgptRepair.mcpUrl
    confirmedMcpUrl = $doctor.chatgptRepair.previousMcpUrl
    connectorAction = $doctor.chatgptRepair.connectorAction
    connectorName = $sessionResult.session.connectorName
    probe = $probe
    transitions = $steps
    planFacts = $plan.facts
} | ConvertTo-Json -Depth 30 -Compress
