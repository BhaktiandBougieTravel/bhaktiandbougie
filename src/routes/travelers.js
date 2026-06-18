const express = require('express');
const pool = require('../db/pool');

const router = express.Router({ mergeParams: true });

const FIELDS = [
  'first_name','last_name','email','phone','address',
  'passport_number','passport_expiry','passport_country',
  'insurance_provider','insurance_policy','insurance_phone',
  'emergency_contact_name','emergency_contact_phone',
  'dietary_notes','medical_notes',
];

// GET /api/trips/:tripId/travelers
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM trip_travelers WHERE trip_id=$1 ORDER BY last_name, first_name`,
      [req.params.tripId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/trips/:tripId/travelers
router.post('/', async (req, res, next) => {
  try {
    const fields = FIELDS.filter(f => req.body[f] !== undefined && req.body[f] !== null);
    const cols = ['trip_id', ...fields];
    const vals = [req.params.tripId, ...fields.map(f => req.body[f] || null)];
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `INSERT INTO trip_travelers (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`,
      vals
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
