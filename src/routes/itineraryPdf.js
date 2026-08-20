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
// Print-safe equivalents of the Command Center's dark-theme badge colors.
const BADGE = {
  gold:   ['#F5E8CC', '#8A5D06'],
  muted:  ['#E7E5E0', '#6B6B66'],
  green:  ['#DCEFE1', '#2F7D46'],
  red:    ['#F5DEDE', '#8B1A1A'],
  cream:  ['#F2E6CC', '#8A7A50'],
  orange: ['#F7E1CE', '#B85A1A'],
};
const GT_PRINT = { E: 'gold', H: 'muted', U: 'green', P: 'cream', D: 'orange', C: 'muted' };

function badge(kind, text) {
  const [bg, color] = BADGE[kind] || BADGE.muted;
  return `<span class="badge" style="background:${bg};color:${color};">${text}</span>`;
}
// Extracts HH:MM straight from an ISO timestamp string/Date without any timezone
// re-interpretation, matching how the Command Center reads these same fields.
function utcHHMM(ts) {
  if (!ts) return null;
  const iso = ts instanceof Date ? ts.toISOString() : String(ts);
  const t = iso.split('T')[1];
  return t ? t.slice(0, 5) : null;
}

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
    `SELECT hb.check_in, hb.check_out, hb.room_type, hb.confirmation_number, h.name, h.city, h.category, h.star_rating, h.website, h.contact_phone
     FROM hotel_bookings hb JOIN hotels h ON h.id = hb.hotel_id
     WHERE hb.trip_id = $1 ORDER BY hb.check_in`, [tripId]
  );

  const { rows: flights } = await pool.query(
    `SELECT flight_number, airline, origin_airport, dest_airport, departure_time, arrival_time, cabin_class, booking_ref, flight_type
     FROM flights WHERE trip_id = $1 AND status != 'cancelled' ORDER BY departure_time`, [tripId]
  );

  const { rows: transports } = await pool.query(
    `SELECT type, vendor, pickup_location, dropoff_location, transport_date, to_char(pickup_time, 'HH24:MI') AS pickup_time, confirmation, notes
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
function normalizeLocationKey(location, title, previousKey) {
  const loc = (location || '').trim();
  if (loc) return loc;
  const stripped = (title || '').replace(/\s*Day\s*\d+\s*$/i, '').trim();
  if (stripped) return stripped;
  return previousKey || title || 'Untitled';
}

// Travel days store location as "Leaving City → Arriving City" and must never
// be matched against a plain city name — they're buffered and attached to the
// front of the destination city's page (the city you're arriving into), or to
// the end of the previous group if the trip ends on a travel day with nothing
// following it (e.g. flying home).
function groupDaysByCity(days) {
  const groups = [];
  let current = null;
  let travelBuffer = [];

  for (const d of days) {
    const isTravel = (d.day_type || 'stay') === 'travel';
    if (isTravel) {
      travelBuffer.push(d);
      continue;
    }
    const key = normalizeLocationKey(d.location, d.title, current ? current.key : null);
    if (current && current.key === key) {
      current.days.push(...travelBuffer, d);
    } else {
      current = { key, location: d.location || key, days: [...travelBuffer, d] };
      groups.push(current);
    }
    travelBuffer = [];
  }
  if (travelBuffer.length) {
    if (current) current.days.push(...travelBuffer);
    else groups.push({ key: 'Travel', location: 'Travel', days: travelBuffer });
  }
  return groups;
}

// Builds one day's schedule exactly like the Command Center's itinerary cards —
// same badges, same sort buckets, same main/sub line structure — just styled
// for print instead of the dark admin theme.
function buildDaySchedule(day, transports, trains, flights, hotelStays) {
  const ds = day.date.toISOString().slice(0, 10);
  const items = [];

  hotelStays.filter(h => h.check_out.toISOString().slice(0, 10) === ds).forEach(h => {
    items.push({ time: '00:00', html: `<div class="sched-item"><div class="sched-icon">🏨</div>${badge('red', 'CHECK-OUT')}<div class="sched-body"><div class="sched-main">${h.name}</div></div></div>` });
  });

  flights.filter(f => f.arrival_time && f.departure_time && f.arrival_time.toISOString().slice(0,10) === ds && f.departure_time.toISOString().slice(0,10) !== ds).forEach(f => {
    const isInt = (f.flight_type || 'DOM') === 'INT';
    const main = [[f.airline, f.flight_number].filter(Boolean).join(' '), f.origin_airport && f.dest_airport ? `${f.origin_airport}→${f.dest_airport}` : ''].filter(Boolean).join(' · ');
    const sub = [`Arrives ${utcHHMM(f.arrival_time)}`, f.booking_ref ? `ref ${f.booking_ref}` : null].filter(Boolean).join(' · ');
    items.push({ time: utcHHMM(f.arrival_time) || '98:00', html: `<div class="sched-item"><div class="sched-icon">✈️</div>${badge(isInt ? 'gold' : 'muted', isInt ? 'INT' : 'DOM')}${badge('green', 'ARRIVING')}<div class="sched-body"><div class="sched-main">${main || 'Flight'}</div><div class="sched-sub">${sub}</div></div></div>` });
  });

  trains.filter(t => t.departure_date && t.departure_date.toISOString().slice(0, 10) === ds).forEach(t => {
    const main = `${[t.carrier, t.train_number].filter(Boolean).join(' ') || 'Train'} · ${t.origin_station || '–'} → ${t.dest_station || '–'}`;
    const sub = [`${t.departure_time || '–'} → ${t.arrival_time || '–'}`, t.class, t.pnr ? `PNR ${t.pnr}` : null].filter(Boolean).join(' · ');
    items.push({ time: t.departure_time || '98:01', html: `<div class="sched-item"><div class="sched-icon">🚂</div><div class="sched-body"><div class="sched-main">${main}</div><div class="sched-sub">${sub}</div></div></div>` });
  });

  flights.filter(f => f.departure_time && f.departure_time.toISOString().slice(0, 10) === ds).forEach(f => {
    const isInt = (f.flight_type || 'DOM') === 'INT';
    const nextDay = f.arrival_time && f.arrival_time.toISOString().slice(0,10) > f.departure_time.toISOString().slice(0,10);
    const arr = utcHHMM(f.arrival_time) + (nextDay ? '<sup>+1</sup>' : '');
    const main = [[f.airline, f.flight_number].filter(Boolean).join(' '), f.origin_airport && f.dest_airport ? `${f.origin_airport}→${f.dest_airport}` : ''].filter(Boolean).join(' · ');
    const sub = [`${utcHHMM(f.departure_time)} → ${arr}`, f.booking_ref ? `ref ${f.booking_ref}` : null].filter(Boolean).join(' · ');
    items.push({ time: utcHHMM(f.departure_time) || '98:02', html: `<div class="sched-item"><div class="sched-icon">✈️</div>${badge(isInt ? 'gold' : 'muted', isInt ? 'INT' : 'DOM')}${badge('red', 'DEPARTING')}<div class="sched-body"><div class="sched-main">${main || 'Flight'}</div><div class="sched-sub">${sub}</div></div></div>` });
  });

  transports.filter(t => t.transport_date && t.transport_date.toISOString().slice(0, 10) === ds).forEach(t => {
    const route = [t.pickup_location, t.dropoff_location].filter(Boolean).join(' → ') || '–';
    const sub = [t.pickup_time, t.vendor, t.confirmation ? `Conf ${t.confirmation}` : null].filter(Boolean).join(' · ');
    items.push({ time: t.pickup_time || '98:03', html: `<div class="sched-item"><div class="sched-icon">🚗</div>${badge(GT_PRINT[t.type] || 'muted', t.type || '–')}<div class="sched-body"><div class="sched-main">${route}</div><div class="sched-sub">${sub}</div></div></div>` });
  });

  hotelStays.filter(h => h.check_in.toISOString().slice(0, 10) === ds).forEach(h => {
    items.push({ time: '99:99', html: `<div class="sched-item"><div class="sched-icon">🏨</div>${badge('green', 'CHECK-IN')}<div class="sched-body"><div class="sched-main">${h.name}</div><div class="sched-sub">${h.confirmation_number ? 'Conf: ' + h.confirmation_number : ''}${h.contact_phone ? ' · ' + h.contact_phone : ''}${h.website ? ' · ' + h.website : ''}</div></div></div>` });
  });

  day.sacred_sites.forEach(s => {
    const tm = (s.site_time || '').slice(0, 5);
    items.push({ time: tm || '98:10', html: `<div class="sched-item"><div class="sched-icon">🛕</div><div class="sched-body"><div class="sched-main sched-main-red">${s.name}</div>${(s.notes || tm) ? `<div class="sched-sub">${[tm || null, s.notes].filter(Boolean).join(' · ')}</div>` : ''}</div></div>` });
  });

  day.activities.forEach(a => {
    const tm = (a.activity_time || '').slice(0, 5);
    const isDining = a.category === 'dining';
    items.push({ time: tm || (isDining ? '98:12' : '98:11'), html: `<div class="sched-item"><div class="sched-icon">${isDining ? '🍽️' : '✨'}</div><div class="sched-body"><div class="sched-main sched-main-gold">${a.description}</div>${tm ? `<div class="sched-sub">${tm}</div>` : ''}</div></div>` });
  });

  items.sort((a, b) => a.time.localeCompare(b.time));
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
.day-head-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.day-num-big { font-family: 'Cormorant Garamond', serif; font-size: 28px; color: #C8860A; }
.day-dow { font-size: 12px; letter-spacing: 1px; color: #8B1A1A; text-transform: uppercase; }
.day-date-txt { font-size: 15px; color: #0D1B2A; opacity: 0.85; }
.day-subtitle { font-size: 14px; color: #0D1B2A; opacity: 0.7; margin-bottom: 16px; }
.badge { display: inline-block; padding: 2px 7px; border-radius: 3px; font-size: 10px; letter-spacing: 1px; font-weight: 600; margin-right: 4px; flex-shrink: 0; }
.sched-icon { flex-shrink: 0; font-size: 15px; }
.sched-body { flex: 1; }
.sched-main { font-weight: 500; }
.sched-main-red { color: #8B1A1A; }
.sched-main-gold { color: #8A5D06; }
.day-custom-title { font-size: 13.5px; color: #8B1A1A; font-style: italic; margin-bottom: 6px; }
.day-hotel-line { font-size: 13px; color: #0D1B2A; opacity: 0.75; margin-bottom: 10px; }
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

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDayLine(d) { return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
function fmtWeekday(d) { return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }); }

function buildItineraryHtml(data) {
  const { trip, days, hotelStays, flights, transports, trains } = data;
  const cityGroups = groupDaysByCity(days);

  const cityPages = cityGroups.map(g => {
    const first = g.days[0], last = g.days[g.days.length - 1];
    const dateRange = g.days.length > 1 ? `${fmtDateShort(first.date)} – ${fmtDateShort(last.date)}` : fmtDateShort(first.date);
    const dayBlocks = g.days.map(d => {
      const dateStr = d.date.toISOString().slice(0, 10);
      const isTravelDay = (d.day_type || 'stay') === 'travel';
      const dayHasFlight = flights.some(f => f.departure_time && f.departure_time.toISOString().slice(0,10) === dateStr);
      const dayHasTrain = trains.some(t => t.departure_date && t.departure_date.toISOString().slice(0,10) === dateStr);
      const dayHasTransport = transports.some(t => t.transport_date && t.transport_date.toISOString().slice(0,10) === dateStr);
      const stayingHotel = hotelStays.find(h => dateStr >= h.check_in.toISOString().slice(0,10) && dateStr < h.check_out.toISOString().slice(0,10));
      const subIcon = isTravelDay ? '✈️' : (dayHasFlight ? '✈️' : dayHasTrain ? '🚂' : dayHasTransport ? '🚗' : (stayingHotel ? '🏨' : ''));
      const subtitle = isTravelDay ? `Travel Day${d.location ? ': ' + d.location : ''}` : (d.location || g.location || '');
      const schedule = buildDaySchedule(d, transports, trains, flights, hotelStays);
      return `
      <div class="day-block">
        <div class="day-head-row">
          <span class="day-num-big">Day ${d.day_number}</span>
          <span class="day-dow">${fmtWeekday(d.date).toUpperCase()}</span>
          <span class="day-date-txt">${fmtDayLine(d.date)}</span>
        </div>
        ${subtitle.trim() ? `<div class="day-subtitle">${subIcon} ${subtitle}</div>` : ''}
        ${d.title && d.title.trim() ? `<div class="day-custom-title">${d.title}</div>` : ''}
        ${stayingHotel ? `<div class="day-hotel-line">🏨 Staying at ${stayingHotel.name}</div>` : ''}
        ${d.description ? `<p class="day-desc">${d.description}</p>` : ''}
        ${schedule.map(i => i.html).join('')}
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
