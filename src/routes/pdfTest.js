const express = require('express');
const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');

const router = express.Router();

function getChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    return execSync('which chromium').toString().trim();
  } catch (e) {
    return execSync('which chromium-browser').toString().trim();
  }
}

router.get('/', async (req, res, next) => {
  let browser;
  try {
    const executablePath = getChromiumPath();
    browser = await puppeteer.launch({
      executablePath,
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
