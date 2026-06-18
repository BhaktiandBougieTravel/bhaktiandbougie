-- Bhakti & Bougie Travel Ltd - Database Schema
-- India-only luxury spiritual travel operations

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- CONTACTS
-- Clients, vendors, guides, and other people in the system
-- ============================================================
CREATE TABLE contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          VARCHAR(20) NOT NULL CHECK (type IN ('client', 'vendor', 'guide', 'driver', 'other')),
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100),
  email         VARCHAR(255),
  phone         VARCHAR(30),
  whatsapp      VARCHAR(30),
  nationality   VARCHAR(100),
  passport_number VARCHAR(50),
  passport_expiry DATE,
  dietary_notes TEXT,
  medical_notes TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TRIPS
-- A trip is a single client journey with one or more travellers
-- ============================================================
CREATE TABLE trips (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         VARCHAR(255) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'enquiry'
                  CHECK (status IN ('enquiry', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  num_pax       INTEGER NOT NULL DEFAULT 1 CHECK (num_pax > 0),
  currency      CHAR(3) NOT NULL DEFAULT 'INR',
  base_price    NUMERIC(12, 2),   -- total quoted price to client
  paid_amount   NUMERIC(12, 2) DEFAULT 0,
  notes                    TEXT,
  emergency_contact_name   TEXT,
  emergency_contact_info   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT end_after_start CHECK (end_date >= start_date)
);

-- ============================================================
-- TRIP TRAVELERS
-- Per-person profile records for each traveler on a trip
-- ============================================================
CREATE TABLE IF NOT EXISTS trip_travelers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id                 UUID REFERENCES trips(id) ON DELETE CASCADE,
  first_name              TEXT,
  last_name               TEXT,
  email                   TEXT,
  phone                   TEXT,
  address                 TEXT,
  passport_number         TEXT,
  passport_expiry         DATE,
  passport_country        TEXT,
  insurance_provider      TEXT,
  insurance_policy        TEXT,
  insurance_phone         TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  dietary_notes           TEXT,
  medical_notes           TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_travelers_trip ON trip_travelers(trip_id);

-- Link trips to their travellers (clients)
CREATE TABLE trip_contacts (
  trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES contacts(id),
  role          VARCHAR(20) NOT NULL DEFAULT 'traveller'
                  CHECK (role IN ('traveller', 'lead', 'emergency_contact')),
  PRIMARY KEY (trip_id, contact_id)
);

-- ============================================================
-- DAYS
-- Itinerary days within a trip
-- ============================================================
CREATE TABLE days (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_number    INTEGER NOT NULL CHECK (day_number > 0),
  date          DATE NOT NULL,
  location      VARCHAR(255),       -- city / region in India
  title         VARCHAR(255),       -- e.g. "Arrival in Varanasi"
  description   TEXT,               -- detailed itinerary narrative
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trip_id, day_number)
);

-- ============================================================
-- HOTELS
-- Accommodation used across all trips
-- ============================================================
CREATE TABLE hotels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  city          VARCHAR(100) NOT NULL,
  state         VARCHAR(100),
  category      VARCHAR(20) CHECK (category IN ('heritage', 'luxury', 'boutique', 'ashram', 'other')),
  star_rating   SMALLINT CHECK (star_rating BETWEEN 1 AND 5),
  address       TEXT,
  contact_name  VARCHAR(255),
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  website       VARCHAR(500),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hotel bookings for a trip (one booking = one hotel stay)
CREATE TABLE hotel_bookings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  hotel_id      UUID NOT NULL REFERENCES hotels(id),
  check_in      DATE NOT NULL,
  check_out     DATE NOT NULL,
  room_type     VARCHAR(100),
  num_rooms     INTEGER NOT NULL DEFAULT 1 CHECK (num_rooms > 0),
  confirmation_number VARCHAR(100),
  rate_per_night NUMERIC(10, 2),
  total_cost    NUMERIC(12, 2),
  currency      CHAR(3) NOT NULL DEFAULT 'INR',
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT checkout_after_checkin CHECK (check_out > check_in)
);

-- ============================================================
-- FLIGHTS
-- Domestic flights within India for trips
-- ============================================================
CREATE TABLE flights (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  flight_number   VARCHAR(20),
  airline         VARCHAR(100),
  origin_airport  CHAR(3) NOT NULL,   -- IATA code e.g. DEL, BOM, MAA
  dest_airport    CHAR(3) NOT NULL,
  departure_time  TIMESTAMPTZ NOT NULL,
  arrival_time    TIMESTAMPTZ NOT NULL,
  booking_ref     VARCHAR(50),
  num_passengers  INTEGER NOT NULL DEFAULT 1 CHECK (num_passengers > 0),
  cabin_class     VARCHAR(20) DEFAULT 'economy'
                    CHECK (cabin_class IN ('economy', 'premium_economy', 'business', 'first')),
  total_cost      NUMERIC(12, 2),
  currency        CHAR(3) NOT NULL DEFAULT 'INR',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT arrival_after_departure CHECK (arrival_time > departure_time)
);

-- ============================================================
-- TRAIN JOURNEYS
-- ============================================================
CREATE TABLE train_journeys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  carrier         VARCHAR(100),
  train_number    VARCHAR(50),
  origin_station  VARCHAR(255),
  dest_station    VARCHAR(255),
  departure_date  DATE,
  departure_time  TIME,
  arrival_time    TIME,
  class           VARCHAR(100),
  pnr             VARCHAR(100),
  cost            NUMERIC(12,2),
  currency        CHAR(3) NOT NULL DEFAULT 'INR',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trains_trip ON train_journeys(trip_id);
CREATE INDEX idx_trains_date ON train_journeys(departure_date);

-- ============================================================
-- EXPENSES
-- All costs associated with a trip (for P&L tracking)
-- ============================================================
CREATE TABLE expenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  category      VARCHAR(30) NOT NULL
                  CHECK (category IN (
                    'accommodation', 'flights', 'ground_transport',
                    'guides', 'meals', 'entrance_fees', 'activities',
                    'gratuities', 'visa', 'insurance', 'miscellaneous'
                  )),
  description   VARCHAR(500) NOT NULL,
  vendor_id     UUID REFERENCES contacts(id),  -- optional link to a vendor contact
  amount        NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  currency      CHAR(3) NOT NULL DEFAULT 'INR',
  expense_date  DATE NOT NULL,
  paid_by       VARCHAR(50) DEFAULT 'company',  -- 'company' | 'client' | staff name
  receipt_ref   VARCHAR(100),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_trips_status      ON trips(status);
CREATE INDEX idx_trips_start_date  ON trips(start_date);
CREATE INDEX idx_days_trip_id      ON days(trip_id);
CREATE INDEX idx_days_date         ON days(date);
CREATE INDEX idx_hotel_bookings_trip ON hotel_bookings(trip_id);
CREATE INDEX idx_flights_trip      ON flights(trip_id);
CREATE INDEX idx_expenses_trip     ON expenses(trip_id);
CREATE INDEX idx_expenses_category ON expenses(category);
CREATE INDEX idx_contacts_type     ON contacts(type);

-- ============================================================
-- updated_at auto-update trigger
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_contacts_updated   BEFORE UPDATE ON contacts   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_trips_updated      BEFORE UPDATE ON trips      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_hotels_updated     BEFORE UPDATE ON hotels     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_expenses_updated   BEFORE UPDATE ON expenses   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
