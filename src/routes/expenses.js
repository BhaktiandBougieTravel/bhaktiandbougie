const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../db/pool');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/expenses?trip_id=<uuid>&category=<cat>
router.get('/', async (req, res, next) => {
  try {
    const { trip_id, category } = req.query;
    let sql = 'SELECT e.*, c.first_name AS vendor_name FROM expenses e LEFT JOIN contacts c ON c.id = e.vendor_id WHERE TRUE';
    const params = [];
    if (trip_id)   { params.push(trip_id);   sql += ` AND e.trip_id = $${params.length}`; }
    if (category)  { params.push(category);  sql += ` AND e.category = $${params.length}`; }
    sql += ' ORDER BY e.expense_date DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/expenses/summary/:trip_id — P&L summary for a trip
router.get('/summary/:trip_id', param('trip_id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows: expRows } = await pool.query(
      `SELECT category, SUM(amount) AS total
       FROM expenses WHERE trip_id = $1 GROUP BY category ORDER BY total DESC`,
      [req.params.trip_id]
    );
    const { rows: tripRows } = await pool.query(
      'SELECT base_price, paid_amount, currency FROM trips WHERE id = $1',
      [req.params.trip_id]
    );
    if (!tripRows.length) return res.status(404).json({ error: 'Trip not found' });
    const { base_price, paid_amount, currency } = tripRows[0];
    const total_expenses = expRows.reduce((sum, r) => sum + parseFloat(r.total), 0);
    res.json({
      trip_id: req.params.trip_id,
      currency,
      base_price: parseFloat(base_price) || 0,
      paid_amount: parseFloat(paid_amount) || 0,
      total_expenses,
      gross_profit: (parseFloat(base_price) || 0) - total_expenses,
      breakdown: expRows,
    });
  } catch (err) { next(err); }
});

// GET /api/expenses/:id
router.get('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM expenses WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/expenses
router.post('/',
  body('trip_id').isUUID(),
  body('category').isIn(['accommodation', 'flights', 'ground_transport', 'guides', 'meals',
    'entrance_fees', 'activities', 'gratuities', 'visa', 'insurance', 'miscellaneous']),
  body('description').notEmpty(),
  body('amount').isFloat({ min: 0 }),
  body('expense_date').isDate(),
  validate,
  async (req, res, next) => {
    const { trip_id, category, description, vendor_id, amount, currency,
            expense_date, paid_by, receipt_ref, notes } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO expenses (trip_id, category, description, vendor_id, amount, currency,
           expense_date, paid_by, receipt_ref, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [trip_id, category, description, vendor_id || null, amount,
         currency || 'INR', expense_date, paid_by || 'company', receipt_ref, notes]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// PATCH /api/expenses/:id
router.patch('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  const allowed = ['category', 'description', 'vendor_id', 'amount', 'currency',
    'expense_date', 'paid_by', 'receipt_ref', 'notes'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE expenses SET ${fields} WHERE id = $1 RETURNING *`,
      [req.params.id, ...Object.values(updates)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/expenses/:id
router.delete('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Expense not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
