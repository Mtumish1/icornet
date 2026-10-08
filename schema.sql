CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    account_balance DECIMAL(10,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id),
    session_key VARCHAR(100) UNIQUE,
    ip_address VARCHAR(15),
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP,
    duration_hours INT,
    status VARCHAR(20) DEFAULT 'active',
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id),
    mpesa_ref VARCHAR(100) UNIQUE,
    amount DECIMAL(10,2),
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE pricing (
    id SERIAL PRIMARY KEY,
    hours INT,
    price DECIMAL(10,2),
    description VARCHAR(100)
);

INSERT INTO pricing (hours, price, description) VALUES
(1, 50, '1 Hour'),
(3, 120, '3 Hours'),
(24, 300, '1 Day Pass'),
(7, 1500, '1 Week');

CREATE INDEX idx_user_phone ON users(phone_number);
CREATE INDEX idx_session_user ON sessions(user_id, status);
CREATE INDEX idx_transaction_user ON transactions(user_id);