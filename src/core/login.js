import { getCredentials } from '../auth/keystore.js';
import { saveSession } from '../auth/session.js';
import { providerClass } from './session-helper.js';
import { ValidationError, ProviderError } from './errors.js';

// Two-step MCP login: openLogin opens a visible browser with the saved
// credentials filled in, returns immediately. The user handles any captcha /
// OTP / MPIN themselves in the browser. The browser instance is held in the
// process-wide map below until finishLogin captures the session, OR the TTL
// elapses (browser auto-closes).
const LOGIN_TTL_MS = 10 * 60 * 1000;
const pending = new Map(); // provider → { client, expiresAt, timer }

async function checkLoggedIn(client, provider) {
  try {
    if (provider === 'khalti') {
      return await client._isLoggedIn();
    }
    if (provider === 'esewa') {
      const url = await client.page.url();
      return url.includes('#/main') || url.includes('#/dashboard');
    }
  } catch (_) {}
  return false;
}

async function closePending(provider) {
  const p = pending.get(provider);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  await p.client.close().catch(() => {});
  pending.delete(provider);
}

// Opens a visible browser, navigates to login, fills saved credentials, submits.
// Does NOT wait for login completion — the user handles captcha/OTP/MPIN
// themselves in the browser. Saved credentials are required (set via the CLI
// at least once); MCP doesn't accept credentials inline.
export async function openLogin(provider) {
  if (!['esewa', 'khalti'].includes(provider)) {
    throw new ValidationError(`Unknown provider: ${provider}`, 'provider');
  }

  const creds = await getCredentials(provider);
  if (!creds) {
    throw new ValidationError(
      `No saved credentials for ${provider}. Run "wallet login ${provider} --relogin" in a terminal once to save them; future logins can run via MCP.`,
    );
  }

  // Clean up any stale pending login for this provider
  await closePending(provider);

  const Provider = providerClass(provider);
  const client = new Provider(false); // headless: false → visible browser
  await client.fillAndSubmit(creds.phone, creds.password);

  const timer = setTimeout(() => {
    closePending(provider).catch(() => {});
  }, LOGIN_TTL_MS);

  pending.set(provider, { client, expiresAt: Date.now() + LOGIN_TTL_MS, timer });

  return {
    status: 'opened',
    provider,
    ttlSec: LOGIN_TTL_MS / 1000,
    message: `Browser opened for ${provider}. Complete any captcha/OTP/MPIN in the visible browser window, then call wallet_finish_login. Auto-closes in 10 minutes.`,
  };
}

// Checks whether the pending login browser is now authenticated. If yes,
// captures cookies, saves the session, closes the browser. If not, returns
// `status: 'not_yet'` so the caller can ask the user to keep going.
export async function finishLogin(provider) {
  const p = pending.get(provider);
  if (!p) {
    throw new ValidationError(
      `No pending login for ${provider}. Call wallet_open_login first (or it may have timed out — TTL is 10 min).`,
    );
  }

  const loggedIn = await checkLoggedIn(p.client, provider);
  if (!loggedIn) {
    return {
      status: 'not_yet',
      provider,
      message: `Browser is open but not yet authenticated. Complete captcha/OTP/MPIN in the visible browser, then call wallet_finish_login again.`,
    };
  }

  let cookies;
  try {
    cookies = await p.client.getCookies();
  } catch (err) {
    throw new ProviderError(`Failed to capture session cookies: ${err.message}`, provider);
  }

  saveSession(provider, cookies);
  await closePending(provider);
  return { status: 'logged_in', provider };
}

// Force-close a pending login without saving. Use if user wants to abort.
export async function cancelLogin(provider) {
  await closePending(provider);
  return { status: 'cancelled', provider };
}
