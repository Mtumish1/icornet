# FastWiFi Admin Dashboard

## Files
- `index.html` — dashboard layout
- `css/admin.css` — responsive styles
- `js/admin.js` — rendering, search, CSV export, refresh and API integration placeholders

## Quick start
The dashboard is served by the existing Express static middleware at `/fastwifi-admin-dashboard/admin.html`. The stylesheet and script use paths relative to that page, so they work from the current `public/fastwifi-admin-dashboard/` location.

The HTML deliberately loads CSS and JavaScript externally to work with a strict CSP such as `script-src 'self'`.

## Backend integration
The dashboard calls the existing admin routes and sends the `X-Admin-Key` header:
- `GET /admin/stats` for summary metrics
- `GET /admin/analytics?days=90` for daily revenue and successful transaction counts
- `GET /admin/sessions?status=active&page=1&limit=100` for active sessions
- `GET /admin/transactions?page=1&limit=100` for recent payments

On first load, enter the value of `ADMIN_API_KEY` from the server’s environment. The key is kept only in this browser tab’s `sessionStorage`; it is cleared when that tab session ends. Never hard-code the key in frontend files. If the key is missing or rejected, the dashboard stays in clearly labelled demo mode.

The backend limits list endpoints to 100 rows per request. The dashboard shows the first 8 transactions by default; “View all” expands to the maximum 100 returned. The existing API does not expose package sales or package names on sessions, so those columns are shown as unavailable rather than fabricated. Package-level sales analytics would require an additional backend endpoint/query.

## Production checklist
1. Prefer a server-side admin login/session or authenticated reverse proxy in production. A shared API key entered into a browser is exposed to that operator and is not a substitute for per-user authentication.
2. Make the server calculate revenue from verified successful M-Pesa callbacks/transactions, not from payment initiation attempts.
3. Get connected-client/session data from your router/captive portal/RADIUS source, not from payment records.
4. Protect phone numbers and other customer information; return only fields the admin needs.
5. Enforce HTTPS and CSRF protections where relevant.
6. Restrict CSV exports to authenticated admins and audit access where appropriate.
7. If using a strict CSP, serve these assets from the same origin. No inline JavaScript is used; CSS uses an external stylesheet. The optional Google Fonts import can be removed if your CSP blocks external styles/fonts.
