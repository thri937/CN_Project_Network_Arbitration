import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const examplePath = path.join(rootDir, '.env.example');

if (!fs.existsSync(envPath)) {
  if (fs.existsSync(examplePath)) {
    let content = fs.readFileSync(examplePath, 'utf8');
    const token = crypto.randomBytes(24).toString('hex');
    content = content.replace(/GATEWAY_TOKEN=.*/, `GATEWAY_TOKEN=${token}`);
    fs.writeFileSync(envPath, content, 'utf8');
    console.log(`Created .env with generated GATEWAY_TOKEN: ${token}`);
  } else {
    console.error('.env.example not found!');
    process.exit(1);
  }
} else {
  console.log('.env already exists.');
}
