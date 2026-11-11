CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role    AS ENUM ('user','admin');
CREATE TYPE seat_status  AS ENUM ('available','held','sold');
CREATE TYPE hold_status  AS ENUM ('active','converted','released','expired');
CREATE TYPE order_status AS ENUM ('pending_payment','paid','failed');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'user',
  is_bench      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE venues (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE NOT NULL,
  name       text NOT NULL,
  city       text NOT NULL,
  layout     jsonb NOT NULL,          -- VenueLayout (§6)
  capacity   int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text UNIQUE NOT NULL,
  title               text NOT NULL,
  subtitle            text NOT NULL DEFAULT '',
  description         text NOT NULL DEFAULT '',
  category            text NOT NULL DEFAULT 'music',   -- music | comedy | theatre | sports | talk
  venue_id            uuid NOT NULL REFERENCES venues(id),
  starts_at           timestamptz NOT NULL,
  sale_opens_at       timestamptz NOT NULL,
  tier_prices         jsonb NOT NULL,                  -- {"platinum": 499900, ...} paise
  queue_enabled       boolean NOT NULL DEFAULT false,
  admit_rate_per_sec  int NOT NULL DEFAULT 25 CHECK (admit_rate_per_sec BETWEEN 1 AND 10000),
  max_seats_per_order int NOT NULL DEFAULT 6  CHECK (max_seats_per_order BETWEEN 1 AND 10),
  hold_ttl_seconds    int NOT NULL DEFAULT 300 CHECK (hold_ttl_seconds BETWEEN 30 AND 1800),
  poster_hue          int NOT NULL DEFAULT 260 CHECK (poster_hue BETWEEN 0 AND 359),
  listed              boolean NOT NULL DEFAULT true,   -- bench events are unlisted
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (sale_opens_at < starts_at)
);

CREATE TABLE event_seats (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section_key  text NOT NULL,
  row_label    text NOT NULL,
  seat_number  int  NOT NULL,
  tier         text NOT NULL,
  price_paise  int  NOT NULL CHECK (price_paise > 0),
  status       seat_status NOT NULL DEFAULT 'available',
  hold_id      uuid,
  held_until   timestamptz,
  order_id     uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, section_key, row_label, seat_number),
  CHECK ((status = 'held') = (hold_id IS NOT NULL AND held_until IS NOT NULL)),
  CHECK ((status = 'sold') = (order_id IS NOT NULL))
);
CREATE INDEX event_seats_event_status ON event_seats (event_id, status);
CREATE INDEX event_seats_hold ON event_seats (hold_id) WHERE hold_id IS NOT NULL;
CREATE INDEX event_seats_expiry ON event_seats (held_until) WHERE status = 'held';

CREATE TABLE holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  seat_ids     bigint[] NOT NULL,
  amount_paise int NOT NULL,
  strategy     text NOT NULL,          -- naive | pessimistic | conditional | redis
  status       hold_status NOT NULL DEFAULT 'active',
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz              -- set when converted / released / expired
);
CREATE INDEX holds_user_event_active ON holds (user_id, event_id) WHERE status = 'active';
CREATE INDEX holds_event ON holds (event_id);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  hold_id         uuid UNIQUE NOT NULL REFERENCES holds(id),
  status          order_status NOT NULL DEFAULT 'pending_payment',
  amount_paise    int NOT NULL,
  failure_reason  text,                -- PAYMENT_DECLINED | HOLD_LOST | SEAT_ALREADY_SOLD | ...
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX orders_user ON orders (user_id, created_at DESC);
CREATE INDEX orders_event ON orders (event_id, created_at DESC);

CREATE TABLE payment_intents (       -- owned by the MockPay module
  id           text PRIMARY KEY,      -- 'pi_' + 24 random base32 chars
  order_id     uuid UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_paise int NOT NULL,
  status       text NOT NULL DEFAULT 'requires_payment', -- requires_payment|processing|succeeded|failed|refunded
  attempts     int NOT NULL DEFAULT 0,
  last4        text,
  failure_code text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (         -- dedupe: a webhook event id is processed at most once
  id          text PRIMARY KEY,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  event_seat_id bigint NOT NULL UNIQUE REFERENCES event_seats(id) ON DELETE CASCADE, -- last line of defence
  user_id       uuid NOT NULL REFERENCES users(id),
  code          text UNIQUE NOT NULL,  -- 'SL-' + 20 random Crockford base32 chars (100 bits)
  checked_in_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_user ON tickets (user_id);
