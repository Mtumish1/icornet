/**
 * WiFi Hotspot Backend Server with M-Pesa Integration
 * Usage: node server.js
 * Make sure .env file exists with all credentials
 */

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { NodeSSH } = require('node-ssh');
const cron = require('node-cron');

dotenv.config();

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ============ SECURITY MIDDLEWARE ============

app.use(helmet());

app.use(cors({
    origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
        : ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static('public'));

// Request logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ============ RATE LIMITERS ============

/** 10 registration attempts per minute per IP */
const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    message: { error: 'Too many attempts. Please wait a minute.' }
});

/** 5 payment initiations per minute per IP */
const paymentLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    message: { error: 'Too many payment requests. Please wait a minute.' }
});

/** General API limiter */
const generalLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    message: { error: 'Too many requests. Please slow down.' }
});

app.use('/api/', generalLimiter);

// ============ ERROR HELPER ============

/**
 * Sends a consistent error response.
 * Hides internal details outside of development mode.
 */
const sendError = (res, status, message, err = null) => {
    const body = { error: message };
    if (process.env.NODE_ENV === 'development' && err) {
        body.details = err.message;
    }
    return res.status(status).json(body);
};

// ============ PHONE VALIDATION ============

/** Validates a Kenyan phone number in international format: 2547XXXXXXXX */
const PHONE_REGEX = /^2547[0-9]{8}$/;

const isValidPhone = (phone) => PHONE_REGEX.test(phone);

// ============ M-PESA SERVICE ============

class MPesaService {
    constructor() {
        this.consumerKey = process.env.MPESA_CONSUMER_KEY;
        this.consumerSecret = process.env.MPESA_CONSUMER_SECRET;
        this.businessCode = process.env.MPESA_BUSINESS_SHORTCODE || '174379';
        this.passkey = process.env.MPESA_PASSKEY;
        this.environment = process.env.MPESA_ENV || 'sandbox';
        this.tokenCache = { token: null, expiry: null };
    }

    getBaseUrl() {
        return this.environment === 'sandbox'
            ? 'https://sandbox.safaricom.co.ke'
            : 'https://api.safaricom.co.ke';
    }

    async getAccessToken() {
        // Return cached token if still valid (with 30s buffer)
        if (this.tokenCache.token && this.tokenCache.expiry > Date.now() + 30_000) {
            return this.tokenCache.token;
        }

        const auth = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');

        try {
            const response = await axios.get(
                `${this.getBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
                { headers: { 'Authorization': `Basic ${auth}` } }
            );

            this.tokenCache = {
                token: response.data.access_token,
                expiry: Date.now() + (response.data.expires_in * 1000)
            };

            return this.tokenCache.token;
        } catch (error) {
            console.error('❌ M-Pesa Token Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /** Generate the timestamp and password required for STK push / query */
    _getTimestampAndPassword() {
        const timestamp = new Date().toISOString().replace(/[:-]/g, '').split('.')[0];
        const password = Buffer.from(
            `${this.businessCode}${this.passkey}${timestamp}`
        ).toString('base64');
        return { timestamp, password };
    }

    async stkPush(phoneNumber, amount, accountReference) {
        const token = await this.getAccessToken();
        const { timestamp, password } = this._getTimestampAndPassword();

        const payload = {
            BusinessShortCode: this.businessCode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.round(amount),
            PartyA: phoneNumber.replace(/\D/g, ''),
            PartyB: this.businessCode,
            PhoneNumber: phoneNumber.replace(/\D/g, ''),
            CallBackURL: `${process.env.CALLBACK_URL}/mpesa/callback`,
            AccountReference: accountReference,
            TransactionDesc: 'WiFi Hotspot Payment'
        };

        try {
            console.log('📱 Sending STK Push...', { phone: phoneNumber, amount });

            const response = await axios.post(
                `${this.getBaseUrl()}/mpesa/stkpush/v1/processrequest`,
                payload,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );

            console.log('✅ STK Push Response:', response.data.ResponseCode);
            return response.data;
        } catch (error) {
            console.error('❌ STK Push Error:', error.response?.data || error.message);
            throw error;
        }
    }

    async queryTransaction(checkoutRequestId) {
        const token = await this.getAccessToken();
        const { timestamp, password } = this._getTimestampAndPassword();

        try {
            const response = await axios.post(
                `${this.getBaseUrl()}/mpesa/stkpushquery/v1/query`,
                {
                    BusinessShortCode: this.businessCode,
                    Password: password,
                    Timestamp: timestamp,
                    CheckoutRequestID: checkoutRequestId
                },
                { headers: { 'Authorization': `Bearer ${token}` } }
            );

            return response.data;
        } catch (error) {
            console.error('❌ Query Error:', error.response?.data || error.message);
            throw error;
        }
    }
}

const mpesaService = new MPesaService();

// ============ MIKROTIK SERVICE ============

class MikrotikService {
    constructor() {
        this.host = process.env.MIKROTIK_HOST || '192.168.1.1';
        this.user = process.env.MIKROTIK_USER || 'admin';
        this.pass = process.env.MIKROTIK_PASS || '';
    }

    /**
     * Opens an SSH connection to the Mikrotik router, runs a command, and closes.
     * @param {string} command - RouterOS CLI command to execute
     * @returns {Promise<string>} stdout from the router
     */
    async executeCommand(command) {
        const ssh = new NodeSSH();
        try {
            console.log(`🔧 Mikrotik CMD: ${command}`);
            await ssh.connect({
                host: this.host,
                username: this.user,
                password: this.pass,
                port: 22,
                readyTimeout: 5000
            });

            const result = await ssh.execCommand(command);

            if (result.stderr) {
                throw new Error(`Mikrotik error: ${result.stderr}`);
            }

            return result.stdout;
        } finally {
            // Always close, even on error
            ssh.dispose();
        }
    }

    /**
     * Creates a hotspot user on the Mikrotik router.
     * @param {string} username
     * @param {string} password
     */
    async addUser(username, password) {
        return this.executeCommand(
            `/ip hotspot user add name="${username}" password="${password}" profile=default`
        );
    }

    /**
     * Removes a hotspot user from the Mikrotik router.
     * @param {string} username
     */
    async removeUser(username) {
        return this.executeCommand(
            `/ip hotspot user remove [find name="${username}"]`
        );
    }
}

const mikrotik = new MikrotikService();

// ============ AUTHENTICATION MIDDLEWARE ============

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendError(res, 401, 'No token provided');
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userPhone = decoded.phone_number;
        next();
    } catch (error) {
        return sendError(res, 401, 'Invalid or expired token');
    }
};

// ============ ADMIN MIDDLEWARE ============

const adminMiddleware = (req, res, next) => {
    const apiKey = req.headers['x-admin-key'];
    if (!process.env.ADMIN_API_KEY || apiKey !== process.env.ADMIN_API_KEY) {
        return sendError(res, 403, 'Admin access denied');
    }
    next();
};

// ============ API ROUTES ============

/**
 * POST /api/auth/register
 * Register or login user with phone number.
 * Phone must be in format: 2547XXXXXXXX
 */
app.post('/api/auth/register', authLimiter, async (req, res) => {
    const { phone_number } = req.body;

    if (!phone_number || !isValidPhone(phone_number)) {
        return sendError(res, 400, 'Invalid phone number. Format: 2547XXXXXXXX (e.g. 254712345678)');
    }

    try {
        // Check if user exists
        const userResult = await pool.query(
            'SELECT id FROM users WHERE phone_number = $1',
            [phone_number]
        );

        let userId;

        if (userResult.rows.length === 0) {
            // Create new user
            const createResult = await pool.query(
                'INSERT INTO users (phone_number) VALUES ($1) RETURNING id',
                [phone_number]
            );
            userId = createResult.rows[0].id;
            console.log(`✅ New user registered: ${phone_number} (ID: ${userId})`);
        } else {
            userId = userResult.rows[0].id;
            console.log(`✅ User logged in: ${phone_number}`);
        }

        // Generate JWT token — 7 day expiry
        const token = jwt.sign(
            { userId, phone_number },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token,
            userId,
            message: 'Login successful'
        });

    } catch (error) {
        console.error('❌ Auth Error:', error);
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * GET /api/user/account
 * Get user account info
 */
app.get('/api/user/account', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, phone_number, account_balance, status, created_at FROM users WHERE id = $1',
            [req.userId]
        );

        if (result.rows.length === 0) {
            return sendError(res, 404, 'User not found');
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error('❌ Account Error:', error);
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * POST /api/payment/initiate
 * Initiate M-Pesa STK push for the authenticated user.
 * Body: { phone_number, amount }
 */
app.post('/api/payment/initiate', paymentLimiter, authMiddleware, async (req, res) => {
    const { phone_number, amount } = req.body;

    if (!phone_number || !amount) {
        return sendError(res, 400, 'Phone and amount are required');
    }

    if (!isValidPhone(phone_number)) {
        return sendError(res, 400, 'Invalid phone number. Format: 2547XXXXXXXX');
    }

    if (typeof amount !== 'number' || amount < 50) {
        return sendError(res, 400, 'Minimum amount is KES 50');
    }

    try {
        // Create a pending transaction record
        const internalRef = uuidv4();

        const dbResult = await pool.query(
            `INSERT INTO transactions (user_id, mpesa_ref, amount, status)
             VALUES ($1, $2, $3, 'pending') RETURNING id`,
            [req.userId, internalRef, amount]
        );

        console.log(`💳 Transaction created: ${internalRef} (DB id: ${dbResult.rows[0].id})`);

        // Trigger STK Push
        const stkResponse = await mpesaService.stkPush(
            phone_number,
            amount,
            `WIFI-${internalRef.substring(0, 12)}`
        );

        if (stkResponse.ResponseCode === '0') {
            // Store the CheckoutRequestID so we can match it on callback
            await pool.query(
                `UPDATE transactions SET checkout_request_id = $1 WHERE mpesa_ref = $2`,
                [stkResponse.CheckoutRequestID, internalRef]
            );

            res.json({
                success: true,
                checkout_request_id: stkResponse.CheckoutRequestID,
                message: 'STK Push sent — check your phone to enter M-Pesa PIN'
            });
        } else {
            res.status(400).json({
                error: 'STK Push failed',
                details: stkResponse.ResponseDescription
            });
        }

    } catch (error) {
        console.error('❌ Payment Initiation Error:', error);
        return sendError(res, 500, 'Payment initiation failed', error);
    }
});

/**
 * POST /mpesa/callback
 * M-Pesa payment callback from Safaricom.
 *
 * Security:
 *  - Transaction is re-verified via queryTransaction() before crediting.
 *  - Transaction lookup uses the exact CheckoutRequestID column (no fuzzy LIKE).
 *  - Always responds with ResultCode: 0 so M-Pesa does not retry endlessly.
 */
app.post('/mpesa/callback', async (req, res) => {
    // Always respond 200 first — M-Pesa will retry if we don't
    res.json({ ResultCode: 0 });

    try {
        const { Body } = req.body;
        if (!Body || !Body.stkCallback) {
            console.warn('⚠️ Malformed M-Pesa callback received');
            return;
        }

        const { stkCallback } = Body;
        const { CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;

        console.log(`📞 M-Pesa Callback — ResultCode: ${ResultCode}, Ref: ${CheckoutRequestID}`);

        if (ResultCode !== 0) {
            console.log(`⚠️ Payment failed: ${ResultDesc}`);
            // Mark the transaction as failed
            await pool.query(
                `UPDATE transactions SET status = 'failed' WHERE checkout_request_id = $1`,
                [CheckoutRequestID]
            );
            return;
        }

        // Re-verify with M-Pesa before crediting (prevents spoofed callbacks)
        let verifyResult;
        try {
            verifyResult = await mpesaService.queryTransaction(CheckoutRequestID);
            if (verifyResult.ResultCode !== '0') {
                console.warn(`⚠️ Callback verification failed for ${CheckoutRequestID}`);
                return;
            }
        } catch (verifyErr) {
            console.error('❌ Verification query failed, aborting credit:', verifyErr.message);
            return;
        }

        // Extract amount from callback metadata
        let amount = 0;
        if (stkCallback.CallbackMetadata?.Item) {
            stkCallback.CallbackMetadata.Item.forEach(item => {
                if (item.Name === 'Amount') amount = parseFloat(item.Value);
            });
        }

        if (amount <= 0) {
            console.warn('⚠️ Invalid amount in callback, skipping credit');
            return;
        }

        // Look up the transaction by exact CheckoutRequestID (not a fuzzy LIKE)
        const transResult = await pool.query(
            `SELECT id, user_id, status FROM transactions
             WHERE checkout_request_id = $1 LIMIT 1`,
            [CheckoutRequestID]
        );

        if (transResult.rows.length === 0) {
            console.warn(`⚠️ No pending transaction found for ${CheckoutRequestID}`);
            return;
        }

        const transaction = transResult.rows[0];

        // Idempotency guard — do not process twice
        if (transaction.status !== 'pending') {
            console.log(`ℹ️ Transaction ${CheckoutRequestID} already processed (${transaction.status})`);
            return;
        }

        const userId = transaction.user_id;

        // Update transaction and user balance atomically
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                `UPDATE transactions SET status = 'success' WHERE id = $1`,
                [transaction.id]
            );

            await client.query(
                `UPDATE users SET account_balance = account_balance + $1 WHERE id = $2`,
                [amount, userId]
            );

            await client.query('COMMIT');
            console.log(`✅ Payment confirmed: KES ${amount} credited to user ${userId}`);
        } catch (dbErr) {
            await client.query('ROLLBACK');
            console.error('❌ DB error crediting balance, rolled back:', dbErr.message);
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('❌ Callback processing error:', error);
    }
});

/**
 * GET /api/pricing
 * Get available WiFi pricing packages
 */
app.get('/api/pricing', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM pricing ORDER BY hours ASC');
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Pricing Error:', error);
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * POST /api/wifi/buy
 * Purchase a WiFi access package using account balance.
 * Body: { package_id }
 *
 * Uses an atomic UPDATE...WHERE to prevent race conditions (double-spend).
 * Wrapped in a DB transaction so balance deduction and session creation are atomic.
 */
app.post('/api/wifi/buy', authMiddleware, async (req, res) => {
    const { package_id } = req.body;

    if (!package_id) {
        return sendError(res, 400, 'Package ID required');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Get pricing
        const priceResult = await client.query(
            'SELECT * FROM pricing WHERE id = $1',
            [package_id]
        );

        if (priceResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return sendError(res, 404, 'Package not found');
        }

        const pkg = priceResult.rows[0];

        // Atomic balance deduction — only succeeds if balance >= price
        // Prevents race conditions / double-spend
        const deductResult = await client.query(
            `UPDATE users
             SET account_balance = account_balance - $1
             WHERE id = $2 AND account_balance >= $1
             RETURNING account_balance`,
            [pkg.price, req.userId]
        );

        if (deductResult.rowCount === 0) {
            // Fetch current balance for the error response
            const balResult = await client.query(
                'SELECT account_balance FROM users WHERE id = $1',
                [req.userId]
            );
            await client.query('ROLLBACK');
            const current = balResult.rows[0]?.account_balance ?? 0;
            return res.status(400).json({
                error: 'Insufficient balance',
                required: pkg.price,
                current,
                shortfall: pkg.price - current
            });
        }

        // Generate Mikrotik credentials
        const username = `wf_${req.userId}_${Date.now()}`.substring(0, 20);
        const password = uuidv4().substring(0, 12);
        const sessionKey = uuidv4().substring(0, 16);

        // Record session
        const sessionResult = await client.query(
            `INSERT INTO sessions
               (user_id, session_key, mikrotik_username, start_time, duration_hours, cost_amount, status)
             VALUES ($1, $2, $3, NOW(), $4, $5, 'active')
             RETURNING *`,
            [req.userId, sessionKey, username, pkg.hours, pkg.price]
        );

        await client.query('COMMIT');

        // Add Mikrotik user AFTER DB commit (so rollback isn't needed if SSH fails)
        try {
            await mikrotik.addUser(username, password);
        } catch (sshErr) {
            // DB is already committed — log prominently but don't fail the API call.
            // A separate reconciliation job can retry the SSH operation.
            console.error(`❌ Mikrotik SSH failed for ${username}:`, sshErr.message);
            console.error('   User session recorded in DB but router not updated. Manual fix required.');
        }

        const expiry = new Date(Date.now() + pkg.hours * 60 * 60 * 1000);
        console.log(`✅ WiFi Access Granted: ${req.userPhone} for ${pkg.hours}h (expires ${expiry.toISOString()})`);

        res.json({
            success: true,
            session_key: sessionKey,
            username,
            password,
            duration_hours: pkg.hours,
            expiry,
            message: `WiFi access granted for ${pkg.hours} hour(s)`,
            instructions: 'Connect to the WiFi network and use the credentials above'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ WiFi Buy Error:', error);
        return sendError(res, 500, 'Purchase failed', error);
    } finally {
        client.release();
    }
});

/**
 * GET /api/sessions/active
 * Get user's active WiFi sessions
 */
app.get('/api/sessions/active', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, session_key, start_time, duration_hours,
                    start_time + (duration_hours * interval '1 hour') AS expiry,
                    status
             FROM sessions
             WHERE user_id = $1 AND status = 'active'
             ORDER BY start_time DESC LIMIT 5`,
            [req.userId]
        );

        res.json(result.rows);
    } catch (error) {
        console.error('❌ Session Error:', error);
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * GET /api/sessions/history
 * Get user's session history
 */
app.get('/api/sessions/history', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, duration_hours, cost_amount, start_time, end_time, status
             FROM sessions WHERE user_id = $1
             ORDER BY start_time DESC LIMIT 20`,
            [req.userId]
        );

        res.json(result.rows);
    } catch (error) {
        console.error('❌ History Error:', error);
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * GET /api/transactions/history
 * Get user's transaction history
 */
app.get('/api/transactions/history', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT amount, status, created_at
             FROM transactions
             WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 20`,
            [req.userId]
        );

        res.json(result.rows);
    } catch (error) {
        console.error('❌ Transaction Error:', error);
        return sendError(res, 500, 'Server error', error);
    }
});

// ============ ADMIN ROUTES ============

/**
 * GET /admin/stats
 * Get system statistics.
 * Requires X-Admin-Key header matching ADMIN_API_KEY in .env
 */
app.get('/admin/stats', adminMiddleware, async (req, res) => {
    try {
        const [usersResult, revenueResult, todayResult, activeResult] = await Promise.all([
            pool.query('SELECT COUNT(*) AS count FROM users'),
            pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE status = 'success'`),
            pool.query(
                `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
                 FROM transactions
                 WHERE status = 'success' AND DATE(created_at) = CURRENT_DATE`
            ),
            pool.query(`SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'`)
        ]);

        res.json({
            total_users: parseInt(usersResult.rows[0].count),
            total_revenue: revenueResult.rows[0].total,
            today_transactions: parseInt(todayResult.rows[0].count),
            today_revenue: todayResult.rows[0].total,
            active_sessions: parseInt(activeResult.rows[0].count)
        });
    } catch (error) {
        console.error('❌ Stats Error:', error);
        return sendError(res, 500, 'Server error', error);
    }
});

// ============ HEALTH CHECK ============

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date(), env: process.env.MPESA_ENV || 'sandbox' });
});

// ============ GLOBAL ERROR HANDLER ============

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('❌ Unhandled Error:', err);
    return sendError(res, 500, 'Internal server error', err);
});

// ============ SESSION EXPIRY CRON JOB ============

/**
 * Runs every minute.
 * Marks sessions as 'expired' when their duration has elapsed,
 * then removes the corresponding user from the Mikrotik router.
 */
cron.schedule('* * * * *', async () => {
    try {
        const expired = await pool.query(
            `UPDATE sessions
             SET status = 'expired', end_time = NOW()
             WHERE status = 'active'
               AND start_time + (duration_hours * interval '1 hour') < NOW()
             RETURNING id, mikrotik_username`
        );

        if (expired.rowCount > 0) {
            console.log(`⏰ Expiring ${expired.rowCount} session(s)...`);
            for (const session of expired.rows) {
                if (session.mikrotik_username) {
                    try {
                        await mikrotik.removeUser(session.mikrotik_username);
                        console.log(`   ✅ Removed Mikrotik user: ${session.mikrotik_username}`);
                    } catch (err) {
                        console.error(`   ❌ Failed to remove ${session.mikrotik_username}:`, err.message);
                    }
                }
            }
        }
    } catch (error) {
        console.error('❌ Session expiry cron error:', error.message);
    }
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   WiFi Hotspot Backend Server         ║
║   Environment: ${(process.env.MPESA_ENV || 'sandbox').padEnd(22)}║
║   Port: ${String(PORT).padEnd(30)}║
╚════════════════════════════════════════╝
    `);
    console.log('📡 Server ready for WiFi hotspot operations');
    console.log(`🌍 Portal:    http://localhost:${PORT}`);
    console.log(`💰 M-Pesa:    ${process.env.MPESA_ENV || 'sandbox'}`);
    console.log(`⏰ Session expiry cron: running every minute`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⛔ Shutting down...');
    pool.end();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n⛔ SIGTERM received, shutting down...');
    pool.end();
    process.exit(0);
});
