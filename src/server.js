require('dotenv').config();
const fetch = require('node-fetch');
const path = require('path');
const express = require('express');
const cors = require('cors');
const pool = require('./db/pool');

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
app.use('/admin', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use('/admin', express.static(path.join(__dirname, '../admin-panel/public')));

app.get('/health', (_req, res) => res.json({ status: 'ok', company: 'Bhakti & Bougie Travel Ltd' }));

pool.query("ALTER TABLE days ADD COLUMN IF NOT EXISTS day_type VARCHAR(10) DEFAULT 'stay'").catch(e => console.error('[startup] day_type migration:', e.message));

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
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: 'Search the web for the latest RCB Royal Challengers Bengaluru IPL 2026 match result today. Then respond ONLY in JSON no markdown with keys: result, rcb_score, opp_score, opponent, venue, date, status (WON/LOST/LIVE/UPCOMING), next_match' }],
      }),
    });
    console.log('[RCB] Anthropic HTTP status:', response.status);
    const d = await response.json();
    console.log('[RCB] Anthropic raw response:', JSON.stringify(d));
    const textBlock = d.content?.find(b => b.type === 'text');
    let raw = textBlock?.text || '{}';
    console.log('[RCB] extracted text:', raw);
    raw = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    const stale = ['knowledge', 'cutoff', 'no access'];
    if (parsed.next_match && stale.some(p => parsed.next_match.toLowerCase().includes(p))) {
      parsed.next_match = null;
    }
    res.json(parsed);
  } catch (e) {
    console.error('[RCB] error:', e.message);
    res.status(500).json({ error: 'RCB data unavailable' });
  }
});

app.get('/api/ground-transport', async (req, res, next) => {
  try {
    const { trip_id } = req.query;
    const q = trip_id
      ? 'SELECT gt.*, t.title as trip_title FROM ground_transport gt LEFT JOIN trips t ON gt.trip_id=t.id WHERE gt.trip_id=$1 ORDER BY gt.transport_date,gt.pickup_time'
      : 'SELECT gt.*, t.title as trip_title FROM ground_transport gt LEFT JOIN trips t ON gt.trip_id=t.id ORDER BY gt.transport_date,gt.pickup_time';
    const result = trip_id ? await pool.query(q, [trip_id]) : await pool.query(q);
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.post('/api/ground-transport', async (req, res, next) => {
  try {
    const { trip_id, type, vendor, pickup_location, dropoff_location, transport_date, pickup_time, cost, currency, confirmation_number, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO ground_transport (trip_id,type,vendor,pickup_location,dropoff_location,transport_date,pickup_time,cost,currency,confirmation_number,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [trip_id, type, vendor, pickup_location, dropoff_location, transport_date, pickup_time||null, cost||null, currency||'INR', confirmation_number, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/ground-transport/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM ground_transport WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});

app.patch('/api/ground-transport/:id', async (req, res, next) => {
  try {
    const allowed = ['type','vendor','pickup_location','dropoff_location','transport_date','pickup_time','cost','currency','confirmation_number','notes'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const fields = Object.keys(updates).map((k,i) => `${k}=$${i+2}`).join(',');
    const result = await pool.query(`UPDATE ground_transport SET ${fields} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(updates)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/trains', async (req, res, next) => {
  try {
    const { trip_id } = req.query;
    const q = trip_id
      ? 'SELECT * FROM train_journeys WHERE trip_id=$1 ORDER BY departure_date,departure_time'
      : 'SELECT * FROM train_journeys ORDER BY departure_date,departure_time';
    const result = trip_id ? await pool.query(q, [trip_id]) : await pool.query(q);
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.post('/api/trains', async (req, res, next) => {
  try {
    const { trip_id, carrier, train_number, origin_station, dest_station, departure_date, departure_time, arrival_time, class: cls, pnr, cost, currency, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO train_journeys (trip_id,carrier,train_number,origin_station,dest_station,departure_date,departure_time,arrival_time,class,pnr,cost,currency,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [trip_id, carrier, train_number, origin_station, dest_station, departure_date||null, departure_time||null, arrival_time||null, cls, pnr, cost||null, currency||'INR', notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/trains/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM train_journeys WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});

app.patch('/api/trains/:id', async (req, res, next) => {
  try {
    const allowed = ['carrier','train_number','origin_station','dest_station','departure_date','departure_time','arrival_time','class','pnr','cost','currency','notes'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const fields = Object.keys(updates).map((k,i) => `${k}=$${i+2}`).join(',');
    const result = await pool.query(`UPDATE train_journeys SET ${fields} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(updates)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/guides', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM guides ORDER BY name');
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.post('/api/guides', async (req, res, next) => {
  try {
    const { name, phone, email, city, specialty, rate, rate_currency, confirmed, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO guides (name,phone,email,city,specialty,rate,rate_currency,confirmed,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [name, phone, email, city, specialty, rate||null, rate_currency||'INR', confirmed||false, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { next(e); }
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
