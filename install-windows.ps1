param(
  [string]$OrcaCli = (Join-Path $env:LOCALAPPDATA 'Programs\orca\resources\bin\orca.exe')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $OrcaCli -PathType Leaf)) {
  throw '未找到新版 Orca CLI。可用 -OrcaCli 指定 resources\bin\orca.exe 的完整路径。'
}
& $OrcaCli plugin validate $PSScriptRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$loadText = & $OrcaCli plugin dev load $PSScriptRoot --json
$loadCode = $LASTEXITCODE
$loaded = ($loadText -join "`n") | ConvertFrom-Json
if (-not $loaded.ok) {
  Write-Host $loaded.error.message
  $fingerprint = $loaded.error.data.approvalFingerprint
  if (-not $fingerprint) { exit $loadCode }
  $answer = Read-Host '插件将读取本机对话记录并保存插件设置。同意上述权限请填写 yes'
  if ($answer -ne 'yes') { Write-Host '未批准加载。'; exit 3 }
  & $OrcaCli plugin dev load $PSScriptRoot --approve $fingerprint --json
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& $OrcaCli plugin system on
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host '插件已加载。请在右侧活动栏打开「对话 TPS」，并保留当前插件目录。'
