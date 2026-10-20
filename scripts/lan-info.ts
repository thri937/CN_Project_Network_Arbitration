import os from 'node:os';
import qrcode from 'qrcode';

async function main() {
  console.log('=== CN Real Network Arbitration Testbed — LAN Info ===\n');
  const nets = os.networkInterfaces();
  const candidates: { name: string; ip: string; isHotspot: boolean }[] = [];

  for (const name of Object.keys(nets)) {
    const netList = nets[name];
    if (!netList) continue;
    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        const isHotspot = net.address.startsWith('192.168.137.') || name.toLowerCase().includes('hotspot');
        candidates.push({ name, ip: net.address, isHotspot });
      }
    }
  }

  if (candidates.length === 0) {
    console.log('No active non-loopback network interface found.');
    console.log('Defaulting to localhost: http://127.0.0.1:8080/join');
    return;
  }

  // Sort hotspot first
  candidates.sort((a, b) => (b.isHotspot ? 1 : 0) - (a.isHotspot ? 1 : 0));

  for (const c of candidates) {
    const label = c.isHotspot ? ' [Mobile Hotspot]' : '';
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
