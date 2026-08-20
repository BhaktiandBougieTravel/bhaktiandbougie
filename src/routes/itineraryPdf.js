const express = require('express');
const { param, validationResult } = require('express-validator');
const puppeteer = require('puppeteer');
const pool = require('../db/pool');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTime(dt) {
  if (!dt) return '';
  return new Date(dt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
// Parses messy free-text time fields ("9:00 AM", "14:30", "9am") into minutes-since-midnight for sorting.
// Returns null (sorts last) if unparseable.
function parseTimeToMinutes(t) {
  if (!t) return null;
  const s = String(t).trim().toLowerCase();
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (m) {
    let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return h * 60 + min;
  }
  m = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    if (m[2] === 'pm' && h < 12) h += 12;
    if (m[2] === 'am' && h === 12) h = 0;
    return h * 60;
  }
  return null;
}
const TRANSPORT_TYPE_LABELS = { E: 'Emirates Limo', H: 'Hotel Transfer', U: 'Taxi/Uber', P: 'Private Transfer', D: 'Private Driver', C: 'City Driver' };

async function loadTripData(tripId) {
  const { rows: tripRows } = await pool.query('SELECT * FROM trips WHERE id = $1', [tripId]);
  if (!tripRows.length) return null;
  const trip = tripRows[0];

  const { rows: days } = await pool.query(
    `SELECT d.*,
       COALESCE((SELECT json_agg(json_build_object('description', a.description, 'activity_time', a.activity_time, 'category', a.category) ORDER BY a.activity_time)
         FROM day_activities a WHERE a.day_id = d.id), '[]') AS activities,
       COALESCE((SELECT json_agg(json_build_object('name', s.name, 'site_time', s.site_time, 'notes', s.notes) ORDER BY s.site_time)
         FROM day_sacred_sites s WHERE s.day_id = d.id), '[]') AS sacred_sites
     FROM days d WHERE d.trip_id = $1 ORDER BY d.day_number`, [tripId]
  );

  const { rows: hotelStays } = await pool.query(
    `SELECT hb.check_in, hb.check_out, hb.room_type, h.name, h.city, h.category, h.star_rating, h.website, h.contact_phone
     FROM hotel_bookings hb JOIN hotels h ON h.id = hb.hotel_id
     WHERE hb.trip_id = $1 ORDER BY hb.check_in`, [tripId]
  );

  const { rows: flights } = await pool.query(
    `SELECT flight_number, airline, origin_airport, dest_airport, departure_time, arrival_time, cabin_class
     FROM flights WHERE trip_id = $1 AND status != 'cancelled' ORDER BY departure_time`, [tripId]
  );

  const { rows: transports } = await pool.query(
    `SELECT type, vendor, pickup_location, dropoff_location, transport_date, to_char(pickup_time, 'HH24:MI') AS pickup_time, notes
     FROM ground_transport WHERE trip_id = $1 ORDER BY transport_date, pickup_time`, [tripId]
  );

  const { rows: trains } = await pool.query(
    `SELECT carrier, train_number, departure_station AS origin_station, arrival_station AS dest_station, journey_date AS departure_date,
            to_char(departure_time, 'HH24:MI') AS departure_time, to_char(arrival_time, 'HH24:MI') AS arrival_time, class, pnr, notes
     FROM train_journeys WHERE trip_id = $1 ORDER BY journey_date, departure_time`, [tripId]
  );

  return { trip, days, hotelStays, flights, transports, trains };
}

// When location is blank, strips a trailing "Day N" pattern from the title so
// e.g. "Madurai Day 3" groups with the other "Madurai" days instead of starting
// a new page on its own.
function normalizeLocationKey(location, title) {
  const loc = (location || '').trim();
  if (loc) return loc;
  const stripped = (title || '').replace(/\s*Day\s*\d+\s*$/i, '').trim();
  return stripped || title || 'Untitled';
}

function groupDaysByCity(days) {
  const groups = [];
  let current = null;
  for (const d of days) {
    const key = normalizeLocationKey(d.location, d.title);
    if (current && current.key === key) {
      current.days.push(d);
    } else {
      current = { key, location: d.location || key, days: [d] };
      groups.push(current);
    }
  }
  return groups;
}

// Merges sacred sites, activities, ground transport, trains, and flights for one
// day into a single time-sorted schedule, since everything happening that day
// should read as one flowing plan, not separate disconnected lists.
function buildDaySchedule(day, transports, trains, flights) {
  const dateStr = day.date.toISOString().slice(0, 10);
  const items = [];

  day.sacred_sites.forEach(s => items.push({ sortKey: parseTimeToMinutes(s.site_time), time: s.site_time, icon: '🕉', label: s.name, sub: s.notes }));
  day.activities.forEach(a => items.push({ sortKey: parseTimeToMinutes(a.activity_time), time: a.activity_time, icon: a.category === 'dining' ? '🍽' : '📍', label: a.description }));
  transports.filter(t => t.transport_date && t.transport_date.toISOString().slice(0, 10) === dateStr).forEach(t => {
    const label = `${TRANSPORT_TYPE_LABELS[t.type] || t.vendor || 'Transfer'}: ${t.pickup_location || ''} → ${t.dropoff_location || ''}`;
    items.push({ sortKey: parseTimeToMinutes(t.pickup_time), time: t.pickup_time, icon: '🚗', label, sub: t.notes });
  });
  trains.filter(t => t.departure_date && t.departure_date.toISOString().slice(0, 10) === dateStr).forEach(t => {
    const label = `${t.carrier || 'Train'} ${t.train_number || ''}: ${t.origin_station || ''} → ${t.dest_station || ''}`;
    items.push({ sortKey: parseTimeToMinutes(t.departure_time), time: t.departure_time, icon: '🚂', label, sub: t.notes });
  });
  flights.filter(f => f.departure_time && f.departure_time.toISOString().slice(0, 10) === dateStr).forEach(f => {
    const label = `${f.airline || ''} ${f.flight_number || ''}: ${f.origin_airport} → ${f.dest_airport}`;
    items.push({ sortKey: parseTimeToMinutes(fmtTime(f.departure_time)), time: fmtTime(f.departure_time), icon: '✈️', label, sub: `Arrives ${fmtTime(f.arrival_time)}` });
  });

  items.sort((a, b) => (a.sortKey === null ? 9999 : a.sortKey) - (b.sortKey === null ? 9999 : b.sortKey));
  return items;
}

const ITINERARY_CSS = `
@page { margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Jost', sans-serif; color: #0D1B2A; font-size: 15px; }
.cover { height: calc(100vh - 20mm); background: #FFFFFF; border-bottom: 6px solid #C8860A; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; page-break-after: always; }
.cover-mark-icon { margin-bottom: 18px; }
.cover-mark { font-family: 'Cormorant Garamond', serif; font-size: 32px; color: #0D1B2A; letter-spacing: 2px; margin-bottom: 4px; }
.cover-rule { width: 60px; height: 2px; background: #C8860A; margin: 16px 0 16px; }
.cover-tagline { font-size: 13px; letter-spacing: 3px; text-transform: uppercase; color: #8B1A1A; margin-bottom: 60px; }
.cover-title { font-family: 'Cormorant Garamond', serif; font-size: 50px; font-weight: 600; color: #0D1B2A; margin-bottom: 16px; max-width: 80%; }
.cover-dates { font-size: 16px; letter-spacing: 1px; color: #0D1B2A; opacity: 0.75; }
.city-page { padding: 40px 60px 20px; page-break-after: always; }
.city-header { display: flex; align-items: center; gap: 16px; border-bottom: 2px solid #C8860A; padding-bottom: 12px; margin-bottom: 26px; }
.city-name { font-family: 'Cormorant Garamond', serif; font-size: 38px; color: #0D1B2A; }
.city-dates { font-size: 13px; letter-spacing: 1px; color: #8B1A1A; text-transform: uppercase; margin-top: 3px; }
.day-block { margin-bottom: 30px; page-break-inside: avoid; }
.day-block + .day-block { border-top: 1px solid #0D1B2A22; padding-top: 22px; }
.day-date { font-family: 'Cormorant Garamond', serif; font-size: 26px; color: #0D1B2A; margin-bottom: 4px; }
.day-title { font-size: 14px; letter-spacing: 1px; text-transform: uppercase; color: #C8860A; font-weight: 500; margin-bottom: 6px; }
.day-num { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #8B1A1A; font-weight: 500; margin-bottom: 14px; }
.day-desc { font-size: 14px; line-height: 1.7; margin-bottom: 16px; }
.sched-item { display: flex; gap: 12px; font-size: 14px; margin-bottom: 10px; align-items: flex-start; }
.sched-time { color: #C8860A; font-weight: 500; min-width: 62px; flex-shrink: 0; }
.sched-icon { flex-shrink: 0; }
.sched-label { flex: 1; }
.sched-sub { font-size: 12.5px; opacity: 0.75; margin-top: 2px; }
.hotel-note { font-size: 13.5px; margin-top: 14px; color: #0D1B2A; opacity: 0.85; }
.hotel-note a { color: #8B1A1A; }
.logistics { padding: 40px 60px 20px; page-break-before: always; }
.section-title { font-family: 'Cormorant Garamond', serif; font-size: 24px; color: #0D1B2A; margin: 26px 0 14px; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
td { padding: 9px 6px; border-bottom: 1px solid #0D1B2A22; }
`;

function tripundraSvg(size) {
  return `<svg width="${size}" height="${Math.round(size*0.6)}" viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg">
    <rect x="10" y="8" width="180" height="26" rx="13" fill="#A8A6A0" stroke="#C8860A" stroke-width="4"/>
    <rect x="10" y="47" width="180" height="26" rx="13" fill="#A8A6A0" stroke="#C8860A" stroke-width="4"/>
    <rect x="10" y="86" width="180" height="26" rx="13" fill="#A8A6A0" stroke="#C8860A" stroke-width="4"/>
    <circle cx="100" cy="60" r="22" fill="none" stroke="#C8860A" stroke-width="4"/>
    <circle cx="100" cy="60" r="18" fill="#8B1A1A" stroke="#0D1B2A" stroke-width="2"/>
  </svg>`;
}

function buildFooterTemplate(tripTitle) {
  return `<div style="width:100%;font-size:9px;font-family:Georgia,'Times New Roman',serif;color:#0D1B2A;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 20px;">
    ${tripundraSvg(14)}
    <span style="letter-spacing:2px;text-transform:uppercase;">Bhakti &amp; Bougie</span>
    <span style="opacity:0.5;">&middot;</span>
    <span style="opacity:0.7;">${tripTitle}</span>
    <span style="opacity:0.5;">&middot;</span>
    <span class="pageNumber"></span><span style="opacity:0.5;"> / </span><span class="totalPages"></span>
  </div>`;
}

function buildItineraryHtml(data) {
  const { trip, days, hotelStays, flights, transports, trains } = data;
  const hotelFor = (dateStr) => hotelStays.find(h => dateStr >= h.check_in.toISOString().slice(0,10) && dateStr < h.check_out.toISOString().slice(0,10));
  const cityGroups = groupDaysByCity(days);

  const cityPages = cityGroups.map(g => {
    const first = g.days[0], last = g.days[g.days.length - 1];
    const dateRange = g.days.length > 1 ? `${fmtDateShort(first.date)} – ${fmtDateShort(last.date)}` : fmtDateShort(first.date);
    const dayBlocks = g.days.map(d => {
      const dateStr = d.date.toISOString().slice(0,10);
      const hotel = hotelFor(dateStr);
      const showTitle = d.title && d.title.trim() !== (d.location || '').trim();
      const schedule = buildDaySchedule(d, transports, trains, flights);
      return `
      <div class="day-block">
        <div class="day-num">Day ${d.day_number}</div>
        <div class="day-date">${fmtDate(d.date)}</div>
        ${showTitle ? `<div class="day-title">${d.title}</div>` : ''}
        ${d.description ? `<p class="day-desc">${d.description}</p>` : ''}
        ${schedule.map(i => `<div class="sched-item"><div class="sched-time">${i.time || ''}</div><div class="sched-icon">${i.icon}</div><div class="sched-label">${i.label}${i.sub ? `<div class="sched-sub">${i.sub}</div>` : ''}</div></div>`).join('')}
        ${hotel ? `<div class="hotel-note">Staying at <strong>${hotel.name}</strong>, ${hotel.city}${hotel.contact_phone ? ` · ${hotel.contact_phone}` : ''}${hotel.website ? ` · <a href="${hotel.website}">${hotel.website}</a>` : ''}</div>` : ''}
      </div>`;
    }).join('');
    return `
    <section class="city-page">
      <div class="city-header">
        ${tripundraSvg(34)}
        <div>
          <div class="city-name">${g.location}</div>
          <div class="city-dates">${dateRange}</div>
        </div>
      </div>
      ${dayBlocks}
    </section>`;
  }).join('');

  const flightRows = flights.map(f => `<tr><td>${fmtDateShort(f.departure_time)}</td><td>${f.airline || ''} ${f.flight_number || ''}</td><td>${f.origin_airport} → ${f.dest_airport}</td><td>${fmtTime(f.departure_time)} – ${fmtTime(f.arrival_time)}</td></tr>`).join('');
  const hotelRows = hotelStays.map(h => `<tr><td>${fmtDateShort(h.check_in)} – ${fmtDateShort(h.check_out)}</td><td>${h.name}</td><td>${h.city}</td></tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
  <style>${ITINERARY_CSS}</style></head><body>
  <section class="cover">
    <div class="cover-mark-icon">${tripundraSvg(60)}</div>
    <div class="cover-mark">Bhakti &amp; Bougie</div>
    <div class="cover-rule"></div>
    <div class="cover-tagline">Auspicious sadhana &middot; Uncompromising luxury</div>
    <h1 class="cover-title">${trip.title}</h1>
    <div class="cover-dates">${fmtDate(trip.start_date)} — ${fmtDate(trip.end_date)}</div>
  </section>
  ${cityPages}
  <section class="logistics">
    <h2 class="section-title">Flights</h2>
    <table>${flightRows}</table>
    <h2 class="section-title">Hotel Stays</h2>
    <table>${hotelRows}</table>
  </section>
  </body></html>`;
}

// GET /api/itinerary-pdf/:id
router.get('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  let browser;
  try {
    const data = await loadTripData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Trip not found' });
    const html = buildItineraryHtml(data);

    browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', bottom: '20mm', left: '0mm', right: '0mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: buildFooterTemplate(data.trip.title)
    });

    const filename = data.trip.title.replace(/[^a-z0-9]+/gi, '-') + '.pdf';
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Content-Length': pdfBuffer.length });
    res.end(pdfBuffer);
  } catch (err) {
    next(err);
  } finally {
    if (browser) await browser.close();
  }
});

module.exports = router;
