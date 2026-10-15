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
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { NodeSSH } = require('node-ssh');
const cron = require('node-cron');
const pino = require('pino');

dotenv.config();

// ============ STRUCTURED LOGGING ============

const log = pino({
    level: process.env.LOG_LEVEL || 'info'
});

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ============ SECURITY MIDDLEWARE ============

app.use(helmet());

app.use(cors({
    origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
        : ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key']
}));

app.use(express.json());
app.use(express.static('public'));

// Request logging (health checks are skipped — they fire every 30s)
app.use((req, res, next) => {
    if (req.path !== '/health') {
        log.info({ method: req.method, path: req.path }, 'request');
    }
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

// ============ CREDENTIAL ENCRYPTION (at rest) ============
// Mikrotik WiFi passwords are stored in the DB as AES-256-GCM ciphertext
// tagged 'enc:v1:...'. Values without the tag are returned as-is, so
// rows written before this feature keep working.

const CREDENTIALS_KEY = (() => {
    const secret = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!process.env.CREDENTIALS_ENCRYPTION_KEY && process.env.JWT_SECRET) {
        log.warn('CREDENTIALS_ENCRYPTION_KEY not set — deriving from JWT_SECRET. Set a dedicated key in production.');
    }
    return crypto.createHash('sha256').update(`hotspot-credentials:v1:${secret}`).digest();
})();

/** Encrypts a secret for storage. Returns a tagged 'enc:v1:<iv>:<tag>:<data>' string. */
const encryptSecret = (value) => {
    if (value === null || value === undefined || value === '') return value;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', CREDENTIALS_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return [
        'enc:v1',
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        encrypted.toString('base64')
    ].join(':');
};

/** Decrypts a stored secret. Plaintext (legacy) values pass through unchanged. */
const decryptSecret = (value) => {
    if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value;
    try {
        const [, , ivB64, tagB64, dataB64] = value.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', CREDENTIALS_KEY, Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
    } catch (error) {
        log.error({ err: error.message }, 'Failed to decrypt stored credential');
        return null;
    }
};

// ============ M-PESA CALLBACK IP ALLOWLIST ============

/** Comma-separated IPs/CIDRs (e.g. "196.201.214.0/24,196.201.213.0/24"). Empty = allow all. */
const MPESA_ALLOWED_IPS = (process.env.MPESA_CALLBACK_IPS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const ipv4ToInt = (ip) => ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);

/** Minimal IPv4 CIDR matcher (no external dependency). */
const matchesCidr = (ip, cidr) => {
    const [range, bitsRaw] = cidr.split('/');
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(range)) return false;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(range) & mask) >>> 0);
};

const isIpAllowed = (ip, allowlist = MPESA_ALLOWED_IPS) => {
    if (!allowlist.length) return true;
    if (!ip) return false;
    return allowlist.some((entry) => entry === ip || matchesCidr(ip, entry));
};

/** Rejects callbacks whose source IP is not on the MPESA_CALLBACK_IPS allowlist. */
const mpesaCallbackGuard = (req, res, next) => {
    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const rawIp = forwarded || req.socket.remoteAddress || '';
    const ip = rawIp.replace(/^::ffff:/, '');
    if (!isIpAllowed(ip)) {
        log.warn({ ip }, 'Rejected M-Pesa callback from non-allowlisted IP');
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
};

// ============ M-PESA SERVICE ============

class MPesaService {
    constructor() {
        this.consumerKey = process.env.MPESA_CONSUMER_KEY;
        this.consumerSecret = process.env.MPESA_CONSUMER_SECRET;
        this.businessCode = process.env.MPESA_BUSINESS_SHORTCODE || '174379';
        this.passkey = process.env.MPESA_PASSKEY;
        this.environment = process.env.MPESA_ENV || 'sandbox';
        this.mock = String(process.env.MOCK_MPESA).toLowerCase() === 'true';
        this.tokenCache = { token: null, expiry: null };
        if (this.mock) {
            log.warn('🧪 MOCK_MPESA enabled — STK pushes auto-confirm after ~8s. Never use in production.');
        }
    }

    getBaseUrl() {
        return this.environment === 'sandbox'
            ? 'https://sandbox.safaricom.co.ke'
            : 'https://api.safaricom.co.ke';
    }

    async getAccessToken() {
        if (this.mock) {
            return 'mock-access-token';
        }

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
            log.error({ err: error.response?.data || error.message }, '❌ M-Pesa Token Error');
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
        if (this.mock) {
            return this._mockStkPush(phoneNumber, amount);
        }

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
            log.info({ phone: phoneNumber, amount }, '📱 Sending STK Push');

            const response = await axios.post(
                `${this.getBaseUrl()}/mpesa/stkpush/v1/processrequest`,
                payload,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );

            log.info({ responseCode: response.data.ResponseCode }, '✅ STK Push accepted');
            return response.data;
        } catch (error) {
            log.error({ err: error.response?.data || error.message }, '❌ STK Push Error');
            throw error;
        }
    }

    async queryTransaction(checkoutRequestId) {
        if (this.mock) {
            return {
                ResultCode: '0',
                ResultDescription: 'The service request is processed successfully. (mock)',
                CheckoutRequestID: checkoutRequestId
            };
        }

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
            log.error({ err: error.response?.data || error.message }, '❌ Query Error');
            throw error;
        }
    }

    /**
     * Simulates a successful STK push when MOCK_MPESA=true.
     * Schedules a fake success callback ~8s later so the real
     * callback processing (DB credit + provisioning) is exercised.
     */
    _mockStkPush(phoneNumber, amount) {
        const checkoutRequestId = `MOCK-CR-${uuidv4().replace(/-/g, '').substring(0, 14)}`;
        log.info({ checkoutRequestId, phone: phoneNumber, amount }, '🧪 Mock STK push accepted — auto-confirming in ~8s');

        const timer = setTimeout(() => {
            processMpesaCallback({
                MerchantRequestID: `MOCK-MR-${uuidv4().replace(/-/g, '').substring(0, 10)}`,
                CheckoutRequestID: checkoutRequestId,
                ResultCode: 0,
                ResultDesc: 'The service request is processed successfully. (mock)',
                CallbackMetadata: {
                    Item: [
                        { Name: 'Amount', Value: Math.round(amount) },
                        { Name: 'MpesaReceiptNumber', Value: `MOCK${Date.now()}` },
                        { Name: 'PhoneNumber', Value: phoneNumber.replace(/\D/g, '') }
                    ]
                }
            }).catch((error) => log.error({ err: error.message }, '❌ Mock callback processing failed'));
        }, 8000);
        if (typeof timer.unref === 'function') timer.unref();

        return {
            ResponseCode: '0',
            ResponseDescription: 'Success. Request accepted for processing (mock)',
            MerchantRequestID: `MOCK-MR-${uuidv4().replace(/-/g, '').substring(0, 10)}`,
            CheckoutRequestID: checkoutRequestId,
            CustomerMessage: 'Success. Request accepted for processing (mock)'
        };
    }
}

const mpesaService = new MPesaService();

// ============ SMS SERVICE (Twilio) ============

class SMSService {
    constructor() {
        this.sid = process.env.SMS_ACCOUNT_SID;
        this.token = process.env.SMS_AUTH_TOKEN;
        this.from = process.env.SMS_FROM_NUMBER;
        this.provider = process.env.SMS_PROVIDER;
        this.enabled = Boolean(this.sid && this.token && this.from);
        if (this.provider && this.provider !== 'twilio') {
            log.warn({ provider: this.provider }, 'Unsupported SMS provider — SMS notifications disabled');
            this.enabled = false;
        } else if (!this.enabled) {
            log.info('SMS notifications disabled (SMS_ACCOUNT_SID / SMS_AUTH_TOKEN / SMS_FROM_NUMBER not set)');
        }
    }

    /**
     * Sends an SMS via the Twilio REST API. Never throws — failures are
     * logged and returned as false so callers can fire-and-forget.
     * @param {string} phoneNumber - Kenyan format 2547XXXXXXXX (a leading + is added)
     * @param {string} message
     * @returns {Promise<boolean>}
     */
    async send(phoneNumber, message) {
        if (!this.enabled || !phoneNumber) return false;
        const to = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber.replace(/\D/g, '')}`;
        try {
            await axios.post(
                `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`,
                new URLSearchParams({ To: to, From: this.from, Body: message }),
                { auth: { username: this.sid, password: this.token }, timeout: 10_000 }
            );
            log.info({ to }, '📱 SMS sent');
            return true;
        } catch (error) {
            log.error({ err: error.response?.data || error.message, to }, '📱 SMS send failed');
            return false;
        }
    }
}

const sms = new SMSService();

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
            log.info(`🔧 Mikrotik CMD: ${command}`);
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

/**
 * Generates fresh credentials for a new WiFi session.
 * The plaintext password lives only in memory long enough to be
 * returned to the customer and pushed to the router — it is stored
 * in the DB encrypted via encryptSecret().
 */
const createWifiCredentials = (userId) => ({
    username: `wf_${userId}_${Date.now()}`.substring(0, 20),
    password: uuidv4().substring(0, 12),
    sessionKey: uuidv4().substring(0, 16)
});

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

/**
 * Records every admin API request (including rejected ones) into
 * admin_audit_log. Fire-and-forget: audit failures are logged but
 * never break the request.
 */
const auditAdmin = (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || req.socket.remoteAddress
            || '';
        pool.query(
            `INSERT INTO admin_audit_log (ip, method, path, status_code, duration_ms)
             VALUES ($1, $2, $3, $4, $5)`,
            [ip, req.method, (req.originalUrl || req.path).substring(0, 200), res.statusCode, Date.now() - startedAt]
        ).catch((error) => log.error({ err: error.message }, 'Failed to write admin audit log'));
    });
    next();
};

/** Combined guard for all admin routes: key check + audit trail. */
const adminGuard = [adminMiddleware, auditAdmin];

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
            log.info(`✅ New user registered: ${phone_number} (ID: ${userId})`);
        } else {
            userId = userResult.rows[0].id;
            log.info(`✅ User logged in: ${phone_number}`);
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
        log.error({ err: error }, '❌ Auth Error:');
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
        log.error({ err: error }, '❌ Account Error:');
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

        log.info(`💳 Transaction created: ${internalRef} (DB id: ${dbResult.rows[0].id})`);

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
        log.error({ err: error }, '❌ Payment Initiation Error:');
        return sendError(res, 500, 'Payment initiation failed', error);
    }
});

/**
 * POST /mpesa/callback
 * M-Pesa payment callback from Safaricom.
 *
 * Security:
 *  - Source IP must be on the MPESA_CALLBACK_IPS allowlist (if configured).
 *  - Transaction is re-verified via queryTransaction() before crediting.
 *  - Transaction lookup uses the exact CheckoutRequestID column (no fuzzy LIKE).
 *  - Always responds with ResultCode: 0 so M-Pesa does not retry endlessly.
 */
app.post('/mpesa/callback', mpesaCallbackGuard, async (req, res) => {
    // Always respond 200 first — M-Pesa will retry if we don't
    res.json({ ResultCode: 0 });

    try {
        const { Body } = req.body;
        if (!Body || !Body.stkCallback) {
            log.warn('⚠️ Malformed M-Pesa callback received');
            return;
        }
        await processMpesaCallback(Body.stkCallback);
    } catch (error) {
        log.error({ err: error }, '❌ Callback processing error');
    }
});

/**
 * Shared callback processor — also used by the MOCK_MPESA simulator.
 * Idempotent: only 'pending' transactions are credited.
 */
async function processMpesaCallback(stkCallback) {
    const { CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;

    log.info({ checkoutRequestId: CheckoutRequestID, resultCode: ResultCode }, '📞 M-Pesa callback received');

    if (ResultCode !== 0) {
        log.info({ checkoutRequestId: CheckoutRequestID, resultDesc: ResultDesc }, '⚠️ Payment failed or cancelled');
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
            log.warn({ checkoutRequestId: CheckoutRequestID }, '⚠️ Callback verification failed');
            return;
        }
    } catch (verifyErr) {
        log.error({ err: verifyErr.message }, '❌ Verification query failed, aborting credit');
        return;
    }

    // Extract amount and payer phone from callback metadata
    let amount = 0;
    let msisdn = '';
    if (stkCallback.CallbackMetadata?.Item) {
        stkCallback.CallbackMetadata.Item.forEach(item => {
            if (item.Name === 'Amount') amount = parseFloat(item.Value);
            if (item.Name === 'PhoneNumber') msisdn = String(item.Value);
        });
    }

    if (amount <= 0) {
        log.warn('⚠️ Invalid amount in callback, skipping credit');
        return;
    }

    // Look up the transaction by exact CheckoutRequestID (not a fuzzy LIKE)
    const transResult = await pool.query(
        `SELECT id, user_id, status, package_id FROM transactions
         WHERE checkout_request_id = $1 LIMIT 1`,
        [CheckoutRequestID]
    );

    if (transResult.rows.length === 0) {
        log.warn({ checkoutRequestId: CheckoutRequestID }, '⚠️ No transaction found for callback');
        return;
    }

    const transaction = transResult.rows[0];

    // Idempotency guard — do not process twice
    if (transaction.status !== 'pending') {
        log.info({ checkoutRequestId: CheckoutRequestID, status: transaction.status }, 'ℹ️ Transaction already processed');
        return;
    }

    const userId = transaction.user_id;

    // Update transaction and user balance atomically.
    // try/finally guarantees the pool client is always released.
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
        log.info({ amount, userId }, '✅ Payment confirmed — balance credited');
    } catch (dbErr) {
        await client.query('ROLLBACK');
        log.error({ err: dbErr.message }, '❌ DB error crediting balance, rolled back');
        return;
    } finally {
        client.release();
    }

    // Auto-provision WiFi if this payment was for a specific package (portal flow)
    if (transaction.package_id) {
        try {
            const pkgResult = await pool.query(
                'SELECT * FROM pricing WHERE id = $1',
                [transaction.package_id]
            );

            if (pkgResult.rows.length > 0) {
                const pkg = pkgResult.rows[0];
                const { username, password, sessionKey } = createWifiCredentials(userId);

                const provClient = await pool.connect();
                let provisioned = false;
                try {
                    await provClient.query('BEGIN');

                    // Deduct balance (atomic guard)
                    const deduct = await provClient.query(
                        `UPDATE users SET account_balance = account_balance - $1
                         WHERE id = $2 AND account_balance >= $1
                         RETURNING account_balance`,
                        [pkg.price, userId]
                    );

                    if (deduct.rowCount === 0) {
                        await provClient.query('ROLLBACK');
                        log.warn({ userId }, '⚠️ Insufficient balance to auto-provision');
                    } else {
                        // Create session (password stored encrypted at rest)
                        const sessionResult = await provClient.query(
                            `INSERT INTO sessions
                               (user_id, session_key, mikrotik_username, mikrotik_password, start_time, duration_hours, cost_amount, status)
                             VALUES ($1, $2, $3, $4, NOW(), $5, $6, 'active')
                             RETURNING id`,
                            [userId, sessionKey, username, encryptSecret(password), pkg.hours, pkg.price]
                        );

                        // Link session back to transaction for status polling
                        await provClient.query(
                            `UPDATE transactions SET provisioned_session_key = $1 WHERE id = $2`,
                            [sessionKey, transaction.id]
                        );

                        await provClient.query('COMMIT');
                        provisioned = true;
                        log.info({ userId, hours: pkg.hours }, '✅ Auto-provisioned WiFi session');
                    }
                } catch (provErr) {
                    await provClient.query('ROLLBACK');
                    log.error({ err: provErr.message }, '❌ Auto-provision DB error');
                } finally {
                    provClient.release();
                }

                if (provisioned) {
                    // Add Mikrotik user outside the DB transaction;
                    // the reconciliation cron retries if this fails.
                    try {
                        await mikrotik.addUser(username, password);
                        await pool.query(
                            `UPDATE sessions SET router_provisioned = TRUE WHERE session_key = $1`,
                            [sessionKey]
                        );
                    } catch (sshErr) {
                        log.error({ err: sshErr.message, username }, '❌ Mikrotik SSH failed for auto-provision — reconciliation will retry');
                    }

                    // Notify the customer (fire and forget)
                    if (!msisdn) {
                        const userResult = await pool.query(
                            'SELECT phone_number FROM users WHERE id = $1',
                            [userId]
                        );
                        msisdn = userResult.rows[0]?.phone_number || '';
                    }
                    sms.send(
                        msisdn,
                        `Your ${pkg.description} WiFi package (${pkg.hours}h) is active. Username: ${username} Password: ${password}`
                    ).catch(() => {});
                }
            }
        } catch (provErr) {
            log.error({ err: provErr.message }, '❌ Auto-provision error');
        }
    }
}

/**
 * GET /api/pricing
 * Get available WiFi pricing packages
 */
app.get('/api/pricing', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, hours, price, description FROM pricing WHERE is_active = TRUE ORDER BY hours ASC'
        );
        res.json(result.rows);
    } catch (error) {
        log.error({ err: error }, '❌ Pricing Error');
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
        const { username, password, sessionKey } = createWifiCredentials(req.userId);

        // Record session — password stored AES-256-GCM encrypted at rest
        const sessionResult = await client.query(
            `INSERT INTO sessions
               (user_id, session_key, mikrotik_username, mikrotik_password, start_time, duration_hours, cost_amount, status)
             VALUES ($1, $2, $3, $4, NOW(), $5, $6, 'active')
             RETURNING id`,
            [req.userId, sessionKey, username, encryptSecret(password), pkg.hours, pkg.price]
        );
        const sessionId = sessionResult.rows[0].id;

        await client.query('COMMIT');

        // Add Mikrotik user AFTER DB commit (so rollback isn't needed if SSH fails)
        let routerProvisioned = false;
        try {
            await mikrotik.addUser(username, password);
            routerProvisioned = true;
        } catch (sshErr) {
            // DB is already committed — log prominently but don't fail the API call.
            // The reconciliation cron job retries the SSH operation every 5 minutes.
            log.error({ err: sshErr.message, username }, '❌ Mikrotik SSH failed — session recorded in DB but router not updated, reconciliation will retry');
        }

        if (routerProvisioned) {
            await pool.query(
                `UPDATE sessions SET router_provisioned = TRUE WHERE id = $1`,
                [sessionId]
            ).catch((error) => log.error({ err: error.message }, 'Failed to mark session router_provisioned'));
        }

        const expiry = new Date(Date.now() + pkg.hours * 60 * 60 * 1000);
        log.info({ phone: req.userPhone, hours: pkg.hours, expiry: expiry.toISOString() }, '✅ WiFi access granted');

        // Notify the customer with their credentials (fire and forget)
        sms.send(
            req.userPhone,
            `WiFi access granted: ${pkg.hours} hour(s). Username: ${username} Password: ${password}. Valid until ${expiry.toLocaleString('en-KE')}.`
        ).catch(() => {});

        res.json({
            success: true,
            session_key: sessionKey,
            username,
            password,
            duration_hours: pkg.hours,
            expiry,
            message: `WiFi access granted for ${pkg.hours} hour(s)`,
            instructions: 'Connect to the WiFi network and use the credentials above. Credentials were also sent by SMS.'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        log.error({ err: error }, '❌ WiFi Buy Error');
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
        log.error({ err: error }, '❌ Session Error:');
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
        log.error({ err: error }, '❌ History Error:');
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
        log.error({ err: error }, '❌ Transaction Error:');
        return sendError(res, 500, 'Server error', error);
    }
});

// ============ PUBLIC PORTAL ROUTES (no auth required) ============

/**
 * POST /api/portal/pay
 * One-step public endpoint for the captive portal.
 * Registers (or logs in) the customer by phone number and immediately
 * triggers an STK Push for the selected package.
 * No JWT token required — customers don't need accounts.
 *
 * Body: { phone_number, package_id }
 */
app.post('/api/portal/pay', paymentLimiter, async (req, res) => {
    const { phone_number, package_id } = req.body;

    if (!phone_number || !isValidPhone(phone_number)) {
        return sendError(res, 400, 'Invalid phone number. Format: 2547XXXXXXXX (e.g. 254712345678)');
    }

    if (!package_id) {
        return sendError(res, 400, 'Please select a package');
    }

    try {
        // Fetch the package (server owns the price — never trust the client)
        const pkgResult = await pool.query(
            'SELECT * FROM pricing WHERE id = $1',
            [package_id]
        );

        if (pkgResult.rows.length === 0) {
            return sendError(res, 404, 'Package not found');
        }

        const pkg = pkgResult.rows[0];

        // Register or find user — fully transparent to the customer
        const userResult = await pool.query(
            `INSERT INTO users (phone_number)
             VALUES ($1)
             ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
             RETURNING id`,
            [phone_number]
        );
        const userId = userResult.rows[0].id;

        // Create a pending transaction that remembers the intended package
        const internalRef = uuidv4();
        await pool.query(
            `INSERT INTO transactions (user_id, mpesa_ref, amount, status, package_id)
             VALUES ($1, $2, $3, 'pending', $4)`,
            [userId, internalRef, pkg.price, pkg.id]
        );

        // Trigger STK Push
        const stkResponse = await mpesaService.stkPush(
            phone_number,
            pkg.price,
            `WIFI-${internalRef.substring(0, 12)}`
        );

        if (stkResponse.ResponseCode !== '0') {
            return res.status(400).json({
                error: 'Could not send payment request',
                details: stkResponse.ResponseDescription
            });
        }

        // Store CheckoutRequestID for callback matching
        await pool.query(
            `UPDATE transactions SET checkout_request_id = $1 WHERE mpesa_ref = $2`,
            [stkResponse.CheckoutRequestID, internalRef]
        );

        log.info(`📱 Portal pay: ${phone_number} → ${pkg.description} (KES ${pkg.price})`);

        res.json({
            success: true,
            checkout_request_id: stkResponse.CheckoutRequestID,
            package: {
                description: pkg.description,
                hours: pkg.hours,
                price: pkg.price
            },
            message: `Payment request sent to ${phone_number}. Enter your M-Pesa PIN.`
        });

    } catch (error) {
        log.error({ err: error }, '❌ Portal Pay Error:');
        return sendError(res, 500, 'Payment request failed. Please try again.', error);
    }
});

/**
 * GET /api/portal/status/:checkoutRequestId
 * Polling endpoint for the captive portal.
 * Returns the payment status and WiFi credentials once the payment is confirmed.
 * No auth required — the checkout_request_id acts as a one-time token.
 */
app.get('/api/portal/status/:checkoutRequestId', async (req, res) => {
    const { checkoutRequestId } = req.params;

    if (!checkoutRequestId || checkoutRequestId.length < 10) {
        return sendError(res, 400, 'Invalid checkout ID');
    }

    try {
        const result = await pool.query(
            `SELECT
                t.status,
                t.amount,
                t.provisioned_session_key,
                s.mikrotik_username  AS username,
                s.mikrotik_password  AS password,
                s.duration_hours,
                s.start_time + (s.duration_hours * interval '1 hour') AS expiry,
                p.description        AS package_name
             FROM transactions t
             LEFT JOIN sessions s ON s.session_key = t.provisioned_session_key
             LEFT JOIN pricing p ON p.id = t.package_id
             WHERE t.checkout_request_id = $1`,
            [checkoutRequestId]
        );

        if (result.rows.length === 0) {
            return sendError(res, 404, 'Transaction not found');
        }

        const tx = result.rows[0];

        if (tx.status === 'pending') {
            return res.json({ status: 'pending', message: 'Waiting for payment confirmation...' });
        }

        if (tx.status === 'failed') {
            return res.json({ status: 'failed', message: 'Payment was cancelled or failed. Please try again.' });
        }

        if (tx.status === 'success' && tx.username) {
            return res.json({
                status: 'success',
                credentials: {
                    username: tx.username,
                    password: decryptSecret(tx.password),
                    duration_hours: tx.duration_hours,
                    expiry: tx.expiry,
                    package_name: tx.package_name
                }
            });
        }

        // Payment succeeded but provisioning still in progress
        return res.json({ status: 'provisioning', message: 'Payment received! Setting up your access...' });

    } catch (error) {
        log.error({ err: error }, '❌ Portal Status Error:');
        return sendError(res, 500, 'Could not check status', error);
    }
});

// ============ ADMIN ROUTES ============

/**
 * Validates shared pagination and search parameters for admin list endpoints.
 */
const getAdminListOptions = (req, res) => {
    const pageParam = req.query.page === undefined ? '1' : req.query.page;
    const limitParam = req.query.limit === undefined ? '25' : req.query.limit;
    const search = req.query.search === undefined ? '' : req.query.search;
    const status = req.query.status === undefined ? '' : req.query.status;

    if (typeof pageParam !== 'string' || !/^\d+$/.test(pageParam) ||
        !Number.isSafeInteger(Number(pageParam)) || Number(pageParam) < 1) {
        sendError(res, 400, 'Page must be a positive integer');
        return null;
    }

    if (typeof limitParam !== 'string' || !/^\d+$/.test(limitParam) ||
        !Number.isInteger(Number(limitParam)) || Number(limitParam) < 1 || Number(limitParam) > 100) {
        sendError(res, 400, 'Limit must be an integer between 1 and 100');
        return null;
    }

    if (typeof search !== 'string' || search.length > 100) {
        sendError(res, 400, 'Search must be a string no longer than 100 characters');
        return null;
    }

    if (typeof status !== 'string' || status.length > 20) {
        sendError(res, 400, 'Status must be a string no longer than 20 characters');
        return null;
    }

    const offset = (Number(pageParam) - 1) * Number(limitParam);
    if (!Number.isSafeInteger(offset)) {
        sendError(res, 400, 'Page is too large');
        return null;
    }

    return {
        page: Number(pageParam),
        limit: Number(limitParam),
        offset,
        search: search.trim(),
        status: status.trim()
    };
};

const sendAdminList = (res, rows, total, options) => {
    res.json({
        data: rows,
        pagination: {
            page: options.page,
            limit: options.limit,
            total,
            total_pages: Math.ceil(total / options.limit)
        }
    });
};

/**
 * GET /admin/stats
 * Get system statistics.
 * Requires X-Admin-Key header matching ADMIN_API_KEY in .env
 */
app.get('/admin/stats', ...adminGuard, async (req, res) => {
    try {
        const [usersResult, transactionsResult, activeResult] = await Promise.all([
            pool.query(
                `SELECT COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE
                                          AND created_at < CURRENT_DATE + INTERVAL '1 day') AS today
                 FROM users`
            ),
            pool.query(
                `SELECT COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE status = 'success') AS successful,
                        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                        COUNT(*) FILTER (WHERE status = 'success'
                                          AND created_at >= CURRENT_DATE
                                          AND created_at < CURRENT_DATE + INTERVAL '1 day') AS today_count,
                        COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0) AS revenue,
                        COALESCE(SUM(amount) FILTER (
                            WHERE status = 'success'
                              AND created_at >= CURRENT_DATE
                              AND created_at < CURRENT_DATE + INTERVAL '1 day'
                        ), 0) AS today_revenue
                 FROM transactions`
            ),
            pool.query(`SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'`)
        ]);

        const users = usersResult.rows[0];
        const transactions = transactionsResult.rows[0];
        res.json({
            total_users: parseInt(users.total, 10),
            new_users_today: parseInt(users.today, 10),
            total_transactions: parseInt(transactions.total, 10),
            successful_transactions: parseInt(transactions.successful, 10),
            pending_transactions: parseInt(transactions.pending, 10),
            failed_transactions: parseInt(transactions.failed, 10),
            total_revenue: transactions.revenue,
            today_transactions: parseInt(transactions.today_count, 10),
            today_revenue: transactions.today_revenue,
            active_sessions: parseInt(activeResult.rows[0].count, 10)
        });
    } catch (error) {
        log.error({ err: error }, '❌ Stats Error:');
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * GET /admin/analytics?days=30
 * Returns daily successful revenue/transaction totals and new user counts.
 */
app.get('/admin/analytics', ...adminGuard, async (req, res) => {
    const daysParam = req.query.days === undefined ? '30' : req.query.days;
    if (typeof daysParam !== 'string' || !/^\d+$/.test(daysParam) ||
        !Number.isInteger(Number(daysParam)) || Number(daysParam) < 1 || Number(daysParam) > 90) {
        return sendError(res, 400, 'Days must be an integer between 1 and 90');
    }
    const days = Number(daysParam);

    try {
        const result = await pool.query(
            `WITH date_range AS (
                 SELECT generate_series(
                     CURRENT_DATE - ($1::int - 1),
                     CURRENT_DATE,
                     INTERVAL '1 day'
                 )::date AS day
             ),
             daily_transactions AS (
                 SELECT created_at::date AS day, COUNT(*) AS transactions, SUM(amount) AS revenue
                 FROM transactions
                 WHERE status = 'success'
                   AND created_at >= CURRENT_DATE - ($1::int - 1)
                   AND created_at < CURRENT_DATE + INTERVAL '1 day'
                 GROUP BY created_at::date
             ),
             daily_users AS (
                 SELECT created_at::date AS day, COUNT(*) AS new_users
                 FROM users
                 WHERE created_at >= CURRENT_DATE - ($1::int - 1)
                   AND created_at < CURRENT_DATE + INTERVAL '1 day'
                 GROUP BY created_at::date
             )
             SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS date,
                    COALESCE(t.revenue, 0) AS revenue,
                    COALESCE(t.transactions, 0)::int AS transactions,
                    COALESCE(u.new_users, 0)::int AS new_users
             FROM date_range d
             LEFT JOIN daily_transactions t ON t.day = d.day
             LEFT JOIN daily_users u ON u.day = d.day
             ORDER BY d.day`,
            [days]
        );

        res.json({ days, data: result.rows });
    } catch (error) {
        log.error({ err: error }, '❌ Admin Analytics Error:');
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * GET /admin/users?search=&status=&page=1&limit=25
 */
app.get('/admin/users', ...adminGuard, async (req, res) => {
    const options = getAdminListOptions(req, res);
    if (!options) return;

    const conditions = [];
    const values = [];
    if (options.status) {
        values.push(options.status);
        conditions.push(`status = $${values.length}`);
    }
    if (options.search) {
        values.push(`%${options.search}%`);
        conditions.push(`phone_number ILIKE $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const countValues = [...values];
        const listValues = [...values, options.limit, options.offset];
        const [countResult, usersResult] = await Promise.all([
            pool.query(`SELECT COUNT(*) AS count FROM users ${where}`, countValues),
            pool.query(
                `SELECT id, phone_number, account_balance, status, created_at
                 FROM users ${where}
                 ORDER BY created_at DESC, id DESC
                 LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
                listValues
            )
        ]);

        sendAdminList(res, usersResult.rows, parseInt(countResult.rows[0].count, 10), options);
    } catch (error) {
        log.error({ err: error }, '❌ Admin Users Error:');
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * GET /admin/sessions?search=&status=&page=1&limit=25
 * Deliberately excludes Mikrotik passwords and session keys.
 */
app.get('/admin/sessions', ...adminGuard, async (req, res) => {
    const options = getAdminListOptions(req, res);
    if (!options) return;

    const conditions = [];
    const values = [];
    if (options.status) {
        values.push(options.status);
        conditions.push(`s.status = $${values.length}`);
    }
    if (options.search) {
        values.push(`%${options.search}%`);
        conditions.push(`(u.phone_number ILIKE $${values.length} OR s.mikrotik_username ILIKE $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const listValues = [...values, options.limit, options.offset];
        const [countResult, sessionsResult] = await Promise.all([
            pool.query(
                `SELECT COUNT(*) AS count
                 FROM sessions s JOIN users u ON u.id = s.user_id ${where}`,
                values
            ),
            pool.query(
                `SELECT s.id, s.user_id, u.phone_number, s.mikrotik_username,
                        s.ip_address, s.start_time,
                        s.start_time + (s.duration_hours * INTERVAL '1 hour') AS expiry,
                        s.duration_hours, s.cost_amount, s.status
                 FROM sessions s JOIN users u ON u.id = s.user_id ${where}
                 ORDER BY s.start_time DESC, s.id DESC
                 LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
                listValues
            )
        ]);

        sendAdminList(res, sessionsResult.rows, parseInt(countResult.rows[0].count, 10), options);
    } catch (error) {
        log.error({ err: error }, '❌ Admin Sessions Error:');
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * GET /admin/transactions?search=&status=&page=1&limit=25
 */
app.get('/admin/transactions', ...adminGuard, async (req, res) => {
    const options = getAdminListOptions(req, res);
    if (!options) return;

    const conditions = [];
    const values = [];
    if (options.status) {
        values.push(options.status);
        conditions.push(`t.status = $${values.length}`);
    }
    if (options.search) {
        values.push(`%${options.search}%`);
        conditions.push(
            `(u.phone_number ILIKE $${values.length} OR t.mpesa_ref ILIKE $${values.length} OR t.checkout_request_id ILIKE $${values.length})`
        );
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const listValues = [...values, options.limit, options.offset];
        const [countResult, transactionsResult] = await Promise.all([
            pool.query(
                `SELECT COUNT(*) AS count
                 FROM transactions t JOIN users u ON u.id = t.user_id ${where}`,
                values
            ),
            pool.query(
                `SELECT t.id, t.user_id, u.phone_number, t.mpesa_ref,
                        t.checkout_request_id, t.amount, t.status,
                        t.package_id, p.description AS package_description, t.created_at
                 FROM transactions t
                 JOIN users u ON u.id = t.user_id
                 LEFT JOIN pricing p ON p.id = t.package_id ${where}
                 ORDER BY t.created_at DESC, t.id DESC
                 LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
                listValues
            )
        ]);

        sendAdminList(res, transactionsResult.rows, parseInt(countResult.rows[0].count, 10), options);
    } catch (error) {
        log.error({ err: error }, '❌ Admin Transactions Error');
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * GET /admin/packages
 * Lists all packages (including inactive) with lifetime sales and revenue.
 */
app.get('/admin/packages', ...adminGuard, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.id, p.hours, p.price, p.description, p.is_active,
                    COUNT(t.id) FILTER (WHERE t.status = 'success')::int AS sales,
                    COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'success'), 0) AS revenue
             FROM pricing p
             LEFT JOIN transactions t ON t.package_id = p.id
             GROUP BY p.id
             ORDER BY p.hours ASC`
        );
        res.json({ data: result.rows });
    } catch (error) {
        log.error({ err: error }, '❌ Admin Packages Error');
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * Validates the request body for package create/update.
 * Returns an error message string, or null if valid.
 */
const validatePackageInput = (body, { partial = false } = {}) => {
    const checks = [];

    if (!partial || body.hours !== undefined) {
        const hours = Number(body.hours);
        if (!Number.isInteger(hours) || hours < 1 || hours > 8760) {
            checks.push('Hours must be an integer between 1 and 8760');
        }
    }

    if (!partial || body.price !== undefined) {
        const price = Number(body.price);
        if (!Number.isFinite(price) || price < 1 || price > 1_000_000) {
            checks.push('Price must be a number between 1 and 1,000,000');
        }
    }

    if (!partial || body.description !== undefined) {
        if (typeof body.description !== 'string' || !body.description.trim() || body.description.trim().length > 100) {
            checks.push('Description is required (max 100 characters)');
        }
    }

    return checks.length ? checks.join('; ') : null;
};

/**
 * POST /admin/packages
 * Creates a new WiFi package. Body: { hours, price, description }
 */
app.post('/admin/packages', ...adminGuard, async (req, res) => {
    const { hours, price, description } = req.body || {};

    const validationError = validatePackageInput({ hours, price, description });
    if (validationError) {
        return sendError(res, 400, validationError);
    }

    try {
        const result = await pool.query(
            `INSERT INTO pricing (hours, price, description)
             VALUES ($1, $2, $3)
             RETURNING id, hours, price, description, is_active`,
            [Number(hours), Number(price), description.trim()]
        );
        log.info({ packageId: result.rows[0].id }, '✅ Package created');
        res.status(201).json({ success: true, package: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return sendError(res, 409, 'A package with this duration (hours) already exists');
        }
        log.error({ err: error }, '❌ Admin Package Create Error');
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * PUT /admin/packages/:id
 * Updates hours, price, description and/or is_active.
 * Body: any subset of { hours, price, description, is_active }
 */
app.put('/admin/packages/:id', ...adminGuard, async (req, res) => {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
        return sendError(res, 400, 'Invalid package ID');
    }

    const body = req.body || {};
    const allowedFields = ['hours', 'price', 'description', 'is_active'];
    const updates = allowedFields.filter((field) => body[field] !== undefined);

    if (updates.length === 0) {
        return sendError(res, 400, 'Provide at least one of: hours, price, description, is_active');
    }

    if (body.is_active !== undefined && typeof body.is_active !== 'boolean') {
        return sendError(res, 400, 'is_active must be a boolean');
    }

    const validationError = validatePackageInput(body, { partial: true });
    if (validationError) {
        return sendError(res, 400, validationError);
    }

    try {
        const setClauses = updates.map((field, index) => `${field} = $${index + 1}`);
        const values = updates.map((field) => (
            field === 'description' ? String(body[field]).trim() : body[field]
        ));
        values.push(id);

        const result = await pool.query(
            `UPDATE pricing SET ${setClauses.join(', ')} WHERE id = $${values.length}
             RETURNING id, hours, price, description, is_active`,
            values
        );

        if (result.rows.length === 0) {
            return sendError(res, 404, 'Package not found');
        }

        log.info({ packageId: id, updates }, '✅ Package updated');
        res.json({ success: true, package: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return sendError(res, 409, 'A package with this duration (hours) already exists');
        }
        log.error({ err: error }, '❌ Admin Package Update Error');
        return sendError(res, 500, 'Server error', error);
    }
});

/**
 * DELETE /admin/packages/:id
 * Soft-deletes a package (sets is_active = FALSE). Historical
 * transactions keep their reference; /api/pricing stops listing it.
 */
app.delete('/admin/packages/:id', ...adminGuard, async (req, res) => {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
        return sendError(res, 400, 'Invalid package ID');
    }

    try {
        const result = await pool.query(
            `UPDATE pricing SET is_active = FALSE WHERE id = $1 RETURNING id`,
            [id]
        );

        if (result.rows.length === 0) {
            return sendError(res, 404, 'Package not found');
        }

        log.info({ packageId: id }, '✅ Package disabled');
        res.json({ success: true, id: Number(id), is_active: false });
    } catch (error) {
        log.error({ err: error }, '❌ Admin Package Delete Error');
        return sendError(res, 500, 'Server error', error);
    }
});

// ============ HEALTH CHECK ============

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'OK',
            database: 'connected',
            timestamp: new Date(),
            env: process.env.MPESA_ENV || 'sandbox'
        });
    } catch (err) {
        log.error({ err: err.message }, '❌ Health check failed:');
        res.status(503).json({
            status: 'ERROR',
            database: 'unreachable',
            timestamp: new Date()
        });
    }
});

// ============ GLOBAL ERROR HANDLER ============

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    log.error({ err: err }, '❌ Unhandled Error:');
    return sendError(res, 500, 'Internal server error', err);
});

// ============ CRON JOBS ============

/**
 * Runs every minute.
 * Marks sessions as 'expired' when their duration has elapsed,
 * then removes the corresponding user from the Mikrotik router.
 */
async function expireSessions() {
    try {
        const expired = await pool.query(
            `UPDATE sessions
             SET status = 'expired', end_time = NOW()
             WHERE status = 'active'
               AND start_time + (duration_hours * interval '1 hour') < NOW()
             RETURNING id, mikrotik_username`
        );

        if (expired.rowCount > 0) {
            log.info({ count: expired.rowCount }, '⏰ Expiring sessions');
            for (const session of expired.rows) {
                if (session.mikrotik_username) {
                    try {
                        await mikrotik.removeUser(session.mikrotik_username);
                        log.info({ username: session.mikrotik_username }, '   ✅ Removed Mikrotik user');
                    } catch (err) {
                        log.error({ err: err.message, username: session.mikrotik_username }, '   ❌ Failed to remove Mikrotik user');
                    }
                }
            }
        }
    } catch (error) {
        log.error({ err: error.message }, '❌ Session expiry cron error');
    }
}

/**
 * Runs every minute.
 * Sends an SMS ~30 minutes before an active session expires.
 * Each session is reminded at most once (expiry_reminder_sent flag).
 */
async function sendExpiryReminders() {
    if (!sms.enabled) return;
    try {
        const expiring = await pool.query(
            `SELECT s.id, u.phone_number
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.status = 'active'
               AND s.expiry_reminder_sent = FALSE
               AND s.start_time + (s.duration_hours * interval '1 hour') BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'`
        );

        for (const row of expiring.rows) {
            const sent = await sms.send(
                row.phone_number,
                'Your WiFi session expires in about 30 minutes. Top up or buy a new package to stay connected.'
            );
            if (sent) {
                await pool.query(`UPDATE sessions SET expiry_reminder_sent = TRUE WHERE id = $1`, [row.id]);
            }
        }
    } catch (error) {
        log.error({ err: error.message }, '❌ Expiry reminder cron error');
    }
}

/**
 * Runs every 5 minutes.
 * Retries Mikrotik provisioning for active sessions whose router user
 * creation failed earlier (SSH down, router reboot, etc.), so customers
 * are not left with paid-but-unusable credentials.
 * Only recent sessions (last 24h) are retried.
 */
async function reconcileUnprovisionedSessions() {
    try {
        const pending = await pool.query(
            `SELECT s.id, s.mikrotik_username, s.mikrotik_password
             FROM sessions s
             WHERE s.status = 'active'
               AND s.router_provisioned = FALSE
               AND s.start_time > NOW() - INTERVAL '24 hours'`
        );

        if (pending.rowCount === 0) return;

        log.info({ count: pending.rowCount }, '🔧 Reconciling unprovisioned sessions');
        for (const session of pending.rows) {
            const password = decryptSecret(session.mikrotik_password);
            if (!session.mikrotik_username || !password) {
                log.error({ sessionId: session.id }, '   ❌ Cannot reconcile — missing credentials');
                continue;
            }
            try {
                // The router may already hold the user from a partially
                // successful attempt — clear it first, ignore errors.
                await mikrotik.removeUser(session.mikrotik_username).catch(() => {});
                await mikrotik.addUser(session.mikrotik_username, password);
                await pool.query(`UPDATE sessions SET router_provisioned = TRUE WHERE id = $1`, [session.id]);
                log.info({ username: session.mikrotik_username }, '   ✅ Router user reconciled');
            } catch (err) {
                log.error({ err: err.message, username: session.mikrotik_username }, '   ❌ Reconciliation attempt failed — will retry');
            }
        }
    } catch (error) {
        log.error({ err: error.message }, '❌ Reconciliation cron error');
    }
}

// ============ START SERVER ============

if (require.main === module) {
    const cronTasks = [
        cron.schedule('* * * * *', expireSessions),
        cron.schedule('* * * * *', sendExpiryReminders),
        cron.schedule('*/5 * * * *', reconcileUnprovisionedSessions)
    ];

    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
        log.info(`
╔════════════════════════════════════════╗
║   WiFi Hotspot Backend Server         ║
║   Environment: ${(process.env.MPESA_ENV || 'sandbox').padEnd(22)}║
║   Port: ${String(PORT).padEnd(30)}║
╚════════════════════════════════════════╝`);
        log.info('📡 Server ready for WiFi hotspot operations');
        log.info(`🌍 Portal:    http://localhost:${PORT}`);
        log.info(`💰 M-Pesa:    ${process.env.MPESA_ENV || 'sandbox'}${mpesaService.mock ? ' (MOCKED)' : ''}`);
        log.info('⏰ Crons: session expiry + reminders every minute, reconciliation every 5 minutes');
    });

    // Graceful shutdown: stop crons, stop accepting new requests, drain
    // in-flight ones, then close the DB pool. A hard timeout force-exits
    // in case keep-alive sockets never drain.
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info({ signal }, '⛔ Shutting down — stopping cron tasks and closing server');
        cronTasks.forEach((task) => {
            try { task?.stop?.(); } catch { /* already stopped */ }
        });

        server.close(() => {
            log.info('HTTP server closed');
            pool.end().finally(() => process.exit(0));
        });

        setTimeout(() => {
            log.warn('Shutdown timeout reached — forcing exit');
            pool.end().catch(() => {}).finally(() => process.exit(0));
        }, 10_000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
} else {
    // Required as a module (test suite): export the app without
    // starting the listener or cron jobs.
    module.exports = app;
    module.exports._internal = {
        isValidPhone,
        isIpAllowed,
        matchesCidr,
        encryptSecret,
        decryptSecret,
        mpesaService
    };
}
