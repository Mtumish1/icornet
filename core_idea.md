No, **you do not need RADIUS for a simple M-Pesa Wi-Fi hotspot**. But RADIUS becomes very useful once you want centralized session control, multiple access points, bandwidth policies, accounting, or more sophisticated authentication.

For your use case, I would actually build it in stages.

### A good starting architecture

```text
                 Internet
                    │
              ┌─────▼─────┐
              │ MikroTik /│
              │ OpenWrt   │
              │ Gateway   │
              └─────┬─────┘
                    │
             ┌──────▼──────┐
             │ Wi-Fi AP    │
             │ Guest VLAN  │
             └──────┬──────┘
                    │
              Customer Phone
                    │
             Captive Portal
                    │
             ┌──────▼──────┐
             │ Your Backend│
             │ Django/FastAPI
             └──────┬──────┘
                    │
              M-Pesa Daraja
                    │
              Payment callback
                    │
             ┌──────▼──────┐
             │ Session     │
             │ Provisioner │
             └─────────────┘
```

The important thing is that **payment confirmation should be the event that provisions Internet access**, not the customer's browser telling your system "I paid."

## Do you need RADIUS?

### Without RADIUS

For one hotspot/router, you can do:

```text
Customer
   ↓
Connect Wi-Fi
   ↓
Captive portal
   ↓
Enter phone number
   ↓
Choose package
   ↓
M-Pesa STK Push
   ↓
M-Pesa confirms payment
   ↓
Backend verifies transaction
   ↓
Create session
   ↓
Router allows customer
   ↓
Session expires
```

This is perfectly reasonable for an MVP.

You could maintain something like:

```text
sessions

id
phone_number
payment_id
package_id
router_session_id
started_at
expires_at
ip_address
mac_address
status
```

The router can then enforce:

* session duration
* bandwidth limits
* IP assignment
* disconnection
* expiration

### When RADIUS becomes worthwhile

I'd introduce FreeRADIUS when you have something like:

```text
                 Backend
                    │
                 RADIUS
                    │
        ┌───────────┼───────────┐
        ↓           ↓           ↓
      AP #1       AP #2       AP #3
        │           │           │
      users       users       users
```

Then you can centrally manage:

* authentication
* authorization
* accounting
* session limits
* bandwidth profiles
* simultaneous sessions
* multiple routers/APs

For your initial system, **RADIUS is optional infrastructure, not a requirement**.

---

# The bigger security issue

For an M-Pesa hotspot, I would worry much more about **payment/session authorization vulnerabilities** than about whether you're using RADIUS.

Your most important security rule should be:

> **Never grant Internet access based on information supplied by the customer's browser.**

For example, don't do:

```http
POST /payment/success

{
    "phone": "2547...",
    "amount": 50,
    "status": "success"
}
```

and then immediately activate the user.

A malicious customer could simply modify the request.

Instead:

```text
Customer
   │
   │ "I want 1 hour"
   ▼
Your backend
   │
   │ STK Push
   ▼
M-Pesa
   │
   │ actual transaction
   ▼
M-Pesa callback
   │
   ▼
Your backend
   │
   ├── verify transaction
   ├── verify amount
   ├── verify merchant
   ├── verify transaction ID
   ├── verify order/reference
   ├── prevent duplicate processing
   │
   ▼
Create session
   │
   ▼
Authorize device
```

That distinction is extremely important.

---

# Vulnerabilities I'd design against

## 1. Payment spoofing

**Threat:**

Customer sends:

```json
{
  "status": "paid"
}
```

to your API.

**Protection:**

Only your trusted M-Pesa callback/payment verification process can transition:

```text
PENDING → PAID
```

Never:

```text
Browser → PAID
```

---

## 2. Replay attacks

Suppose a legitimate payment callback is:

```text
Transaction ABC123
KES 50
```

An attacker shouldn't be able to send that callback repeatedly and obtain multiple sessions.

Use a unique payment/transaction identifier and enforce idempotency:

```text
ABC123
   ↓
already processed?
   │
   ├── YES → don't provision again
   │
   └── NO → process payment
```

Database constraint:

```text
UNIQUE(mpesa_transaction_id)
```

is extremely valuable.

---

## 3. Wrong amount / package manipulation

Suppose:

```text
30 minutes = KES 20
1 hour     = KES 50
24 hours   = KES 150
```

Don't trust:

```json
{
    "package": "24_hours",
    "amount": 20
}
```

from the client.

Instead:

```text
package_id = 24h
       ↓
backend looks up package
       ↓
KES 150
       ↓
M-Pesa payment
```

The server owns the price.

---

# 4. Session hijacking

Imagine:

```text
Customer A
IP: 10.10.0.25
MAC: AA:BB:CC...
```

gets a 2-hour session.

You don't want Customer B to somehow inherit it.

Don't make authorization depend on a single easily spoofed value.

Depending on your gateway technology, use a combination of:

* authenticated session/token
* assigned IP
* device identity
* router-side authorization
* session ID
* expiration timestamp

And don't put sensitive authorization information in URLs such as:

```text
/wifi/login?paid=true&phone=...
```

---

# 5. MAC-address spoofing

This is particularly important for hotspot systems.

A customer can potentially change their device MAC address.

So don't treat:

```text
MAC = paid
```

as your entire authorization mechanism.

Think:

```text
Payment
   +
server-side session
   +
gateway authorization
   +
expiration
```

rather than simply:

```text
MAC → Internet
```

---

# 6. Captive portal bypass

This is one of the big ones.

A user might try:

```text
Connect
   ↓
Don't use portal
   ↓
Directly access Internet
```

Your gateway needs to ensure unauthenticated clients cannot simply bypass the captive portal.

For example:

```text
GUEST VLAN

DNS → captive portal
HTTP → captive portal
HTTPS → normally blocked/redirect limitations
Internet → blocked

             ↓
       authenticated

Internet → allowed
```

Don't rely solely on JavaScript in the portal.

The **router/firewall must enforce the restriction**.

---

# 7. Client-to-client attacks

This is very important in public Wi-Fi.

Imagine:

```text
Customer A ───┐
              │
Customer B ───┼── Wi-Fi
              │
Customer C ───┘
```

You generally don't want A to be able to directly attack B.

Enable client isolation / AP isolation where appropriate.

Conceptually:

```text
Internet
   ↑
   │
Gateway
   │
 ┌─┴──────────────┐
 │                │
User A           User B
 │                │
X <──────────────> X
```

rather than allowing unrestricted lateral communication.

---

# 8. Management interface exposure

**Never put router management on the customer network.**

Bad:

```text
Customer Wi-Fi
      │
      ├── Internet
      └── Router admin
```

Better:

```text
             Router
          ┌─────┴─────┐
          │           │
      MANAGEMENT    GUEST
       VLAN          VLAN
         │             │
      Admin          Users
```

Your customers should not be able to reach:

```text
192.168.88.1
```

or whatever management address you use.

---

# 9. API vulnerabilities

Your backend becomes part of the security boundary.

Protect against:

* SQL injection
* broken authentication
* IDOR
* privilege escalation
* mass assignment
* insecure API endpoints
* brute-force requests
* rate-limit bypass
* CSRF where applicable
* CORS misconfiguration
* SSRF
* leaked API credentials
* exposed debug endpoints

For example, don't allow:

```http
POST /api/session/activate
```

with:

```json
{
  "user_id": 123,
  "duration": 86400
}
```

unless the server independently establishes that the user has paid for that entitlement.

---

# 10. M-Pesa callback security

Your callback endpoint is especially important.

Don't treat:

```text
POST /mpesa/callback
```

as an ordinary public API.

You should consider:

* HTTPS
* strict request validation
* transaction uniqueness
* expected merchant/account validation
* expected amount validation
* expected order/reference validation
* idempotent processing
* logging
* rate limiting where appropriate
* secrets/credentials stored outside source code

And importantly, design for **delayed, duplicated, or out-of-order callbacks**.

Payment systems are distributed systems. Don't assume:

```text
payment → callback → session
```

always happens exactly once and immediately.

---

# 11. Session expiration

Don't rely on the frontend timer.

This:

```javascript
setTimeout(() => logout(), 3600000)
```

is not security.

The gateway needs to enforce:

```text
expires_at = 2026-10-07 22:30
```

Then:

```text
22:30
 ↓
gateway removes authorization
 ↓
Internet blocked
```

Even if the customer's browser remains open.

---

# 12. Bandwidth abuse

One person shouldn't be able to destroy the hotspot for everyone.

Define profiles:

```text
FREE
  ↓
1 Mbps
30 min

KES 20
  ↓
5 Mbps
1 hour

KES 50
  ↓
10 Mbps
3 hours
```

Enforce this **at the gateway**, not merely in your application.

---

# 13. DNS abuse

Be careful with DNS.

A client shouldn't be able to simply configure:

```text
8.8.8.8
1.1.1.1
```

and bypass whatever DNS-based restrictions you're relying on.

A common approach is to have the gateway control DNS for the guest network and prevent unauthorized DNS paths where appropriate.

But don't confuse DNS control with full captive-portal security. **Firewall enforcement is the real boundary.**

---

# 14. IPv6 bypass

This one is surprisingly easy to miss.

You secure:

```text
IPv4
 ↓
firewall
 ↓
portal
```

but your AP/router gives customers IPv6:

```text
IPv6
 ↓
Internet
```

and the IPv6 path isn't subject to the same policy.

If you aren't intentionally supporting IPv6 yet, make sure IPv6 is either properly secured or disabled on the guest network.

---

# 15. DHCP attacks

Your guest network should have a controlled DHCP environment.

Watch for:

```text
Customer device
      ↓
Fake DHCP server
      ↓
Other customers
      ↓
Attacker-controlled gateway/DNS
```

Use network isolation and appropriate DHCP protections where your hardware supports them.

---

# 16. Rogue access points / evil twins

Public Wi-Fi users can be tricked by:

```text
YOUR_WIFI
     ↑
     │
real AP

YOUR_WIFI
     ↑
     │
attacker AP
```

You can't completely prevent a nearby attacker from broadcasting a similar SSID, but you can reduce risk through:

* WPA configuration where appropriate
* clear captive portal branding
* HTTPS everywhere
* no sensitive information in captive portal URLs
* customer education
* proper AP configuration

---

# I'd structure your system around these trust boundaries

```text
                INTERNET
                   │
             ┌─────▼─────┐
             │ FIREWALL  │
             │  ROUTER   │
             └─────┬─────┘
                   │
             GUEST VLAN
                   │
          ┌────────▼────────┐
          │     Wi-Fi       │
          └────────┬────────┘
                   │
              CUSTOMER
                   │
             Captive Portal
                   │
             HTTPS Backend
                   │
        ┌──────────┴──────────┐
        │                     │
    PostgreSQL             M-Pesa
        │                     │
        └──────────┬──────────┘
                   │
              SESSION ENGINE
                   │
                   ▼
              ROUTER API
                   │
                   ▼
          Internet authorization
```

The key principle is:

> **The customer network should be considered hostile.**

Your customer's phone is not trusted.

The captive portal is not trusted.

The customer's claimed payment status is not trusted.

The customer's MAC address is not trusted.

The browser is not trusted.

Your **backend + payment verification + gateway** establish the truth.

---

## What I'd use for your first version

Given that you're building this yourself, I would keep V1 relatively simple:

| Component          | V1                                   |
| ------------------ | ------------------------------------ |
| Router             | MikroTik or OpenWrt                  |
| Wi-Fi              | Dedicated AP                         |
| Guest network      | VLAN                                 |
| Captive portal     | Router + custom portal               |
| Backend            | Django/FastAPI                       |
| Database           | PostgreSQL                           |
| Payments           | M-Pesa Daraja                        |
| Authentication     | Phone/payment-based session          |
| RADIUS             | **No**                               |
| Client isolation   | **Yes**                              |
| Rate limiting      | **Yes**                              |
| Session expiration | **Gateway enforced**                 |
| Admin network      | **Separate VLAN**                    |
| IPv6               | Secure properly or disable initially |
| Logging            | **Yes**                              |
| Monitoring         | Basic metrics + alerts               |

Then **V2** can introduce FreeRADIUS:

```text
                    Backend
                       │
                ┌──────▼──────┐
                │ FreeRADIUS  │
                └──────┬──────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       MikroTik      OpenWrt       APs
          │            │            │
       Users         Users        Users
```

That makes much more sense once you're managing **multiple hotspots or APs**.

And because you're building this as a payment-enabled network appliance, I'd treat **payment authorization, captive-portal bypass, client isolation, management-plane isolation, session expiration, and IPv6** as the first six things to threat-model before writing much code.
