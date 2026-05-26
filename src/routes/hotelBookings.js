const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../db/pool');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/hotel-bookings?trip_id=<uuid>
router.get('/', async (req, res, next) => {
  try {
    const { trip_id } = req.query;
    const baseSelect = `
      SELECT hb.*,
             h.name AS hotel_name, h.city, h.star_rating, h.category
      FROM hotel_bookings hb
      JOIN hotels h ON h.id = hb.hotel_id`;

    const { rows } = trip_id
      ? await pool.query(
          `${baseSelect} WHERE hb.trip_id = $1 ORDER BY hb.check_in`,
          [trip_id]
        )
      : await pool.query(`${baseSelect} ORDER BY hb.check_in DESC`);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/hotel-bookings/:id
router.get('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT hb.*,
              h.name AS hotel_name, h.city, h.star_rating, h.category,
              h.contact_name, h.contact_email, h.contact_phone
       FROM hotel_bookings hb
       JOIN hotels h ON h.id = hb.hotel_id
       WHERE hb.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Hotel booking not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/hotel-bookings
router.post('/',
  body('trip_id').isUUID(),
  body('hotel_id').isUUID(),
  body('check_in').isDate(),
  body('check_out').isDate(),
  body('num_rooms').optional().isInt({ min: 1 }),
  body('rate_per_night').optional().isFloat({ min: 0 }),
  body('total_cost').optional().isFloat({ min: 0 }),
  validate,
  async (req, res, next) => {
    const { trip_id, hotel_id, check_in, check_out, room_type, num_rooms,
            confirmation_number, rate_per_night, total_cost, currency, status, notes } = req.body;

    // Auto-calculate total_cost if rate and nights provided but total omitted
    let computedTotal = total_cost;
    if (!computedTotal && rate_per_night && check_in && check_out) {
      const nights = Math.round((new Date(check_out) - new Date(check_in)) / 86400000);
      computedTotal = rate_per_night * (num_rooms || 1) * nights;
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO hotel_bookings (trip_id, hotel_id, check_in, check_out, room_type, num_rooms,
           confirmation_number, rate_per_night, total_cost, currency, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [trip_id, hotel_id, check_in, check_out, room_type, num_rooms || 1,
         confirmation_number, rate_per_night, computedTotal, currency || 'INR', status || 'pending', notes]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// PATCH /api/hotel-bookings/:id
router.patch('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  const allowed = ['hotel_id', 'check_in', 'check_out', 'room_type', 'num_rooms',
    'confirmation_number', 'rate_per_night', 'total_cost', 'currency', 'status', 'notes'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE hotel_bookings SET ${fields} WHERE id = $1 RETURNING *`,
      [req.params.id, ...Object.values(updates)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Hotel booking not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/hotel-bookings/:id
router.delete('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM hotel_bookings WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Hotel booking not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
