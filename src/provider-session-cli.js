// Private operator tool: no HTTP listener, no tokens/URLs printed or argv grants.
import fs from 'node:fs';
import { SpotiFLACQobuzHost } from './spotiflac-qobuz-host.js';
const [command, file] = process.argv.slice(2);
try {
  if (!file || !['start', 'complete'].includes(command)) throw new Error('Usage: start OUTPUT_FILE | complete PRIVATE_CALLBACK_FILE');
  const host = new SpotiFLACQobuzHost();
  if (command === 'start') {
    const result = host.startAuth();
    if (!result.needsVerification || !result.auth_url) throw new Error('No human challenge available (or already authenticated)');
    fs.writeFileSync(file, result.auth_url + '\n', { mode: 0o600, flag: 'wx' });
    console.log('Verification link saved privately; expires in at most 3 minutes.');
  } else {
    const stat = fs.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16384) throw new Error('Callback must be a private mode600 file, at most 16KiB');
    const result = host.completeAuth(fs.readFileSync(file, 'utf8'));
    if (!result.success) throw new Error('Verification exchange failed; check expiry and use the full copied callback link');
    fs.unlinkSync(file);
    console.log('Provider session saved privately. Playback still requires stream verification.');
  }
} catch {
  console.error('Provider provisioning failed; no secret response was logged.');
  process.exitCode = 1;
}
