/**
 * Fresh start: deletes all history and seeds the 7 departments again.
 *
 *   npm run reset                      decisions, contentions, audit log, users, policy and recordings
 *   npm run reset -- --keep-recordings  the same, but keeps the CSV recordings in experiments/
 *
 * Stop `npm run dev` / `npm start` first: a running controller would write its old data back.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'apps', 'controller', '.data');
const experimentsDir = path.join(root, 'experiments');
const keepRecordings = process.argv.includes('--keep-recordings');

/** True if something is listening on 127.0.0.1:port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function main(): Promise<void> {
  const busy = [];
  for (const [port, name] of [
    [4000, 'controller'],
    [8080, 'gateway'],
    [9090, 'gateway'],
  ] as const) {
    if (await listening(port)) busy.push(`${name} (port ${port})`);
  }
  if (busy.length > 0) {
    console.error(`Still running: ${[...new Set(busy)].join(', ')}.`);
    console.error('Stop it first (Ctrl+C in the npm run dev window), then run npm run reset again.');
    process.exit(1);
  }

  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('Deleted apps/controller/.data (decisions, contentions, audit log, users, policy).');
  } else {
    console.log('No saved controller data to delete.');
  }

  if (keepRecordings) {
    console.log('Kept the recordings in experiments/.');
  } else if (fs.existsSync(experimentsDir)) {
    let removed = 0;
    for (const entry of fs.readdirSync(experimentsDir)) {
      if (entry === 'README.md') continue;
      fs.rmSync(path.join(experimentsDir, entry), { recursive: true, force: true });
      removed++;
    }
    console.log(`Deleted ${removed} recording file(s)/folder(s) from experiments/ (paper/results/ is untouched).`);
  }

  console.log('\nSeeding the 7 departments, slices, policy and users...\n');
  execSync('npm run seed', { cwd: root, stdio: 'inherit' });
  console.log('\nFresh start ready. Run npm run dev.');
}

void main();
