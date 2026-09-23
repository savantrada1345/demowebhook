import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const certsDir = path.join(__dirname, '../certs');

if (!fs.existsSync(certsDir)) {
  fs.mkdirSync(certsDir, { recursive: true });
}

const keyPath = path.join(certsDir, 'key.pem');
const certPath = path.join(certsDir, 'cert.pem');

console.log('Generating self-signed SSL certificates for localhost...');

try {
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`,
    { stdio: 'inherit' }
  );
  console.log(`\n✓ SSL certificates generated in: ${certsDir}`);
  console.log(`  - Key:  ${keyPath}`);
  console.log(`  - Cert: ${certPath}\n`);
  console.log('You can now start the server with HTTPS enabled!');
} catch (err) {
  console.error('Failed to generate SSL certificates with openssl:', err.message);
  process.exit(1);
}
