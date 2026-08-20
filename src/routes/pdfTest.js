const express = require('express');
const puppeteer = require('puppeteer');

const router = express.Router();

router.get('/', async (req, res, next) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent('<html><body style="font-family:sans-serif;padding:40px;"><h1>Bhakti & Bougie PDF Test</h1><p>If you can read this as a downloaded PDF, headless Chromium is working on Railway.</p></body></html>');
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="pdf-test.pdf"' });
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  } finally {
    if (browser) await browser.close();
  }
});

module.exports = router;
