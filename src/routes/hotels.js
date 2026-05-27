const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../db/pool');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/hotels
router.get('/', async (req, res, next) => {
  try {
    const { city } = req.query;
    const { rows } = city
      ? await pool.query('SELECT * FROM hotels WHERE city ILIKE $1 ORDER BY name', [`%${city}%`])
      : await pool.query('SELECT * FROM hotels ORDER BY city, name');
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/hotels/:id
router.get('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM hotels WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Hotel not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/hotels
router.post('/',
  body('name').notEmpty(),
  body('city').optional(),
  body('star_rating').optional().isInt({ min: 1, max: 5 }),
  validate,
  async (req, res, next) => {
    const { name, city, state, category, star_rating, address,
            contact_name, contact_email, contact_phone, website, notes } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO hotels (name, city, state, category, star_rating, address,
           contact_name, contact_email, contact_phone, website, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [name, city, state, category, star_rating, address,
         contact_name, contact_email, contact_phone, website, notes]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// PATCH /api/hotels/:id
router.patch('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  const allowed = ['name', 'city', 'state', 'category', 'star_rating', 'address',
    'contact_name', 'contact_email', 'contact_phone', 'website', 'notes'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE hotels SET ${fields} WHERE id = $1 RETURNING *`,
      [req.params.id, ...Object.values(updates)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Hotel not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/hotels/:id/bookings — all bookings for a hotel
router.get('/:id/bookings', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT hb.*, t.title AS trip_title
       FROM hotel_bookings hb
       JOIN trips t ON t.id = hb.trip_id
       WHERE hb.hotel_id = $1
       ORDER BY hb.check_in DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
