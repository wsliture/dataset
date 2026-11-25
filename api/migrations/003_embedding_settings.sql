CREATE TABLE embedding_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL CHECK (revision > 0),
  endpoint text NOT NULL,
  model_name text NOT NULL,
  api_key text,
  dimension integer NOT NULL CHECK (dimension BETWEEN 1 AND 16000)
);
