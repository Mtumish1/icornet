# FastWiFi Admin Dashboard starter

## Files
- `index.html` — dashboard layout
- `css/admin.css` — responsive styles
- `js/admin.js` — rendering, search, CSV export, refresh and API integration placeholders

## Quick start
Copy the files into the same frontend root that serves the customer page. If your app already has an `index.html`, use this dashboard file as `admin.html` instead and adjust the stylesheet/script links if your server uses a different static root.

The HTML deliberately loads CSS and JavaScript externally to work with a strict CSP such as `script-src 'self'`.

## Important: demo data vs live data
The dashboard starts with sample data and displays a banner so it is not mistaken for live business data. It then attempts these suggested endpoints:
- `GET /api/admin/overview`
- `GET /api/admin/sessions`
- `GET /api/admin/payments`

These routes are integration placeholders; they were not present in the provided customer page, so they must be implemented or changed to match your backend. Each endpoint should return JSON. Example shapes are documented at the top of `js/admin.js`.

The dashboard currently expects fields such as `connected_count`, `today_revenue`, `month_revenue`, `sessions`, and `payments`. Adjust the normalizers if your backend uses different field names.

## Production checklist
1. Add authentication and authorization to all admin pages and API routes. Do not rely on hiding the URL.
2. Make the server calculate revenue from verified successful M-Pesa callbacks/transactions, not from payment initiation attempts.
3. Get connected-client/session data from your router/captive portal/RADIUS source, not from payment records.
4. Protect phone numbers and other customer information; return only fields the admin needs.
5. Enforce HTTPS and CSRF protections where relevant.
6. Restrict CSV exports to authenticated admins and audit access where appropriate.
7. If using a strict CSP, serve these assets from the same origin. No inline JavaScript is used; CSS uses an external stylesheet. The optional Google Fonts import can be removed if your CSP blocks external styles/fonts.
