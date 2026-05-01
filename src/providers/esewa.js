import { BaseProvider } from './base.js';

const BASE_URL = 'https://esewa.com.np';

export class EsewaProvider extends BaseProvider {
  constructor(headless = true) {
    super(headless);
    this.isLoggedIn = false;
  }

  async fillAndSubmit(phone, password, cookies = null) {
    await this.launch(cookies);
    await this.page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });
    await this.page.waitForTimeout(3000);
    await this.page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await this.page.fill('input[name="username"]', phone);
    await this.page.waitForTimeout(300);
    await this.page.fill('input[type="password"]', password);
    await this.page.waitForTimeout(300);
    await this.page.click('button.btn-green, input[type="submit"][value*="Login"], button[type="submit"]:has-text("Login")');
  }

  // Restore a saved session — returns true if still valid
  async restoreSession(cookies) {
    await this.launch(cookies);
    await this.page.goto(`${BASE_URL}/#/main`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    const url = this.page.url();
    const loggedIn = url.includes('#/main') || url.includes('#/dashboard');
    if (loggedIn) this.isLoggedIn = true;
    return loggedIn;
  }

  async login(phone, password) {
    await this.launch();
    await this.page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });
    await this.page.waitForTimeout(3000);
    await this.page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await this.page.fill('input[name="username"]', phone);
    await this.page.waitForTimeout(300);
    await this.page.fill('input[type="password"]', password);
    await this.page.waitForTimeout(300);
    await this.page.click('button.btn-green, input[type="submit"][value*="Login"], button[type="submit"]:has-text("Login")');

    const timeout = this.headless ? 15000 : 600000;

    try {
      await this.page.waitForFunction(
        () => {
          const onOtpPage = !!document.querySelector('input[placeholder*="Token"], input[placeholder*="token"], input[placeholder*="verification"]');
          if (onOtpPage) return false;
          return document.querySelector('.user-balance') !== null ||
                 document.querySelector('.balance-amount') !== null ||
                 document.querySelector('[ng-show="isLoggedIn()"]')?.offsetParent !== null;
        },
        { timeout }
      );
      this.isLoggedIn = true;
      return { success: true };
    } catch {
      await this.page.screenshot({ path: '/tmp/esewa-debug.png', fullPage: false });
      const errEl = await this.page.$('.alert-danger, .error-message, [class*="error"]');
      const errText = errEl ? await errEl.innerText() : 'Login failed. Check your credentials.';
      return { success: false, error: `${errText.trim().split('\n')[0]} (screenshot: /tmp/esewa-debug.png)` };
    }
  }

  async getBalance() {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/main`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    const { balance, name } = await this.page.evaluate(() => {
      const balanceEl = document.querySelector('.es-user__balance');
      const balance = balanceEl
        ? balanceEl.innerText.replace(/NPR\.?\s*/i, '').trim()
        : null;
      const nameEl = document.querySelector('.dropdown--profile__name-section');
      const name = nameEl ? nameEl.innerText.trim().split('\n')[0].trim() : null;
      return { balance, name };
    });

    return { balance: balance || 'N/A', name };
  }

  async sendMoney(cookies, receiver, amount, purpose, remarks, mpin) {
    if (!this.isLoggedIn) await this.restoreSession(cookies);

    await this.page.goto(`${BASE_URL}/#/make_payment/BALTXN/Fund%20Transfer`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    // Step 1: fill the form
    await this.page.waitForSelector('input[name="receiverName"]', { timeout: 10000 });
    await this.page.fill('input[name="receiverName"]', receiver);
    await this.page.waitForTimeout(400);
    await this.page.fill('input[name="amount"]', String(amount));
    await this.page.waitForTimeout(300);
    const validPurposes = ['Bill sharing', 'Family Expenses', 'Groceries', 'Lend/borrow', 'Personal Use', 'Ride Sharing'];
    const safePurpose = validPurposes.includes(purpose) ? purpose : 'Personal Use';
    await this.page.selectOption('select[name="purpose"]', safePurpose);
    await this.page.waitForTimeout(300);
    if (remarks) await this.page.fill('input[name="remarks"]', remarks);
    await this.page.waitForTimeout(300);

    // Step 2: PROCEED → confirmation screen
    await this.page.click('button.btn-confirm');
    await this.page.waitForTimeout(2000);

    // Step 3: PAY VIA ESEWA → MPIN dialog
    try {
      await this.page.waitForSelector('button.btn-confirm:has-text("PAY VIA ESEWA")', { timeout: 8000 });
      await this.page.click('button.btn-confirm:has-text("PAY VIA ESEWA")');
      await this.page.waitForTimeout(2000);

      // Step 4: race between MPIN dialog and immediate success
      // (eSewa sometimes skips MPIN for trusted devices)
      const next = await Promise.race([
        this.page.waitForSelector('input[name="credential"]', { timeout: 8000 }).then(() => 'mpin'),
        this.page.waitForSelector('button:has-text("Raise Issue"), .transaction-detail, :text("COMPLETE")', { timeout: 8000 }).then(() => 'success'),
      ]).catch(() => 'unknown');

      if (next === 'mpin') {
        await this._submitMpin(mpin);

        const errorEl = await this.page.$('.alert-danger, [class*="error-msg"]');
        if (errorEl) {
          const errText = await errorEl.innerText();
          return { success: false, error: errText.trim().split('\n')[0] };
        }
      }

      if (next === 'success' || next === 'mpin') {
        // Extract transaction reference if available
        const refEl = await this.page.$('td:has-text("Reference") + td, :text("Reference Code") + *, .ref-code');
        const ref = refEl ? await refEl.innerText() : null;
        return { success: true, ref };
      }

      await this.page.screenshot({ path: '/tmp/esewa-send-debug.png', fullPage: false });
      return { success: false, error: 'Transfer result unclear. Check /tmp/esewa-send-debug.png' };
    } catch (e) {
      await this.page.screenshot({ path: '/tmp/esewa-send-debug.png', fullPage: false });
      return { success: false, error: `${e.message.split('\n')[0]} (screenshot: /tmp/esewa-send-debug.png)` };
    }
  }

  async loadFund(bankName, amount, purpose) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/loadfund/linked-account`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    // Click the bank card — each card is .load-fund-wrap__list with ng-click="showBankModal(...)"
    const clicked = await this.page.evaluate((name) => {
      const cards = Array.from(document.querySelectorAll('.load-fund-wrap__list'));
      for (const card of cards) {
        if (card.innerText.trim() === name) {
          card.click();
          return true;
        }
      }
      return false;
    }, bankName);

    if (!clicked) {
      await this.page.screenshot({ path: '/tmp/esewa-load-debug.png', fullPage: false });
      return { success: false, error: `Bank "${bankName}" not found. Screenshot: /tmp/esewa-load-debug.png` };
    }

    await this.page.waitForTimeout(2000);

    // Fill amount in modal
    const amountInput = await this.page.$('input[placeholder*="amount" i], input[placeholder*="Enter amount" i]');
    if (!amountInput) {
      await this.page.screenshot({ path: '/tmp/esewa-load-debug.png', fullPage: false });
      return { success: false, error: 'Amount field not found. Screenshot: /tmp/esewa-load-debug.png' };
    }
    await amountInput.fill(String(amount));
    await this.page.waitForTimeout(300);

    // Select purpose
    await this.page.selectOption('select', purpose).catch(async () => {
      // Try clicking purpose option if not a native select
      const opts = await this.page.$$('[ng-options] option, select option');
      for (const opt of opts) {
        const text = await opt.innerText().catch(() => '');
        if (text.trim() === purpose) { await opt.click(); break; }
      }
    });
    await this.page.waitForTimeout(300);

    // Click Send OTP
    await this.page.click('button:has-text("Send OTP")');
    await this.page.waitForTimeout(2000);

    // Check if OTP screen appeared
    const otpField = await this.page.$('input[placeholder*="OTP" i], input[placeholder*="otp" i]');
    if (otpField) return 'otp_required';

    await this.page.screenshot({ path: '/tmp/esewa-load-debug.png', fullPage: false });
    return { success: false, error: 'OTP screen did not appear. Screenshot: /tmp/esewa-load-debug.png' };
  }

  async submitLoadOtp(otp) {
    const otpField = await this.page.$('input[placeholder*="OTP" i], input[placeholder*="otp" i]');
    if (!otpField) return { success: false, error: 'OTP field not found' };

    await otpField.fill(otp);
    await this.page.waitForTimeout(300);
    await this.page.click('button:has-text("Verify")');
    await this.page.waitForTimeout(3000);

    const errorEl = await this.page.$('.alert-danger, [class*="error"], [class*="invalid"]');
    if (errorEl) {
      const msg = await errorEl.innerText();
      return { success: false, error: msg.trim().split('\n')[0] };
    }

    const refEl = await this.page.$('p.fields');
    const ref = refEl ? await refEl.innerText() : null;
    return { success: true, ref };
  }

  async topUp(mobile, amount, mpin) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/make_payment/TOPUP/Top%20Up`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    await this.page.waitForSelector('input[name="topNumber"]', { timeout: 10000 });
    await this.page.fill('input[name="topNumber"]', mobile);
    await this.page.waitForTimeout(1000);

    // Fill amount
    const amountInput = await this.page.$('input[name="amount"], input[name="topupAmount"], input[placeholder*="amount" i]');
    if (!amountInput) {
      await this.page.screenshot({ path: '/tmp/esewa-topup-debug.png', fullPage: false });
      return { success: false, error: 'Could not find amount field. Screenshot: /tmp/esewa-topup-debug.png' };
    }
    await amountInput.fill(String(amount));
    await this.page.waitForTimeout(800);

    // Check for minimum amount validation error before trying to PROCEED
    const minError = await this.page.$eval(
      'input[name="amount"] ~ *, input[name="topupAmount"] ~ *',
      (el) => el?.innerText?.trim() || null
    ).catch(() => null);
    if (minError && /minimum amount is (\d+)/i.test(minError)) {
      const min = minError.match(/minimum amount is (\d+)/i)[1];
      return { success: false, error: `Minimum recharge amount is Rs.${min}` };
    }

    // PROCEED — button must be enabled; if still disabled, catch and report
    try {
      await this.page.click('button.btn-confirm', { timeout: 8000 });
    } catch {
      // Re-check for minimum error after attempt
      const minErr = await this.page.$eval(
        'input[name="amount"] ~ *, input[name="topupAmount"] ~ *',
        (el) => el?.innerText?.trim() || null
      ).catch(() => null);
      if (minErr && /minimum/i.test(minErr)) {
        const m = minErr.match(/(\d+)/);
        return { success: false, error: `Minimum recharge amount is Rs.${m ? m[1] : '?'}` };
      }
      await this.page.screenshot({ path: '/tmp/esewa-topup-debug.png', fullPage: false });
      return { success: false, error: 'PROCEED button is disabled. Screenshot: /tmp/esewa-topup-debug.png' };
    }
    await this.page.waitForTimeout(2000);

    try {
      await this.page.waitForSelector('button.btn-confirm:has-text("PAY VIA ESEWA")', { timeout: 8000 });
      await this.page.click('button.btn-confirm:has-text("PAY VIA ESEWA")');
      await this.page.waitForTimeout(2000);

      const next = await Promise.race([
        this.page.waitForSelector('input[name="credential"]', { timeout: 8000 }).then(() => 'mpin'),
        this.page.waitForSelector('button:has-text("Raise Issue"), :text("COMPLETE")', { timeout: 8000 }).then(() => 'success'),
      ]).catch(() => 'unknown');

      if (next === 'mpin') {
        await this._submitMpin(mpin);

        const errorEl = await this.page.$('.alert-danger, [class*="error-msg"]');
        if (errorEl) {
          const errText = await errorEl.innerText();
          return { success: false, error: errText.trim().split('\n')[0] };
        }
      }

      if (next === 'success' || next === 'mpin') {
        const refEl = await this.page.$('p.fields');
        const ref = refEl ? await refEl.innerText() : null;
        return { success: true, ref };
      }

      await this.page.screenshot({ path: '/tmp/esewa-topup-debug.png', fullPage: false });
      return { success: false, error: 'Top Up result unclear. Check /tmp/esewa-topup-debug.png' };
    } catch (e) {
      await this.page.screenshot({ path: '/tmp/esewa-topup-debug.png', fullPage: false });
      return { success: false, error: `${e.message.split('\n')[0]} (screenshot: /tmp/esewa-topup-debug.png)` };
    }
  }

  async getTransactionDetail(rowNum = 1) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/statements`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(4000);

    // Dismiss any open modals (e.g. Terms & Conditions) before proceeding
    const closeBtn = await this.page.$('.modal .close, .modal button[data-dismiss="modal"], .modal .btn-default');
    if (closeBtn) {
      await closeBtn.click();
      await this.page.waitForTimeout(1000);
    }
    // Press Escape as fallback
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(500);

    // Scroll enough rows into view if needed
    if (rowNum > 10) {
      let previous = 0;
      for (let i = 0; i < Math.ceil(rowNum / 20) + 1; i++) {
        await this.page.keyboard.press('End');
        await this.page.waitForTimeout(1500);
        const count = await this.page.$$eval('table tbody tr', (rows) => rows.length);
        if (count === previous) break;
        previous = count;
      }
    }

    const rows = await this.page.$$('table tbody tr');
    if (rows.length < rowNum) return null;

    // Try clicking a link inside the row first; fall back to the row itself
    const row = rows[rowNum - 1];
    const link = await row.$('a, button, [ng-click], [ui-sref]');
    if (link) {
      await link.click();
    } else {
      await row.click();
    }
    await this.page.waitForTimeout(2000);

    // Wait for a modal that contains transaction-specific content
    // (not T&C — those don't have "Reference" or "Amount" labels)
    const detailModalSel = '.modal.in .modal-content, .modal.show .modal-content';
    try {
      await this.page.waitForSelector(detailModalSel, { timeout: 8000 });
    } catch {
      // Try without .in/.show qualifier
      try {
        await this.page.waitForSelector('.modal-content', { timeout: 4000 });
      } catch {
        return null;
      }
    }

    // Give Angular a moment to populate the modal fields
    await this.page.waitForTimeout(1500);

    const detail = await this.page.evaluate(() => {
      // Find the visible modal
      const modal = Array.from(document.querySelectorAll('.modal-content')).find(
        (el) => el.offsetParent !== null
      ) || document.querySelector('.modal-content');

      if (!modal) return { map: {}, title: null };

      // eSewa uses span.lr (label) + p.fields (value) inside the same parent div
      const title = modal.querySelector('.transaction-header__title')?.innerText.trim() || null;
      const map = {};

      modal.querySelectorAll('span.lr').forEach((span) => {
        const key = span.innerText.trim();
        const val = span.parentElement?.querySelector('p.fields')?.innerText.trim();
        if (key && val) map[key] = val;
      });

      return { map, title };
    });

    const m = detail.map;

    // eSewa's exact label strings (from DOM: span.lr innerText)
    const get = (label) => {
      // exact match first
      if (m[label]) return m[label];
      // case-insensitive substring fallback
      const lower = label.toLowerCase();
      for (const [k, v] of Object.entries(m)) {
        if (k.toLowerCase().includes(lower)) return v;
      }
      return null;
    };

    const status = get('Status');

    return {
      title: detail.title,
      reference:     get('Reference Code'),
      date:          get('Date/Time'),
      status:        status ? status.replace(/\s+/g, ' ').trim() : null,
      amount:        get('Amount (NPR)'),
      channel:       get('Channel'),
      purpose:       get('Purpose Of  Transaction') || get('Purpose Of Transaction') || get('Purpose'),
      processedBy:   get('Processed By'),
      senderName:    get('Sender  Name') || get('Sender Name') || get('Sender'),
      receiverName:  get('Receiver  Name') || get('Receiver Name') || get('Receiver'),
      bankName:      get('Source Bank Name') || get('Bank Name') || get('Bank'),
      paymentMethod: get('Payment Method'),
      remarks:       get('Remarks'),
      requestId:     get('Request unique id') || get('Request Unique Id'),
      _raw: m,
    };
  }

  async getSavedBanks() {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/withdraw/bank_withdraw`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    return this.page.evaluate(() => {
      return Array.from(document.querySelectorAll('figure.showcase-item')).map((fig) => ({
        name: fig.querySelector('.fig-img__section__with-logo__content__title')?.innerText?.trim() || '',
        holder: fig.querySelector('.fig-img__section__main-text')?.innerText?.trim() || '',
        accountNo: fig.querySelector('.fig-img__section__sub-text')?.innerText?.trim() || '',
        linked: !!fig.querySelector('.ribbon'),
      })).filter((b) => b.name);
    });
  }

  async bankTransfer(bankName, amount, remarks, mpin) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/withdraw/bank_withdraw`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    // Click the saved bank card matching the bank name
    const clicked = await this.page.evaluate((name) => {
      const figs = Array.from(document.querySelectorAll('figure.showcase-item'));
      for (const fig of figs) {
        const title = fig.querySelector('.fig-img__section__with-logo__content__title')?.innerText?.trim();
        if (title === name) { fig.click(); return true; }
      }
      return false;
    }, bankName);

    if (!clicked) {
      await this.page.screenshot({ path: '/tmp/esewa-banktx-debug.png', fullPage: false });
      return { success: false, error: `Bank "${bankName}" not found. Screenshot: /tmp/esewa-banktx-debug.png` };
    }
    await this.page.waitForTimeout(2000);

    // Use triple-click + type to trigger Angular ng-change on amount field
    const amountField = await this.page.$('input#amount');
    await amountField.click({ clickCount: 3 });
    await this.page.keyboard.type(String(amount));
    await this.page.keyboard.press('Tab');
    await this.page.waitForTimeout(800);

    const remarksField = await this.page.$('input#remarks');
    await remarksField.click({ clickCount: 3 });
    await this.page.keyboard.type(remarks || 'Transfer');
    await this.page.keyboard.press('Tab');
    await this.page.waitForTimeout(500);

    try {
      await this.page.click('button:has-text("PROCEED")', { timeout: 8000 });
    } catch {
      await this.page.screenshot({ path: '/tmp/esewa-banktx-debug.png', fullPage: false });
      return { success: false, error: 'PROCEED disabled — check amount/remarks. Screenshot: /tmp/esewa-banktx-debug.png' };
    }
    await this.page.waitForTimeout(2000);

    try {
      // eSewa may show an "Account Validation" modal before PAY VIA ESEWA
      const step2 = await Promise.race([
        this.page.waitForSelector('button:has-text("PAY VIA ESEWA")', { timeout: 6000 }).then(() => 'pay'),
        this.page.waitForSelector('.modal button:has-text("PROCEED"), .modal-dialog button:has-text("PROCEED")', { timeout: 6000 }).then(() => 'validation'),
      ]).catch(() => 'unknown');

      if (step2 === 'validation') {
        await this.page.click('.modal button:has-text("PROCEED"), .modal-dialog button:has-text("PROCEED")');
        await this.page.waitForTimeout(1500);
      }

      await this.page.waitForSelector('button:has-text("PAY VIA ESEWA")', { timeout: 8000 });
      await this.page.click('button:has-text("PAY VIA ESEWA")');
      await this.page.waitForTimeout(2000);

      const next = await Promise.race([
        this.page.waitForSelector('input[name="credential"]', { timeout: 8000 }).then(() => 'mpin'),
        this.page.waitForSelector('button:has-text("Raise Issue"), :text("COMPLETE")', { timeout: 8000 }).then(() => 'success'),
      ]).catch(() => 'unknown');

      if (next === 'mpin') {
        await this._submitMpin(mpin);

        const errorEl = await this.page.$('.alert-danger, [class*="error-msg"]');
        if (errorEl) {
          return { success: false, error: (await errorEl.innerText()).trim().split('\n')[0] };
        }
      }

      if (next === 'success' || next === 'mpin') {
        const refEl = await this.page.$('p.fields');
        return { success: true, ref: refEl ? await refEl.innerText() : null };
      }

      await this.page.screenshot({ path: '/tmp/esewa-banktx-debug.png', fullPage: false });
      return { success: false, error: 'Result unclear. Screenshot: /tmp/esewa-banktx-debug.png' };
    } catch (e) {
      await this.page.screenshot({ path: '/tmp/esewa-banktx-debug.png', fullPage: false });
      return { success: false, error: `${e.message.split('\n')[0]} (screenshot: /tmp/esewa-banktx-debug.png)` };
    }
  }

  async _navigateToCategoryPage(categoryLabel) {
    await this.page.goto(`${BASE_URL}/#/main`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    // Match by href content (most reliable) then fall back to inner text
    const clicked = await this.page.evaluate((label) => {
      const lc = label.toLowerCase();
      const anchors = Array.from(document.querySelectorAll('a[href*="service-list"], a[href*="products/"]'));
      for (const a of anchors) {
        const href = (a.getAttribute('href') || '').toLowerCase();
        const text = (a.innerText?.trim() || '').toLowerCase();
        if (href.includes(lc) || text.includes(lc)) {
          a.click();
          return { found: true, href: a.getAttribute('href'), text: a.innerText?.trim() };
        }
      }
      return { found: false };
    }, categoryLabel);

    if (!clicked.found) {
      await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
      throw new Error(`Category "${categoryLabel}" not found on main page. Screenshot: /tmp/esewa-bill-debug.png`);
    }

    await this.page.waitForTimeout(3000);
  }

  async getBillProductsByCategory(categoryLabel) {
    if (!this.isLoggedIn) throw new Error('Not logged in');
    await this._navigateToCategoryPage(categoryLabel);

    const products = await this.page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Layout 1: service-list pages — ng-click="getDetails(product.productCode, ...)"
      document.querySelectorAll('[ng-click*="getDetails(product"], [ng-click*="getDetails(p,"]').forEach((el) => {
        try {
          const scope = window.angular?.element(el).scope?.();
          if (scope?.product?.productCode && scope?.product?.name) {
            const key = scope.product.productCode;
            if (!seen.has(key)) {
              seen.add(key);
              results.push({ name: scope.product.name, code: scope.product.productCode, productName: scope.product.name });
            }
            return;
          }
        } catch {}
        const name = el.querySelector('h5.ng-binding, h4.ng-binding, .ng-binding')?.innerText?.trim() || el.innerText?.trim();
        if (name && name.length > 1 && !seen.has(name)) {
          seen.add(name);
          results.push({ name, code: null, productName: name });
        }
      });

      // Literal getDetails('CODE','NAME') form
      document.querySelectorAll('[ng-click*="getDetails(\'"]').forEach((el) => {
        const ngClick = el.getAttribute('ng-click') || '';
        const nc = ngClick.match(/getDetails\('([^']+)',\s*'([^']+)'/);
        if (nc && !seen.has(nc[1])) {
          seen.add(nc[1]);
          results.push({ name: el.innerText?.trim() || nc[2], code: nc[1], productName: nc[2] });
        }
      });

      if (results.length) return results;

      // Layout 2: /products/Category/ID pages — sub-categories with school.code / school.name
      // Pull all products from ALL childMenus
      try {
        const catEl = document.querySelector('[ng-repeat*="childMenus"]');
        if (catEl) {
          const scope = window.angular?.element(catEl).scope?.();
          const childMenus = scope?.products?.childMenus || [];
          for (const menu of childMenus) {
            for (const p of (menu.products || [])) {
              const key = p.code || p.name;
              if (key && !seen.has(key) && p.name) {
                seen.add(key);
                results.push({ name: p.name, code: p.code || null, productName: p.name, subCategory: menu.name });
              }
            }
          }
        }
      } catch {}

      // Fallback: visible anchor items using goToState
      if (!results.length) {
        document.querySelectorAll('a[ng-click*="goToState"]').forEach((a) => {
          try {
            const scope = window.angular?.element(a).scope?.();
            const s = scope?.school;
            if (s?.code && s?.name && !seen.has(s.code)) {
              seen.add(s.code);
              results.push({ name: s.name, code: s.code, productName: s.name });
            }
          } catch {}
        });
      }

      return results;
    });

    return products;
  }

  async selectCategoryProductAndGetCode(categoryLabel, productName, productCode = null) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    // If we have the product code, navigate directly — no sub-category tab clicking needed.
    // This avoids Angular re-render timing issues on products/ pages (Financial, Education, etc.)
    if (productCode) {
      const directUrl = `${BASE_URL}/#/make_payment/${encodeURIComponent(productCode)}/${encodeURIComponent(productName)}`;
      await this.page.goto(directUrl, { waitUntil: 'load', timeout: 20000 });
      await this.page.waitForTimeout(2500);
      const finalUrl = this.page.url();
      if (finalUrl.includes('make_payment')) {
        const match = finalUrl.match(/#\/make_payment\/([^/]+)\/(.+)/);
        return {
          code: match ? decodeURIComponent(match[1]) : productCode,
          productName: match ? decodeURIComponent(match[2]) : productName,
          directUrl: finalUrl,
        };
      }
      // Fell through (redirect) — screenshot and return null
      await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
      return null;
    }

    // Fallback: navigate to category page and click through the UI (service-list pages)
    await this._navigateToCategoryPage(categoryLabel);

    // Try service-list style first (ng-click*="getDetails")
    let clicked = await this.page.evaluate((name) => {
      const lc = name.toLowerCase();
      for (const el of document.querySelectorAll('[ng-click*="getDetails"]')) {
        const text = el.querySelector('h5.ng-binding, .ng-binding')?.innerText?.trim() || el.innerText?.trim();
        if (text && text.toLowerCase() === lc) { el.click(); return true; }
      }
      return false;
    }, productName);

    if (!clicked) {
      // goToState anchor pages (sub-category tabs) — click each tab, wait, search
      const tabCount = await this.page.evaluate(() =>
        document.querySelectorAll('div.cat-list').length
      );
      for (let i = 0; i < tabCount && !clicked; i++) {
        await this.page.evaluate((idx) => {
          const tabs = document.querySelectorAll('div.cat-list');
          if (tabs[idx]) tabs[idx].click();
        }, i);
        await this.page.waitForTimeout(1000);
        clicked = await this.page.evaluate((name) => {
          const lc = name.toLowerCase();
          for (const a of document.querySelectorAll('a[ng-click*="goToState"]')) {
            if (a.innerText?.trim().toLowerCase() === lc) { a.click(); return true; }
          }
          return false;
        }, productName);
      }
    }

    if (!clicked) {
      await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
      return null;
    }

    await this.page.waitForTimeout(3000);

    const finalUrl = this.page.url();
    const match = finalUrl.match(/#\/make_payment\/([^/]+)\/(.+)/);
    if (match) {
      return {
        code: decodeURIComponent(match[1]),
        productName: decodeURIComponent(match[2]),
        directUrl: finalUrl,
      };
    }

    await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
    return null;
  }

  async searchBillers(query) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/main`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    // eSewa's product search input (not the nav merchantId input)
    const searchInput = await this.page.$('input[type="search"], input[placeholder*="Search service" i], input[placeholder*="Find" i], input[name="merchantId"]');
    if (!searchInput) {
      await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
      throw new Error('Search input not found on eSewa main page. Screenshot: /tmp/esewa-bill-debug.png');
    }

    await searchInput.click({ clickCount: 3 });
    await this.page.keyboard.type(query);
    await this.page.waitForTimeout(2500);

    // Collect typeahead suggestions — eSewa uses ng-click="onItemSelection(product)"
    const results = await this.page.evaluate(() => {
      // Try multiple selectors for typeahead results
      const selectors = [
        '[ng-click*="onItemSelection"]',
        'typeahead-popup li',
        '.custom-popup-wrapper li',
        '[uib-typeahead-popup] li',
        '.dropdown-menu li[ng-repeat]',
      ];
      for (const sel of selectors) {
        const items = Array.from(document.querySelectorAll(sel));
        if (items.length) {
          return items.map((el) => ({
            name: el.innerText?.trim(),
            ngClick: el.getAttribute('ng-click') || '',
          })).filter((r) => r.name && r.name.length > 1 && r.name.length < 80);
        }
      }
      return [];
    });

    return results;
  }

  async selectBillerAndGetPaymentCode(query, resultIndex = 0) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/main`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(3000);

    const searchInput = await this.page.$('input[type="search"], input[placeholder*="Search service" i], input[placeholder*="Find" i], input[name="merchantId"]');
    if (!searchInput) throw new Error('Search input not found on eSewa main page.');

    await searchInput.click({ clickCount: 3 });
    await this.page.keyboard.type(query);
    await this.page.waitForTimeout(2500);

    const selectors = [
      '[ng-click*="onItemSelection"]',
      'typeahead-popup li',
      '.custom-popup-wrapper li',
      '[uib-typeahead-popup] li',
      '.dropdown-menu li[ng-repeat]',
    ];
    let items = [];
    for (const sel of selectors) {
      items = await this.page.$$(sel);
      if (items.length) break;
    }

    if (!items.length) {
      await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
      return null;
    }

    await items[resultIndex].click();
    await this.page.waitForTimeout(3000);

    const finalUrl = this.page.url();
    const match = finalUrl.match(/#\/make_payment\/([^/]+)\/(.+)/);
    if (match) {
      return {
        code: decodeURIComponent(match[1]),
        productName: decodeURIComponent(match[2]),
        url: finalUrl,
      };
    }

    // Fallback: look for payment links on the page
    const payLink = await this.page.$('a[href*="make_payment"]');
    if (payLink) {
      const href = await payLink.getAttribute('href');
      const m2 = href?.match(/#\/make_payment\/([^/]+)\/(.+)/);
      if (m2) return { code: decodeURIComponent(m2[1]), productName: decodeURIComponent(m2[2]), url: finalUrl };
    }

    await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
    return null;
  }

  async _parsePaymentResult() {
    // eSewa shows "Raise Issue" on BOTH success and failure result pages.
    // Distinguish by checking for failure text first, then reference code.
    const result = await this.page.evaluate(() => {
      function isVisible(el) {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      }

      const ERROR_PAT = /invalid|failed|error|incorrect|unsuccessful|wrong|not found|must be|greater than|minimum|required/i;
      // Check visible notifications/toasts first (fixed-position — offsetParent is null for these)
      const notifSelectors = [
        '[class*="notification"]', '[class*="toast"]', '[class*="growl"]',
        '.alert-danger', '[class*="error-msg"]',
      ];
      for (const sel of notifSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.innerText?.trim();
          if (isVisible(el) && t && t.length > 5 && ERROR_PAT.test(t)) return { success: false, error: t };
        }
      }

      const body = document.body.innerText || '';

      // Check for explicit failure indicators
      const failPatterns = [
        /insufficient\s+balance/i,
        /transaction\s+(failed|unsuccessful)/i,
        /payment\s+(failed|unsuccessful)/i,
        /could\s+not\s+complete/i,
        /invalid\s+credit\s+card/i,
        /dear\s+customer[^.]*(?:insufficient|failed|error)/i,
      ];
      for (const pat of failPatterns) {
        const m = body.match(pat);
        if (m) {
          return { success: false, error: m[0] };
        }
      }

      // Look for reference code — the clearest success indicator
      const refEl = document.querySelector('p.fields');
      if (refEl) {
        const ref = refEl.innerText.trim();
        if (ref) return { success: true, ref };
      }

      // Check for COMPLETE text alongside a non-failure context
      if (/\bCOMPLETE\b/i.test(body) && !/failed|unsuccessful|insufficient/i.test(body)) {
        return { success: true, ref: null };
      }

      // No clear signal
      return { success: null };
    });

    if (result.success === true) return { success: true, ref: result.ref };
    if (result.success === false) return { success: false, error: result.error };

    // Take screenshot for ambiguous cases
    await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
    return { success: false, error: 'Payment result unclear. Check /tmp/esewa-bill-debug.png' };
  }

  // Navigate to a payment form URL and wait for at least one form field to appear
  async navigateToPaymentForm(url) {
    await this.page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(2000);
    try {
      await this.page.waitForFunction(() => {
        const skip = new Set(['merchantId', 'usedPromocode', 'txtPromoCode']);
        return Array.from(document.querySelectorAll('input, select, textarea')).some((el) => {
          const name = el.getAttribute('name') || '';
          return el.offsetParent !== null && !skip.has(name) && el.getAttribute('type') !== 'hidden';
        });
      }, { timeout: 12000 });
    } catch {
      await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
      throw new Error('Payment form did not load. Screenshot: /tmp/esewa-bill-debug.png');
    }
  }

  // Reads every visible form field from the current page and returns structured metadata.
  // Returns: [{label, name, ngModel, key, type, required, options, currentValue, readonly}]
  async discoverFormFields() {
    return this.page.evaluate(() => {
      const SKIP_NAMES = new Set(['merchantId', 'usedPromocode', 'txtPromoCode', 'credential']);
      const SKIP_TYPES = new Set(['hidden', 'submit', 'button']);
      const BLANK_OPTIONS = new Set(['Select', '-Select-', 'SELECT COUNTER', '--Select--', 'select', '']);

      function findLabel(input) {
        // 1. <label for="id"> — most reliable
        const id = input.getAttribute('id');
        if (id) {
          try {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl) return lbl.innerText;
          } catch {}
        }

        // 2. Walk backwards through the PARENT'S children to find the nearest preceding label
        // This handles flat sibling layouts (label, input, label, input...)
        const parent = input.parentElement;
        if (parent) {
          const children = Array.from(parent.children);
          const idx = children.indexOf(input);
          for (let j = idx - 1; j >= 0; j--) {
            const c = children[j];
            if (c.tagName === 'LABEL') return c.innerText;
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(c.tagName)) break; // hit another field, stop
            const lbl = c.querySelector?.('label');
            if (lbl) return lbl.innerText;
          }
        }

        // 3. Input inside a .form-group (Bootstrap style) — look at direct label child
        const fg = input.closest('.form-group, .field-group, .input-group-label');
        if (fg) {
          // Get only direct children labels to avoid picking up a label from a sibling group
          const directLabel = Array.from(fg.children).find(c => c.tagName === 'LABEL');
          if (directLabel) return directLabel.innerText;
        }

        // 4. Placeholder / name fallback
        return input.getAttribute('placeholder') || input.getAttribute('name') || 'Field';
      }

      // --- 1. ui-select custom dropdowns (Angular ui-select / ui-bootstrap typeahead) ---
      const fields = [];
      const seen = new Set();
      const uiSelectLabels = new Set(); // labels claimed by ui-select; used to skip ghost native inputs

      // Detect ui-select containers FIRST so we can skip their internal inputs below
      const uiSelectContainers = Array.from(
        document.querySelectorAll('.ui-select-container, ui-select')
      ).filter((el) => el.offsetParent !== null);

      for (const container of uiSelectContainers) {
        // Label is on a sibling/preceding <label> of the container, not inside it
        let labelText = '';
        const parent = container.parentElement;
        if (parent) {
          const children = Array.from(parent.children);
          const idx = children.indexOf(container);
          for (let j = idx - 1; j >= 0; j--) {
            const c = children[j];
            if (c.tagName === 'LABEL') { labelText = c.innerText; break; }
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes(c.tagName)) break;
          }
        }
        if (!labelText) {
          const fg = container.closest('.form-group, .field-group');
          if (fg) {
            const lbl = Array.from(fg.children).find((c) => c.tagName === 'LABEL');
            if (lbl) labelText = lbl.innerText;
          }
        }
        labelText = (labelText || 'Counter').replace(/[*:\n\r]+/g, ' ').trim().replace(/\s+/g, ' ').replace(/\s*[*:]+\s*$/, '').trim();

        // The ng-model is on the container itself (Angular binds it there)
        const ngModel = container.getAttribute('ng-model') || '';
        // Read already-selected value from the match display
        const matchEl = container.querySelector('.ui-select-match-text, .ui-select-toggle span:not(.caret)');
        const currentValue = matchEl?.innerText?.trim() || '';

        const key = ngModel || labelText;
        if (seen.has(key)) continue;
        seen.add(key);
        uiSelectLabels.add(labelText.toLowerCase());

        fields.push({
          label: labelText,
          name: '',
          ngModel,
          key,
          type: 'ui-select',
          required: container.getAttribute('ng-required') === 'true' || false,
          currentValue,
          readonly: false,
          options: [], // populated lazily when interactiveFill expands the dropdown
        });
      }

      // --- 2. Native inputs / selects / textareas ---
      const inputs = Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => {
        if (!el.offsetParent) return false;
        const name = el.getAttribute('name') || '';
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (SKIP_NAMES.has(name)) return false;
        if (SKIP_TYPES.has(type)) return false;
        if (/promo/i.test(name)) return false;
        // Skip inputs that live INSIDE a ui-select container (they are the search/match inputs)
        if (el.closest('.ui-select-container, ui-select')) return false;
        // Skip unidentifiable ghost inputs (no name, no ng-model — cannot be filled or sent)
        const ngModel = el.getAttribute('ng-model') || '';
        if (!name && !ngModel && el.tagName !== 'SELECT') return false;
        return true;
      });

      // First pass: group radio buttons by name, collect all other inputs
      const radioGroups = {}; // name → [{label, value}]
      const nonRadioInputs = [];
      for (const input of inputs) {
        if ((input.getAttribute('type') || '').toLowerCase() === 'radio') {
          const name = input.getAttribute('name') || 'radio';
          if (!radioGroups[name]) radioGroups[name] = { inputs: [], label: '' };
          const sibling = input.nextElementSibling;
          const optLabel = (sibling && sibling.tagName !== 'INPUT')
            ? (sibling.tagName === 'LABEL' ? sibling.innerText : sibling.innerText)
            : (input.getAttribute('value') || '');
          radioGroups[name].inputs.push({ value: input.getAttribute('value') || '', text: optLabel.trim() || input.getAttribute('value') || '' });
          if (!radioGroups[name].label) {
            let lbl = findLabel(input);
            // If findLabel fell back to the name, try wider: nearest container with a label
            if (lbl === name || lbl === 'Field') {
              const wrap = input.closest('.form-group, .field-group, fieldset, [class*="form"]');
              if (wrap) {
                const found = Array.from(wrap.querySelectorAll('label, legend')).find((l) => !l.querySelector('input'));
                if (found) lbl = found.innerText;
              }
            }
            radioGroups[name].label = lbl;
          }
        } else {
          nonRadioInputs.push(input);
        }
      }

      // Add radio groups as single select-like fields
      for (const [name, group] of Object.entries(radioGroups)) {
        const key = name;
        if (seen.has(key)) continue;
        seen.add(key);
        let labelText = (group.label || name).replace(/[*:\n\r]+/g, ' ').trim().replace(/\s+/g, ' ').replace(/\s*[*:]+\s*$/, '').trim();
        fields.push({
          label: labelText || name,
          name,
          ngModel: '',
          key,
          type: 'radio',
          required: false,
          currentValue: '',
          readonly: false,
          options: group.inputs,
        });
      }

      // Second pass: non-radio inputs, deduplicate by label (generic template renders all type variants)
      // Priority per label: select > text > number > checkbox > textarea
      const TYPE_PRIORITY = { select: 0, text: 1, number: 2, checkbox: 3, textarea: 4 };
      const labelBest = {}; // labelText → {priority, field}

      for (const input of nonRadioInputs) {
        let labelText = findLabel(input);
        labelText = labelText.replace(/[*:\n\r]+/g, ' ').trim().replace(/\s+/g, ' ').replace(/\s*[*:]+\s*$/, '').trim();

        const name = input.getAttribute('name') || '';
        const ngModel = input.getAttribute('ng-model') || '';
        const key = name || ngModel || labelText;
        if (seen.has(key)) { continue; } // strict key dedup still applies
        // Skip native inputs that share a label with an already-discovered ui-select (ghost duplicates)
        if (uiSelectLabels.has(labelText.toLowerCase()) && !name && !ngModel) continue;

        const isSelect = input.tagName === 'SELECT';
        const isTextarea = input.tagName === 'TEXTAREA';
        const rawType = (input.getAttribute('type') || '').toLowerCase();
        const fieldType = isSelect ? 'select' : isTextarea ? 'textarea' : rawType || 'text';
        const priority = TYPE_PRIORITY[fieldType] ?? 99;

        const currentValue = input.value?.trim() || '';
        const isReadonly = input.hasAttribute('readonly') || input.hasAttribute('disabled')
          || input.getAttribute('ng-readonly') === 'true' || input.getAttribute('readonly') === 'readonly';
        const minVal = input.getAttribute('min') || input.getAttribute('ng-min') || '';
        const maxVal = input.getAttribute('max') || input.getAttribute('ng-max') || '';

        const field = {
          label: labelText,
          name,
          ngModel,
          key,
          type: fieldType,
          required: input.hasAttribute('required') || input.getAttribute('ng-required') === 'true',
          currentValue,
          readonly: isReadonly,
          min: minVal || undefined,
          max: maxVal || undefined,
        };

        if (isSelect) {
          field.options = Array.from(input.options)
            .filter((o) => !BLANK_OPTIONS.has(o.text.trim()))
            .map((o) => ({ text: o.text.trim(), value: o.value }));
        }

        // Label-based dedup only applies to anonymous fields (no name/ngModel).
        // Named fields always survive even if they share a label with another field —
        // label detection glitches should not cause real form fields to be silently dropped.
        if (!name && !ngModel) {
          const existing = labelBest[labelText];
          if (!existing || priority < existing.priority) {
            if (existing) {
              const idx = fields.indexOf(existing.field);
              if (idx !== -1) fields.splice(idx, 1);
              seen.delete(existing.field.key);
            }
            labelBest[labelText] = { priority, field };
            seen.add(key);
            fields.push(field);
          }
        } else {
          seen.add(key);
          fields.push(field);
        }
      }

      return fields;
    });
  }

  // Fill all form fields. fieldValues is {field.key: value}.
  // For selects/ui-select, value should be the option text string.
  async fillFormFields(fields, fieldValues) {
    for (const field of fields) {
      const val = fieldValues[field.key];
      if (val === undefined || val === null || val === '') continue;

      if (field.type === 'ui-select') {
        // Click the dropdown toggle to open it, then click the matching option
        await this.page.evaluate((ngModel) => {
          const containers = ngModel
            ? Array.from(document.querySelectorAll('.ui-select-container')).filter(
                (c) => c.getAttribute('ng-model') === ngModel || c.querySelector(`[ng-model="${ngModel}"]`)
              )
            : Array.from(document.querySelectorAll('.ui-select-container'));
          const c = containers[0];
          if (!c) return;
          const toggle = c.querySelector('.ui-select-toggle') || c.querySelector('input') || c;
          toggle.click();
        }, field.ngModel);
        await this.page.waitForTimeout(700);
        const clicked = await this.page.evaluate((text) => {
          const selectors = ['.ui-select-choices-row-inner', '.ui-select-choices .ng-binding', '[role="option"]', '.ui-select-choices-row a'];
          for (const sel of selectors) {
            const match = Array.from(document.querySelectorAll(sel)).find(
              (el) => el.offsetParent !== null && el.innerText?.trim() === text
            );
            if (match) { match.click(); return true; }
          }
          // Fuzzy fallback: starts-with match
          for (const sel of selectors) {
            const match = Array.from(document.querySelectorAll(sel)).find(
              (el) => el.offsetParent !== null && el.innerText?.trim().startsWith(text.slice(0, 8))
            );
            if (match) { match.click(); return true; }
          }
          return false;
        }, String(val));
        if (!clicked) await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(500);
        continue;
      }

      if (field.type === 'radio') {
        await this.page.evaluate(({ name, value }) => {
          const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"]`));
          const radio = radios.find((r) => r.getAttribute('value') === value || r.nextElementSibling?.innerText?.trim() === value);
          if (radio) {
            radio.checked = true;
            ['change', 'input'].forEach((ev) => radio.dispatchEvent(new Event(ev, { bubbles: true })));
            try { window.angular?.element(radio).scope()?.$apply?.(); } catch {}
          }
        }, { name: field.name, value: String(val) });
        await this.page.waitForTimeout(300);
        continue;
      }

      if (field.type === 'select') {
        const optText = typeof val === 'object' ? val.text : String(val);
        // page.evaluate only accepts ONE serialisable arg — wrap in object
        await this.page.evaluate(({ name, ngModel, text }) => {
          const sel = name
            ? document.querySelector(`select[name="${name}"]`)
            : Array.from(document.querySelectorAll('select')).find((s) => s.getAttribute('ng-model') === ngModel);
          if (!sel) return;
          const opt = Array.from(sel.options).find((o) => o.text.trim() === text);
          if (opt) {
            sel.value = opt.value;
            ['input', 'change'].forEach((ev) => sel.dispatchEvent(new Event(ev, { bubbles: true })));
          }
        }, { name: field.name, ngModel: field.ngModel, text: optText });
        await this.page.waitForTimeout(900); // let Angular re-render dependent selects/fields
      } else {
        // Use JS to set value — bypasses Playwright's enabled/stable checks entirely
        const filled = await this.page.evaluate(({ name, ngModel, value }) => {
          const el = name
            ? document.querySelector(`input[name="${name}"], textarea[name="${name}"]`)
            : document.querySelector(`[ng-model="${ngModel}"]`);
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(el, value); else el.value = value;
          ['input', 'change', 'blur'].forEach((ev) => el.dispatchEvent(new Event(ev, { bubbles: true })));
          try { window.angular?.element(el).scope()?.$apply?.(); } catch {}
          return true;
        }, { name: field.name, ngModel: field.ngModel, value: String(val) });
        if (!filled) continue;
        await this.page.waitForTimeout(200);
      }
    }
  }

  // Returns true if the current form has a CHECK button (account lookup) rather than direct PROCEED
  async hasCheckButton() {
    return this.page.evaluate(() => {
      // "Rechercher" is a persistent ui-select search button on every page — exclude it
      const FAKE_BTNS = /^(rechercher|search|clear|goto home)$/i;
      return Array.from(document.querySelectorAll('button')).some(
        (b) => b.offsetParent !== null && /\bcheck\b/i.test(b.innerText.trim())
          && !b.disabled && !FAKE_BTNS.test(b.innerText.trim())
      );
    });
  }

  // Returns true if the page cannot be used for bill payment:
  // - GOTO HOME only pages (cinema/bus ticket external booking)
  // - Pages that redirected away from the payment form
  async isExternalBookingPage() {
    const url = this.page.url();
    // If we got redirected away from the make_payment path, it's not a payment page
    if (!url.includes('make_payment')) return true;
    return this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
        .filter((b) => b.offsetParent !== null)
        .map((b) => b.innerText.trim().toLowerCase());
      const hasGotoHome = buttons.some((t) => t === 'goto home');
      const hasProceedOrCheck = buttons.some((t) => t === 'proceed' || /\bcheck\b/.test(t));
      const hasForm = document.querySelectorAll('input:not([type=hidden]):not([type=submit]), select, textarea')
        .length > 0;
      return hasGotoHome && !hasProceedOrCheck && !hasForm;
    });
  }

  // Expand a ui-select dropdown and return the list of visible option texts
  async getUiSelectOptions(field) {
    try {
      await this.page.evaluate((ngModel) => {
        const containers = ngModel
          ? Array.from(document.querySelectorAll('.ui-select-container')).filter(
              (c) => c.getAttribute('ng-model') === ngModel || c.querySelector(`[ng-model="${ngModel}"]`)
            )
          : Array.from(document.querySelectorAll('.ui-select-container'));
        const c = containers[0];
        if (!c) return;
        const toggle = c.querySelector('.ui-select-toggle') || c.querySelector('input') || c;
        toggle.click();
      }, field.ngModel);
      await this.page.waitForTimeout(800);
      const options = await this.page.evaluate(() => {
        const selectors = ['.ui-select-choices-row-inner', '.ui-select-choices .ng-binding', '[role="option"]', '.ui-select-choices-row a'];
        for (const sel of selectors) {
          const items = Array.from(document.querySelectorAll(sel))
            .filter((el) => el.offsetParent !== null)
            .map((el) => el.innerText?.trim())
            .filter(Boolean);
          if (items.length) return items;
        }
        return [];
      });
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(300);
      return options.map((t) => ({ text: t, value: t }));
    } catch {
      return [];
    }
  }

  // Fill MPIN and submit
  async _submitMpin(mpin) {
    const inp = await this.page.waitForSelector('input[name="credential"]', { timeout: 10000 });
    await this.page.waitForTimeout(400);
    // Use Playwright's fill() so Angular ng-model binds properly (the credential input is always enabled)
    await inp.click({ clickCount: 3 });
    await inp.fill(mpin);
    await this.page.waitForTimeout(400);
    // Click submit — try button[type="submit"] first, then any visible btn-primary
    const clicked = await this.page.evaluate(() => {
      const candidates = [
        document.querySelector('button[type="submit"]'),
        ...Array.from(document.querySelectorAll('button.btn-primary, button[class*="primary"]')),
      ].filter(Boolean);
      for (const btn of candidates) {
        if (btn.offsetParent !== null && !btn.disabled) { btn.click(); return true; }
      }
      return false;
    });
    if (!clicked) {
      // Fallback: press Enter in the input
      await inp.press('Enter');
    }
    await this.page.waitForTimeout(3500);
  }

  // Click CHECK and wait for the second step to fully render
  async _clickCheck() {
    await this.page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.offsetParent !== null && /\bcheck\b/i.test(b.innerText.trim()) && !b.disabled
      );
      if (btn) btn.click();
    });
    await this.page.waitForURL('**/paymentDetails**', { timeout: 10000 }).catch(() => {});
    await this.page.waitForFunction(() => {
      if (Array.from(document.querySelectorAll('button')).some((b) => /PROCEED/i.test(b.innerText) && b.offsetParent)) return true;
      if (document.querySelector('.mi-value, table tbody tr td, span.lr')?.innerText?.trim()) return true;
      if (Array.from(document.querySelectorAll('select')).some((s) => s.offsetParent && s.options.length > 1)) return true;
      return false;
    }, { timeout: 12000 }).catch(() => this.page.waitForTimeout(2500));
  }

  // Scrape bill details from the current page (post-CHECK or post-PROCEED confirmation page)
  async _scrapeBillInfo() {
    return this.page.evaluate(() => {
      const fields = {};

      // mi-label + mi-value (DishHome, Subisu, WorldLink second step)
      document.querySelectorAll('.mi-form__detail, [class*="mi-form"]').forEach((block) => {
        const label = block.querySelector('.mi-label, [class*="mi-label"]')?.innerText?.replace(':', '').trim();
        const value = block.querySelector('.mi-value, [class*="mi-value"]')?.innerText?.trim();
        if (label && value) fields[label] = value;
      });

      // Table rows
      document.querySelectorAll('table tr').forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const k = cells[0].innerText.replace(':', '').trim();
          const v = cells[1].innerText.trim();
          if (k && v && k.length < 60) fields[k] = v;
        }
      });

      // span.lr / p.fields
      document.querySelectorAll('span.lr').forEach((span) => {
        const k = span.innerText.replace(':', '').trim();
        const v = span.parentElement?.querySelector('p.fields')?.innerText?.trim();
        if (k && v) fields[k] = v;
      });

      // definition lists
      document.querySelectorAll('dl').forEach((dl) => {
        dl.querySelectorAll('dt').forEach((dt, i) => {
          const k = dt.innerText.replace(':', '').trim();
          const v = dl.querySelectorAll('dd')[i]?.innerText?.trim();
          if (k && v) fields[k] = v;
        });
      });

      // Amount
      const amountEl = document.querySelector('.pre_payment .rt, .payable-amount, .bill-amount, .total-amount');
      const amount = amountEl?.innerText?.trim() || null;

      // Plan dropdown (post-CHECK only — e.g. DishHome, WorldLink recharge)
      const planSelect = Array.from(document.querySelectorAll('select')).find(
        (s) => s.offsetParent !== null && s.options.length > 1 && !/promo/i.test(s.getAttribute('name') || '')
      );
      const plans = planSelect
        ? Array.from(planSelect.options)
            .filter((o) => o.text.trim() && !['Select', '--Select--', ''].includes(o.text.trim()))
            .map((o) => ({ text: o.text.trim(), value: o.value }))
        : null;

      return { fields, amount, plans };
    });
  }

  // Called after the form is already filled on the open page.
  // Clicks CHECK, waits for second step, returns scraped bill info + plan options.
  async checkAndGetBillInfo() {
    try {
      await this._clickCheck();
    } catch (e) {
      await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
      return { success: false, error: `CHECK failed: ${e.message.split('\n')[0]}` };
    }
    const postCheckError = await this.page.evaluate(() => {
      const el = document.querySelector('.alert-danger, [class*="error-msg"], [class*="errorMessage"], .growl-message');
      return el?.innerText?.trim() || null;
    });
    if (postCheckError) return { success: false, error: postCheckError.split('\n')[0] };
    const billInfo = await this._scrapeBillInfo();
    return { success: true, billInfo };
  }

  // Replay fieldValues on the current page in field-discovery order, handling dependent selects.
  // After each SELECT is set, re-discovers to pick up newly revealed fields before filling them.
  async _replayFieldValues(fieldValues) {
    const filled = new Set();
    let fields = await this.discoverFormFields();

    for (let pass = 0; pass < 10; pass++) {
      const pending = fields.filter((f) => !filled.has(f.key) && fieldValues[f.key] !== undefined);
      if (!pending.length) break;

      for (const field of pending) {
        await this.fillFormFields([field], { [field.key]: fieldValues[field.key] });
        filled.add(field.key);

        if (field.type === 'select' || field.type === 'ui-select' || field.type === 'radio') {
          await this.page.waitForTimeout(700);
          fields = await this.discoverFormFields();
          break; // re-check pending after dependent fields may have appeared
        }
      }

      // If nothing triggers re-discovery, we're done
      if (!pending.some((f) => ['select', 'ui-select', 'radio'].includes(f.type))) break;
    }

    // Fill any remaining non-dependent fields in one shot
    const remaining = fields.filter((f) => !filled.has(f.key) && fieldValues[f.key] !== undefined);
    if (remaining.length) await this.fillFormFields(remaining, fieldValues);
  }

  // Fetch bill info: navigate → fill fields → CHECK (if present) → return scraped details.
  // For direct-PROCEED services (no CHECK), returns isDirectProceed:true with no billInfo.
  async billFetch(url, fieldValues) {
    if (!this.isLoggedIn) throw new Error('Not logged in');
    try {
      await this.navigateToPaymentForm(url);
    } catch (e) {
      return { success: false, error: e.message };
    }

    await this._replayFieldValues(fieldValues);

    const isCheck = await this.hasCheckButton();
    if (!isCheck) {
      return { success: true, billInfo: null, isDirectProceed: true };
    }

    try {
      await this._clickCheck();
    } catch (e) {
      await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
      return { success: false, error: `CHECK failed: ${e.message.split('\n')[0]}` };
    }

    // Check for error after CHECK (invalid account etc.)
    const postCheckError = await this.page.evaluate(() => {
      const el = document.querySelector('.alert-danger, [class*="error-msg"], [class*="errorMessage"], .growl-message');
      return el?.innerText?.trim() || null;
    });
    if (postCheckError) return { success: false, error: postCheckError.split('\n')[0] };

    const billInfo = await this._scrapeBillInfo();
    return { success: true, billInfo, isDirectProceed: false };
  }

  // Full payment: navigate → fill → CHECK or PROCEED → select plan → PROCEED → PAY → MPIN
  async billPay(url, fieldValues, mpin, selectedPlan = null) {
    if (!this.isLoggedIn) throw new Error('Not logged in');
    try {
      await this.navigateToPaymentForm(url);
    } catch (e) {
      return { success: false, error: e.message };
    }

    await this._replayFieldValues(fieldValues);

    const isCheck = await this.hasCheckButton();
    if (isCheck) {
      try {
        await this._clickCheck();
      } catch (e) {
        await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
        return { success: false, error: `CHECK failed: ${e.message.split('\n')[0]}` };
      }

      // Select plan if provided (DishHome, WorldLink recharge)
      if (selectedPlan) {
        const planText = typeof selectedPlan === 'object' ? selectedPlan.text : selectedPlan;
        await this.page.evaluate((text) => {
          const sel = Array.from(document.querySelectorAll('select')).find(
            (s) => s.offsetParent !== null && s.options.length > 1 && !/promo/i.test(s.getAttribute('name') || '')
          );
          if (!sel) return;
          const opt = Array.from(sel.options).find((o) => o.text.trim() === text);
          if (opt) {
            sel.value = opt.value;
            ['input', 'change'].forEach((ev) => sel.dispatchEvent(new Event(ev, { bubbles: true })));
          }
        }, planText);
        await this.page.waitForTimeout(600);
      }
    }

    // Click PROCEED (once for direct, once more for CHECK services at second step)
    try {
      await this.page.waitForTimeout(800);
      const afterProceed = await this.page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const proceed = btns.find((b) => /^PROCEED$/i.test(b.innerText.trim()) && !b.disabled && b.offsetParent);
        if (proceed) { proceed.click(); return 'clicked'; }
        if (btns.some((b) => /PAY VIA ESEWA/i.test(b.innerText))) return 'at-pay';
        return null;
      }, { timeout: 12000 }).catch(() => null);

      if (afterProceed) await this.page.waitForTimeout(1500);

      // Check for any visible notification / toast error — runs right after PROCEED click
      // eSewa shows toasts for "Invalid Credit card Detail", amount errors, etc.
      // NOTE: toasts are position:fixed so offsetParent===null — use computed style instead.
      const checkForError = () => this.page.evaluate(() => {
        function isVisible(el) {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        }
        const ERROR_PAT = /invalid|failed|error|incorrect|unsuccessful|wrong|not found|must be|greater than|minimum|required/i;
        // Broad notification selectors (eSewa uses several styles, including fixed-position toasts)
        const notifSelectors = [
          '.alert-danger', '.alert-warning',
          '[class*="notification"]', '[class*="toast"]', '[class*="growl"]',
          '[class*="error-msg"]', '[class*="errorMessage"]',
          '.ng-invalid ~ .help-block', 'span.error', 'p.error',
        ];
        for (const sel of notifSelectors) {
          for (const el of document.querySelectorAll(sel)) {
            const t = el.innerText?.trim();
            // Must look like an actual error message, not a UI label like "Notifications"
            if (isVisible(el) && t && t.length > 5 && ERROR_PAT.test(t)) return t;
          }
        }
        // Catch-all: any visible leaf node with error-like text (covers fixed-position toasts)
        // "required" omitted here — form field asterisks say "Required" and produce false positives
        for (const el of document.querySelectorAll('*')) {
          if (el.children.length > 0 || !isVisible(el)) continue;
          const t = el.innerText?.trim();
          if (t && t.length < 200 && /invalid|failed|error|incorrect|unsuccessful|wrong|not found|must be|greater than|minimum/i.test(t))
            return t;
        }
        return null;
      });

      const earlyError = await checkForError();
      if (earlyError) return { success: false, error: earlyError.split('\n')[0] };

      // Wait for PAY VIA ESEWA — race against an error notification appearing
      const payReached = await Promise.race([
        this.page.waitForFunction(
          () => Array.from(document.querySelectorAll('button')).some((b) => /PAY VIA ESEWA/i.test(b.innerText)),
          { timeout: 12000 }
        ).then(() => 'pay'),
        // Re-check for error notifications that appear after the initial check
        // Fixed-position toasts have offsetParent===null — use computed style
        this.page.waitForFunction(
          () => {
            function isVisible(el) {
              const s = window.getComputedStyle(el);
              return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            }
            const notifSelectors = [
              '.alert-danger', '[class*="notification"]', '[class*="toast"]', '[class*="growl"]',
            ];
            for (const sel of notifSelectors) {
              for (const el of document.querySelectorAll(sel)) {
                const t = el.innerText?.trim();
                if (isVisible(el) && t && t.length > 5
                    && /invalid|failed|error|incorrect|unsuccessful/i.test(t)) return true;
              }
            }
            return false;
          },
          { timeout: 12000 }
        ).then(() => 'error'),
      ]).catch(() => 'timeout');

      if (payReached === 'error' || payReached === 'timeout') {
        await this.page.waitForTimeout(500);
        const lateError = await checkForError();
        if (lateError) return { success: false, error: lateError.split('\n')[0] };
        if (payReached === 'timeout') {
          await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
          return { success: false, error: 'Payment timed out — PROCEED did not advance. Screenshot: /tmp/esewa-bill-debug.png' };
        }
      }

      await this.page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => /PAY VIA ESEWA/i.test(b.innerText));
        if (btn) btn.click();
      });
      await this.page.waitForTimeout(2000);

      const next = await Promise.race([
        this.page.waitForSelector('input[name="credential"]', { timeout: 10000 }).then(() => 'mpin'),
        this.page.waitForFunction(
          () => /COMPLETE/i.test(document.body.innerText) || !!document.querySelector('button:has-text("Raise Issue")'),
          { timeout: 10000 }
        ).then(() => 'done'),
      ]).catch(() => 'unknown');

      if (next === 'mpin') {
        await this._submitMpin(mpin);
      } else {
        await this.page.waitForTimeout(1000);
      }

      return this._parsePaymentResult();
    } catch (e) {
      await this.page.screenshot({ path: '/tmp/esewa-bill-debug.png', fullPage: false });
      return { success: false, error: `${e.message.split('\n')[0]} (screenshot: /tmp/esewa-bill-debug.png)` };
    }
  }

  async getTransactions(limit = 10) {
    if (!this.isLoggedIn) throw new Error('Not logged in');

    await this.page.goto(`${BASE_URL}/#/statements`, { waitUntil: 'load', timeout: 20000 });
    await this.page.waitForTimeout(4000);

    // Scroll to trigger infinite scroll for larger limits
    if (limit > 20) {
      let previous = 0;
      for (let i = 0; i < Math.ceil(limit / 20); i++) {
        await this.page.keyboard.press('End');
        await this.page.waitForTimeout(1500);
        const count = await this.page.$$eval('table tbody tr', (rows) => rows.length);
        if (count === previous) break;
        previous = count;
      }
    }

    const rows = await this.page.$$eval('table tbody tr', (trs) =>
      trs.map((row) =>
        Array.from(row.querySelectorAll('td')).map((td) => td.innerText.trim())
      ).filter((r) => r.length >= 8)
    );

    // Columns: [2]=description [3]=date [4]=channel [6]=DR [7]=CR [8]=balance
    return rows.slice(0, limit).map((row) => {
      const dr = row[6]?.replace(/[^\d,.]/g, '').replace(/-/g, '').trim();
      const cr = row[7]?.replace(/[^\d,.]/g, '').replace(/-/g, '').trim();
      const isCredit = cr && cr.length > 0;
      return {
        date: row[3] || '—',
        description: row[2] || '—',
        channel: row[4] || '—',
        amount: (isCredit ? cr : dr) || '—',
        type: isCredit ? 'credit' : 'debit',
        balance: row[8]?.replace(/[^\d,.]/g, '') || null,
      };
    });
  }
}
