require('dotenv').config();
const fetch = require('node-fetch');
const path = require('path');
const express = require('express');
const cors = require('cors');

const tripsRouter        = require('./routes/trips');
const contactsRouter     = require('./routes/contacts');
const hotelsRouter       = require('./routes/hotels');
const hotelBookingsRouter = require('./routes/hotelBookings');
const flightsRouter      = require('./routes/flights');
const expensesRouter     = require('./routes/expenses');
const daysRouter         = require('./routes/days');
const festivalsRouter    = require('./routes/festivals');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/admin', express.static(path.join(__dirname, '../admin-panel/public')));

app.get('/health', (_req, res) => res.json({ status: 'ok', company: 'Bhakti & Bougie Travel Ltd' }));

app.use('/api/trips',          tripsRouter);
app.use('/api/contacts',       contactsRouter);
app.use('/api/hotels',         hotelsRouter);
app.use('/api/hotel-bookings', hotelBookingsRouter);
app.use('/api/flights',        flightsRouter);
app.use('/api/expenses',       expensesRouter);
app.use('/api/days',           daysRouter);
app.use('/api/festivals',      festivalsRouter);

app.post('/api/rcb', async (_req, res) => {
  console.log('[RCB] route hit');
  console.log('[RCB] ANTHROPIC_API_KEY set:', !!process.env.ANTHROPIC_API_KEY);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: 'Give me the latest RCB Royal Challengers Bengaluru IPL 2026 match result and their next scheduled match. Respond ONLY in JSON no markdown with keys: result, rcb_score, opp_score, opponent, venue, date, status (WON/LOST/LIVE/UPCOMING), next_match' }],
      }),
    });
    console.log('[RCB] Anthropic HTTP status:', response.status);
    const d = await response.json();
    console.log('[RCB] Anthropic raw response:', JSON.stringify(d));
    const raw = d.content?.[0]?.text || '{}';
    console.log('[RCB] extracted text:', raw);
    res.json(JSON.parse(raw));
  } catch (e) {
    console.error('[RCB] error:', e.message);
    res.status(500).json({ error: 'RCB data unavailable' });
  }
});

// Central error handler
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Bhakti & Bougie Travel Ops running on port ${PORT}`);
});

module.exports = app;
