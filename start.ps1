param([switch]$Check)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
# 대형 파일은 파트 합계가 GB 단위로 간다. 기본 힙(약 4GB)으로는 ZIP 조립에서 죽는다.
$env:NODE_OPTIONS = "$($env:NODE_OPTIONS) --max-old-space-size=8192".Trim()

$WebUrl = "http://127.0.0.1:5173/figma"
$PluginCode = Join-Path $ProjectRoot "plugins\figma-trace\dist\code.js"
$PluginUi = Join-Path $ProjectRoot "plugins\figma-trace\dist\ui.html"
$Tsx = Join-Path $ProjectRoot "node_modules\.bin\tsx.cmd"
$Vite = Join-Path $ProjectRoot "node_modules\.bin\vite.cmd"

Set-Location $ProjectRoot
if (-not (Test-Path $Tsx) -or -not (Test-Path $Vite) -or -not (Test-Path $PluginCode) -or -not (Test-Path $PluginUi)) {
  if ($Check) {
    Write-Error "실행 준비가 되지 않았습니다. setup.ps1을 먼저 실행해 주세요."
    exit 1
  }
  & (Join-Path $ProjectRoot "setup.ps1") -NonInteractive
}

if ($Check) {
  Write-Host "MCP Trace Studio 실행 준비 완료"
  Write-Host "URL: $WebUrl"
  exit 0
}

Start-Job -ScriptBlock {
  param($Url)
  for ($Attempt = 0; $Attempt -lt 80; $Attempt++) {
    try {
      $Response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1
      if ($Response.StatusCode -eq 200) { Start-Process $Url; return }
    } catch { Start-Sleep -Milliseconds 500 }
  }
} -ArgumentList $WebUrl | Out-Null

Write-Host "MCP Trace Studio를 시작합니다. 종료하려면 Control-C를 누르세요."
& npm run dev
