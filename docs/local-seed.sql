-- ── A stand-in "host application" schema ─────────────────────────────────────
-- This is the sort of thing the agent reads. It is NOT part of the service;
-- the service only ever adds its own `ori` schema alongside whatever is here.

CREATE TABLE IF NOT EXISTS organisations (
  id   BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id     BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisations(id),
  name   TEXT NOT NULL,
  email  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisations(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  reference   TEXT NOT NULL,
  status      TEXT NOT NULL,
  total       NUMERIC(10,2) NOT NULL,
  placed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_ref_idx  ON orders (lower(reference));
CREATE INDEX IF NOT EXISTS orders_org_idx  ON orders (org_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS customers_org_idx ON customers (org_id);

INSERT INTO organisations (id, name) VALUES (1, 'Acme Ltd'), (2, 'Globex')
  ON CONFLICT DO NOTHING;

INSERT INTO customers (id, org_id, name, email) VALUES
  (1, 1, 'Priya Sharma',  'priya@acme.test'),
  (2, 1, 'Priya Sharman', 'priya.s@acme.test'),
  (3, 1, 'Arjun Rao',     'arjun@acme.test'),
  (4, 2, 'Kim Patel',     'kim@globex.test')
  ON CONFLICT DO NOTHING;

INSERT INTO orders (id, org_id, customer_id, reference, status, total, placed_at) VALUES
  (1, 1, 1, 'ORD-10023', 'SHIPPED',   249.00, now() - interval '9 days'),
  (2, 1, 1, 'ORD-10024', 'PENDING',    79.50, now() - interval '2 days'),
  (3, 1, 2, 'ORD-10025', 'SHIPPED',   410.00, now() - interval '5 days'),
  (4, 1, 3, 'ORD-10026', 'CANCELLED',  15.00, now() - interval '1 day'),
  (5, 2, 4, 'ORD-20001', 'SHIPPED',   999.00, now() - interval '3 days')
  ON CONFLICT DO NOTHING;

SELECT setval('organisations_id_seq', 2, true);
SELECT setval('customers_id_seq', 4, true);
SELECT setval('orders_id_seq', 5, true);

-- ── The read-only role the agent runs registry functions as ──────────────────
-- This is the guarantee that makes admin-authored SQL safe to execute.
DROP ROLE IF EXISTS ori_reader;
CREATE ROLE ori_reader LOGIN PASSWORD 'ori_reader_pw';
GRANT CONNECT ON DATABASE oridemo TO ori_reader;
GRANT USAGE  ON SCHEMA public TO ori_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ori_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ori_reader;
ALTER ROLE ori_reader SET default_transaction_read_only = on;
