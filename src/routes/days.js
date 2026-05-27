const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../db/pool');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/days?trip_id=<uuid>
router.get('/', async (req, res, next) => {
  try {
    const { trip_id } = req.query;
    const { rows } = trip_id
      ? await pool.query(
          'SELECT * FROM days WHERE trip_id = $1 ORDER BY day_number',
          [trip_id]
        )
      : await pool.query('SELECT * FROM days ORDER BY date');
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/days/:id
router.get('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM days WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Day not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/days
router.post('/',
  body('trip_id').isUUID(),
  body('day_number').isInt({ min: 1 }),
  body('date').isDate(),
  validate,
  async (req, res, next) => {
    const { trip_id, day_number, date, location, title, description, notes, day_type } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO days (trip_id, day_number, date, location, title, description, notes, day_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [trip_id, day_number, date, location, title, description, notes, day_type || 'stay']
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Day number already exists for this trip' });
      next(err);
    }
  }
);

// POST /api/days/bulk — create multiple days at once for a trip
router.post('/bulk',
  body('trip_id').isUUID(),
  body('days').isArray({ min: 1 }),
  body('days.*.day_number').isInt({ min: 1 }),
  body('days.*.date').isDate(),
  validate,
  async (req, res, next) => {
    const { trip_id, days } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = [];
      for (const day of days) {
        const { rows } = await client.query(
          `INSERT INTO days (trip_id, day_number, date, location, title, description, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [trip_id, day.day_number, day.date, day.location, day.title, day.description, day.notes]
        );
        inserted.push(rows[0]);
      }
      await client.query('COMMIT');
      res.status(201).json(inserted);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'Duplicate day number in this trip' });
      next(err);
    } finally {
      client.release();
    }
  }
);

// PATCH /api/days/:id
router.patch('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  const allowed = ['day_number', 'date', 'location', 'title', 'description', 'notes', 'day_type'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE days SET ${fields} WHERE id = $1 RETURNING *`,
      [req.params.id, ...Object.values(updates)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Day not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Day number already exists for this trip' });
    next(err);
  }
});

// DELETE /api/days/:id
router.delete('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM days WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Day not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// DELETE /api/days?trip_id=<uuid> — wipe all days for a trip (useful when rebuilding itinerary)
router.delete('/', async (req, res, next) => {
  const { trip_id } = req.query;
  if (!trip_id) return res.status(400).json({ error: 'trip_id query param required' });
  try {
    const { rowCount } = await pool.query('DELETE FROM days WHERE trip_id = $1', [trip_id]);
    res.json({ deleted: rowCount });
  } catch (err) { next(err); }
});

module.exports = router;
