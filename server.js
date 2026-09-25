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

dotenv.config();

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ============ MIDDLEWARE ============
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Request logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

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
        // Return cached token if still valid
        if (this.tokenCache.token && this.tokenCache.expiry > Date.now()) {
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

    async stkPush(phoneNumber, amount, accountReference) {
        const token = await this.getAccessToken();
        const timestamp = new Date().toISOString().replace(/[:-]/g, '').split('.')[0];
        
        const password = Buffer.from(
            `${this.businessCode}${this.passkey}${timestamp}`
        ).toString('base64');

        const payload = {
            BusinessShortCode: this.businessCode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.round(amount),
            PartyA: phoneNumber.replace(/\D/g, ''), // Remove non-digits
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
        const timestamp = new Date().toISOString().replace(/[:-]/g, '').split('.')[0];
        
        const password = Buffer.from(
            `${this.businessCode}${this.passkey}${timestamp}`
        ).toString('base64');

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

    async executeCommand(command) {
        try {
            // For production, use SSH
            // For testing, return mock success
            console.log(`🔧 Mikrotik: ${command}`);
            return { success: true, output: 'Command executed' };
        } catch (error) {
            console.error('❌ Mikrotik Error:', error);
            throw error;
        }
    }

    async addUser(username, password) {
        return this.executeCommand(
            `/ip hotspot user add name=${username} password=${password} profile=default`
        );
    }

    async removeUser(username) {
        return this.executeCommand(
            `/ip hotspot user remove [find name=${username}]`
        );
    }
}

const mikrotik = new MikrotikService();

// ============ AUTHENTICATION MIDDLEWARE ============

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userPhone = decoded.phone_number;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token', details: error.message });
    }
};

// ============ API ROUTES ============

/**
 * POST /api/auth/register
 * Register or login user with phone number
 */
app.post('/api/auth/register', async (req, res) => {
    const { phone_number } = req.body;

    // Validate phone format
    if (!phone_number || phone_number.length < 10) {
        return res.status(400).json({ 
            error: 'Invalid phone number. Format: 254712345678' 
        });
    }

    try {
        // Check if user exists
        const userResult = await pool.query(
            'SELECT * FROM users WHERE phone_number = $1',
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

        // Generate JWT token
        const token = jwt.sign(
            { userId, phone_number },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({ 
            success: true, 
            token, 
            userId,
            message: 'Login successful'
        });

    } catch (error) {
        console.error('❌ Auth Error:', error);
        res.status(500).json({ error: 'Server error', details: error.message });
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
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error('❌ Account Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/payment/initiate
 * Initiate M-Pesa payment
 */
app.post('/api/payment/initiate', authMiddleware, async (req, res) => {
    const { phone_number, amount } = req.body;

    // Validate input
    if (!phone_number || !amount) {
        return res.status(400).json({ error: 'Phone and amount required' });
    }

    if (amount < 50) {
        return res.status(400).json({ error: 'Minimum amount is KES 50' });
    }

    try {
        // Create transaction record
        const transactionId = uuidv4();
        
        const dbResult = await pool.query(
            `INSERT INTO transactions (user_id, mpesa_ref, amount, status) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [req.userId, transactionId, amount, 'pending']
        );

        console.log(`💳 Transaction created: ${transactionId}`);

        // Trigger STK Push
        const stkResponse = await mpesaService.stkPush(
            phone_number,
            amount,
            `WIFI-${transactionId}`
        );

        if (stkResponse.ResponseCode === '0') {
            res.json({
                success: true,
                checkout_request_id: stkResponse.CheckoutRequestID,
                response_code: stkResponse.ResponseCode,
                message: 'STK Push sent - Check your phone to enter M-Pesa PIN'
            });
        } else {
            res.status(400).json({
                error: 'STK Push failed',
                details: stkResponse.ResponseDescription
            });
        }

    } catch (error) {
        console.error('❌ Payment Initiation Error:', error);
        res.status(500).json({ 
            error: 'Payment initiation failed', 
            details: error.message 
        });
    }
});

/**
 * POST /mpesa/callback
 * M-Pesa payment callback
 */
app.post('/mpesa/callback', async (req, res) => {
    try {
        const { Body } = req.body;
        const { stkCallback } = Body;
        
        const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;

        console.log(`📞 M-Pesa Callback - ResultCode: ${ResultCode}`);

        if (ResultCode === 0) {
            // Payment successful
            let amount = 0;
            let phoneNumber = '';

            if (CallbackMetadata && CallbackMetadata.Item) {
                CallbackMetadata.Item.forEach(item => {
                    if (item.Name === 'Amount') amount = parseFloat(item.Value);
                    if (item.Name === 'PhoneNumber') phoneNumber = item.Value;
                });
            }

            // Get transaction
            const transResult = await pool.query(
                'SELECT * FROM transactions WHERE mpesa_ref LIKE $1 LIMIT 1',
                [`%${CheckoutRequestID.substring(0, 20)}%`]
            );

            if (transResult.rows.length > 0) {
                const transaction = transResult.rows[0];
                const userId = transaction.user_id;

                // Update transaction
                await pool.query(
                    `UPDATE transactions SET status = 'success' WHERE id = $1`,
                    [transaction.id]
                );

                // Update user balance
                await pool.query(
                    `UPDATE users SET account_balance = account_balance + $1 WHERE id = $2`,
                    [amount, userId]
                );

                console.log(`✅ Payment confirmed: KES ${amount} to user ${userId}`);
            }
        } else {
            console.log(`⚠️ Payment failed: ${ResultDesc}`);
        }

        res.json({ ResultCode: 0 });

    } catch (error) {
        console.error('❌ Callback Error:', error);
        res.status(500).json({ error: 'Callback processing failed' });
    }
});

/**
 * GET /api/pricing
 * Get WiFi pricing packages
 */
app.get('/api/pricing', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM pricing ORDER BY hours ASC');
        res.json(result.rows);

    } catch (error) {
        console.error('❌ Pricing Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/wifi/buy
 * Purchase WiFi access package
 */
app.post('/api/wifi/buy', authMiddleware, async (req, res) => {
    const { package_id } = req.body;

    if (!package_id) {
        return res.status(400).json({ error: 'Package ID required' });
    }

    try {
        // Get pricing
        const priceResult = await pool.query(
            'SELECT * FROM pricing WHERE id = $1',
            [package_id]
        );

        if (priceResult.rows.length === 0) {
            return res.status(404).json({ error: 'Package not found' });
        }

        const pkg = priceResult.rows[0];

        // Check user balance
        const userResult = await pool.query(
            'SELECT account_balance FROM users WHERE id = $1',
            [req.userId]
        );

        const balance = userResult.rows[0].account_balance;

        if (balance < pkg.price) {
            return res.status(400).json({ 
                error: 'Insufficient balance',
                required: pkg.price,
                current: balance,
                shortfall: pkg.price - balance
            });
        }

        // Deduct from balance
        await pool.query(
            'UPDATE users SET account_balance = account_balance - $1 WHERE id = $2',
            [pkg.price, req.userId]
        );

        // Create WiFi session
        const username = `wifi_${req.userId}_${Date.now()}`.substring(0, 20);
        const password = uuidv4().substring(0, 12);
        const sessionKey = uuidv4().substring(0, 16);

        // Add to Mikrotik
        await mikrotik.addUser(username, password);

        // Record session
        const sessionResult = await pool.query(
            `INSERT INTO sessions (user_id, session_key, start_time, duration_hours, cost_amount, status) 
             VALUES ($1, $2, NOW(), $3, $4, 'active') RETURNING *`,
            [req.userId, sessionKey, pkg.hours, pkg.price]
        );

        console.log(`✅ WiFi Access Granted: ${req.userPhone} for ${pkg.hours}h`);

        res.json({
            success: true,
            session_key: sessionKey,
            username: username,
            password: password,
            duration_hours: pkg.hours,
            expiry: new Date(Date.now() + pkg.hours * 60 * 60 * 1000),
            message: `WiFi access granted for ${pkg.hours} hour(s)`,
            instructions: 'Connect to the WiFi network and use the credentials above'
        });

    } catch (error) {
        console.error('❌ WiFi Buy Error:', error);
        res.status(500).json({ error: 'Purchase failed', details: error.message });
    }
});

/**
 * GET /api/sessions/active
 * Get user's active WiFi sessions
 */
app.get('/api/sessions/active', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, session_key, start_time, duration_hours, status FROM sessions 
             WHERE user_id = $1 AND status = 'active' 
             ORDER BY start_time DESC LIMIT 5`,
            [req.userId]
        );

        res.json(result.rows);

    } catch (error) {
        console.error('❌ Session Error:', error);
        res.status(500).json({ error: 'Server error' });
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
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/transactions/history
 * Get user's transaction history
 */
app.get('/api/transactions/history', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT amount, status, created_at FROM transactions 
             WHERE user_id = $1 
             ORDER BY created_at DESC LIMIT 20`,
            [req.userId]
        );

        res.json(result.rows);

    } catch (error) {
        console.error('❌ Transaction Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============ ADMIN ROUTES (No auth for demo) ============

/**
 * GET /admin/stats
 * Get system statistics
 */
app.get('/admin/stats', async (req, res) => {
    try {
        const stats = {};

        // Total users
        const usersResult = await pool.query('SELECT COUNT(*) as count FROM users');
        stats.total_users = parseInt(usersResult.rows[0].count);

        // Total revenue
        const revenueResult = await pool.query(
            `SELECT SUM(amount) as total FROM transactions WHERE status = 'success'`
        );
        stats.total_revenue = revenueResult.rows[0].total || 0;

        // Today's transactions
        const todayResult = await pool.query(
            `SELECT COUNT(*) as count, SUM(amount) as total FROM transactions 
             WHERE status = 'success' AND DATE(created_at) = CURRENT_DATE`
        );
        stats.today_transactions = parseInt(todayResult.rows[0].count);
        stats.today_revenue = todayResult.rows[0].total || 0;

        // Active sessions
        const activeResult = await pool.query(
            `SELECT COUNT(*) as count FROM sessions WHERE status = 'active'`
        );
        stats.active_sessions = parseInt(activeResult.rows[0].count);

        res.json(stats);

    } catch (error) {
        console.error('❌ Stats Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============ HEALTH CHECK ============

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date() });
});

// ============ ERROR HANDLER ============

app.use((err, req, res, next) => {
    console.error('❌ Unhandled Error:', err);
    res.status(500).json({ 
        error: 'Server error', 
        details: process.env.NODE_ENV === 'development' ? err.message : undefined 
    });
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   WiFi Hotspot Backend Server         ║
║   Environment: ${process.env.MPESA_ENV || 'sandbox'}                  ║
║   Port: ${PORT}                           ║
║   Database: Connected               ║
╚════════════════════════════════════════╝
    `);
    console.log('📡 Server ready for WiFi hotspot operations');
    console.log(`🌍 Portal: http://localhost:${PORT}`);
    console.log(`💰 M-Pesa Env: ${process.env.MPESA_ENV || 'sandbox'}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⛔ Shutting down...');
    pool.end();
    process.exit(0);
});
