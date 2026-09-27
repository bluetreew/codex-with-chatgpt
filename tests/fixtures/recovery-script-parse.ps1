param([Parameter(Mandatory = $true)][string]$ScriptsRoot)

$parseErrors = @()
Get-ChildItem -LiteralPath $ScriptsRoot -Filter '*.ps1' -File | ForEach-Object {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    foreach ($errorRecord in $errors) {
        $parseErrors += [ordered]@{ file = $_.Name; message = $errorRecord.Message; line = $errorRecord.Extent.StartLineNumber }
    }
}
if ($parseErrors.Count -gt 0) {
    [ordered]@{ ok = $false; errors = $parseErrors } | ConvertTo-Json -Depth 5 -Compress
    exit 1
}
[ordered]@{ ok = $true; parsed = (Get-ChildItem -LiteralPath $ScriptsRoot -Filter '*.ps1' -File).Count } | ConvertTo-Json -Compress
