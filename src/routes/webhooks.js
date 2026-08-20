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

    let emailDate = new Date();
    const dateMatch = messageHeadersRaw.match(/"Date"\s*,\s*"([^"]+)"/i);
    if (dateMatch) {
      const parsed = new Date(dateMatch[1]);
      if (!isNaN(parsed)) emailDate = parsed;
    }

    if (req.files && req.files.length) {
      for (const file of req.files) {
        if (file.mimetype !== 'application/pdf') continue;
        const fnameLower = (file.originalname || '').toLowerCase();
        const subjLower = (subject || '').toLowerCase();
        const isBoardingDoc = /boarding|e-?ticket|itinerary/i.test(fnameLower) || /boarding|e-?ticket|check-?in/i.test(subjLower);
        if (!isBoardingDoc) continue;

        const docType = /boarding/i.test(fnameLower + subjLower) ? 'boarding_pass' : 'eticket';
        let pnrMatch = (subject + ' ' + bodyPlain).match(/\b(?:PNR|booking ref(?:erence)?)[:\-\s]*([A-Z0-9]{5,8})\b/i);
        if (!pnrMatch) pnrMatch = (subject + ' ' + bodyPlain + ' ' + file.originalname).match(/\(([A-Z0-9]{5,8})\)/);
        const pnr = pnrMatch ? pnrMatch[1].toUpperCase() : null;
        const nameMatch = fnameLower.match(/[-–]\s*([a-z][a-z\s]{1,30})\.pdf$/i);
        const travelerName = nameMatch ? nameMatch[1].trim().replace(/\b\w/g, c => c.toUpperCase()) : null;

        let flightId = null, tripId = null;
        if (pnr) {
          const { rows } = await pool.query('SELECT id, trip_id FROM flights WHERE UPPER(booking_ref) = $1 LIMIT 1', [pnr]);
          if (rows.length) { flightId = rows[0].id; tripId = rows[0].trip_id; }
        }

        await pool.query(
          `INSERT INTO flight_documents (flight_id, trip_id, traveler_name, document_type, filename, mime_type, file_data, source_email_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source_email_id, filename) DO NOTHING`,
          [flightId, tripId, travelerName, docType, file.originalname, file.mimetype, file.buffer, sourceEmailId]
        );
        console.log('[mailgun-inbound] stored document:', file.originalname, 'flight matched:', !!flightId);
      }
    }

    const parsedEmail = parseAirlineEmail({ subject: subject || '', body: bodyPlain, senderDomain, emailDate });
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
