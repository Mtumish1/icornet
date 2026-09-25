# WiFi Hotspot System Design with M-Pesa Integration
## Haplite Mikrotik + Pay-Per-Hour Model

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    WiFi Users                            │
└──────────────┬──────────────────────────────────────────┘
               │ (Connect to SSID)
               ▼
┌─────────────────────────────────────────────────────────┐
│         Haplite Mikrotik Access Point                    │
│  ├─ Radius Authentication                               │
│  ├─ User Session Management                             │
│  └─ Traffic Bandwidth Control                           │
└──────────────┬──────────────────────────────────────────┘
               │ (API Calls)
               ▼
┌─────────────────────────────────────────────────────────┐
│         Hotspot Portal Server (Your Backend)            │
│  ├─ User Management Database                            │
│  ├─ M-Pesa Payment Gateway                              │
│  ├─ Session Tracking & Billing                          │
│  └─ Access Control Logic                                │
└──────────────┬──────────────────────────────────────────┘
               │
      ┌────────┴────────┐
      ▼                 ▼
   M-Pesa API      Local Database
  (Payments)    (Users, Sessions, Logs)
```

---

## 1. HARDWARE & MIKROTIK SETUP

### Initial Mikrotik Configuration

```mikrotik
# Access the Mikrotik via Winbox or SSH
# Default: admin / no password

# 1. Set up wireless interface
/interface wireless
add name=wlan1 ssid="YourWiFiName" frequency=2400 band=2ghz-b/g/n mode=ap-bridge
set wlan1 security-profile=default

# 2. Create bridge for hotspot
/interface bridge
add name=bridge-local
/interface bridge port
add interface=ether2 bridge=bridge-local
add interface=wlan1 bridge=bridge-local

# 3. IP Address Configuration
/ip address
add address=192.168.1.1/24 interface=bridge-local

# 4. Enable DHCP Server
/ip pool
add name=dhcp_pool ranges=192.168.1.100-192.168.1.200

/ip dhcp-server
add address-pool=dhcp_pool interface=bridge-local disabled=no

/ip dhcp-server network
add address=192.168.1.0/24 gateway=192.168.1.1 dns-server=8.8.8.8,8.8.4.4

# 5. Set up Hotspot (Built-in Mikrotik feature)
/ip hotspot profile
add name=hsprof1 idle-timeout=0s

/ip hotspot
add address-pool=dhcp_pool interface=bridge-local name=myhspot profile=hsprof1

# 6. Create Admin User
/ip hotspot user
add name=admin password=strongpassword123 profile=default
```

### Alternative: Radius-Based Authentication (Recommended for Production)

```mikrotik
# Configure Radius for external authentication
/radius
add service=hotspot address=YOUR_SERVER_IP secret=radiussecret123 timeout=3s

/ip hotspot
set myhspot authentication=radius radius-called-id-type=interface
```

---

## 2. PAYMENT FLOW (M-Pesa Integration)

### M-Pesa Setup Requirements

1. **Register with Safaricom** - Get Shortcode and Consumer Key/Secret
2. **Get SSL Certificate** - M-Pesa requires HTTPS
3. **Obtain API Credentials:**
   - Consumer Key
   - Consumer Secret
   - Business Shortcode
   - Passkey (for online queries)

### Payment Process Flow

```
Customer → Portal → Check Balance → M-Pesa STK Push
                        ↓
                    [Customer Enters PIN]
                        ↓
                   Payment Confirmed
                        ↓
        Grant WiFi Access for 1 Hour
```

---

## 3. BACKEND IMPLEMENTATION

### Recommended Tech Stack

- **Backend:** Node.js + Express.js (or Python Flask)
- **Database:** PostgreSQL/MySQL
- **M-Pesa Integration:** Lipisha, Daraja (Official), or Jambopay
- **Hosting:** AWS, Digital Ocean, or local VPS

### Database Schema

```sql
-- Users Table
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    account_balance DECIMAL(10,2) DEFAULT 0,
    status ENUM('active', 'suspended') DEFAULT 'active'
);

-- Sessions Table (WiFi Access)
CREATE TABLE sessions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    session_key VARCHAR(100) UNIQUE,
    mac_address VARCHAR(17),
    ip_address VARCHAR(15),
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP,
    duration_hours INT,
    cost_amount DECIMAL(10,2),
    status ENUM('active', 'expired', 'completed') DEFAULT 'active',
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Transactions Table
CREATE TABLE transactions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    mpesa_ref VARCHAR(50) UNIQUE,
    amount DECIMAL(10,2),
    transaction_type ENUM('payment', 'refund'),
    status ENUM('success', 'pending', 'failed') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Pricing Table
CREATE TABLE pricing (
    id INT PRIMARY KEY AUTO_INCREMENT,
    hours INT,
    price DECIMAL(10,2),
    description VARCHAR(100)
);

-- Insert default pricing
INSERT INTO pricing (hours, price, description) VALUES
(1, 50, '1 Hour'),
(3, 120, '3 Hours'),
(24, 300, '1 Day'),
(7, 1500, '1 Week');
```

---

## 4. NODE.JS BACKEND CODE

### Installation & Setup

```bash
npm init -y
npm install express dotenv axios pg bcrypt jsonwebtoken cors body-parser uuid
npm install --save-dev nodemon
```

### .env File
```
PORT=3000
MPESA_CONSUMER_KEY=your_key_here
MPESA_CONSUMER_SECRET=your_secret_here
MPESA_BUSINESS_SHORTCODE=123456
MPESA_PASSKEY=your_passkey_here
MPESA_ENV=sandbox  # or production
DATABASE_URL=postgresql://user:password@localhost:5432/hotspot_db
JWT_SECRET=your_jwt_secret_key
MIKROTIK_HOST=192.168.1.1
MIKROTIK_USER=admin
MIKROTIK_PASS=password
```

### Main Server (server.js)

```javascript
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const NodeSSH = require('node-ssh');

dotenv.config();

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ============ M-Pesa Configuration ============

class MPesaService {
    constructor() {
        this.consumerKey = process.env.MPESA_CONSUMER_KEY;
        this.consumerSecret = process.env.MPESA_CONSUMER_SECRET;
        this.businessCode = process.env.MPESA_BUSINESS_SHORTCODE;
        this.passkey = process.env.MPESA_PASSKEY;
        this.environment = process.env.MPESA_ENV || 'sandbox';
    }

    // Get M-Pesa Access Token
    async getAccessToken() {
        const auth = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');
        const url = this.environment === 'sandbox'
            ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
            : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

        try {
            const response = await axios.get(url, {
                headers: { 'Authorization': `Basic ${auth}` }
            });
            return response.data.access_token;
        } catch (error) {
            console.error('M-Pesa Token Error:', error.response?.data || error.message);
            throw error;
        }
    }

    // STK Push (Lipa Na M-Pesa Online)
    async stkPush(phoneNumber, amount, accountReference) {
        const token = await this.getAccessToken();
        const timestamp = new Date().toISOString().replace(/[:-]/g, '').split('.')[0];
        
        const password = Buffer.from(
            `${this.businessCode}${this.passkey}${timestamp}`
        ).toString('base64');

        const url = this.environment === 'sandbox'
            ? 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
            : 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

        try {
            const response = await axios.post(url, {
                BusinessShortCode: this.businessCode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: amount,
                PartyA: phoneNumber,
                PartyB: this.businessCode,
                PhoneNumber: phoneNumber,
                CallBackURL: `${process.env.CALLBACK_URL}/mpesa/callback`,
                AccountReference: accountReference,
                TransactionDesc: 'WiFi Hotspot Payment'
            }, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            return response.data;
        } catch (error) {
            console.error('STK Push Error:', error.response?.data || error.message);
            throw error;
        }
    }

    // Query M-Pesa Transaction Status
    async queryTransaction(checkoutRequestId) {
        const token = await this.getAccessToken();
        const timestamp = new Date().toISOString().replace(/[:-]/g, '').split('.')[0];
        
        const password = Buffer.from(
            `${this.businessCode}${this.passkey}${timestamp}`
        ).toString('base64');

        const url = this.environment === 'sandbox'
            ? 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query'
            : 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query';

        try {
            const response = await axios.post(url, {
                BusinessShortCode: this.businessCode,
                Password: password,
                Timestamp: timestamp,
                CheckoutRequestID: checkoutRequestId
            }, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            return response.data;
        } catch (error) {
            console.error('Query Error:', error.response?.data || error.message);
            throw error;
        }
    }
}

const mpesaService = new MPesaService();

// ============ Mikrotik SSH Control ============

class MikrotikControl {
    constructor() {
        this.ssh = new NodeSSH();
    }

    async connect() {
        await this.ssh.connect({
            host: process.env.MIKROTIK_HOST,
            username: process.env.MIKROTIK_USER,
            password: process.env.MIKROTIK_PASS,
            port: 22
        });
    }

    async addHotspotUser(username, password, duration) {
        await this.connect();
        const command = `/ip hotspot user add name=${username} password=${password} profile=default`;
        await this.ssh.execCommand(command);
        await this.ssh.dispose();
    }

    async removeHotspotUser(username) {
        await this.connect();
        const command = `/ip hotspot user remove [find name=${username}]`;
        await this.ssh.execCommand(command);
        await this.ssh.dispose();
    }

    async getUserSession(username) {
        await this.connect();
        const result = await this.ssh.execCommand(
            `/ip hotspot active print where user=${username}`
        );
        await this.ssh.dispose();
        return result.stdout;
    }
}

const mikrotik = new MikrotikControl();

// ============ Middleware ============

app.use(express.json());
app.use(express.static('public'));

// JWT Authentication Middleware
const authMiddleware = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// ============ API Routes ============

// 1. Register/Login User
app.post('/api/auth/register', async (req, res) => {
    const { phone_number } = req.body;

    if (!phone_number || phone_number.length < 10) {
        return res.status(400).json({ error: 'Valid phone number required' });
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
        } else {
            userId = userResult.rows[0].id;
        }

        // Generate JWT token
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
        console.error('Auth Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 2. Get User Account Info
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
        console.error('Account Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 3. Initiate M-Pesa Payment
app.post('/api/payment/initiate', authMiddleware, async (req, res) => {
    const { phone_number, amount, package_id } = req.body;

    try {
        // Validate amount
        if (!amount || amount < 50) {
            return res.status(400).json({ error: 'Minimum amount is KES 50' });
        }

        // Create transaction record
        const transactionId = uuidv4();
        await pool.query(
            `INSERT INTO transactions (user_id, mpesa_ref, amount, status) 
             VALUES ($1, $2, $3, $4)`,
            [req.userId, transactionId, amount, 'pending']
        );

        // Trigger STK Push
        const stkResponse = await mpesaService.stkPush(
            phone_number,
            amount,
            `HOTSPOT-${transactionId}`
        );

        res.json({
            success: true,
            checkout_request_id: stkResponse.CheckoutRequestID,
            response_code: stkResponse.ResponseCode,
            message: 'STK Push sent to your phone'
        });
    } catch (error) {
        console.error('Payment Initiation Error:', error);
        res.status(500).json({ error: 'Payment initiation failed' });
    }
});

// 4. M-Pesa Callback Handler
app.post('/mpesa/callback', async (req, res) => {
    try {
        const { Body } = req.body;
        const { stkCallback } = Body;
        
        const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;

        if (ResultCode === 0) {
            // Payment successful
            const metadata = CallbackMetadata.Item;
            let amount, phoneNumber;

            metadata.forEach(item => {
                if (item.Name === 'Amount') amount = item.Value;
                if (item.Name === 'PhoneNumber') phoneNumber = item.Value;
            });

            // Get transaction
            const transResult = await pool.query(
                'SELECT * FROM transactions WHERE mpesa_ref LIKE $1',
                [`%${CheckoutRequestID}%`]
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

                // Auto-grant WiFi access if balance sufficient
                await grantWiFiAccess(userId, 1); // 1 hour default
            }
        }

        res.json({ ResultCode: 0 });
    } catch (error) {
        console.error('Callback Error:', error);
        res.status(500).json({ error: 'Callback processing failed' });
    }
});

// 5. Buy WiFi Package
app.post('/api/wifi/buy', authMiddleware, async (req, res) => {
    const { package_id } = req.body;

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
        const price = pkg.price;

        // Check user balance
        const userResult = await pool.query(
            'SELECT account_balance FROM users WHERE id = $1',
            [req.userId]
        );

        const balance = userResult.rows[0].account_balance;

        if (balance < price) {
            return res.status(400).json({ 
                error: 'Insufficient balance',
                required: price,
                current: balance,
                shortfall: price - balance
            });
        }

        // Deduct from balance
        await pool.query(
            'UPDATE users SET account_balance = account_balance - $1 WHERE id = $2',
            [price, req.userId]
        );

        // Grant WiFi access
        const session = await grantWiFiAccess(req.userId, pkg.hours);

        res.json({
            success: true,
            session_key: session.session_key,
            duration_hours: pkg.hours,
            message: `WiFi access granted for ${pkg.hours} hour(s)`
        });
    } catch (error) {
        console.error('WiFi Buy Error:', error);
        res.status(500).json({ error: 'Purchase failed' });
    }
});

// Helper function to grant WiFi access
async function grantWiFiAccess(userId, hours) {
    const username = `user_${userId}_${Date.now()}`;
    const password = uuidv4().substring(0, 12);
    const sessionKey = uuidv4();

    try {
        // Add hotspot user in Mikrotik
        await mikrotik.addHotspotUser(username, password, hours);

        // Record session
        const sessionResult = await pool.query(
            `INSERT INTO sessions (user_id, session_key, start_time, duration_hours, cost_amount, status) 
             VALUES ($1, $2, NOW(), $3, 0, 'active') RETURNING *`,
            [userId, sessionKey, hours]
        );

        return sessionResult.rows[0];
    } catch (error) {
        console.error('WiFi Access Error:', error);
        throw error;
    }
}

// 6. Check Active Sessions
app.get('/api/sessions/active', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM sessions WHERE user_id = $1 AND status = 'active' 
             ORDER BY start_time DESC LIMIT 10`,
            [req.userId]
        );

        res.json(result.rows);
    } catch (error) {
        console.error('Session Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 7. Get Pricing Plans
app.get('/api/pricing', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM pricing');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============ Start Server ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✓ Server running on http://localhost:${PORT}`);
});
```

---

## 5. FRONTEND PORTAL (HTML/JavaScript)

### Portal Page (portal.html)

```html
<!DOCTYPE html>
<html>
<head>
    <title>WiFi Hotspot - M-Pesa Payment Portal</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 15px;
            padding: 40px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        .logo { text-align: center; margin-bottom: 30px; }
        .logo h1 { color: #667eea; font-size: 28px; }
        .logo p { color: #999; font-size: 14px; }
        
        .form-group { margin-bottom: 20px; }
        label { 
            display: block; 
            margin-bottom: 8px; 
            color: #333;
            font-weight: 500;
        }
        input, select {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.3s;
        }
        input:focus, select:focus {
            outline: none;
            border-color: #667eea;
        }

        .info-box {
            background: #f0f4ff;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            border-left: 4px solid #667eea;
        }
        .info-box p { color: #555; font-size: 13px; line-height: 1.5; }

        .packages {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 20px;
        }
        .package {
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            padding: 15px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s;
        }
        .package:hover {
            border-color: #667eea;
            background: #f8f9ff;
        }
        .package.selected {
            border-color: #667eea;
            background: #667eea;
            color: white;
        }
        .package h3 { font-size: 16px; margin-bottom: 5px; }
        .package .price { font-size: 20px; font-weight: bold; }
        .package .duration { font-size: 12px; opacity: 0.8; }

        .btn {
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
        }
        .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(102,126,234,0.4); }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

        .status-message {
            margin-top: 20px;
            padding: 15px;
            border-radius: 8px;
            display: none;
        }
        .status-message.success {
            background: #d4edda;
            color: #155724;
            display: block;
        }
        .status-message.error {
            background: #f8d7da;
            color: #721c24;
            display: block;
        }

        .account-info {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
        }
        .account-info p { margin-bottom: 8px; }
        .balance { 
            font-size: 18px; 
            font-weight: bold; 
            color: #667eea;
            margin-top: 10px;
        }

        @media (max-width: 600px) {
            .container { padding: 20px; }
            .packages { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <h1>📡 WiFi Hotspot</h1>
            <p>Fast & Reliable Internet Access</p>
        </div>

        <div id="accountInfo" class="account-info">
            <p>Phone: <strong id="userPhone">-</strong></p>
            <p>Account Balance: <span class="balance">KES <span id="userBalance">0</span></span></p>
        </div>

        <form id="paymentForm">
            <div class="info-box">
                <p>💡 <strong>Tip:</strong> Select a package or enter a custom amount to top up your account, then purchase WiFi access.</p>
            </div>

            <div class="form-group">
                <label>Select Package:</label>
                <div class="packages" id="packagesContainer"></div>
            </div>

            <div class="form-group">
                <label for="customAmount">Or Enter Custom Amount (KES):</label>
                <input type="number" id="customAmount" placeholder="Minimum 50" min="50" step="10">
            </div>

            <div class="form-group">
                <label for="phoneNumber">Phone Number (Format: 254xxxxxxxxx):</label>
                <input type="tel" id="phoneNumber" placeholder="254712345678" required>
            </div>

            <button type="button" class="btn btn-primary" id="topupBtn">Top Up Account (M-Pesa)</button>
            <button type="button" class="btn btn-primary" style="background: #28a745;" id="buyWifiBtn">Buy WiFi Package</button>

            <div id="statusMessage" class="status-message"></div>
        </form>
    </div>

    <script>
        const API_URL = 'http://localhost:3000/api';
        let authToken = localStorage.getItem('authToken');
        let selectedPackage = null;
        let currentUser = null;

        // Initialize
        document.addEventListener('DOMContentLoaded', async () => {
            if (!authToken) {
                promptLogin();
            } else {
                await loadAccount();
                await loadPricing();
            }
        });

        // Login
        async function promptLogin() {
            const phone = prompt('Enter your phone number (254xxxxxxxxx):');
            if (!phone) return;

            try {
                const response = await fetch(`${API_URL}/auth/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone_number: phone })
                });

                const data = await response.json();
                if (data.success) {
                    authToken = data.token;
                    localStorage.setItem('authToken', authToken);
                    await loadAccount();
                    await loadPricing();
                } else {
                    alert('Login failed: ' + data.error);
                    promptLogin();
                }
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }

        // Load account info
        async function loadAccount() {
            try {
                const response = await fetch(`${API_URL}/user/account`, {
                    headers: { 'Authorization': `Bearer ${authToken}` }
                });

                currentUser = await response.json();
                document.getElementById('userPhone').textContent = currentUser.phone_number;
                document.getElementById('userBalance').textContent = currentUser.account_balance.toFixed(2);
                document.getElementById('phoneNumber').value = currentUser.phone_number;
            } catch (error) {
                console.error('Error loading account:', error);
            }
        }

        // Load pricing packages
        async function loadPricing() {
            try {
                const response = await fetch(`${API_URL}/pricing`);
                const packages = await response.json();

                const container = document.getElementById('packagesContainer');
                container.innerHTML = packages.map(pkg => `
                    <div class="package" onclick="selectPackage(${pkg.id}, ${pkg.price}, this)">
                        <h3>${pkg.hours}h</h3>
                        <div class="price">KES ${pkg.price}</div>
                        <div class="duration">${pkg.description}</div>
                    </div>
                `).join('');
            } catch (error) {
                console.error('Error loading pricing:', error);
            }
        }

        // Select package
        function selectPackage(id, price, element) {
            document.querySelectorAll('.package').forEach(p => p.classList.remove('selected'));
            element.classList.add('selected');
            selectedPackage = { id, price };
            document.getElementById('customAmount').value = '';
        }

        // Top up M-Pesa
        document.getElementById('topupBtn').addEventListener('click', async () => {
            const phone = document.getElementById('phoneNumber').value;
            const amount = selectedPackage ? selectedPackage.price : parseInt(document.getElementById('customAmount').value);

            if (!phone || !amount) {
                showMessage('Please enter phone and amount', 'error');
                return;
            }

            try {
                const response = await fetch(`${API_URL}/payment/initiate`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                    },
                    body: JSON.stringify({ phone_number: phone, amount })
                });

                const data = await response.json();
                showMessage('STK Push sent! Check your phone to complete payment.', 'success');

                // Poll for payment completion
                setTimeout(loadAccount, 3000);
            } catch (error) {
                showMessage('Error: ' + error.message, 'error');
            }
        });

        // Buy WiFi
        document.getElementById('buyWifiBtn').addEventListener('click', async () => {
            if (!selectedPackage) {
                showMessage('Please select a package', 'error');
                return;
            }

            try {
                const response = await fetch(`${API_URL}/wifi/buy`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                    },
                    body: JSON.stringify({ package_id: selectedPackage.id })
                });

                const data = await response.json();
                if (data.success) {
                    showMessage(`✓ WiFi Access Granted!\nUsername: ${data.session_key.substring(0, 8)}\nConnect to the WiFi network and use this code.`, 'success');
                    await loadAccount();
                } else {
                    showMessage(data.error, 'error');
                }
            } catch (error) {
                showMessage('Error: ' + error.message, 'error');
            }
        });

        // Show message
        function showMessage(text, type) {
            const msg = document.getElementById('statusMessage');
            msg.textContent = text;
            msg.className = `status-message ${type}`;
            setTimeout(() => { msg.className = 'status-message'; }, 5000);
        }
    </script>
</body>
</html>
```

---

## 6. SECURITY CONSIDERATIONS

### Critical Security Measures

```
✓ HTTPS/SSL Required
  - Get certificate from Let's Encrypt or Comodo
  - M-Pesa requires HTTPS callbacks

✓ API Security
  - JWT token expiration: 7 days
  - CORS only from approved domains
  - Rate limiting on payment endpoints

✓ Database Security
  - Never store M-Pesa passphrases in code
  - Encrypt sensitive transactions
  - Regular backups

✓ Mikrotik Security
  - Change default admin password
  - Use SSH key instead of password
  - Enable firewall rules
  - Limit admin access to specific IPs

✓ Payment Security
  - Validate all callback signatures
  - Store transaction IDs for reconciliation
  - Log all payment attempts
  - Never expose API keys client-side
```

### Firewall Rules (Mikrotik)

```mikrotik
/ip firewall nat
add chain=srcnat out-interface=ether1 action=masquerade

/ip firewall filter
add chain=forward action=accept connection-state=established,related
add chain=forward in-interface=bridge-local out-interface=ether1 action=accept
add chain=forward action=drop
```

---

## 7. DEPLOYMENT CHECKLIST

- [ ] Mikrotik configured & tested
- [ ] M-Pesa API credentials obtained
- [ ] SSL certificate installed
- [ ] Database created & schemas deployed
- [ ] Node.js backend deployed on VPS
- [ ] Environment variables configured
- [ ] Portal frontend accessible
- [ ] Payment testing in sandbox mode
- [ ] Email notifications configured
- [ ] Monitoring & logging setup

---

## 8. USEFUL COMMANDS

```bash
# Test M-Pesa connectivity
curl -X GET "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials" \
  -H "Authorization: Basic $(echo -n 'key:secret' | base64)"

# Monitor Mikrotik Sessions
ssh admin@192.168.1.1 "/ip hotspot active print"

# Database backups
pg_dump hotspot_db > backup_$(date +%Y%m%d).sql

# View server logs
tail -f /var/log/hotspot-server.log
```

---

## 9. TROUBLESHOOTING

| Problem | Solution |
|---------|----------|
| M-Pesa callback not received | Check firewall allows inbound on callback URL; verify HTTPS working |
| Users can't connect to hotspot | Check DHCP pool range; verify SSID broadcasting; check MAC filters |
| Payment stuck as pending | Manually query M-Pesa API with CheckoutRequestID |
| Mikrotik SSH timeout | Verify SSH port open; check credentials; test connectivity with PuTTY first |
| Database connection errors | Check PostgreSQL running; verify credentials; check network connectivity |

---

## 10. NEXT STEPS

1. **Test in sandbox** before going live
2. **Set up monitoring** - track payments, usage, and uptime
3. **Create admin dashboard** - view sessions, revenue, users
4. **Add SMS notifications** - send WiFi codes via SMS
5. **Analytics** - track peak hours, revenue trends
6. **Scaling** - add more Mikrotik APs as user base grows

---

**Need help with specific part? Let me know!**
