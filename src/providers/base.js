import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

export class BaseProvider {
  constructor(headless = true) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.headless = headless;
  }

  async launch(session = null) {
    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'Asia/Kathmandu',
    });

    // Accept either a plain cookies array (eSewa) or a storageState object {cookies, origins} (Khalti)
    const cookies = Array.isArray(session) ? session : session?.cookies;
    if (cookies?.length) {
      await this.context.addCookies(cookies);
    }

    this.page = await this.context.newPage();
  }

  async showBrowser() {
    const url = this.page?.url();
    const cookies = await this.getCookies();
    await this.close();
    this.headless = false;
    await this.launch(cookies);
    if (url) await this.page.goto(url, { waitUntil: 'load', timeout: 20000 });
  }

  async getCookies() {
    if (!this.context) return [];
    return this.context.cookies();
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  async screenshot(path) {
    if (this.page) await this.page.screenshot({ path, fullPage: false });
  }
}
