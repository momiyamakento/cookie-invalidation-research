$ErrorActionPreference = 'Stop'
$diagnosticRoot = Join-Path (Get-Location) ('evaluation/results/causal-diagnostics-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $diagnosticRoot | Out-Null
$conditions = @(
 '1,50,light,baseline', '1,100,heavy,baseline', '1,50,medium,baseline', '1,100,light,baseline', '1,100,medium,baseline',
 '2,100,medium,baseline', '2,100,light,baseline', '2,50,medium,baseline', '2,100,heavy,baseline', '2,50,light,baseline',
 '1,100,light,force-gc', '1,100,heavy,force-gc', '1,100,heavy,paced', '1,100,light,paced'
)
Set-Content -LiteralPath (Join-Path $diagnosticRoot 'conditions.json') -Value (ConvertTo-Json $conditions)
Write-Output "RESULT_ROOT=$diagnosticRoot"
foreach ($condition in $conditions) {
 $parts = $condition.Split(',')
 $conditionDirectory = Join-Path $diagnosticRoot ($condition.Replace(',','-'))
 New-Item -ItemType Directory -Path $conditionDirectory | Out-Null
 Write-Output "START $condition"
 & node --expose-gc --import tsx evaluation/diagnostics/run-condition.ts $conditionDirectory $parts[1] $parts[2] $parts[3] 30 *> (Join-Path $conditionDirectory 'run.log')
 if ($LASTEXITCODE -ne 0) { throw "Diagnostic failed: $conditionDirectory" }
 Get-Content -LiteralPath (Join-Path $conditionDirectory 'run.log') -Tail 1
}
Write-Output "COMPLETE $diagnosticRoot"
