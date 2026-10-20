# open-firewall.ps1 — let phones on the hotspot (or the same Wi-Fi) reach the testbed.
#
# Run once, in PowerShell opened with "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File scripts\windows\open-firewall.ps1
#
# Opens TCP 8080 (department page, load, probes) and, with -IncludeProxy, 8888, for the local
# subnet only. Port 9090 (gateway control API) is never opened: it listens on 127.0.0.1 only.
# Undo with close-firewall.ps1.
param(
  [switch]$IncludeProxy,
  [switch]$IncludeDashboard
)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Please run this in PowerShell opened with 'Run as administrator'." -ForegroundColor Yellow
  exit 1
}

function Open-Port([string]$Name, [int]$Port, [string]$What) {
  # Re-running the script must not pile up duplicate rules.
  Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $Name -Direction Inbound -Protocol TCP -LocalPort $Port `
    -Action Allow -RemoteAddress LocalSubnet -Profile Any -Description $What | Out-Null
  if (Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue) {
    Write-Host "  opened TCP $Port  ($What)" -ForegroundColor Green
  } else {
    Write-Host "  FAILED to open TCP $Port" -ForegroundColor Red
  }
}

Write-Host "Opening the testbed ports for the local network:"
Open-Port "CN-Testbed-Gateway-8080" 8080 "department page, load and probes"
if ($IncludeProxy) { Open-Port "CN-Testbed-Proxy-8888" 8888 "optional HTTP proxy (not shaped)" }
if ($IncludeDashboard) { Open-Port "CN-Testbed-Dashboard-4000" 4000 "dashboard from another computer" }

# If someone once pressed Cancel on Windows' "allow Node.js to communicate" prompt, Windows
# created a Block rule for node.exe. Block rules win over allow rules, so phones would still be
# refused. Remove those block rules (they only ever block Node.js).
$blocked = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -like '*node.exe' } |
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }
if ($blocked) {
  $blocked | ForEach-Object { Write-Host "  removing block rule for Node.js: $($_.DisplayName)" -ForegroundColor Yellow }
  $blocked | Remove-NetFirewallRule
}

Write-Host ""
Write-Host "Done. Phones on the hotspot can now open http://<laptop address>:8080/join" -ForegroundColor Green
Write-Host "(run 'npm run lan:info' to see the address and a QR code)."
