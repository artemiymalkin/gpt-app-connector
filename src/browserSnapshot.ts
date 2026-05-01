import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { getLogsRoot } from './cli';

export async function browserSnapshot(input: { url: string; fullPage?: boolean; timeoutMs?: number }) {
  const timeoutMs = Math.max(1000, Math.min(Number(input.timeoutMs) || 30000, 120000));
  const logsRoot = getLogsRoot();
  const screenshotsDir = path.join(logsRoot, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];

  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) {
      consoleMessages.push({ type: msg.type(), text: msg.text() });
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || null,
    });
  });

  try {
    await page.goto(input.url, { waitUntil: 'networkidle', timeout: timeoutMs });
    const title = await page.title();
    const visibleText = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 20000);
    const interactiveElements = await page
      .locator('a,button,input,textarea,select,[role="button"],[role="link"]')
      .evaluateAll((elements) =>
        elements.slice(0, 100).map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 200),
          ariaLabel: el.getAttribute('aria-label'),
          placeholder: el.getAttribute('placeholder'),
          href: el.getAttribute('href'),
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
        }))
      )
      .catch(() => []);

    const screenshotName = `snapshot-${Date.now()}.png`;
    const screenshotPath = path.join(screenshotsDir, screenshotName);
    await page.screenshot({ path: screenshotPath, fullPage: input.fullPage ?? true });

    return {
      ok: true,
      url: page.url(),
      title,
      visibleText,
      interactiveElements,
      consoleMessages,
      pageErrors,
      failedRequests,
      screenshotPath,
      screenshotLogPath: path.relative(logsRoot, screenshotPath),
    };
  } finally {
    await browser.close();
  }
}
