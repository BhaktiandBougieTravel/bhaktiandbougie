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
app.use('/mobile', express.static(path.join(__dirname, '../mobile')));

app.post('/api/mobile-auth', (req, res) => {
  const { password } = req.body;
  const correct = process.env.MOBILE_PASSWORD || 'india2026';
  if (password === correct) res.json({ ok: true });
  else res.status(401).json({ error: 'Invalid password' });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', company: 'Bhakti & Bougie Travel Ltd' }));

pool.query("ALTER TABLE days ADD COLUMN IF NOT EXISTS day_type VARCHAR(10) DEFAULT 'stay'").catch(e => console.error('[startup] day_type migration:', e.message));
pool.query("ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_code VARCHAR(50) UNIQUE").catch(e => console.error('[startup] trip_code migration:', e.message));
pool.query("ALTER TABLE days ALTER COLUMN date TYPE DATE USING date::date").catch(e => console.error('[startup] days date type migration:', e.message));
pool.query("ALTER TABLE days ADD COLUMN IF NOT EXISTS activities TEXT").catch(e => console.error('[startup] activities migration:', e.message));
pool.query("ALTER TABLE days ADD COLUMN IF NOT EXISTS sacred_sites TEXT").catch(e => console.error('[startup] sacred_sites migration:', e.message));
pool.query(`CREATE TABLE IF NOT EXISTS day_sacred_sites (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), trip_id UUID REFERENCES trips(id), day_id UUID REFERENCES days(id), name TEXT NOT NULL, site_time TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(e => console.error('[startup] day_sacred_sites:', e.message));
pool.query(`CREATE TABLE IF NOT EXISTS day_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), trip_id UUID REFERENCES trips(id), day_id UUID REFERENCES days(id), description TEXT NOT NULL, activity_time TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(e => console.error('[startup] day_activities:', e.message));

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
    const { trip_id, date, types } = req.query;
    const conditions = [];
    const params = [];
    if (trip_id) { params.push(trip_id); conditions.push(`gt.trip_id=$${params.length}`); }
    if (date) { params.push(date); conditions.push(`gt.transport_date=$${params.length}`); }
    if (types) { params.push(types.split(',')); conditions.push(`gt.type=ANY($${params.length})`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(`SELECT gt.*, t.title as trip_title FROM ground_transport gt LEFT JOIN trips t ON gt.trip_id=t.id ${where} ORDER BY gt.transport_date,gt.pickup_time`, params);
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.post('/api/ground-transport', async (req, res, next) => {
  try {
    const { trip_id, type, vendor, pickup_location, dropoff_location, transport_date, pickup_time, cost, currency, confirmation, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO ground_transport (trip_id,type,vendor,pickup_location,dropoff_location,transport_date,pickup_time,cost,currency,confirmation,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [trip_id, type, vendor, pickup_location, dropoff_location, transport_date, pickup_time||null, cost||null, currency||'INR', confirmation, notes]
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
    const allowed = ['type','vendor','pickup_location','dropoff_location','transport_date','pickup_time','cost','currency','confirmation','notes'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const fields = Object.keys(updates).map((k,i) => `${k}=$${i+2}`).join(',');
    const result = await pool.query(`UPDATE ground_transport SET ${fields} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(updates)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});
app.delete('/api/ground-transport/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM ground_transport WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (e) { next(e); }
});

app.get('/api/trains', async (req, res, next) => {
  try {
    const { trip_id, date } = req.query;
    const conditions = [];
    const params = [];
    if (trip_id) { params.push(trip_id); conditions.push(`trip_id=$${params.length}`); }
    if (date) { params.push(date); conditions.push(`journey_date=$${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(`SELECT * FROM train_journeys ${where} ORDER BY journey_date,departure_time`, params);
    res.json(result.rows || []);
  } catch (e) { next(e); }
});

app.post('/api/trains', async (req, res, next) => {
  try {
    const { trip_id, carrier, train_number, departure_station, arrival_station, journey_date, departure_time, arrival_time, class: cls, pnr, cost, currency, notes } = req.body;
    if (!trip_id) return res.status(400).json({ error: 'trip_id required' });
    const result = await pool.query(
      `INSERT INTO train_journeys (trip_id,carrier,train_number,departure_station,arrival_station,journey_date,departure_time,arrival_time,class,pnr,cost,currency,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [trip_id, carrier||null, train_number||null, departure_station||null, arrival_station||null,
       journey_date||null, departure_time||null, arrival_time||null,
       cls||null, pnr||null, cost?parseFloat(cost):null, currency||'INR', notes||null]
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
    const allowed = ['carrier','train_number','departure_station','arrival_station','journey_date','departure_time','arrival_time','class','pnr','cost','currency','notes'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const fields = Object.keys(updates).map((k,i) => `${k}=$${i+2}`).join(',');
    const result = await pool.query(`UPDATE train_journeys SET ${fields} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(updates)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});
app.delete('/api/trains/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM train_journeys WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
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

// ── Sacred Sites ─────────────────────────────────────────────────────────────
app.get('/api/sacred-sites', async (req, res, next) => {
  try {
    const { trip_id, day_id } = req.query;
    const conditions = []; const params = [];
    if (trip_id) { params.push(trip_id); conditions.push(`trip_id=$${params.length}`); }
    if (day_id)  { params.push(day_id);  conditions.push(`day_id=$${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(`SELECT * FROM day_sacred_sites ${where} ORDER BY site_time NULLS LAST, created_at`, params);
    res.json(result.rows);
  } catch (e) { next(e); }
});
app.post('/api/sacred-sites', async (req, res, next) => {
  try {
    const { trip_id, day_id, name, site_time, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = await pool.query(
      'INSERT INTO day_sacred_sites (trip_id,day_id,name,site_time,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [trip_id, day_id, name, site_time || null, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { next(e); }
});
app.get('/api/sacred-sites/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM day_sacred_sites WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});
app.patch('/api/sacred-sites/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'site_time', 'notes'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const fields = Object.keys(updates).map((k, i) => `${k}=$${i+2}`).join(',');
    const result = await pool.query(`UPDATE day_sacred_sites SET ${fields} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(updates)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});
app.delete('/api/sacred-sites/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM day_sacred_sites WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── Activities ────────────────────────────────────────────────────────────────
app.get('/api/activities', async (req, res, next) => {
  try {
    const { trip_id, day_id } = req.query;
    const conditions = []; const params = [];
    if (trip_id) { params.push(trip_id); conditions.push(`trip_id=$${params.length}`); }
    if (day_id)  { params.push(day_id);  conditions.push(`day_id=$${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(`SELECT * FROM day_activities ${where} ORDER BY activity_time NULLS LAST, created_at`, params);
    res.json(result.rows);
  } catch (e) { next(e); }
});
app.post('/api/activities', async (req, res, next) => {
  try {
    const { trip_id, day_id, description, activity_time } = req.body;
    if (!description) return res.status(400).json({ error: 'description required' });
    const result = await pool.query(
      'INSERT INTO day_activities (trip_id,day_id,description,activity_time) VALUES ($1,$2,$3,$4) RETURNING *',
      [trip_id, day_id, description, activity_time || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { next(e); }
});
app.get('/api/activities/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM day_activities WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});
app.patch('/api/activities/:id', async (req, res, next) => {
  try {
    const allowed = ['description', 'activity_time'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const fields = Object.keys(updates).map((k, i) => `${k}=$${i+2}`).join(',');
    const result = await pool.query(`UPDATE day_activities SET ${fields} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(updates)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});
app.delete('/api/activities/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM day_activities WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (e) { next(e); }
});

app.get('/', (_req, res) => res.redirect('/mobile'));

app.get('/trip/:code', async (req, res) => {
  const result = await pool.query('SELECT id FROM trips WHERE trip_code=$1', [req.params.code]);
  if (result.rows.length) res.redirect('/mobile?trip=' + result.rows[0].id);
  else res.status(404).send('Trip not found');
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
