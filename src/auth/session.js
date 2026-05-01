import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SESSION_DIR = join(homedir(), '.config', 'nepali-wallet-cli');

function sessionPath(provider) {
  return join(SESSION_DIR, `${provider}-session.json`);
}

export function saveSession(provider, cookies) {
  writeFileSync(sessionPath(provider), JSON.stringify(cookies, null, 2));
}

export function loadSession(provider) {
  const p = sessionPath(provider);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function clearSession(provider) {
  const p = sessionPath(provider);
  if (existsSync(p)) unlinkSync(p);
}

export function hasSession(provider) {
  return existsSync(sessionPath(provider));
}
