require('dotenv').config();
const express = require('express');
const cors = require('cors');

const tripsRouter        = require('./routes/trips');
const contactsRouter     = require('./routes/contacts');
const hotelsRouter       = require('./routes/hotels');
const hotelBookingsRouter = require('./routes/hotelBookings');
const flightsRouter      = require('./routes/flights');
const expensesRouter     = require('./routes/expenses');
const daysRouter         = require('./routes/days');
const festivalsRouter    = require('./routes/festivals');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', company: 'Bhakti & Bougie Travel Ltd' }));

app.use('/api/trips',          tripsRouter);
app.use('/api/contacts',       contactsRouter);
app.use('/api/hotels',         hotelsRouter);
app.use('/api/hotel-bookings', hotelBookingsRouter);
app.use('/api/flights',        flightsRouter);
app.use('/api/expenses',       expensesRouter);
app.use('/api/days',           daysRouter);
app.use('/api/festivals',      festivalsRouter);

// Central error handler
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Bhakti & Bougie Travel Ops running on port ${PORT}`);
});

module.exports = app;
