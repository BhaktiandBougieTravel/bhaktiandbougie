const express = require('express');
const { param, validationResult } = require('express-validator');
const pool = require('../db/pool');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/flight-documents?trip_id=<uuid>&traveler_name=<name>
// Metadata only — never returns file bytes in the list view.
router.get('/', async (req, res, next) => {
  try {
    const { trip_id, traveler_name } = req.query;
    const conditions = [];
    const params = [];
    if (trip_id) { params.push(trip_id); conditions.push(`fd.trip_id = $${params.length}`); }
    if (traveler_name) { params.push(traveler_name); conditions.push(`fd.traveler_name ILIKE $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT fd.id, fd.flight_id, fd.trip_id, fd.traveler_name, fd.document_type, fd.filename, fd.uploaded_at,
              f.flight_number, f.origin_airport, f.dest_airport, f.departure_time
       FROM flight_documents fd
       LEFT JOIN flights f ON f.id = fd.flight_id
       ${where}
       ORDER BY fd.uploaded_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/flight-documents/:id/download — streams the actual PDF bytes
router.get('/:id/download', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT filename, mime_type, file_data FROM flight_documents WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });
    const doc = rows[0];
    res.set({ 'Content-Type': doc.mime_type || 'application/pdf', 'Content-Disposition': `inline; filename="${doc.filename}"` });
    res.end(doc.file_data);
  } catch (err) { next(err); }
});

// PATCH /api/flight-documents/:id — assign or correct the traveler this document belongs to
router.patch('/:id', param('id').isUUID(), validate, async (req, res, next) => {
  try {
    const { traveler_name } = req.body;
    const { rows } = await pool.query(
      'UPDATE flight_documents SET traveler_name = $2 WHERE id = $1 RETURNING id, traveler_name',
      [req.params.id, traveler_name || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
