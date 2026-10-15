'use strict';

/**
 * Test suite for the WiFi hotspot backend.
 *
 * Runs entirely offline: DATABASE_URL points at an unreachable port so
 * every DB-backed code path deterministically fails, letting us assert
 * validation, auth and error shapes without infrastructure.
 * MOCK_MPESA=true exercises the simulated M-Pesa flow.
 *
 * Run with: npm test
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'test-jwt-secret-for-suite';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.DATABASE_URL = 'postgresql://hotspot:test@127.0.0.1:1/hotspot_test';
process.env.MOCK_MPESA = 'true';
// MPESA_CALLBACK_IPS intentionally unset — allowlist disabled for these tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const app = require('../server');
const { _internal } = require('../server');
const {
    isValidPhone,
    isIpAllowed,
    matchesCidr,
    encryptSecret,
    decryptSecret,
    mpesaService
} = _internal;

const adminHeaders = { 'X-Admin-Key': 'test-admin-key' };

// ============ HEALTH ============

test('GET /health returns 503 and reports the database unreachable when Postgres is down', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'ERROR');
    assert.equal(res.body.database, 'unreachable');
});

// ============ PHONE VALIDATION ============

test('isValidPhone accepts Kenyan numbers in 2547XXXXXXXX format', () => {
    assert.equal(isValidPhone('254712345678'), true);
});

test('isValidPhone rejects local format, wrong prefix, and wrong lengths', () => {
    assert.equal(isValidPhone('0712345678'), false);
    assert.equal(isValidPhone('25471234567'), false);
    assert.equal(isValidPhone('2547123456789'), false);
    assert.equal(isValidPhone('254112345678'), false);
    assert.equal(isValidPhone(''), false);
    assert.equal(isValidPhone(undefined), false);
});

// ============ AUTH ENDPOINTS ============

test('POST /api/auth/register rejects invalid phone numbers with 400', async () => {
    const res = await request(app).post('/api/auth/register').send({ phone_number: '0712345678' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
});

test('POST /api/auth/register rejects a missing phone with 400', async () => {
    const res = await request(app).post('/api/auth/register').send({});
    assert.equal(res.status, 400);
});

test('GET /api/user/account requires a bearer token', async () => {
    const res = await request(app).get('/api/user/account');
    assert.equal(res.status, 401);
});

test('GET /api/user/account rejects malformed tokens', async () => {
    const res = await request(app).get('/api/user/account').set('Authorization', 'Bearer not-a-real-token');
    assert.equal(res.status, 401);
});

test('GET /api/user/account accepts a valid JWT, then surfaces the DB failure as 500', async () => {
    const token = jwt.sign(
        { userId: 1, phone_number: '254700000001' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );
    const res = await request(app).get('/api/user/account').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Server error');
});

test('POST /api/payment/initiate requires authentication', async () => {
    const res = await request(app)
        .post('/api/payment/initiate')
        .send({ phone_number: '254712345678', amount: 100 });
    assert.equal(res.status, 401);
});

// ============ PUBLIC PORTAL ============

test('GET /api/portal/status rejects too-short checkout ids', async () => {
    const res = await request(app).get('/api/portal/status/abc');
    assert.equal(res.status, 400);
});

// ============ ADMIN AUTH + VALIDATION ============

test('Admin endpoints reject requests without the admin key', async () => {
    const res = await request(app).get('/admin/stats');
    assert.equal(res.status, 403);
});

test('Admin endpoints reject a wrong admin key', async () => {
    const res = await request(app).get('/admin/stats').set('X-Admin-Key', 'wrong-key');
    assert.equal(res.status, 403);
});

test('GET /admin/analytics rejects out-of-range days param', async () => {
    const res = await request(app).get('/admin/analytics?days=999').set(adminHeaders);
    assert.equal(res.status, 400);
});

test('GET /admin/users rejects an invalid limit param', async () => {
    const res = await request(app).get('/admin/users?limit=0').set(adminHeaders);
    assert.equal(res.status, 400);
});

test('POST /admin/packages requires hours', async () => {
    const res = await request(app)
        .post('/admin/packages')
        .set(adminHeaders)
        .send({ description: '3 Hours', price: 15 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Hours/);
});

test('POST /admin/packages rejects a non-numeric price', async () => {
    const res = await request(app)
        .post('/admin/packages')
        .set(adminHeaders)
        .send({ hours: 3, price: 'abc', description: '3 Hours' });
    assert.equal(res.status, 400);
});

test('PUT /admin/packages/:id rejects non-numeric ids', async () => {
    const res = await request(app)
        .put('/admin/packages/notanumber')
        .set(adminHeaders)
        .send({ price: 10 });
    assert.equal(res.status, 400);
});

test('PUT /admin/packages/:id rejects a non-boolean is_active', async () => {
    const res = await request(app)
        .put('/admin/packages/1')
        .set(adminHeaders)
        .send({ is_active: 'yes' });
    assert.equal(res.status, 400);
});

// ============ M-PESA CALLBACK ============

test('POST /mpesa/callback always answers 200 with ResultCode 0 (even for junk)', async () => {
    const res = await request(app).post('/mpesa/callback').send({});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ResultCode: 0 });
});

test('POST /mpesa/callback acknowledges failed-payment callbacks without crashing', async () => {
    const res = await request(app).post('/mpesa/callback').send({
        Body: {
            stkCallback: {
                CheckoutRequestID: 'ws_CO_000000000000',
                ResultCode: 1032,
                ResultDesc: 'Request cancelled by user'
            }
        }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ResultCode: 0 });
});

// ============ CREDENTIAL ENCRYPTION ============

test('encryptSecret/decryptSecret round-trips a password', () => {
    const encrypted = encryptSecret('s3cret-pass');
    assert.notEqual(encrypted, 's3cret-pass');
    assert.ok(encrypted.startsWith('enc:v1:'));
    assert.equal(decryptSecret(encrypted), 's3cret-pass');
});

test('encryptSecret produces unique ciphertexts (random IV)', () => {
    assert.notEqual(encryptSecret('same-value'), encryptSecret('same-value'));
});

test('decryptSecret passes legacy plaintext through unchanged', () => {
    assert.equal(decryptSecret('plaintext-legacy'), 'plaintext-legacy');
});

test('decryptSecret returns null for tampered ciphertext', () => {
    const encrypted = encryptSecret('s3cret-pass');
    const parts = encrypted.split(':');
    parts[4] = Buffer.from('tampered').toString('base64');
    assert.equal(decryptSecret(parts.join(':')), null);
});

test('decryptSecret handles null/empty values', () => {
    assert.equal(decryptSecret(null), null);
    assert.equal(decryptSecret(''), '');
});

// ============ IP ALLOWLIST ============

test('isIpAllowed allows everything when the allowlist is empty', () => {
    assert.equal(isIpAllowed('1.2.3.4', []), true);
    assert.equal(isIpAllowed('', []), true);
});

test('isIpAllowed matches exact IPs', () => {
    const list = ['196.201.214.1'];
    assert.equal(isIpAllowed('196.201.214.1', list), true);
    assert.equal(isIpAllowed('196.201.214.2', list), false);
});

test('isIpAllowed supports CIDR ranges', () => {
    const list = ['196.201.214.0/24', '10.0.0.0/8'];
    assert.equal(isIpAllowed('196.201.214.200', list), true);
    assert.equal(isIpAllowed('196.201.215.1', list), false);
    assert.equal(isIpAllowed('10.255.1.1', list), true);
    assert.equal(isIpAllowed('11.0.0.1', list), false);
});

test('matchesCidr handles /32 defaults and rejects malformed input', () => {
    assert.equal(matchesCidr('1.2.3.4', '1.2.3.4'), true);
    assert.equal(matchesCidr('1.2.3.4', '1.2.3.4/32'), true);
    assert.equal(matchesCidr('1.2.3.4', '0.0.0.0/0'), true);
    assert.equal(matchesCidr('999.1.1.1', '1.2.3.0/24'), false);
    assert.equal(matchesCidr('1.2.3.4', 'not-a-cidr'), false);
});

// ============ MOCK M-PESA ============

test('MOCK_MPESA: stkPush returns an instant success with a MOCK checkout id', async () => {
    const res = await mpesaService.stkPush('254712345678', 50, 'WIFI-test');
    assert.equal(res.ResponseCode, '0');
    assert.ok(res.CheckoutRequestID.startsWith('MOCK-CR-'));
});

test('MOCK_MPESA: queryTransaction reports success', async () => {
    const res = await mpesaService.queryTransaction('MOCK-CR-test');
    assert.equal(res.ResultCode, '0');
});
