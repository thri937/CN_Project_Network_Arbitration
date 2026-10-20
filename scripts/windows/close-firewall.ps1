# close-firewall.ps1
# Run as Administrator in PowerShell to remove testbed firewall rules

Write-Host "Removing firewall rules for CN Real Network Arbitration Testbed..." -ForegroundColor Cyan

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Warning "This script requires Administrator privileges. Please re-run PowerShell as Administrator."
  exit 1
}

Remove-NetFirewallRule -DisplayName "CN-Testbed-Gateway-8080" -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName "CN-Testbed-Proxy-8888" -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName "CN-Testbed-Controller-4000" -ErrorAction SilentlyContinue

Write-Host "Firewall rules removed successfully." -ForegroundColor Green
