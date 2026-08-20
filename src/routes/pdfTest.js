const express = require('express');
const puppeteer = require('puppeteer');

const router = express.Router();

router.get('/', async (req, res, next) => {
  let browser;
  try {
    console.log('[pdf-test] launching browser...');
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('[pdf-test] browser launched, opening page...');
    const page = await browser.newPage();
    await page.setContent('<html><body style="font-family:sans-serif;padding:40px;"><h1>Bhakti & Bougie PDF Test</h1><p>If you can read this as a downloaded PDF, headless Chromium is working on Railway.</p></body></html>');
    console.log('[pdf-test] content set, generating PDF...');
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    console.log('[pdf-test] PDF generated. Buffer length:', pdfBuffer.length);
    console.log('[pdf-test] First 20 bytes as string:', pdfBuffer.slice(0, 20).toString('utf8'));
    console.log('[pdf-test] Is Buffer:', Buffer.isBuffer(pdfBuffer));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="pdf-test.pdf"', 'Content-Length': pdfBuffer.length });
    res.end(pdfBuffer);
    console.log('[pdf-test] response sent.');
  } catch (err) {
    console.error('[pdf-test] ERROR:', err.message);
    console.error('[pdf-test] STACK:', err.stack);
    res.status(500).json({ error: err.message, stack: err.stack });
  } finally {
    if (browser) {
      await browser.close();
      console.log('[pdf-test] browser closed.');
    }
  }
});

module.exports = router;
