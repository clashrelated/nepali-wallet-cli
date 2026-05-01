import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import { EsewaProvider } from '../providers/esewa.js';
import { KhaltiProvider } from '../providers/khalti.js';
import { loadSession, saveSession, hasSession } from '../auth/session.js';

const LOG_DIR = join(homedir(), '.config', 'nepali-wallet-cli');
const logPath = (provider) => join(LOG_DIR, `keep-alive-${provider}.log`);

function logLine(provider, msg) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${msg}\n`;
  appendFileSync(logPath(provider), line);
  process.stdout.write(`${chalk.grey(stamp)}  ${msg}\n`);
}

function makeProvider(provider) {
  if (provider === 'esewa') return new EsewaProvider(true);
  if (provider === 'khalti') return new KhaltiProvider(true);
  throw new Error(`Unknown provider: ${provider}`);
}

// Single probe — returns true if session still valid.
async function probe(provider) {
  const session = loadSession(provider);
  if (!session) {
    logLine(provider, 'no session on disk — exiting');
    return false;
  }

  const p = makeProvider(provider);
  try {
    const ok = await p.restoreSession(session);
    if (ok) {
      // Save rotated cookies back so any refresh tokens persist.
      const fresh = await p.getCookies();
      if (fresh?.length) saveSession(provider, fresh);
      logLine(provider, chalk.green('ok'));
      return true;
    }
    logLine(provider, chalk.yellow('expired — login again with: wallet login ' + provider));
    return false;
  } catch (err) {
    logLine(provider, chalk.red(`probe error: ${err.message}`));
    return false;
  } finally {
    await p.close().catch(() => {});
  }
}

export async function keepAliveCommand(provider, opts) {
  if (!hasSession(provider)) {
    console.log(chalk.red(`No saved session for ${provider}. Run: wallet login ${provider}`));
    process.exit(1);
  }

  const baseMin = Number(opts.interval) || 12;
  if (baseMin < 1 || baseMin > 60) {
    console.log(chalk.red('--interval must be between 1 and 60 minutes'));
    process.exit(1);
  }

  console.log(chalk.bold(`\n  keep-alive  ${provider}`));
  console.log(chalk.grey(`  interval ~${baseMin} min (±2 jitter)`));
  console.log(chalk.grey(`  log: ${logPath(provider)}\n`));

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // First probe immediately so failures surface fast.
  let alive = await probe(provider);

  while (alive && !stopping) {
    const jitterMs = (Math.random() * 4 - 2) * 60_000; // ±2 min
    const waitMs = Math.max(60_000, baseMin * 60_000 + jitterMs);
    await new Promise((r) => setTimeout(r, waitMs));
    if (stopping) break;
    alive = await probe(provider);
  }

  process.exit(alive ? 0 : 2);
}

function formatAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

// Strip ANSI color codes that the log may contain.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function readLastLine(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trimEnd();
  if (!text) return null;
  const last = text.split('\n').at(-1);
  const m = last.match(/^\[(.+?)\]\s+(.*)$/);
  if (!m) return { raw: stripAnsi(last) };
  return { ts: new Date(m[1]), msg: stripAnsi(m[2]) };
}

export function keepAliveStatusCommand() {
  const providers = ['esewa', 'khalti'];
  console.log();
  console.log(chalk.bold('  keep-alive status'));
  console.log();
  for (const p of providers) {
    const label = p === 'esewa' ? chalk.green.bold('eSewa ') : chalk.magenta.bold('Khalti');
    const path = logPath(p);
    if (!existsSync(path)) {
      console.log(`  ${label}  ${chalk.grey('○')} no log yet`);
      continue;
    }
    const last = readLastLine(path);
    if (!last?.ts) {
      console.log(`  ${label}  ${chalk.grey('?')} ${last?.raw ?? 'unreadable log'}`);
      continue;
    }
    const age = formatAge(Date.now() - last.ts.getTime());
    const dot = /ok/i.test(last.msg) ? chalk.green('●') : chalk.red('●');
    const size = statSync(path).size;
    console.log(`  ${label}  ${dot} ${last.msg.padEnd(10)}  ${chalk.grey(age)}  ${chalk.grey(`(${size}B)`)}`);
  }
  console.log();
  console.log(chalk.grey(`  logs: ${LOG_DIR}/keep-alive-<provider>.log`));
  console.log();
}
