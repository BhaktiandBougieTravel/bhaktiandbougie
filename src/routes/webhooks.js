// src/routes/webhooks.js
// Receives inbound airline emails forwarded via Mailgun, verifies the request
// is genuinely from Mailgun, parses it, and runs it through the alert engine.
// Defaults to dryRun=true unless FLIGHT_ALERTS_DRY_RUN is explicitly set to 'false'.

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../db/pool');
const { parseAirlineEmail } = require('../lib/flightEmailParser');
const { processFlightEmail } = require('../lib/flightAlertEngine');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const KNOWN_MAILBOXES = [
  'DJDTINVT@gmail.com',
  'michael.levin@fora.travel',
  'michael@bhaktiandbougie.travel'
];

function verifySignature(timestamp, token, signature) {
  const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!key || !timestamp || !token || !signature) return false;
  const expected = crypto.createHmac('sha256', key).update(timestamp + token).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function detectMailbox(messageHeadersRaw) {
  if (!messageHeadersRaw) return 'unknown';
  const found = KNOWN_MAILBOXES.find(m => messageHeadersRaw.toLowerCase().includes(m.toLowerCase()));
  return found || 'unknown';
}

function extractSenderDomain(messageHeadersRaw, fallbackSender) {
  if (messageHeadersRaw) {
    const m = messageHeadersRaw.match(/"From"\s*,\s*"[^"]*<?([^"<>@\s]+@([^">\s]+))/i);
    if (m) return m[2];
  }
  if (fallbackSender && fallbackSender.includes('@')) return fallbackSender.split('@')[1];
  return '';
}

router.post('/mailgun-inbound', express.urlencoded({ extended: true }), upload.any(), async (req, res) => {
  const { timestamp, token, signature, sender, recipient, subject } = req.body;
  const bodyPlain = req.body['body-plain'] || '';
  const messageHeadersRaw = req.body['message-headers'] || '';

  if (!verifySignature(timestamp, token, signature)) {
    console.error('[mailgun-inbound] signature verification failed');
    return res.status(401).send('invalid signature');
  }

  res.status(200).send('ok'); // ack immediately, Mailgun retries on non-2xx

  try {
    const senderDomain = extractSenderDomain(messageHeadersRaw, sender);
    const mailbox = detectMailbox(messageHeadersRaw);
    let sourceEmailId = token ? `mg-${token}` : `mg-${Date.now()}`;
    const midMatch = messageHeadersRaw.match(/"Message-Id"\s*,\s*"([^"]+)"/i);
    if (midMatch) sourceEmailId = midMatch[1];

    const parsedEmail = parseAirlineEmail({ subject: subject || '', body: bodyPlain, senderDomain });
    if (!parsedEmail) {
      console.log('[mailgun-inbound] no parseable flight data, subject:', subject);
      return;
    }

    const dryRun = process.env.FLIGHT_ALERTS_DRY_RUN !== 'false';
    const result = await processFlightEmail({ parsedEmail, sourceEmailId, mailbox, pool, dryRun });
    console.log('[mailgun-inbound] processed:', JSON.stringify({ recipient, mailbox, result }));
  } catch (err) {
    console.error('[mailgun-inbound] processing error:', err.message);
  }
});

module.exports = router;
