// src/lib/flightAlertEngine.js
// Matches a parsed airline email against the flights table and decides whether to
// auto-apply a time change or queue it in flight_change_alerts for manual review.
// Never deletes anything. Only writes to flights when ALL of: single unambiguous
// match, flight number unchanged, confidence high, emailType schedule_change, dryRun false.

function normalizeFlightNumber(str) {
  return (str || '').replace(/\s+/g, '').toUpperCase();
}

async function logAlert(pool, { parsedEmail, sourceEmailId, mailbox, flightId, tripId, changeType, status, oldValues }) {
  await pool.query(
    `INSERT INTO flight_change_alerts
      (flight_id, trip_id, source_email_id, change_type, old_values, new_values, status, raw_email_snippet)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source_email_id) DO NOTHING`,
    [flightId, tripId, sourceEmailId, changeType,
     oldValues ? JSON.stringify(oldValues) : null,
     JSON.stringify({ ...parsedEmail, mailbox }), status,
     JSON.stringify(parsedEmail).slice(0, 500)]
  );
}

async function processFlightEmail({ parsedEmail, sourceEmailId, mailbox, pool, dryRun = true }) {
  if (!parsedEmail || !parsedEmail.bookingRef) {
    return { action: 'no_match', reason: 'no_booking_ref' };
  }

  const { rows } = await pool.query(
    'SELECT * FROM flights WHERE UPPER(booking_ref) = UPPER($1)',
    [parsedEmail.bookingRef]
  );

  if (rows.length === 0) {
    await logAlert(pool, { parsedEmail, sourceEmailId, mailbox, flightId: null, tripId: null,
      changeType: 'other', status: 'pending', oldValues: null });
    return { action: 'queued', reason: 'no_matching_flight' };
  }

  let candidates = rows;
  if (parsedEmail.flightNumber) {
    const wanted = normalizeFlightNumber(parsedEmail.flightNumber);
    const filtered = rows.filter(r => normalizeFlightNumber(r.flight_number) === wanted);
    if (filtered.length >= 1) candidates = filtered;
  }

  if (candidates.length !== 1) {
    await logAlert(pool, { parsedEmail, sourceEmailId, mailbox, flightId: null,
      tripId: rows[0].trip_id, changeType: 'ambiguous', status: 'pending', oldValues: null });
    return { action: 'queued', reason: 'ambiguous_match', matchCount: candidates.length };
  }

  const flight = candidates[0];
  const flightNumChanged = parsedEmail.flightNumber &&
    normalizeFlightNumber(flight.flight_number) !== normalizeFlightNumber(parsedEmail.flightNumber);

  const oldValues = {
    flight_number: flight.flight_number,
    departure_time: flight.departure_time,
    arrival_time: flight.arrival_time
  };

  if (parsedEmail.emailType === 'cancellation') {
    await logAlert(pool, { parsedEmail, sourceEmailId, mailbox, flightId: flight.id,
      tripId: flight.trip_id, changeType: 'cancellation', status: 'pending', oldValues });
    return { action: 'queued', reason: 'cancellation' };
  }

  if (flightNumChanged) {
    await logAlert(pool, { parsedEmail, sourceEmailId, mailbox, flightId: flight.id,
      tripId: flight.trip_id, changeType: 'flight_number_change', status: 'pending', oldValues });
    return { action: 'queued', reason: 'flight_number_change' };
  }

  const newDep = parsedEmail.newDepartureDate && parsedEmail.newDepartureTime
    ? `${parsedEmail.newDepartureDate}T${parsedEmail.newDepartureTime}:00` : null;
  const newArr = parsedEmail.newArrivalDate && parsedEmail.newArrivalTime
    ? `${parsedEmail.newArrivalDate}T${parsedEmail.newArrivalTime}:00` : null;

  const depChanged = newDep && new Date(newDep).getTime() !== new Date(flight.departure_time).getTime();
  const arrChanged = newArr && new Date(newArr).getTime() !== new Date(flight.arrival_time).getTime();

  if (!depChanged && !arrChanged) {
    return { action: 'no_change' };
  }

  const eligible = parsedEmail.confidence === 'high' && parsedEmail.emailType === 'schedule_change' && !flightNumChanged;

  if (eligible && !dryRun) {
    const updates = {};
    if (depChanged) updates.departure_time = newDep;
    if (arrChanged) updates.arrival_time = newArr;
    const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(`UPDATE flights SET ${fields} WHERE id = $1`, [flight.id, ...Object.values(updates)]);
    await logAlert(pool, { parsedEmail, sourceEmailId, mailbox, flightId: flight.id,
      tripId: flight.trip_id, changeType: 'time_change', status: 'auto_applied', oldValues });
    return { action: 'auto_applied', flightId: flight.id };
  }

  await logAlert(pool, { parsedEmail, sourceEmailId, mailbox, flightId: flight.id,
    tripId: flight.trip_id, changeType: 'time_change', status: 'pending', oldValues });
  return { action: eligible ? 'would_auto_apply_dry_run' : 'queued', flightId: flight.id };
}

module.exports = { processFlightEmail, normalizeFlightNumber };
