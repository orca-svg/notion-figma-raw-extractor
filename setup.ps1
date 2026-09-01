param(
  [switch]$Check,
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $ProjectRoot "plugins\figma-trace\manifest.json"
$PluginCode = Join-Path $ProjectRoot "plugins\figma-trace\dist\code.js"
$PluginUi = Join-Path $ProjectRoot "plugins\figma-trace\dist\ui.html"

function Fail([string]$Message) {
  Write-Error "설정 실패: $Message"
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js 20.19 이상이 필요합니다." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm을 찾을 수 없습니다." }

$VersionText = (& node -p "process.versions.node").Trim()
$Parts = $VersionText.Split(".")
if ([int]$Parts[0] -lt 20 -or ([int]$Parts[0] -eq 20 -and [int]$Parts[1] -lt 19)) {
  Fail "현재 Node.js는 $VersionText 입니다. 20.19 이상으로 업데이트해 주세요."
}

Set-Location $ProjectRoot
if (-not $Check) {
  Write-Host "[1/2] 의존성을 설치합니다."
  & npm ci
  if ($LASTEXITCODE -ne 0) { Fail "npm ci가 실패했습니다." }
  Write-Host "[2/2] Figma Plugin을 빌드합니다."
  & npm run build:plugin
  if ($LASTEXITCODE -ne 0) { Fail "Plugin 빌드가 실패했습니다." }
}

foreach ($Required in @($ManifestPath, $PluginCode, $PluginUi)) {
  if (-not (Test-Path $Required -PathType Leaf)) { Fail "필수 파일이 없습니다: $Required" }
}

if (-not $NonInteractive) {
  if (Get-Command Set-Clipboard -ErrorAction SilentlyContinue) { Set-Clipboard $ManifestPath }
  Start-Process explorer.exe -ArgumentList $ManifestPath
}

Write-Host "설정 완료"
Write-Host "Figma Desktop > Plugins > Development > Import plugin from manifest... 에서 다음 파일을 선택하세요:"
Write-Host $ManifestPath
