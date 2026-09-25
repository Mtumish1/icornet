# WiFi Hotspot System - Quick Start Guide

## PHASE 1: Mikrotik Setup (30 mins)

### Step 1: Access Your Mikrotik
```bash
# Via SSH
ssh admin@192.168.1.1

# Or via Winbox GUI (download from mikrotik.com)
# IP: 192.168.1.1
# User: admin
# Pass: (default empty)
```

### Step 2: Basic Hotspot Config (Copy-Paste Ready)

```mikrotik
# 1. Reset to defaults (optional - careful!)
/system reset-configuration no-defaults=yes keep-users=yes

# 2. Create hotspot bridge
/interface bridge add name=br-hotspot
/interface bridge port add interface=ether2 bridge=br-hotspot
/interface bridge port add interface=wlan1 bridge=br-hotspot

# 3. IP address
/ip address add address=192.168.100.1/24 interface=br-hotspot

# 4. DHCP
/ip pool add name=hotspot-pool ranges=192.168.100.2-192.168.100.254
/ip dhcp-server add interface=br-hotspot address-pool=hotspot-pool disabled=no
/ip dhcp-server network add address=192.168.100.0/24 gateway=192.168.100.1 dns-server=8.8.8.8

# 5. NAT (for internet access)
/ip firewall nat add chain=srcnat out-interface=ether1 action=masquerade

# 6. WiFi (adjust SSID & frequency)
/interface wireless set wlan1 ssid="MyWiFi" frequency=2400 band=2ghz-b/g/n mode=ap-bridge disabled=no

# 7. Enable hotspot with external authentication
/ip hotspot profile add name=myprofile html-directory=hotspot
/ip hotspot add name=myhspot address-pool=hotspot-pool interface=br-hotspot profile=myprofile authentication=radius

# 8. Set Radius server (replace with YOUR server)
/radius add service=hotspot address=YOUR_SERVER_IP secret=radiussecret123 timeout=3s
```

**Test it:** Connect to WiFi - you should get a login page

---

## PHASE 2: Backend Setup (1 hour)

### Quick Setup on Linux VPS

```bash
# 1. Install dependencies
sudo apt update
sudo apt install nodejs npm postgresql -y

# 2. Create project folder
mkdir hotspot-system && cd hotspot-system

# 3. Initialize Node project
npm init -y
npm install express dotenv axios pg jwt jsonwebtoken cors uuid node-ssh

# 4. Create .env file
cat > .env << EOF
PORT=3000
MPESA_CONSUMER_KEY=your_key_here
MPESA_CONSUMER_SECRET=your_secret_here
MPESA_BUSINESS_SHORTCODE=174379
MPESA_PASSKEY=bfb279f9aa9bdbcf158e97dd1a503b6e
DATABASE_URL=postgresql://hotspot:password123@localhost:5432/hotspot_db
JWT_SECRET=your_super_secret_key_123
CALLBACK_URL=https://yourdomain.com
MIKROTIK_HOST=192.168.1.1
MIKROTIK_USER=admin
MIKROTIK_PASS=yourpass
EOF

# 5. Create database
sudo -u postgres psql << EOF
CREATE DATABASE hotspot_db;
CREATE USER hotspot WITH PASSWORD 'password123';
ALTER ROLE hotspot SET client_encoding TO 'utf8';
ALTER ROLE hotspot SET default_transaction_isolation TO 'read committed';
ALTER ROLE hotspot SET default_transaction_deferrable TO 'off';
ALTER ROLE hotspot SET default_transaction_read_only TO 'off';
ALTER ROLE hotspot SET statement_timeout TO 0;
GRANT ALL PRIVILEGES ON DATABASE hotspot_db TO hotspot;
EOF

# 6. Import database schema
sudo -u postgres psql hotspot_db < schema.sql

# 7. Run server
node server.js
```

### Database Schema (save as `schema.sql`)

```sql
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
```

---

## PHASE 3: M-Pesa Setup

### Get M-Pesa Credentials (Real Steps)

1. **Register** at https://developer.safaricom.co.ke/
2. **Create App**:
   - Go to "My Apps" → "New App"
   - Name: "Hotspot WiFi"
   - Choose "Mpesa"
3. **Get Credentials**:
   - Copy: Consumer Key, Consumer Secret
   - Business Shortcode: Usually your till/paybill number
   - Get Passkey from Safaricom Support

4. **Set Callback URL**:
   - In app settings: `https://yourdomain.com/mpesa/callback`
   - Make sure you have SSL certificate

### Test M-Pesa (Sandbox)

```bash
# Get access token
curl -X GET "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials" \
  -H "Authorization: Basic $(echo -n 'YOUR_KEY:YOUR_SECRET' | base64)"

# Response should have access_token
```

---

## PHASE 4: Portal Setup

### Deploy Portal HTML

```bash
# In your Node server folder
mkdir public
# Copy portal.html to public/portal.html

# Access at: http://your-server:3000
```

### Custom Domain (Optional but Recommended)

```bash
# Use Nginx as reverse proxy
sudo apt install nginx certbot python3-certbot-nginx

# Create Nginx config
sudo tee /etc/nginx/sites-available/hotspot << EOF
server {
    server_name wifi.yourdomain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
EOF

# Enable & get SSL cert
sudo ln -s /etc/nginx/sites-available/hotspot /etc/nginx/sites-enabled/
sudo certbot --nginx -d wifi.yourdomain.com
```

---

## PHASE 5: Testing Checklist

```
☐ Mikrotik WiFi connects (no authentication needed yet)
☐ Portal loads at http://localhost:3000
☐ Can register with phone number
☐ Can see pricing packages
☐ M-Pesa STK push triggers (check sandbox)
☐ Payment callback received
☐ Account balance updates after payment
☐ Can buy WiFi package
☐ Hotspot user created in Mikrotik
☐ Can connect with WiFi credentials
```

### Manual Test

```bash
# Register user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"phone_number":"254712345678"}'

# Response: {"success":true,"token":"eyJhbGc...","userId":1}

# Get account info
curl http://localhost:3000/api/user/account \
  -H "Authorization: Bearer YOUR_TOKEN"

# Check pricing
curl http://localhost:3000/api/pricing
```

---

## PHASE 6: Go Live

### Before Launch

```bash
# 1. Switch M-Pesa to PRODUCTION
# In .env:
MPESA_ENV=production

# 2. Set strong secrets
# Generate: openssl rand -base64 32
JWT_SECRET=<generate-new>

# 3. Enable HTTPS
# Ensure your domain has SSL certificate

# 4. Backup database
pg_dump -U hotspot hotspot_db > backup.sql

# 5. Monitor logs
tail -f /var/log/hotspot/server.log
```

### Systemd Service (Auto-start)

```bash
sudo tee /etc/systemd/system/hotspot.service << EOF
[Unit]
Description=WiFi Hotspot Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/hotspot-system
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable hotspot
sudo systemctl start hotspot
sudo systemctl status hotspot
```

---

## PHASE 7: Admin Dashboard (Bonus)

```bash
# Check active sessions
sudo ssh admin@192.168.1.1 "/ip hotspot active print"

# View user stats
psql hotspot_db -c "
SELECT 
    u.phone_number,
    COUNT(s.id) as sessions,
    SUM(s.duration_hours) as total_hours,
    u.account_balance
FROM users u
LEFT JOIN sessions s ON u.id = s.user_id
GROUP BY u.id
ORDER BY u.account_balance DESC;
"

# Daily revenue
psql hotspot_db -c "
SELECT 
    DATE(created_at) as date,
    COUNT(*) as transactions,
    SUM(amount) as revenue
FROM transactions
WHERE status = 'success'
GROUP BY DATE(created_at)
ORDER BY date DESC;
"
```

---

## PHASE 8: Scaling Tips

### When You Have 50+ Users
- Add second Mikrotik AP (mesh network)
- Set up load balancer for backend
- Use Redis for session caching
- Monitor Mikrotik CPU/Memory

### When You Have 200+ Users
- Migrate to managed PostgreSQL (AWS RDS)
- Use CDN for portal
- Implement rate limiting
- Add SMS notifications

### Cost Optimization
```
Hardware: ~5,000 KES (Mikrotik)
VPS: ~1,000-2,000 KES/month
Domain: ~300 KES/year
SSL: Free (Let's Encrypt)
M-Pesa: 2% + 5 KES per transaction
```

---

## TROUBLESHOOTING

### "Connection refused" on Mikrotik
```bash
# Check SSH is enabled
# Check firewall allows port 22
ssh -v admin@192.168.1.1  # verbose output
```

### M-Pesa callback not received
```bash
# Test your callback URL works
curl -X POST https://yourdomain.com/mpesa/callback \
  -H "Content-Type: application/json" \
  -d '{"Body":{"stkCallback":{"ResultCode":0}}}'

# Check HTTPS working
openssl s_client -connect yourdomain.com:443
```

### Hotspot users not appearing in Mikrotik
```bash
# Check user was actually created
ssh admin@192.168.1.1 "/ip hotspot user print"

# Check authentication method
ssh admin@192.168.1.1 "/ip hotspot print"
```

### Database connection error
```bash
# Test connection
psql -U hotspot -d hotspot_db -h localhost

# Check PostgreSQL running
sudo systemctl status postgresql
```

---

## SUPPORT & RESOURCES

- Mikrotik Wiki: https://wiki.mikrotik.com/
- M-Pesa Docs: https://developer.safaricom.co.ke/documentation
- Node.js Docs: https://nodejs.org/docs/
- PostgreSQL Docs: https://www.postgresql.org/docs/

---

**Got stuck? Double-check your .env file and firewall settings first!** ✓
