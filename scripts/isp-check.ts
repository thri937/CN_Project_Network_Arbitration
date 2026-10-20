import http from 'node:http';
import https from 'node:https';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const TEST_URL = process.env.INTERNET_SOURCE_URL || 'https://speed.cloudflare.com/__down?bytes=2000000';
const TARGET_CAPACITY_KBPS = Number(process.env.NETWORK_TOTAL_CAPACITY_MBPS || 1000);

export async function checkIspSpeed(url = TEST_URL): Promise<{ speedKbps: number; durationMs: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const start = process.hrtime.bigint();
    let receivedBytes = 0;

    const req = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        return reject(new Error(`HTTP status ${res.statusCode}`));
      }

      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
      });

      res.on('end', () => {
        const end = process.hrtime.bigint();
        const durationS = Number(end - start) / 1e9;
        const durationMs = Math.round(durationS * 1000);
        const speedKbps = Math.round((receivedBytes * 8) / (durationS * 1000));
        resolve({ speedKbps, durationMs, bytes: receivedBytes });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('ISP speed check timed out after 15 seconds'));
    });
  });
}

async function run() {
  console.log('=== ISP Throughput Calibration Check ===');
  console.log(`Target Offered Bottleneck: ${TARGET_CAPACITY_KBPS} kbps`);
  console.log(`Connecting to: ${TEST_URL} ...`);

  try {
    const result = await checkIspSpeed();
    console.log(`Downloaded ${result.bytes.toLocaleString()} bytes in ${result.durationMs} ms`);
    console.log(`Measured ISP Speed: ${result.speedKbps.toLocaleString()} kbps (${(result.speedKbps / 1000).toFixed(2)} Mbps)`);

    if (result.speedKbps < TARGET_CAPACITY_KBPS) {
      console.warn(`\n[WARNING] Measured ISP speed (${result.speedKbps} kbps) is LOWER than configured testbed capacity (${TARGET_CAPACITY_KBPS} kbps)!`);
      console.warn('The real ISP connection may become the bottleneck rather than the slice gateway shaper.');
    } else {
      console.log(`\n[OK] ISP connection speed is sufficient for the ${TARGET_CAPACITY_KBPS} kbps testbed.`);
    }
  } catch (err: any) {
    console.error('ISP check failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('isp-check.ts')) {
  run();
}
