param(
    [Parameter(Mandatory = $true)][ValidateSet('AI_CONFIRM_CONNECTOR')][string]$RecoveryState,
    [Parameter(Mandatory = $true)][string]$ConnectorName,
    [Parameter(Mandatory = $true)][string]$McpUrl,
    [string]$WorkspacePath = (Get-Location).Path,
    [string]$StateDir = "",
    [string]$C2cJs = ""
)

. "$PSScriptRoot\_common.ps1" -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs

$statusScript = Join-Path $PSScriptRoot 'c2c-status.ps1'
$before = $null
$preflight = $null
$sessionNameChanged = $false
$endpointConfirmationSucceeded = $false
$rollbackSucceeded = $true
try {
    $preflight = (& $statusScript -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RecoveryState $RecoveryState -TransitionEvent 'CONNECTOR_CONFIRM_REQUESTED' -RequestedMcpUrl $McpUrl -ActualConnectorName $ConnectorName | ConvertFrom-Json)
    if ($preflight.state -ne 'CONFIRMING_CONNECTOR') {
        [ordered]@{ ok = $false; state = 'INVALID_RECOVERY_TRANSITION'; nextAction = 'INVALID_RECOVERY_TRANSITION' } | ConvertTo-Json -Compress
        return
    }
    $before = Invoke-C2CJson -C2CArgs @('session', '--workspace', $WorkspacePath, '--json')
    Invoke-C2C -C2CArgs @('session', 'set', '--workspace', $WorkspacePath, '--connector-name', $ConnectorName) | Out-Null
    $sessionNameChanged = $true
    try {
        $confirmed = Invoke-C2CJson -C2CArgs @('connector-confirm', '--workspace', $WorkspacePath, '--mcp-url', $McpUrl, '--json')
        $endpointConfirmationSucceeded = $true
    }
    catch {
        try {
            Invoke-C2C -C2CArgs @('session', 'set', '--workspace', $WorkspacePath, '--connector-name', $before.session.connectorName) | Out-Null
            $sessionNameChanged = $false
        }
        catch { $rollbackSucceeded = $false }
        throw
    }
    $doctor = Invoke-C2CJson -C2CArgs @('doctor', '--workspace', $WorkspacePath, '--no-fix', '--json')
    $workspace = Invoke-C2CJson -C2CArgs @('workspace', '--workspace', $WorkspacePath, '--json')
    $after = Invoke-C2CJson -C2CArgs @('session', '--workspace', $WorkspacePath, '--json')
    $metadataPreserved = Test-RecoverySessionPreserved -Before $before -After $after -AllowConnectorNameChange
    $nameUpdated = $after.session.connectorName -ceq $ConnectorName
    $localPass = $true
    foreach ($checkName in @('node', 'sandbox', 'workspace', 'bridge', 'mcp', 'oauth', 'tunnel')) {
        $checkResult = $doctor.report.PSObject.Properties[$checkName].Value
        if ($null -eq $checkResult -or $checkResult.ok -ne $true) { $localPass = $false }
    }
    $endpointConfirmed = $confirmed.mcpUrl -eq $McpUrl -and $doctor.chatgptRepair.needed -ne $true
    $transitionEvent = if (-not $metadataPreserved) { 'SESSION_PRESERVATION_FAILED' } elseif ($endpointConfirmed -and $nameUpdated -and $localPass) { 'CONNECTOR_CONFIRMED' } else { 'CONNECTOR_CONFIRMATION_FAILED' }
    $transition = (& $statusScript -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RecoveryState $preflight.state -TransitionEvent $transitionEvent -ActualConnectorName $after.session.connectorName -ConnectorConfirmed:$($transitionEvent -eq 'CONNECTOR_CONFIRMED') | ConvertFrom-Json)
    $ok = $endpointConfirmed -and $metadataPreserved -and $nameUpdated -and $localPass -and $transition.state -eq 'POST_RECOVERY_VERIFY'
    [ordered]@{
        ok = $ok
        state = $transition.state
        connectorConfirmed = $endpointConfirmed
        connectorName = $after.session.connectorName
        mcpUrl = $confirmed.mcpUrl
        sessionMetadataPreserved = $metadataPreserved
        connectorNameUpdated = $nameUpdated
        localHealthPass = $localPass
        recoveryState = $transition.state
        sessionRollbackSucceeded = $rollbackSucceeded
        workspace = [ordered]@{ name = $workspace.name; workspaceId = $workspace.workspaceId }
    } | ConvertTo-Json -Depth 10 -Compress
}
catch {
    $terminalState = 'LOCAL_RECOVERY_FAILED'
    if ($preflight.state -eq 'CONFIRMING_CONNECTOR') {
        if ($sessionNameChanged -and -not $endpointConfirmationSucceeded -and $before) {
            try {
                Invoke-C2C -C2CArgs @('session', 'set', '--workspace', $WorkspacePath, '--connector-name', $before.session.connectorName) | Out-Null
                $rollbackSucceeded = $true
            }
            catch { $rollbackSucceeded = $false }
        }
        try {
            $failureEvent = if (-not $rollbackSucceeded) { 'SESSION_PRESERVATION_FAILED' } else { 'CONNECTOR_CONFIRMATION_FAILED' }
            $failed = (& $statusScript -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RecoveryState $preflight.state -TransitionEvent $failureEvent | ConvertFrom-Json)
            $terminalState = $failed.state
        }
        catch { $terminalState = 'LOCAL_RECOVERY_FAILED' }
    }
    [ordered]@{ ok = $false; state = $terminalState; error = $_.Exception.Message; sessionRollbackSucceeded = $rollbackSucceeded } | ConvertTo-Json -Compress
}
