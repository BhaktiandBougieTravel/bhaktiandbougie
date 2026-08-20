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

async function loadTripData(tripId) {
  const { rows: tripRows } = await pool.query('SELECT * FROM trips WHERE id = $1', [tripId]);
  if (!tripRows.length) return null;
  const trip = tripRows[0];

  const { rows: days } = await pool.query(
    `SELECT d.*,
       COALESCE((SELECT json_agg(json_build_object('description', a.description, 'activity_time', a.activity_time) ORDER BY a.activity_time)
         FROM day_activities a WHERE a.day_id = d.id), '[]') AS activities,
       COALESCE((SELECT json_agg(json_build_object('name', s.name, 'site_time', s.site_time, 'notes', s.notes) ORDER BY s.site_time)
         FROM day_sacred_sites s WHERE s.day_id = d.id), '[]') AS sacred_sites
     FROM days d WHERE d.trip_id = $1 ORDER BY d.day_number`, [tripId]
  );

  const { rows: hotelStays } = await pool.query(
    `SELECT hb.check_in, hb.check_out, hb.room_type, h.name, h.city, h.category, h.star_rating
     FROM hotel_bookings hb JOIN hotels h ON h.id = hb.hotel_id
     WHERE hb.trip_id = $1 ORDER BY hb.check_in`, [tripId]
  );

  const { rows: flights } = await pool.query(
    `SELECT flight_number, airline, origin_airport, dest_airport, departure_time, arrival_time, cabin_class
     FROM flights WHERE trip_id = $1 AND status != 'cancelled' ORDER BY departure_time`, [tripId]
  );

  return { trip, days, hotelStays, flights };
}

// Groups consecutive days sharing the same location into one printable page
// so a short stay doesn't waste an entire page of white space.
function groupDaysByCity(days) {
  const groups = [];
  let current = null;
  for (const d of days) {
    const key = d.location || d.title || 'Untitled';
    if (current && current.key === key) {
      current.days.push(d);
    } else {
      current = { key, location: d.location || d.title || '', days: [d] };
      groups.push(current);
    }
  }
  return groups;
}

const ITINERARY_CSS = `
@page { margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Jost', sans-serif; color: #0D1B2A; }
.cover { height: 100vh; background: #FFFFFF; border-bottom: 6px solid #C8860A; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; page-break-after: always; }
.cover-mark { font-family: 'Cormorant Garamond', serif; font-size: 30px; color: #0D1B2A; letter-spacing: 2px; margin-bottom: 4px; }
.cover-rule { width: 60px; height: 2px; background: #C8860A; margin: 16px 0 16px; }
.cover-tagline { font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: #8B1A1A; margin-bottom: 60px; }
.cover-title { font-family: 'Cormorant Garamond', serif; font-size: 44px; font-weight: 600; color: #0D1B2A; margin-bottom: 16px; max-width: 80%; }
.cover-dates { font-size: 14px; letter-spacing: 1px; color: #0D1B2A; opacity: 0.75; }
.city-page { padding: 45px 60px; page-break-after: always; }
.city-header { border-bottom: 2px solid #C8860A; padding-bottom: 10px; margin-bottom: 24px; }
.city-name { font-family: 'Cormorant Garamond', serif; font-size: 34px; color: #0D1B2A; }
.city-dates { font-size: 12px; letter-spacing: 1px; color: #8B1A1A; text-transform: uppercase; margin-top: 2px; }
.day-block { margin-bottom: 28px; page-break-inside: avoid; }
.day-block + .day-block { border-top: 1px solid #0D1B2A22; padding-top: 20px; }
.day-num { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #8B1A1A; font-weight: 500; }
.day-date { font-size: 11px; color: #0D1B2A; opacity: 0.65; margin-bottom: 6px; }
.day-title { font-family: 'Cormorant Garamond', serif; font-size: 20px; color: #0D1B2A; margin-bottom: 8px; }
.day-desc { font-size: 12.5px; line-height: 1.65; margin-bottom: 14px; }
.block { margin-bottom: 12px; }
.block-label { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #8B1A1A; margin-bottom: 6px; }
.item { font-size: 12.5px; margin-bottom: 6px; padding-left: 4px; }
.time { color: #C8860A; font-weight: 500; margin-right: 10px; }
.item-notes { font-size: 11.5px; opacity: 0.75; margin-top: 2px; margin-left: 4px; }
.hotel-note { font-size: 11.5px; margin-top: 10px; color: #0D1B2A; opacity: 0.8; }
.logistics { padding: 50px 60px; page-break-before: always; }
.section-title { font-family: 'Cormorant Garamond', serif; font-size: 22px; color: #0D1B2A; margin: 24px 0 12px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
td { padding: 8px 6px; border-bottom: 1px solid #0D1B2A22; }
`;

function buildItineraryHtml(data) {
  const { trip, days, hotelStays, flights } = data;
  const hotelFor = (dateStr) => hotelStays.find(h => dateStr >= h.check_in.toISOString().slice(0,10) && dateStr < h.check_out.toISOString().slice(0,10));
  const cityGroups = groupDaysByCity(days);

  const cityPages = cityGroups.map(g => {
    const first = g.days[0], last = g.days[g.days.length - 1];
    const dateRange = g.days.length > 1 ? `${fmtDateShort(first.date)} – ${fmtDateShort(last.date)}` : fmtDateShort(first.date);
    const dayBlocks = g.days.map(d => {
      const dateStr = d.date.toISOString().slice(0,10);
      const hotel = hotelFor(dateStr);
      const showTitle = d.title && d.title.trim() !== (d.location || '').trim();
      return `
      <div class="day-block">
        <div class="day-num">Day ${d.day_number}</div>
        <div class="day-date">${fmtDate(d.date)}</div>
        ${showTitle ? `<div class="day-title">${d.title}</div>` : ''}
        ${d.description ? `<p class="day-desc">${d.description}</p>` : ''}
        ${d.sacred_sites.length ? `<div class="block"><div class="block-label">Sacred Sites</div>${d.sacred_sites.map(s => `<div class="item">${s.site_time ? `<span class="time">${s.site_time}</span>` : ''}<span class="item-name">${s.name}</span>${s.notes ? `<div class="item-notes">${s.notes}</div>` : ''}</div>`).join('')}</div>` : ''}
        ${d.activities.length ? `<div class="block"><div class="block-label">Activities</div>${d.activities.map(a => `<div class="item">${a.activity_time ? `<span class="time">${a.activity_time}</span>` : ''}<span class="item-name">${a.description}</span></div>`).join('')}</div>` : ''}
        ${hotel ? `<div class="hotel-note">Staying at <strong>${hotel.name}</strong>, ${hotel.city}</div>` : ''}
      </div>`;
    }).join('');
    return `
    <section class="city-page">
      <div class="city-header">
        <div class="city-name">${g.location}</div>
        <div class="city-dates">${dateRange}</div>
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
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });

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
