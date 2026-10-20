# close-firewall.ps1 — remove the rules open-firewall.ps1 added.
# Run in PowerShell opened with "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File scripts\windows\close-firewall.ps1

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Please run this in PowerShell opened with 'Run as administrator'." -ForegroundColor Yellow
  exit 1
}

foreach ($name in 'CN-Testbed-Gateway-8080', 'CN-Testbed-Proxy-8888', 'CN-Testbed-Dashboard-4000', 'CN-Testbed-Controller-4000') {
  $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
  if ($rule) {
    $rule | Remove-NetFirewallRule
    Write-Host "  removed $name" -ForegroundColor Green
  }
}
Write-Host "Done."
