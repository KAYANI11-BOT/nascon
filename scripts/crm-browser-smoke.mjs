// Optional local browser verification. Pass an installed Playwright module path as argv[2].
// Uses only demo interactions and signed-out routes; never creates a remote user or record.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
let checks = 0;
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4173/opportunities');
  await page.getByRole('heading', { name: 'Opportunities', exact: true }).waitFor(); checks++;
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByRole('button', { name: 'Add condition', exact: true }).click();
  await page.getByLabel('Stage', { exact: true }).selectOption({ label: 'Proposal' });
  await page.getByLabel('Filter name', { exact: true }).fill('Browser smoke filter');
  await page.getByRole('button', { name: 'Save as new', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Browser smoke filter' }).waitFor(); checks++;
  await page.getByRole('button', { name: 'Clear conditions', exact: true }).click();
  const option = page.getByRole('option', { name: 'Browser smoke filter', exact: true });
  await page.getByLabel('Saved filters', { exact: true }).selectOption(await option.getAttribute('value'));
  assert.equal(await page.getByLabel('Stage', { exact: true }).inputValue(), 'Proposal'); checks++;
  await page.getByLabel('Filter name', { exact: true }).fill('Renamed browser filter');
  await page.getByRole('button', { name: 'Update filter', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Updated' }).waitFor(); checks++;
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: 'No saved filters yet' }).count(), 1); checks++;
  for (const route of ['/', '/contacts', '/companies', '/pipeline']) {
    await page.goto(`http://127.0.0.1:4173${route}`);
    await page.locator('h1').waitFor();
    assert.equal(await page.getByText("This page didn't load", { exact: true }).count(), 0); checks++;
  }
  // Backend mode is separately served with VITE_DEMO_MODE=false, without editing .env.
  for (const route of ['/contacts', '/companies', '/opportunities', '/pipeline', '/']) {
    await page.goto(`http://127.0.0.1:4174${route}`);
    await page.waitForURL(/\/login(?:\?|$)/);
    assert.equal(await page.getByText('Sample workspace', { exact: true }).count(), 0); checks++;
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, browser: 'Chrome headless', pageErrors: errors.length, remotePersistenceTested: false }));
} finally { await browser.close(); }
