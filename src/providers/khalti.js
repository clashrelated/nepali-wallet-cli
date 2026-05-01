import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { join } from 'path';
import { homedir } from 'os';

chromium.use(StealthPlugin());

const BASE_URL = 'https://web.khalti.com';
const PROFILE_DIR = join(homedir(), '.config', 'nepali-wallet-cli', 'khalti-profile');

// Khalti's auth is primarily sessionStorage-based. Chromium clears
// sessionStorage when the browser closes, so we persist and re-inject it.
export class KhaltiProvider {
  constructor(headless = true) {
    this.headless = headless;
    this.context = null;
    this.page = null;
    this.isLoggedIn = false;
  }

  async launch() {
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: this.headless,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'Asia/Kathmandu',
    });
    this.page = await this.context.newPage();
  }

  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }

  async getCookies() {
    if (!this.context) return null;

    await this.page.waitForFunction(
      () => Boolean(sessionStorage.getItem('khaltiToken')),
      { timeout: 8000 }
    ).catch(() => this._waitForSessionReady().catch(() => {}));

    const storage = await this.page.evaluate(() => {
      const session = {};
      const local = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        session[key] = sessionStorage.getItem(key);
      }
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        local[key] = localStorage.getItem(key);
      }
      return { session, local };
    });

    const cookies = await this.context.cookies();
    const in7Days = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    return {
      khaltiToken: storage.session.khaltiToken || null,
      sessionStorage: storage.session,
      localStorage: storage.local,
      cookies: cookies.map((c) => ({ ...c, expires: c.expires === -1 ? in7Days : c.expires })),
    };
  }

  async fillAndSubmit(phone, password) {
    await this.launch();
    await this.page.goto(`${BASE_URL}/#/login`, { waitUntil: 'load', timeout: 30000 });
    await this.page.waitForTimeout(4000);
    await this.page.waitForSelector('input[name="id"]', { timeout: 10000 });
    await this.page.fill('input[name="id"]', phone);
    await this.page.waitForTimeout(300);
    await this.page.fill('input[name="password"]', password);
    await this.page.waitForTimeout(300);
    await this.page.click('button[type="submit"]');
  }

  async restoreSession(session) {
    await this.launch();

    const { khaltiToken, sessionStorage, localStorage, cookies } = session || {};
    const sessionValues = {
      ...(sessionStorage || {}),
      ...(khaltiToken ? { khaltiToken } : {}),
    };

    if (Object.keys(sessionValues).length || localStorage) {
      await this.context.addInitScript(({ sessionValues, localStorageValues }) => {
        try {
          for (const [key, value] of Object.entries(sessionValues || {})) {
            if (value !== null && value !== undefined) sessionStorage.setItem(key, value);
          }
          for (const [key, value] of Object.entries(localStorageValues || {})) {
            if (value !== null && value !== undefined) localStorage.setItem(key, value);
          }
        } catch (_) {}
      }, { sessionValues, localStorageValues: localStorage || {} });
    }

    if (cookies?.length) {
      await this.context.addCookies(cookies);
    }

    await this.page.goto(`${BASE_URL}/#/`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(5000);

    let loggedIn = await this._isLoggedIn();
    if (!loggedIn && Object.keys(sessionValues).length) {
      await this.page.evaluate(({ sessionValues, localStorageValues }) => {
        for (const [key, value] of Object.entries(sessionValues || {})) {
          if (value !== null && value !== undefined) sessionStorage.setItem(key, value);
        }
        for (const [key, value] of Object.entries(localStorageValues || {})) {
          if (value !== null && value !== undefined) localStorage.setItem(key, value);
        }
      }, { sessionValues, localStorageValues: localStorage || {} });
      await this.page.reload({ waitUntil: 'load', timeout: 20000 });
      await this.page.waitForTimeout(5000);
      loggedIn = await this._isLoggedIn();
    }

    if (loggedIn) this.isLoggedIn = true;
    return loggedIn;
  }

  async login(phone, password) {
    await this.launch();

    await this.page.goto(`${BASE_URL}/#/login`, { waitUntil: 'load', timeout: 30000 });
    await this.page.waitForTimeout(4000);

    await this.page.waitForSelector('input[name="id"]', { timeout: 10000 });
    await this.page.fill('input[name="id"]', phone);
    await this.page.waitForTimeout(200);
    await this.page.fill('input[name="password"]', password);
    await this.page.waitForTimeout(200);
    await this.page.click('button[type="submit"]');

    const state = await Promise.race([
      this.page.waitForFunction(
        () => {
          const h = window.location.hash;
          return (
            h.includes('wallet') ||
            h.includes('dashboard') ||
            h.includes('home') ||
            (h !== '#/login' && (h === '#/' || h === ''))
          );
        },
        { timeout: 12000 }
      ).then(() => 'dashboard'),
      this.page.waitForFunction(
        () => {
          const inputs = Array.from(document.querySelectorAll('input'));
          return inputs.some(
            (i) =>
              /otp|verification|code|pin/i.test(
                i.getAttribute('placeholder') ||
                  i.getAttribute('name') ||
                  i.getAttribute('id') ||
                  i.getAttribute('aria-label') ||
                  ''
              ) ||
              i.getAttribute('inputmode') === 'numeric' ||
              i.getAttribute('autocomplete') === 'one-time-code' ||
              (i.getAttribute('maxlength') &&
                parseInt(i.getAttribute('maxlength')) <= 6 &&
                i.getAttribute('type') !== 'password')
          );
        },
        { timeout: 12000 }
      ).then(() => 'otp'),
    ]).catch(async () => {
      const errEl = await this.page.$(
        '.Toastify__toast--error, [class*="error-message"], [class*="errorMessage"]'
      );
      return errEl ? 'error' : 'unknown';
    });

    if (state === 'dashboard') {
      this.isLoggedIn = true;
      return { success: true };
    }
    if (state === 'otp') return { success: false, needsOtp: true };

    const errEl = await this.page.$('.Toastify__toast--error, [class*="error"]');
    const errText = errEl
      ? (await errEl.innerText()).trim().split('\n')[0]
      : 'Login failed. Check credentials.';
    return { success: false, error: errText };
  }

  async submitOtp(otp) {
    try {
      await this.page.waitForTimeout(1000);

      const singleSel = [
        'input[name="otp"]',
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
        'input[placeholder*="OTP" i]',
        'input[placeholder*="code" i]',
        'input[placeholder*="verif" i]',
        'input[aria-label*="OTP" i]',
        'input[aria-label*="code" i]',
      ].join(', ');

      const otpInput = await this.page.$(singleSel);

      if (otpInput) {
        await otpInput.fill(otp);
      } else {
        const digitInputs = await this.page.$$(
          'input[maxlength="1"], input[type="tel"][maxlength], input[type="number"][maxlength]'
        );
        if (digitInputs.length >= 4) {
          for (let i = 0; i < digitInputs.length && i < otp.length; i++) {
            await digitInputs[i].fill(otp[i]);
            await this.page.waitForTimeout(80);
          }
        } else {
          return { success: false, error: 'OTP input not found on page.' };
        }
      }

      await this.page.waitForTimeout(300);

      const submitBtn = await this.page.$('button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        if (otpInput) await otpInput.press('Enter');
      }

      // Wait for the actual home/dashboard — #/verification is still the OTP page
      await this.page.waitForFunction(
        () => {
          const h = window.location.hash;
          return h === '#/' || h.includes('home') || h.includes('wallet') || h.includes('dashboard');
        },
        { timeout: 20000 }
      );

      await this._waitForSessionReady();

      this.isLoggedIn = true;
      return { success: true };
    } catch (e) {
      const errEl = await this.page.$('.Toastify__toast--error, [class*="error"]');
      const errText = errEl
        ? (await errEl.innerText()).trim().split('\n')[0]
        : e.message.split('\n')[0];
      return { success: false, error: errText };
    }
  }

  async getBalance() {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    const showBalance = this.page.locator('button[aria-label="Show balance"]').first();
    if (await showBalance.count()) {
      await showBalance.click().catch(() => {});
      await this.page.waitForFunction(() => {
        const text = document.querySelector('[class*=BalanceTop i]')?.innerText || '';
        return text && !text.includes('•');
      }, { timeout: 4000 }).catch(() => {});
    }

    const { balance, name } = await this.page.evaluate(() => {
      const normalize = (text) => (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const allLeafs = Array.from(document.querySelectorAll('*'))
        .filter((el) => el.children.length === 0)
        .map((el) => ({ el, text: normalize(el.textContent) }))
        .filter((item) => item.text);

      let balance = null;
      let name = null;

      const balanceTopText = normalize(document.querySelector('[class*=BalanceTop i]')?.innerText);
      if (balanceTopText && !/•/.test(balanceTopText)) {
        const match = balanceTopText.match(/Rs\.?\s*([\d,]+(?:\.\d+)?)/);
        if (match) balance = match[1];
      }

      const balanceEl = allLeafs.find(({ el, text }) => {
        if (/•/.test(text)) return false;
        return /^Rs\.?\s*[\d,]+(\.\d+)?$/.test(text) ||
          (/^[\d,]+(\.\d+)?$/.test(text) && el.closest('[class*="balance" i], [class*="Balance"]'));
      });
      if (!balance && balanceEl) balance = balanceEl.text.replace(/^Rs\.?\s*/, '').trim();

      const lines = (document.body.innerText || '').split('\n').map(normalize).filter(Boolean);
      const phoneIdx = lines.findIndex((line) => /^\d{10}$/.test(line));
      if (phoneIdx > 0) name = lines[phoneIdx - 1];

      if (!name) {
        const nameEl = allLeafs.find(({ text }) =>
          /^[A-Za-z][A-Za-z\s]{2,39}$/.test(text) &&
          !['My profile', 'Settings', 'Logout', 'Home', 'Wallet'].includes(text)
        );
        if (nameEl) name = nameEl.text;
      }

      return { balance, name };
    });

    return { balance: balance || 'Hidden', name };
  }

  async getTransactions(limit = 10) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/transaction`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(4000);

    await this.page.waitForSelector('[class*="Transactions-module__Item"]', { timeout: 12000 }).catch(() => {});

    const transactions = await this.page.evaluate(() => {
      const normalize = (text) => (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const amountPattern = /^([+-])\s*([\d,]+(?:\.\d+)?)$/;

      return Array.from(document.querySelectorAll('[class*="Transactions-module__Item"]'))
        .map((el) => {
          const lines = (el.innerText || '').split('\n').map(normalize).filter(Boolean);
          const date = lines.find((line) =>
            /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+-\s+\d{2}:\d{2}$/.test(line)
          );
          const amountLine = [...lines].reverse().find((line) => amountPattern.test(line));
          if (!date || !amountLine) return null;

          const amountMatch = amountLine.match(amountPattern);
          const title = lines[0] || 'Transaction';
          const detailLines = lines.slice(1).filter((line) => line !== date && line !== amountLine);

          return {
            date,
            description: detailLines.length ? `${title} — ${detailLines.join(' · ')}` : title,
            channel: 'Khalti',
            amount: amountMatch[2],
            type: amountMatch[1] === '+' ? 'credit' : 'debit',
            balance: null,
          };
        })
        .filter(Boolean);
    });

    return transactions.slice(0, limit);
  }

  async getTransactionDetail(rowNum = 1) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/transaction`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(4000);

    if (rowNum > 10) {
      let previous = 0;
      for (let i = 0; i < Math.ceil(rowNum / 20) + 1; i++) {
        await this.page.keyboard.press('End');
        await this.page.waitForTimeout(1200);
        const count = await this.page.locator('[class*="Transactions-module__Item"]').count();
        if (count === previous) break;
        previous = count;
      }
    }

    const items = this.page.locator('[class*="Transactions-module__Item"]');
    const count = await items.count();
    if (count < rowNum) return null;

    await items.nth(rowNum - 1).click();
    await this.page.waitForURL('**/#/transaction/**', { timeout: 12000 }).catch(() => {});
    await this.page.waitForTimeout(2500);

    return this.page.evaluate(() => {
      const normalize = (text) => (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const labels = new Set([
        'Amount',
        'Id',
        'Type',
        'State',
        'Created On',
        'Original Transaction',
        'Balance',
        'To',
        'From',
        'Transaction',
      ]);

      const map = {};
      document.querySelectorAll('.ui.equal.width.grid .row').forEach((row) => {
        const cols = Array.from(row.children).map((el) => normalize(el.innerText)).filter(Boolean);
        if (cols.length >= 2 && labels.has(cols[0])) map[cols[0]] = cols.slice(1).join(' ');
      });

      const title = normalize(document.querySelector('[class*="TransactionDetail-module__Header"]')?.innerText);

      return {
        title: title || 'Khalti Transaction Detail',
        reference: map.Id || null,
        date: map['Created On'] || null,
        status: map.State || null,
        amount: map.Amount?.replace(/^Rs\.?\s*/i, '') || null,
        balance: map.Balance?.replace(/^Rs\.?\s*/i, '') || null,
        type: map.Type || null,
        transaction: map.Transaction || null,
        senderName: map.From || null,
        receiverName: map.To || null,
        originalTransaction: map['Original Transaction'] || null,
        _raw: map,
      };
    });
  }

  async prepareTopUp(mobile, amount) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this._openTopUpForm();

    await this._replaceInput('input[name="number"]', mobile);
    await this.page.waitForSelector('input[name="amount"]', { timeout: 10000 });
    await this._replaceInput('input[name="amount"]', String(amount));

    const formError = await this._visibleErrorText();
    if (formError) return { success: false, error: formError };

    const proceedClicked = await this.page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('div, button')).find(
        (el) => /^PROCEED$/i.test(el.innerText?.trim() || '') && !/disabled/i.test(el.className || '')
      );
      if (!btn) return false;
      btn.click();
      return true;
    });

    if (!proceedClicked) {
      return { success: false, error: 'PROCEED is disabled. Check mobile number and amount.' };
    }

    await this.page.waitForSelector('[data-testid="service-modal-test"], .ui.modal.visible.active', {
      timeout: 10000,
    });

    const summary = await this.page.evaluate(() => {
      const normalize = (text) => (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const modal = document.querySelector('[data-testid="service-modal-test"], .ui.modal.visible.active');
      const rows = {};
      modal?.querySelectorAll('tr').forEach((row) => {
        const cells = Array.from(row.querySelectorAll('td')).map((td) => normalize(td.innerText));
        if (cells.length >= 2) rows[cells[0]] = cells.slice(1).join(' ');
      });
      return {
        title: normalize(modal?.querySelector('.header')?.innerText) || 'Mobile Topup',
        fields: rows,
        text: normalize(modal?.innerText),
      };
    });

    return { success: true, summary };
  }

  async confirmTopUp() {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    const clicked = await this.page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('div, button')).find(
        (el) => /^Continue$/i.test(el.innerText?.trim() || '') && el.offsetParent !== null
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) return { success: false, error: 'Continue button not found.' };

    await this.page.waitForTimeout(4000);

    const result = await this.page.evaluate(() => {
      const normalize = (text) => (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const errorPattern = /insufficient|failed|error|invalid|not enough|unable|could not|limit|minimum|maximum/i;
      const successPattern = /success|successful|completed|transaction id|reference/i;

      for (const el of document.querySelectorAll('[class*="toast"], [class*="Toast"], [class*="error"], .message, .modal')) {
        const text = normalize(el.innerText);
        if (!text || !visible(el)) continue;
        if (errorPattern.test(text)) return { success: false, error: text };
        if (successPattern.test(text)) return { success: true, message: text };
      }

      const body = normalize(document.body.innerText);
      if (errorPattern.test(body)) {
        const match = body.match(/[^.]*?(?:insufficient|failed|error|invalid|not enough|unable|could not|limit|minimum|maximum)[^.]*\.?/i);
        return { success: false, error: match?.[0] || 'Topup failed.' };
      }
      if (successPattern.test(body)) return { success: true, message: 'Topup completed.' };
      return { success: null };
    });

    if (result.success === true) return { success: true, message: result.message };
    if (result.success === false) return { success: false, error: result.error };
    return { success: false, error: 'Topup result unclear. Check Khalti history before retrying.' };
  }

  async prepareSendMoney(recipient, amount, remarks = '') {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this._openSendFundForm();

    await this._replaceInput('input[name="user"]', recipient);
    await this.page.waitForSelector('input[name="amount"]', { timeout: 10000 });
    await this._replaceInput('input[name="amount"]', String(amount));

    if (remarks) {
      const ta = this.page.locator('textarea').first();
      if (await ta.count()) {
        await ta.fill(remarks);
        await this.page.waitForTimeout(300);
      }
    }

    await this.page.waitForTimeout(800);

    const formError = await this._visibleErrorText();
    if (formError) return { success: false, error: formError };

    const submitState = await this.page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (el) => /^submit$/i.test(el.innerText?.trim() || '')
      );
      if (!btn) return { found: false };
      const disabled = btn.disabled || /disabled/i.test(btn.className || '');
      return { found: true, disabled };
    });

    if (!submitState.found) return { success: false, error: 'Submit button not found.' };
    if (submitState.disabled) {
      return { success: false, error: 'Submit is disabled. Check Khalti ID and amount.' };
    }

    return {
      success: true,
      summary: {
        title: 'Send Fund (Khalti Wallet)',
        fields: {
          'Khalti ID': recipient,
          Amount: `Rs. ${amount}`,
          Remarks: remarks || '(none)',
        },
      },
    };
  }

  async confirmSendMoney() {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    const clicked = await this.page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((el) => {
        if (!/^submit$/i.test(el.innerText?.trim() || '')) return false;
        if (el.disabled) return false;
        if (/disabled/i.test(el.className || '')) return false;
        return true;
      });
      if (!btn) return false;
      btn.click();
      return true;
    });

    if (!clicked) return { success: false, error: 'Submit button not enabled when confirming.' };

    await this.page.waitForTimeout(3000);

    // Some flows show a follow-up confirm modal after Submit; click through if present.
    await this.page.evaluate(() => {
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const btn = Array.from(document.querySelectorAll('button, div, [role="button"]')).find((el) => {
        const t = el.innerText?.trim() || '';
        return /^(Continue|Confirm|Yes, ?Confirm|OK|Proceed)$/i.test(t) && visible(el);
      });
      if (btn) btn.click();
      return Boolean(btn);
    }).then(async (clickedFollowUp) => {
      if (clickedFollowUp) await this.page.waitForTimeout(3000);
    });

    const result = await this.page.evaluate(() => {
      const normalize = (text) => (text || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };

      const errorPattern = /insufficient|failed|error|invalid|not enough|unable|could not|limit|minimum|maximum|denied|reject/i;
      const successPattern = /success|successful|completed|transaction id|reference|sent successfully/i;

      for (const el of document.querySelectorAll('[class*="toast"], [class*="Toast"], [class*="error"], .message, .modal, .ui.modal')) {
        const text = normalize(el.innerText);
        if (!text || !visible(el)) continue;
        if (errorPattern.test(text)) return { success: false, error: text };
        if (successPattern.test(text)) return { success: true, message: text };
      }

      const body = normalize(document.body.innerText);
      if (errorPattern.test(body)) {
        const match = body.match(/[^.]*?(insufficient|failed|error|invalid|not enough|unable|could not|limit|minimum|maximum|denied|reject)[^.]*\.?/i);
        return { success: false, error: match?.[0] || 'Transfer failed.' };
      }
      if (successPattern.test(body)) return { success: true, message: 'Transfer completed.' };
      return { success: null };
    });

    if (result.success === true) return { success: true, message: result.message };
    if (result.success === false) return { success: false, error: result.error };
    return { success: false, error: 'Transfer result unclear. Check Khalti history before retrying.' };
  }

  // Khalti stores `khaltiToken` in sessionStorage as a JSON-encoded string
  // (literal quotes around the value). JSON.parse before sending it as the
  // API auth header — otherwise Khalti returns 401.
  _extractToken(session) {
    let t = session?.khaltiToken;
    if (!t) throw new Error('Khalti session has no khaltiToken — run wallet login khalti.');
    if (typeof t === 'string' && t.startsWith('"') && t.endsWith('"')) {
      try { t = JSON.parse(t); } catch (_) {}
    }
    return t;
  }

  // Bank Transfer is implemented via Khalti's REST API rather than UI
  // automation. The web form's onSubmit lives in Redux callbacks that don't
  // fire from external DOM events (same root cause as Load Fund).
  // Note: `bank` field uses bank.idx here, NOT swift_code (load fund uses swift_code).
  async listWithdrawBanksApi(session) {
    const token = this._extractToken(session);
    const res = await fetch('https://khalti.com/api/bank/?payment_type=withdraw&page_size=200', {
      headers: { Authorization: `Token ${token}` },
    });
    if (res.status === 401) throw new Error('Session expired — run wallet login khalti.');
    if (!res.ok) throw new Error(`Banks API ${res.status}`);
    const data = await res.json();
    return (data.records || [])
      .filter((b) => b.has_direct_withdraw)
      .map((b) => ({ idx: b.idx, name: b.name, short_name: b.short_name, swift_code: b.swift_code }));
  }

  async validateBankAccountApi(session, { bankIdx, accountHolder, accountNo, amountRs, purpose, remarks = '' }) {
    const token = this._extractToken(session);
    const res = await fetch('https://khalti.com/api/v5/bankaccount/validate/', {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bank: bankIdx,
        account_holder_name: accountHolder,
        account_no: accountNo,
        amount: Math.round(amountRs * 100),
        purpose,
        remarks,
        paywithkhalti: 'on',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false) {
      return { success: false, error: data?.detail || data?.error || JSON.stringify(data) || `HTTP ${res.status}` };
    }
    return {
      success: true,
      accountNumber: data.account_number,
      accountName: data.account_name,
      matchPercentage: data.match_percentage,
      feeRs: typeof data.fee_amount === 'number' ? data.fee_amount / 100 : 0,
      message: data.message,
    };
  }

  async submitBankTransferApi(session, { bankIdx, accountHolder, accountNo, amountRs, purpose, remarks = '' }) {
    const token = this._extractToken(session);
    const res = await fetch('https://khalti.com/api/v5/fund/v2/withdraw/', {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bank: bankIdx,
        account_holder_name: accountHolder,
        account_no: accountNo,
        amount: Math.round(amountRs * 100),
        purpose,
        remarks,
        paywithkhalti: 'on',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false) {
      return { success: false, error: data?.detail || data?.error || JSON.stringify(data) || `HTTP ${res.status}` };
    }
    const balancePaisa = data?.meta?.balance?.primary;
    return {
      success: true,
      message: data.detail || 'Bank transfer successful',
      txnId: data.idx,
      balance: typeof balancePaisa === 'number' ? balancePaisa / 100 : null,
    };
  }

  // ======================================================================
  // Load Fund — Khalti REST API (skips React/Redux UI which silently no-ops).
  // Note: `bank` field uses bank.swift_code here (load fund), NOT bank.idx.
  // ======================================================================

  async listLinkedAccountsApi(session) {
    const token = this._extractToken(session);
    const res = await fetch('https://khalti.com/api/v5/bindaccount/my/?page_size=100', {
      headers: { Authorization: `Token ${token}` },
    });
    if (res.status === 401) throw new Error('Session expired — run wallet login khalti.');
    if (!res.ok) throw new Error(`Linked accounts API ${res.status}`);
    const data = await res.json();
    return (data.records || []).map((r) => ({
      account_id: r.account_id,
      bank_name: r.bank?.name,
      swift_code: r.bank?.swift_code,
      account_number: r.account_number,
      account_name: r.account_name,
      txn_enabled: r.txn_enabled,
    }));
  }

  async initiateLoadFundApi(session, account, amountRs, remarks = '') {
    const token = this._extractToken(session);
    const res = await fetch('https://khalti.com/api/v5/bindtransaction/v2/load/', {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Math.round(amountRs * 100),
        remarks: remarks || '',
        account_id: account.account_id,
        bank: account.swift_code,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.detail || data?.error || JSON.stringify(data) || `HTTP ${res.status}`;
      return { success: false, error: msg };
    }
    return {
      success: true,
      otpId: data.otp_id,
      needsOtp: Boolean(data.has_otp_validate),
    };
  }

  async verifyLoadFundOtpApi(session, otpId, code) {
    const token = this._extractToken(session);
    const res = await fetch('https://khalti.com/api/v5/otpmodule/verify/', {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp_id: otpId, context: 'load', code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.detail || data?.error || data?.code || JSON.stringify(data) || `HTTP ${res.status}`;
      return { success: false, error: msg };
    }
    const balancePaisa = data?.meta?.balance?.primary;
    return {
      success: true,
      message: data.detail || 'Fund loaded',
      amount: typeof data.amount === 'number' ? data.amount / 100 : null,
      txnId: data.idx,
      balance: typeof balancePaisa === 'number' ? balancePaisa / 100 : null,
    };
  }

  // ======================================================================
  // Bill payment — generic UI-driven flow.
  //
  // Khalti's bill services are IconContent cards that lead to one of:
  //   - a category page (`#/service/category/?id=...`) with more IconContent sub-cards
  //   - a direct service page (`#/service/<slug>/`) with a form + action button
  // We navigate by clicking cards until we hit a form, then discover its
  // fields, prompt the user, click the action button (PROCEED/PAY/Check),
  // optionally walk through a confirmation modal, and scrape the result.
  // ======================================================================

  async listBillTopCards() {
    if (!this.isLoggedIn) throw new Error('Not logged in');
    await this.page.goto(`${BASE_URL}/#/`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3500);
    return this.page.evaluate(() => {
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        return el.getBoundingClientRect().width > 0;
      };
      return Array.from(document.querySelectorAll('.IconContent'))
        .filter(visible)
        .map((el) => ((el.innerText || '').split('\n')[0] || '').trim())
        .filter((t) => t && t.length < 60);
    });
  }

  async clickBillCard(label) {
    if (!this.isLoggedIn) throw new Error('Not logged in');
    const clicked = await this.page.evaluate((l) => {
      const card = Array.from(document.querySelectorAll('.IconContent')).find(
        (el) => ((el.innerText || '').split('\n')[0] || '').trim() === l
      );
      if (!card) return false;
      card.click();
      return true;
    }, label);
    if (!clicked) return { kind: 'not_found' };
    await this.page.waitForTimeout(3500);
    return this.getBillState();
  }

  async getBillState() {
    const state = await this.page.evaluate(() => {
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

      const subCards = Array.from(document.querySelectorAll('.IconContent'))
        .filter(visible)
        .map((el) => ((el.innerText || '').split('\n')[0] || '').trim())
        .filter((t) => t && t.length < 60);

      const inputs = Array.from(document.querySelectorAll('input[name], textarea[name], select[name]'))
        .filter(visible)
        .filter((el) => !el.readOnly && !el.disabled)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          name: el.getAttribute('name'),
          type: el.getAttribute('type'),
          placeholder: el.getAttribute('placeholder'),
          label: el.labels?.[0]?.innerText?.trim() || null,
        }));

      const actionRe = /^(PROCEED|Pay|PAY|Submit|Check|Next)$/i;
      const actions = Array.from(document.querySelectorAll('button, div, [role="button"]'))
        .filter(visible)
        .map((el) => norm(el.innerText))
        .filter((t) => actionRe.test(t));

      const modal = document.querySelector(
        '[data-testid="service-modal-test"], .ui.modal.visible.active'
      );
      const hasModal = modal && visible(modal);

      let summary = null;
      if (hasModal) {
        const rows = {};
        modal.querySelectorAll('tr').forEach((row) => {
          const cells = Array.from(row.querySelectorAll('td')).map((td) => norm(td.innerText));
          if (cells.length >= 2) rows[cells[0]] = cells.slice(1).join(' ');
        });
        summary = {
          title: norm(modal.querySelector('.header')?.innerText) || 'Confirm',
          fields: rows,
        };
      }

      return { subCards, inputs, actions, hasModal, summary, url: location.href };
    });

    if (state.hasModal) state.kind = 'modal';
    else if (state.inputs.length > 0) state.kind = 'form';
    else if (state.subCards.length > 0) state.kind = 'category';
    else state.kind = 'unknown';

    return state;
  }

  async fillBillForm(values) {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined || value === null || value === '') continue;
      const sel = `input[name="${name}"], textarea[name="${name}"]`;
      const exists = await this.page.locator(sel).count();
      if (!exists) continue;
      await this._replaceInput(sel, String(value));
    }
  }

  async clickBillAction(actionLabel) {
    const wantedRe = new RegExp(`^${actionLabel}$`, 'i');
    const clicked = await this.page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const btn = Array.from(document.querySelectorAll('button, div, [role="button"]'))
        .filter(visible)
        .find((el) => {
          const t = (el.innerText || '').trim();
          if (!re.test(t)) return false;
          if (/disabled/i.test(el.className || '')) return false;
          return true;
        });
      if (!btn) return false;
      btn.click();
      return true;
    }, wantedRe.source);
    if (!clicked) return { success: false, error: `${actionLabel} button not found or disabled.` };
    await this.page.waitForTimeout(3500);
    return { success: true };
  }

  async confirmBillModal() {
    const clicked = await this.page.evaluate(() => {
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const btn = Array.from(document.querySelectorAll('button, div, [role="button"]'))
        .filter(visible)
        .find((el) => /^Continue$/i.test((el.innerText || '').trim()));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) return { success: false, error: 'Continue button not found in modal.' };
    await this.page.waitForTimeout(4500);
    return this._scrapeBillResult();
  }

  async _scrapeBillResult() {
    const result = await this.page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };

      const candidates = [];
      document
        .querySelectorAll(
          '.Toastify__toast, .Toastify__toast--success, .Toastify__toast--error, .Toastify__toast--warning, .Toastify__toast--info, .khalti-error, [class*="ErrorMessage"], [class*="errorMessage"], [class*="error-message"], .ui.modal.visible.active, .ui.message.error, .ui.message.positive, .ui.message.success, .ui.message.negative, .ui.message.warning'
        )
        .forEach((el) => {
          if (!visible(el)) return;
          const text = norm(el.innerText);
          if (!text || text.length > 250) return;
          candidates.push({
            text,
            isError: /toast--error|errorMessage|error-message|khalti-error|message\.negative|message\.error/i.test(el.className),
            isSuccess: /toast--success|message\.positive|message\.success/i.test(el.className),
          });
        });

      for (const c of candidates) {
        if (c.isError) return { success: false, error: c.text };
        if (c.isSuccess) return { success: true, message: c.text };
      }
      const errorPattern = /insufficient|failed|invalid|not enough|unable|could not|denied|rejected|incorrect|wrong|empty|required/i;
      const successPattern = /success|successful|completed|paid|sent/i;
      for (const c of candidates) {
        if (errorPattern.test(c.text)) return { success: false, error: c.text };
        if (successPattern.test(c.text)) return { success: true, message: c.text };
      }
      return { success: null, candidates: candidates.slice(0, 5).map((c) => c.text) };
    });

    if (result.success === true) return { success: true, message: result.message };
    if (result.success === false) return { success: false, error: result.error };
    const seen = (result.candidates || []).join(' | ') || 'no toasts/modals detected';
    return { success: false, error: `Bill result unclear. Check Khalti history. Visible: ${seen}` };
  }

  async _openSendFundForm() {
    await this.page.goto(`${BASE_URL}/#/wallet/offer-fund`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3500);
    await this.page.waitForSelector('input[name="user"]', { timeout: 15000 });
  }

  async _openTopUpForm() {
    await this.page.goto(`${BASE_URL}/#/`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);
    await this.page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.IconContent')).find((el) =>
        el.innerText?.trim().startsWith('Topup')
      );
      card?.click();
    });
    await this.page.waitForSelector('input[name="number"]', { timeout: 15000 });
  }

  async _replaceInput(selector, value) {
    const input = this.page.locator(selector).first();
    await input.click({ clickCount: 3 });
    await input.fill('');
    await input.type(String(value), { delay: 20 });
    await input.press('Tab');
    await this.page.waitForTimeout(800);
  }

  async _visibleErrorText() {
    return this.page.evaluate(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const error = Array.from(document.querySelectorAll('.khalti-error, [class*="error"], [class*="Error"]'))
        .map((el) => visible(el) ? el.innerText?.trim() : '')
        .find(Boolean);
      return error || null;
    });
  }

  // screenshot compatibility shim used by some commands
  async screenshot(path) {
    if (this.page) await this.page.screenshot({ path, fullPage: false });
  }

  async _waitForSessionReady() {
    await this.page.waitForFunction(
      () => {
        const token = sessionStorage.getItem('khaltiToken');
        const text = document.body?.innerText || '';
        return Boolean(token) || /Total Balance|Transaction History|LOAD|TRANSFER/i.test(text);
      },
      { timeout: 8000 }
    );
  }

  async _isLoggedIn() {
    return this.page.evaluate(() => {
      const text = document.body.innerText || '';
      const hash = window.location.hash || '';
      const hasLoginForm = !!document.querySelector('input[name="id"], input[name="password"]');
      if (hash.includes('login') || hasLoginForm) return false;
      return (
        text.includes('Total Balance') ||
        text.includes('Transaction History') ||
        /\bLOAD\b/.test(text) ||
        /\bTRANSFER\b/.test(text)
      );
    });
  }
}
