# lan-info.ps1
# Discovers local IPv4 addresses, identifying Windows Mobile Hotspot and Wi-Fi LAN interfaces

Write-Host "=== CN Real Network Arbitration Testbed - Network Discovery ===" -ForegroundColor Cyan

$adapters = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -ne "127.0.0.1" -and $_.IPAddress -notlike "169.254.*"
}

$hotspot = $adapters | Where-Object { $_.IPAddress -like "192.168.137.*" -or $_.InterfaceAlias -like "*Hotspot*" -or $_.InterfaceAlias -like "*Local Area Connection*1*" }
$wifi = $adapters | Where-Object { $_.InterfaceAlias -like "*Wi-Fi*" -or $_.InterfaceAlias -like "*Wireless*" }

if ($hotspot) {
  Write-Host "Detected Mobile Hotspot interface:" -ForegroundColor Green
  foreach ($h in $hotspot) {
    Write-Host "  Interface: $($h.InterfaceAlias)"
    Write-Host "  Gateway IP: $($h.IPAddress)" -ForegroundColor Yellow
    Write-Host "  Portal Join URL: http://$($h.IPAddress):8080/join" -ForegroundColor Cyan
  }
} else {
  Write-Host "No active Mobile Hotspot interface (192.168.137.1) detected." -ForegroundColor Yellow
  Write-Host "If using Mobile Hotspot, enable it in Settings -> Network & Internet -> Mobile Hotspot."
}

if ($wifi) {
  Write-Host "`nDetected Wi-Fi LAN interface:" -ForegroundColor Green
  foreach ($w in $wifi) {
    Write-Host "  Interface: $($w.InterfaceAlias)"
    Write-Host "  LAN IP: $($w.IPAddress)" -ForegroundColor Yellow
    Write-Host "  Portal Join URL: http://$($w.IPAddress):8080/join" -ForegroundColor Cyan
  }
}

Write-Host "`nAll non-loopback IPv4 addresses:" -ForegroundColor Gray
foreach ($a in $adapters) {
  Write-Host "  $($a.InterfaceAlias): $($a.IPAddress)"
}
