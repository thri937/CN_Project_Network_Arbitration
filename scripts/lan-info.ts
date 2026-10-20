import os from 'node:os';
import qrcode from 'qrcode';

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|bluetooth|tailscale|zerotier/i;

function interfaceRank(name: string, ip: string): number {
  if (ip.startsWith('192.168.137.') || /hotspot/i.test(name)) return 0;
  if (VIRTUAL_ADAPTER.test(name) || ip.startsWith('192.168.56.')) return 3;
  if (/wi-?fi|wlan|wireless/i.test(name)) return 1;
  return 2;
}

async function main() {
  console.log('=== CN Real Network Arbitration Testbed — LAN Info ===\n');
  const nets = os.networkInterfaces();
  const candidates: { name: string; ip: string; isHotspot: boolean; rank: number }[] = [];

  for (const name of Object.keys(nets)) {
    const netList = nets[name];
    if (!netList) continue;
    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        const isHotspot = net.address.startsWith('192.168.137.') || name.toLowerCase().includes('hotspot');
        candidates.push({ name, ip: net.address, isHotspot, rank: interfaceRank(name, net.address) });
      }
    }
  }

  if (candidates.length === 0) {
    console.log('No active non-loopback network interface found.');
    console.log('Defaulting to localhost: http://127.0.0.1:8080/join');
    return;
  }

  // Hotspot first, then Wi-Fi, then Ethernet; virtual adapters last.
  candidates.sort((a, b) => a.rank - b.rank);

  for (const c of candidates) {
    const label = c.isHotspot ? ' [Mobile Hotspot]' : c.rank === 3 ? ' [virtual adapter — phones cannot use this]' : '';
    console.log(`Interface: ${c.name}${label}`);
    console.log(`IP:        ${c.ip}`);
    console.log(`Join URL:  http://${c.ip}:8080/join\n`);
  }

  const primary = candidates[0];
  const url = `http://${primary.ip}:8080/join`;
  console.log(`Primary Portal QR Code (${url}):\n`);
  try {
    const qrString = await qrcode.toString(url, { type: 'terminal', small: true });
    console.log(qrString);
  } catch (err) {
    console.log('Could not generate terminal QR:', err);
  }
}

main().catch(console.error);
