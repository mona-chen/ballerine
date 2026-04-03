const { webkit } = require('playwright');

(async () => {
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone size

  page.on('console', msg => console.log(`[console ${msg.type()}]`, msg.text()));
  page.on('pageerror', err => console.log('[pageerror]', err.message));

  console.log('1. Loading liveness dev server...');
  await page.goto('http://localhost:5202/');
  await page.waitForTimeout(2500);

  console.log('2. Checking liveness page DOM...');
  const status = page.locator('.pill').first();
  await status.waitFor({ state: 'visible', timeout: 15000 });
  const initialStatus = await status.textContent();
  console.log('Initial status:', initialStatus?.trim());

  const buttons = await page.locator('button, .hint-pill').allTextContents();
  console.log('Action elements:', buttons.map(b => b.trim()).filter(Boolean));

  const statusCount = await page.locator('.overlay').count();
  console.log('Overlay count:', statusCount);

  const ovalCount = await page.locator('.face-oval').count();
  console.log('Face oval count:', ovalCount);

  await page.screenshot({ path: 'test-results/liveness-webkit.png', fullPage: false });
  console.log('Screenshot saved to test-results/liveness-webkit.png');

  await browser.close();
  console.log('WebKit test complete.');
})();
