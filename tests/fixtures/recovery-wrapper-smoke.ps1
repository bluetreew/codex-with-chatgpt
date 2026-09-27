param(
    [Parameter(Mandatory = $true)][string]$CommonScript,
    [Parameter(Mandatory = $true)][string]$FakeC2cJs,
    [Parameter(Mandatory = $true)][string]$WorkspacePath,
    [Parameter(Mandatory = $true)][string]$StateDir
)

. $CommonScript -WorkspacePath $WorkspacePath -StateDir $StateDir -C2cJs $FakeC2cJs
Invoke-C2C -C2CArgs @('status', '--workspace', $WorkspacePath, '--json')
