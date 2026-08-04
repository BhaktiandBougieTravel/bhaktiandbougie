const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../db/pool');
const travelersRouter = require('./travelers');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/trips
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*,
              COALESCE(json_agg(json_build_object('id', c.id, 'first_name', c.first_name,
                'last_name', c.last_name, 'role', tc.role))
                FILTER (WHERE c.id IS NOT NULL), '[]') AS travellers
       FROM trips t
       LEFT JOIN trip_contacts tc ON tc.trip_id = t.id
       LEFT JOIN contacts c ON c.id = tc.contact_id
       GROUP BY t.id
       ORDER BY t.start_date DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/trips/:id
router.get('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*,
              COALESCE(json_agg(DISTINCT jsonb_build_object('id', c.id, 'first_name', c.first_name,
                'last_name', c.last_name, 'role', tc.role))
                FILTER (WHERE c.id IS NOT NULL), '[]') AS travellers,
              COALESCE(json_agg(DISTINCT to_jsonb(d.*)) FILTER (WHERE d.id IS NOT NULL), '[]') AS days,
              COALESCE(json_agg(DISTINCT to_jsonb(hb.*)) FILTER (WHERE hb.id IS NOT NULL), '[]') AS hotel_bookings,
              COALESCE(json_agg(DISTINCT to_jsonb(f.*)) FILTER (WHERE f.id IS NOT NULL), '[]') AS flights,
              COALESCE(json_agg(DISTINCT to_jsonb(e.*)) FILTER (WHERE e.id IS NOT NULL), '[]') AS expenses
       FROM trips t
       LEFT JOIN trip_contacts tc ON tc.trip_id = t.id
       LEFT JOIN contacts c ON c.id = tc.contact_id
       LEFT JOIN days d ON d.trip_id = t.id
       LEFT JOIN hotel_bookings hb ON hb.trip_id = t.id
       LEFT JOIN flights f ON f.trip_id = t.id
       LEFT JOIN expenses e ON e.trip_id = t.id
       WHERE t.id = $1
       GROUP BY t.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Trip not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/trips
router.post('/',
  body('title').notEmpty(),
  body('start_date').isDate(),
  body('end_date').isDate(),
  body('num_pax').optional().isInt({ min: 1 }),
  validate,
  async (req, res, next) => {
    const { title, status, start_date, end_date, num_pax, currency, base_price, notes } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO trips (title, status, start_date, end_date, num_pax, currency, base_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [title, status || 'enquiry', start_date, end_date, num_pax || 1, currency || 'INR', (base_price === '' || base_price === undefined) ? null : base_price, notes]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// PATCH /api/trips/:id
router.patch('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  const allowed = ['title', 'status', 'start_date', 'end_date', 'num_pax', 'currency', 'base_price', 'paid_amount', 'notes', 'trip_code', 'emergency_contact_name', 'emergency_contact_info'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE trips SET ${fields} WHERE id = $1 RETURNING *`,
      [req.params.id, ...Object.values(updates)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Trip not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/trips/:id/contacts — link a contact to a trip
router.post('/:id/contacts',
  param('id').isUUID(),
  body('contact_id').isUUID(),
  body('role').optional().isIn(['traveller', 'lead', 'emergency_contact']),
  validate,
  async (req, res, next) => {
    const { contact_id, role } = req.body;
    try {
      await pool.query(
        `INSERT INTO trip_contacts (trip_id, contact_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (trip_id, contact_id) DO UPDATE SET role = EXCLUDED.role`,
        [req.params.id, contact_id, role || 'traveller']
      );
      res.status(201).json({ trip_id: req.params.id, contact_id, role: role || 'traveller' });
    } catch (err) { next(err); }
  }
);

// DELETE /api/trips/:id/contacts/:contactId — unlink a contact
router.delete('/:id/contacts/:contactId',
  param('id').isUUID(), param('contactId').isUUID(), validate,
  async (req, res, next) => {
    try {
      await pool.query('DELETE FROM trip_contacts WHERE trip_id=$1 AND contact_id=$2',
        [req.params.id, req.params.contactId]);
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// DELETE /api/trips/:id
router.delete('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM day_activities WHERE trip_id = $1', [req.params.id]);
    await pool.query('DELETE FROM day_sacred_sites WHERE trip_id = $1', [req.params.id]);
    const { rowCount } = await pool.query('DELETE FROM trips WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Trip not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// /api/trips/:tripId/travelers
router.use('/:tripId/travelers', travelersRouter);

module.exports = router;
