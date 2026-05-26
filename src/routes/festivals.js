const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/festivals
// Query params: city, from, to, type
router.get('/', async (req, res, next) => {
  try {
    const { city, from, to, type } = req.query;
    const conditions = [];
    const values = [];

    if (city) {
      values.push(`%${city}%`);
      conditions.push(`(city ILIKE $${values.length} OR region ILIKE $${values.length} OR state ILIKE $${values.length})`);
    }
    if (from) {
      values.push(from);
      conditions.push(`start_date >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      conditions.push(`start_date <= $${values.length}`);
    }
    if (type) {
      values.push(`%${type}%`);
      conditions.push(`festival_type ILIKE $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM festivals ${where} ORDER BY start_date ASC`,
      values
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
