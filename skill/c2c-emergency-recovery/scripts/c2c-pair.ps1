param(
    [Parameter(Mandatory = $true)][ValidateSet('WAIT_PAIR_CODE_GENERATION')][string]$RecoveryState,
    [Parameter(Mandatory = $true)][string]$TargetProfile,
    [string]$WorkspacePath = "",
    [string]$StateDir = "",
    [string]$C2cJs = ""
)

. "$PSScriptRoot\_common.ps1" -TargetProfile $TargetProfile -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs

try {
    $statusScript = Join-Path $PSScriptRoot 'c2c-status.ps1'
    $preflight = (& $statusScript -TargetProfile $TargetProfile -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RecoveryState $RecoveryState -TransitionEvent 'PAIR_CODE_GENERATION_REQUESTED' | ConvertFrom-Json)
    if ($preflight.state -ne 'GENERATING_PAIR_CODE') {
        [ordered]@{ ok = $false; state = 'INVALID_RECOVERY_TRANSITION'; nextAction = 'INVALID_RECOVERY_TRANSITION' } | ConvertTo-Json -Compress
        return
    }
    $pairing = Invoke-C2CJson -C2CArgs @('pair', '--workspace', $WorkspacePath, '--json')
    if ($pairing.ok -ne $true -or [string]::IsNullOrWhiteSpace($pairing.pairingCode)) {
        $failure = (& $statusScript -TargetProfile $TargetProfile -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RecoveryState $preflight.state -TransitionEvent 'PAIR_CODE_GENERATION_FAILED' | ConvertFrom-Json)
        [ordered]@{ ok = $false; state = $failure.state; nextAction = $failure.nextAction; error = 'Pair-code generation failed.' } | ConvertTo-Json -Compress
        return
    }
    $transition = (& $statusScript -TargetProfile $TargetProfile -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RecoveryState $preflight.state -TransitionEvent 'PAIR_CODE_GENERATED' | ConvertFrom-Json)
    if ($transition.state -ne 'WAIT_PAIRING_COMPLETE') { throw 'Invalid recovery pairing transition.' }
    [ordered]@{
        ok = $pairing.ok
        state = $transition.state
        nextAction = $transition.nextAction
        pairingCode = $pairing.pairingCode
        expiresAt = $pairing.expiresAt
    } | ConvertTo-Json -Compress
}
catch {
    $failureState = 'LOCAL_RECOVERY_FAILED'
    if ($preflight.state -eq 'GENERATING_PAIR_CODE') {
        $failure = (& $statusScript -TargetProfile $TargetProfile -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $C2cJs -RecoveryState $preflight.state -TransitionEvent 'PAIR_CODE_GENERATION_FAILED' | ConvertFrom-Json)
        $failureState = $failure.state
    }
    [ordered]@{ ok = $false; state = $failureState; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
