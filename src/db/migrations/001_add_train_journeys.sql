-- Migration 001: Add train_journeys table
-- Run on production Railway database

CREATE TABLE IF NOT EXISTS train_journeys (
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

CREATE INDEX IF NOT EXISTS idx_trains_trip ON train_journeys(trip_id);
CREATE INDEX IF NOT EXISTS idx_trains_date ON train_journeys(departure_date);
