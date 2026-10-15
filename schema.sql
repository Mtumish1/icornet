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
    description  VARCHAR(100) NOT NULL,
    -- Soft-delete flag: inactive packages are hidden from /api/pricing
    -- but kept so historical transactions still reference them
    is_active    BOOLEAN NOT NULL DEFAULT TRUE
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
    -- can return them after payment.
    -- mikrotik_password is stored AES-256-GCM encrypted (prefix 'enc:v1:')
    mikrotik_username  VARCHAR(50),
    mikrotik_password  VARCHAR(255),

    ip_address         VARCHAR(15),

    start_time         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    end_time           TIMESTAMP,

    duration_hours     INT NOT NULL,

    cost_amount        DECIMAL(10,2),

    status             VARCHAR(20) NOT NULL DEFAULT 'active',

    -- Set to TRUE once the user was confirmed created on the Mikrotik router.
    -- FALSE rows are retried by the reconciliation cron job.
    router_provisioned BOOLEAN NOT NULL DEFAULT FALSE,

    -- Set to TRUE once the "expiring soon" SMS reminder has been sent
    expiry_reminder_sent BOOLEAN NOT NULL DEFAULT FALSE
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


-- ============================================================
-- ADMIN AUDIT LOG
-- One row per admin API request (method, path, source IP,
-- response status). Written by the auditAdmin middleware.
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id           SERIAL PRIMARY KEY,
    ip           VARCHAR(45),
    method       VARCHAR(10) NOT NULL,
    path         VARCHAR(200) NOT NULL,
    status_code  INT,
    duration_ms  INT,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_created
    ON admin_audit_log(created_at);


-- ============================================================
-- MIGRATIONS (idempotent — safe to re-run on existing databases)
-- Brings older deployments up to the current shape.
-- ============================================================

-- Encrypted credentials are longer than the original 50 chars
ALTER TABLE sessions ALTER COLUMN mikrotik_password TYPE VARCHAR(255);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS router_provisioned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expiry_reminder_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pricing ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;