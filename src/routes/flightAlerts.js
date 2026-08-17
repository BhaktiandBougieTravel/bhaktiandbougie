const express = require('express');
const { param, validationResult } = require('express-validator');
const pool = require('../db/pool');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/flight-alerts?status=pending&trip_id=<uuid>
router.get('/', async (req, res, next) => {
  try {
    const { status, trip_id } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`fca.status = $${params.length}`); }
    if (trip_id) { params.push(trip_id); conditions.push(`fca.trip_id = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT fca.*, f.flight_number AS current_flight_number, f.origin_airport, f.dest_airport,
              f.departure_time AS current_departure_time, f.arrival_time AS current_arrival_time,
              t.title AS trip_name
       FROM flight_change_alerts fca
       LEFT JOIN flights f ON f.id = fca.flight_id
       LEFT JOIN trips t ON t.id = fca.trip_id
       ${where}
       ORDER BY fca.detected_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/flight-alerts/:id/approve
router.post('/:id/approve', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM flight_change_alerts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
    const alert = rows[0];
    if (alert.status !== 'pending') return res.status(400).json({ error: `Alert already ${alert.status}` });
    if (!alert.flight_id) return res.status(400).json({ error: 'No matched flight to apply changes to; dismiss and update manually' });

    const newValues = alert.new_values || {};

    if (alert.change_type === 'cancellation') {
      await pool.query(`UPDATE flights SET status = 'cancelled' WHERE id = $1`, [alert.flight_id]);
    } else {
      const updates = {};
      if (newValues.flightNumber) updates.flight_number = newValues.flightNumber;
      if (newValues.newDepartureDate && newValues.newDepartureTime) {
        updates.departure_time = `${newValues.newDepartureDate}T${newValues.newDepartureTime}:00`;
      }
      if (newValues.newArrivalDate && newValues.newArrivalTime) {
        updates.arrival_time = `${newValues.newArrivalDate}T${newValues.newArrivalTime}:00`;
      }
      if (Object.keys(updates).length) {
        const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
        await pool.query(`UPDATE flights SET ${fields} WHERE id = $1`, [alert.flight_id, ...Object.values(updates)]);
      }
    }

    const { rows: updated } = await pool.query(
      `UPDATE flight_change_alerts SET status = 'approved', resolved_at = NOW() WHERE id = $1 RETURNING *`,
      [alert.id]
    );
    res.json(updated[0]);
  } catch (err) { next(err); }
});

// POST /api/flight-alerts/:id/dismiss
router.post('/:id/dismiss', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE flight_change_alerts SET status = 'dismissed', resolved_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alert not found or already resolved' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
