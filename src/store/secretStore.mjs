import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '../../.env');

class SecretStore {
  constructor() {
    this.secret = process.env.ALTIS_WEBHOOK_SECRET || '';
  }

  getSecret() {
    return this.secret || process.env.ALTIS_WEBHOOK_SECRET || '';
  }

  setSecret(newSecret) {
    this.secret = (newSecret || '').trim();
    process.env.ALTIS_WEBHOOK_SECRET = this.secret;

    // Persist to .env file so it survives if server restarts later
    try {
      let content = '';
      if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf8');
      }

      if (content.includes('ALTIS_WEBHOOK_SECRET=')) {
        content = content.replace(
          /ALTIS_WEBHOOK_SECRET=.*/,
          `ALTIS_WEBHOOK_SECRET=${this.secret}`
        );
      } else {
        content += `\nALTIS_WEBHOOK_SECRET=${this.secret}\n`;
      }

      fs.writeFileSync(envPath, content, 'utf8');
      console.log(`[SECRET-STORE] Secret updated dynamically in-memory and saved to .env: ${this.secret.slice(0, 10)}...`);
    } catch (err) {
      console.warn('[SECRET-STORE] Failed to persist secret to .env file:', err.message);
    }

    return this.secret;
  }
}

export const secretStore = new SecretStore();
