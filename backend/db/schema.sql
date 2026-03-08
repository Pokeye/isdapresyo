-- IsdaPresyo (Bulan, Sorsogon) database schema (PostgreSQL)

CREATE TABLE IF NOT EXISTS fish_prices (
  id SERIAL PRIMARY KEY,
  fish_type VARCHAR(100) NOT NULL,
  min_price DECIMAL(10,2) NOT NULL,
  max_price DECIMAL(10,2) NOT NULL,
  avg_price DECIMAL(10,2) NOT NULL,
  date_updated DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX IF NOT EXISTS idx_fish_prices_type_date
  ON fish_prices (fish_type, date_updated DESC, id DESC);

CREATE TABLE IF NOT EXISTS admin (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Optional input feature used by the prediction model.
-- Whole municipality (single market) daily gas price reference.
CREATE TABLE IF NOT EXISTS gas_prices (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  price DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gas_prices_date
  ON gas_prices (date DESC, id DESC);

-- Predicted prices generated from historical fish_prices (+ optional gas_prices).
CREATE TABLE IF NOT EXISTS predictions (
  id SERIAL PRIMARY KEY,
  fish_type VARCHAR(100) NOT NULL,
  predicted_min_price DECIMAL(10,2) NOT NULL,
  predicted_max_price DECIMAL(10,2) NOT NULL,
  predicted_avg_price DECIMAL(10,2) NOT NULL,
  prediction_date DATE NOT NULL,
  algorithm_used VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_predictions_fish_date_algo
  ON predictions (fish_type, prediction_date, algorithm_used);

CREATE INDEX IF NOT EXISTS idx_predictions_date
  ON predictions (prediction_date DESC, fish_type ASC, id DESC);
