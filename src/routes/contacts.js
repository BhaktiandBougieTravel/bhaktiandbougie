const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../db/pool');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/contacts
router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query;
    const { rows } = type
      ? await pool.query('SELECT * FROM contacts WHERE type = $1 ORDER BY last_name, first_name', [type])
      : await pool.query('SELECT * FROM contacts ORDER BY last_name, first_name');
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/contacts/:id
router.get('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/contacts
router.post('/',
  body('first_name').notEmpty(),
  body('type').isIn(['client', 'vendor', 'guide', 'driver', 'other']),
  body('email').optional().isEmail(),
  validate,
  async (req, res, next) => {
    const { type, first_name, last_name, email, phone, whatsapp, nationality,
            passport_number, passport_expiry, dietary_notes, medical_notes, notes } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO contacts (type, first_name, last_name, email, phone, whatsapp,
           nationality, passport_number, passport_expiry, dietary_notes, medical_notes, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [type, first_name, last_name, email, phone, whatsapp,
         nationality, passport_number, passport_expiry, dietary_notes, medical_notes, notes]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// PATCH /api/contacts/:id
router.patch('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  const allowed = ['type', 'first_name', 'last_name', 'email', 'phone', 'whatsapp',
    'nationality', 'passport_number', 'passport_expiry', 'dietary_notes', 'medical_notes', 'notes'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE contacts SET ${fields} WHERE id = $1 RETURNING *`,
      [req.params.id, ...Object.values(updates)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/contacts/:id
router.delete('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Contact not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
