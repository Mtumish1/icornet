# WiFi Hotspot System with M-Pesa Integration

A complete system for managing a pay-per-hour WiFi hotspot using Haplite Mikrotik access point and M-Pesa payment integration.

```
┌─────────────────────────────────────────────────────┐
│     Your WiFi Customers                             │
└────────────┬────────────────────────────────────────┘
             │ (Connect to SSID)
             ▼
┌─────────────────────────────────────────────────────┐
│  Haplite Mikrotik Router                            │
│  (WiFi Access Point + Session Control)              │
└────────────┬────────────────────────────────────────┘
             │ (API Communication)
             ▼
┌─────────────────────────────────────────────────────┐
│  Node.js Backend Server                             │
│  ├─ User Management                                  │
│  ├─ M-Pesa Payment Processing                       │
│  ├─ WiFi Session Management                         │
│  └─ Database & Logging                              │
└────────────┬────────────────────────────────────────┘
             │
      ┌──────┴──────┐
      ▼             ▼
   M-Pesa      PostgreSQL
  (Payments)   (Users, Sessions, 
               Transactions)
```

---

## 📋 What's Included

| File | Purpose |
|------|---------|
| `server.js` | Complete Node.js backend with all API endpoints |
| `package.json` | NPM dependencies configuration |
| `.env.example` | Environment variables template |
| `QUICK_START.md` | Step-by-step setup guide (1-2 hours) |
| `wifi_hotspot_system_design.md` | Complete technical documentation |
| This file (`README.md`) | System overview and architecture |

---

## 🚀 Quick Start (30 mins)

### 1. Prerequisites
```bash
# You need:
✓ Haplite Mikrotik Router (already have it)
✓ VPS/Server with Node.js & PostgreSQL
✓ M-Pesa business account (Safaricom Kenya)
✓ Domain with HTTPS certificate
```

### 2. Install & Configure (5 mins)
```bash
# Clone/copy files to your server
mkdir hotspot-system && cd hotspot-system
# Copy all files here

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials
nano .env
```

### 3. Database Setup (5 mins)
```bash
# Create database
sudo -u postgres psql << EOF
CREATE DATABASE hotspot_db;
CREATE USER hotspot WITH PASSWORD 'password123';
GRANT ALL PRIVILEGES ON DATABASE hotspot_db TO hotspot;
EOF

# Import schema (create schema.sql from QUICK_START.md)
psql hotspot_db < schema.sql
```

### 4. Mikrotik Configuration (10 mins)
```bash
# SSH into your Mikrotik and run setup commands
# See QUICK_START.md Phase 1 for complete commands
ssh admin@192.168.1.1

# Then execute Mikrotik configuration commands
/interface bridge add name=br-hotspot
# ... (see QUICK_START.md for full config)
```

### 5. Test & Launch (5 mins)
```bash
# Start server
node server.js

# Access portal
# http://localhost:3000 (or your domain)

# Test registration
# Use phone: 254712345678
# Try M-Pesa payment in sandbox mode
```

---

## 📱 How It Works (User Flow)

```
1. Customer connects to WiFi SSID
       ↓
2. Redirected to login portal (automatic redirect)
       ↓
3. Enter phone number → App registers user
       ↓
4. Choose WiFi package (1h for KES 50, 3h for KES 120, etc.)
       ↓
5. System sends STK Push → Customer enters M-Pesa PIN
       ↓
6. Payment confirmed → Account credited
       ↓
7. WiFi access granted → Customer can browse
       ↓
8. After duration expires → Access automatically revoked
```

---

## 💾 Database Structure

### Users Table
```sql
id | phone_number | account_balance | status | created_at
```

### Sessions Table (WiFi Access)
```sql
id | user_id | session_key | start_time | duration_hours | status
```

### Transactions Table (M-Pesa Payments)
```sql
id | user_id | mpesa_ref | amount | status | created_at
```

### Pricing Table
```sql
id | hours | price | description
1  | 1     | 50    | 1 Hour
2  | 3     | 120   | 3 Hours
3  | 24    | 300   | 1 Day
4  | 7     | 1500  | 1 Week
```

---

## 🔌 API Endpoints

### Authentication
```
POST /api/auth/register
├─ Input: { phone_number: "254712345678" }
└─ Output: { token, userId, message }
```

### User Account
```
GET /api/user/account (requires auth token)
├─ Output: { phone_number, account_balance, status, created_at }
```

### Pricing & Packages
```
GET /api/pricing
├─ Output: [{ id, hours, price, description }, ...]
```

### WiFi Purchase
```
POST /api/wifi/buy (requires auth token)
├─ Input: { package_id: 1 }
└─ Output: { session_key, username, password, duration_hours }
```

### Payments
```
POST /api/payment/initiate (requires auth token)
├─ Input: { phone_number: "254712345678", amount: 100 }
└─ Output: { checkout_request_id, message }

POST /mpesa/callback (from M-Pesa)
├─ Input: M-Pesa callback data
└─ Output: { ResultCode: 0 }
```

### History
```
GET /api/sessions/active (requires auth token)
GET /api/sessions/history (requires auth token)
GET /api/transactions/history (requires auth token)
```

### Admin Dashboard
All admin endpoints require `X-Admin-Key: <ADMIN_API_KEY>` and return `403` when the key is missing or invalid.

```
GET /admin/stats
└─ Summary metrics: users, transactions, revenue, and active sessions

GET /admin/analytics?days=30
└─ Daily successful revenue, transaction counts, and new users (1-90 days)

GET /admin/users?search=2547&status=active&page=1&limit=25
GET /admin/sessions?search=2547&status=active&page=1&limit=25
GET /admin/transactions?search=2547&status=success&page=1&limit=25
└─ Searchable, filterable lists with { data, pagination }; limit is capped at 100
```

---

## ⚙️ Configuration Guide

### M-Pesa Setup

1. **Register at Safaricom Developer Portal**
   - Go to: https://developer.safaricom.co.ke/
   - Create account & verify

2. **Create M-Pesa Application**
   - Click "My Apps" → "New App"
   - Fill in details:
     - App Name: `Hotspot WiFi`
     - Select: `Mpesa` → `Lipa Na M-Pesa Online`

3. **Get Credentials**
   - Consumer Key → Add to `.env`
   - Consumer Secret → Add to `.env`
   - Business Shortcode (your Paybill) → Add to `.env`
   - Passkey (get from Safaricom Support) → Add to `.env`

4. **Set Callback URL**
   - In app settings, add callback URL
   - Format: `https://yourdomain.com/mpesa/callback`
   - Must be HTTPS

### Mikrotik Configuration

**Minimal Setup** (Production Ready)
```mikrotik
# Bridge WiFi interface
/interface bridge add name=br-hotspot
/interface bridge port add interface=ether2 bridge=br-hotspot
/interface bridge port add interface=wlan1 bridge=br-hotspot

# IP & DHCP
/ip address add address=192.168.100.1/24 interface=br-hotspot
/ip pool add name=hotspot-pool ranges=192.168.100.2-192.168.100.254
/ip dhcp-server add interface=br-hotspot address-pool=hotspot-pool disabled=no

# Hotspot with Radius
/ip hotspot profile add name=myprofile
/ip hotspot add interface=br-hotspot authentication=radius
/radius add service=hotspot address=YOUR_SERVER_IP secret=radiussecret123
```

---

## 🔐 Security Best Practices

### Essential
- [ ] Use HTTPS only (not HTTP)
- [ ] Change Mikrotik default password
- [ ] Keep M-Pesa API keys in `.env` (never in code)
- [ ] Rotate JWT secret regularly
- [ ] Enable database backups

### Recommended
- [ ] Enable firewall on Mikrotik
- [ ] Use SSH keys for Mikrotik access
- [ ] Rate limit payment endpoints
- [ ] Log all transactions
- [ ] Monitor account balances
- [ ] SSL certificate auto-renewal

### Deployment
```bash
# Example: Using Let's Encrypt for free SSL
sudo apt install certbot python3-certbot-nginx
sudo certbot certonly --standalone -d wifi.yourdomain.com

# Auto-renew daily
sudo systemctl enable certbot.timer
```

---

## 📊 Monitoring & Maintenance

### Check System Health
```bash
# Server status
curl http://localhost:3000/health

# Database connection
psql hotspot_db -c "SELECT COUNT(*) FROM users;"

# Mikrotik sessions
ssh admin@192.168.1.1 "/ip hotspot active print count-only"
```

### View Statistics
```bash
# Total users
psql hotspot_db -c "SELECT COUNT(*) FROM users;"

# Total revenue
psql hotspot_db -c "SELECT SUM(amount) FROM transactions WHERE status='success';"

# Today's revenue
psql hotspot_db -c "SELECT SUM(amount) FROM transactions WHERE DATE(created_at)=CURRENT_DATE AND status='success';"

# Active WiFi sessions
psql hotspot_db -c "SELECT COUNT(*) FROM sessions WHERE status='active';"
```

### Backup Database
```bash
# Daily backup
pg_dump hotspot_db > backup_$(date +%Y%m%d_%H%M%S).sql

# Automatic backup (add to crontab)
0 2 * * * pg_dump hotspot_db > /backups/hotspot_$(date +\%Y\%m\%d).sql
```

---

## 🛠️ Troubleshooting

### Problem: "M-Pesa credentials invalid"
**Solution:**
- Verify credentials in M-Pesa dashboard
- Check if using sandbox or production correctly
- Test token generation: See QUICK_START.md troubleshooting

### Problem: "Mikrotik SSH connection timeout"
**Solution:**
- Check SSH enabled on Mikrotik (System > SSH)
- Test: `ssh admin@192.168.1.1`
- Verify firewall allows port 22

### Problem: "Users can't connect to WiFi"
**Solution:**
- Check SSID is broadcasting
- Verify DHCP pool has free IPs
- Check Mikrotik bridge configuration
- Test with a known device first

### Problem: "Database connection refused"
**Solution:**
```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Check credentials in .env
psql -U hotspot -h localhost -d hotspot_db

# Check database exists
psql -U postgres -l | grep hotspot_db
```

### Problem: "Hotspot users not created"
**Solution:**
- Verify Mikrotik authentication is enabled
- Check Radius configuration (if using)
- Test manual user creation via SSH:
  ```bash
  ssh admin@192.168.1.1 "/ip hotspot user print"
  ```

---

## 📈 Scaling Tips

### Phase 1: 10-50 Users
- Single Mikrotik AP
- Local VPS (2GB RAM, 2 CPU)
- PostgreSQL on same server
- Sufficient for ~50 concurrent users

### Phase 2: 50-200 Users
- Add second Mikrotik AP (mesh)
- Separate VPS for database (AWS RDS)
- Add caching (Redis)
- Implement load balancer

### Phase 3: 200+ Users
- 3-5 Mikrotik APs
- Managed database service
- CDN for portal
- Dedicated monitoring

### Cost Estimation
```
Hardware:        KES 5,000 (Mikrotik)
VPS/month:       KES 1,000-2,000
Domain/year:     KES 300
SSL:             Free (Let's Encrypt)
M-Pesa fees:     2% + KES 5 per transaction
```

---

## 📞 Support & Resources

### Documentation
- **Mikrotik Wiki**: https://wiki.mikrotik.com/
- **M-Pesa API**: https://developer.safaricom.co.ke/
- **Node.js**: https://nodejs.org/docs/
- **PostgreSQL**: https://www.postgresql.org/docs/
- **Express.js**: https://expressjs.com/

### Common Issues
1. **M-Pesa not working?**
   - Check credentials in `.env`
   - Verify callback URL is accessible
   - Test in sandbox first

2. **Mikrotik not connecting?**
   - Verify SSH enabled
   - Check IP address & credentials
   - Test with PuTTY first

3. **Portal not loading?**
   - Check server running: `ps aux | grep node`
   - Check port: `curl http://localhost:3000`
   - Check logs: `tail -f server.log`

---

## 📝 Implementation Checklist

### Setup Phase
- [ ] Mikrotik WiFi configured & tested
- [ ] Node.js backend installed
- [ ] PostgreSQL database created
- [ ] M-Pesa API credentials obtained
- [ ] Domain & HTTPS certificate ready

### Configuration Phase
- [ ] `.env` file created with all credentials
- [ ] Database schema imported
- [ ] Mikrotik Radius configured (optional)
- [ ] M-Pesa callback URL verified
- [ ] Portal tested locally

### Testing Phase
- [ ] User registration working
- [ ] M-Pesa payment in sandbox works
- [ ] WiFi access granted correctly
- [ ] Session expires after time
- [ ] Account balance updates

### Deployment Phase
- [ ] SSL certificate installed
- [ ] M-Pesa switched to production
- [ ] Database backed up
- [ ] Monitoring enabled
- [ ] Error logging configured

### Post-Launch
- [ ] Monitor payment success rate
- [ ] Check WiFi session quality
- [ ] Review user feedback
- [ ] Optimize pricing if needed
- [ ] Plan expansion

---

## 📄 License

This system is provided as-is. Customize for your business needs.

---

## 🎯 Next Steps

1. **Read**: Start with `QUICK_START.md` (30 mins)
2. **Configure**: Set up `.env` with your credentials (10 mins)
3. **Test**: Run locally and test the flow (30 mins)
4. **Deploy**: Move to production VPS (1 hour)
5. **Launch**: Go live and monitor (ongoing)

---

**Questions? Check QUICK_START.md troubleshooting section first, then review the detailed technical docs in wifi_hotspot_system_design.md**

---

**Happy hotspotting! 📡✨**
