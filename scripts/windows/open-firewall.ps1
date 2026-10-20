# open-firewall.ps1
# Run as Administrator in PowerShell to allow inbound traffic on local subnet
param(
  [switch]$IncludeController = $true
)

Write-Host "Opening firewall rules for CN Real Network Arbitration Testbed..." -ForegroundColor Cyan

# Check Administrator privileges
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Warning "This script requires Administrator privileges. Please re-run PowerShell as Administrator."
  exit 1
}

# Rule for Slice Gateway Portal and Load (TCP 8080)
New-NetFirewallRule -DisplayName "CN-Testbed-Gateway-8080" `
  -Direction Inbound `
  -LocalPort 8080 `
  -Protocol TCP `
  -Action Allow `
  -RemoteAddress LocalSubnet `
  -Profile Any `
  -Description "Allows mobile devices on hotspot/LAN to connect to the slice portal and load generator" `
  -ErrorAction SilentlyContinue

# Rule for HTTP Proxy (TCP 8888)
New-NetFirewallRule -DisplayName "CN-Testbed-Proxy-8888" `
  -Direction Inbound `
  -LocalPort 8888 `
  -Protocol TCP `
  -Action Allow `
  -RemoteAddress LocalSubnet `
  -Profile Any `
  -Description "Allows mobile devices to route traffic through the slice forward proxy" `
  -ErrorAction SilentlyContinue

if ($IncludeController) {
  New-NetFirewallRule -DisplayName "CN-Testbed-Controller-4000" `
    -Direction Inbound `
    -LocalPort 4000 `
    -Protocol TCP `
    -Action Allow `
    -RemoteAddress LocalSubnet `
    -Profile Any `
    -Description "Allows operator devices to view the controller dashboard" `
    -ErrorAction SilentlyContinue
}

Write-Host "Firewall rules created successfully for LocalSubnet." -ForegroundColor Green
Write-Host "Ports 8080 (Gateway/Portal) and 8888 (Proxy) are open." -ForegroundColor Green
if ($IncludeController) {
  Write-Host "Port 4000 (Controller/Dashboard) is open." -ForegroundColor Green
}
