const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../db/pool');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/flights?trip_id=<uuid>&date=YYYY-MM-DD
router.get('/', async (req, res, next) => {
  try {
    const { trip_id, date } = req.query;
    const conditions = [];
    const params = [];
    if (trip_id) { params.push(trip_id); conditions.push(`trip_id = $${params.length}`); }
    if (date) { params.push(date); conditions.push(`(departure_time AT TIME ZONE 'UTC')::date = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(`SELECT * FROM flights ${where} ORDER BY departure_time`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/flights/:id
router.get('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM flights WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Flight not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/flights
router.post('/',
  body('trip_id').isUUID(),
  body('origin_airport').isLength({ min: 3, max: 3 }),
  body('dest_airport').isLength({ min: 3, max: 3 }),
  body('departure_time').isISO8601(),
  body('arrival_time').isISO8601(),
  validate,
  async (req, res, next) => {
    const { trip_id, flight_number, airline, origin_airport, dest_airport,
            departure_time, arrival_time, booking_ref, num_passengers,
            cabin_class, flight_type, total_cost, currency, status, notes } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO flights (trip_id, flight_number, airline, origin_airport, dest_airport,
           departure_time, arrival_time, booking_ref, num_passengers, cabin_class,
           flight_type, total_cost, currency, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6::timestamp,$7::timestamp,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [trip_id, flight_number, airline, origin_airport, dest_airport,
         departure_time, arrival_time, booking_ref, num_passengers || 1,
         cabin_class || 'economy', flight_type || 'DOM', total_cost, currency || 'INR', status || 'pending', notes]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// PATCH /api/flights/:id
router.patch('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  const allowed = ['flight_number', 'airline', 'origin_airport', 'dest_airport',
    'departure_time', 'arrival_time', 'booking_ref', 'num_passengers',
    'cabin_class', 'flight_type', 'total_cost', 'currency', 'status', 'notes'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE flights SET ${fields} WHERE id = $1 RETURNING *`,
      [req.params.id, ...Object.values(updates)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Flight not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/flights/:id
router.delete('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM flights WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Flight not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
