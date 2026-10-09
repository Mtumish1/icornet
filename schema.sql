-- schema.sql
-- WiFi Hotspot Database Schema
-- PostgreSQL — import with: psql hotspot_db < schema.sql


-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id               SERIAL PRIMARY KEY,
    phone_number     VARCHAR(15) UNIQUE NOT NULL,
    account_balance  DECIMAL(10,2) NOT NULL DEFAULT 0,
    status           VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_phone
    ON users(phone_number);


-- ============================================================
-- PRICING
-- Must be created BEFORE transactions because transactions
-- references pricing(id).
-- ============================================================

CREATE TABLE IF NOT EXISTS pricing (
    id           SERIAL PRIMARY KEY,
    hours        INT NOT NULL UNIQUE,
    price        DECIMAL(10,2) NOT NULL,
    description  VARCHAR(100) NOT NULL
);

-- Default pricing packages
INSERT INTO pricing (hours, price, description)
VALUES
    (1,  5,  '1 Hour'),
    (6,  10, '6 Hours'),
    (12, 20, '12 Hours'),
    (24, 50, '24 Hours')
ON CONFLICT (hours) DO NOTHING;


-- ============================================================
-- SESSIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
    id                 SERIAL PRIMARY KEY,

    user_id            INT NOT NULL REFERENCES users(id),

    session_key        VARCHAR(100) UNIQUE,

    -- Credentials stored so the portal status endpoint
    -- can return them after payment
    mikrotik_username  VARCHAR(50),
    mikrotik_password  VARCHAR(50),

    ip_address         VARCHAR(15),

    start_time         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    end_time           TIMESTAMP,

    duration_hours     INT NOT NULL,

    cost_amount        DECIMAL(10,2),

    status             VARCHAR(20) NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_session_user
    ON sessions(user_id, status);

CREATE INDEX IF NOT EXISTS idx_session_expiry
    ON sessions(start_time, duration_hours)
    WHERE status = 'active';


-- ============================================================
-- TRANSACTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS transactions (
    id                       SERIAL PRIMARY KEY,

    user_id                  INT NOT NULL REFERENCES users(id),

    -- Internal reference created when initiating the STK Push
    mpesa_ref                VARCHAR(100) UNIQUE,

    -- CheckoutRequestID returned by M-Pesa STK Push
    -- Used to match callbacks
    checkout_request_id      VARCHAR(100) UNIQUE,

    amount                   DECIMAL(10,2) NOT NULL,

    status                   VARCHAR(20) NOT NULL DEFAULT 'pending',

    -- Package intended for this payment
    -- Used for automatic WiFi provisioning
    package_id               INT REFERENCES pricing(id),

    -- Set after callback auto-provisions WiFi
    -- Used by status endpoint to return credentials
    provisioned_session_key  VARCHAR(100),

    created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transaction_user
    ON transactions(user_id);

CREATE INDEX IF NOT EXISTS idx_transaction_checkout
    ON transactions(checkout_request_id);

CREATE INDEX IF NOT EXISTS idx_transaction_package
    ON transactions(package_id);

CREATE INDEX IF NOT EXISTS idx_transaction_status
    ON transactions(status);