/*
 * FastWiFi admin dashboard
 *
 * Uses the backend admin routes protected by the X-Admin-Key header.
 */
(() => {
  'use strict';

  const ENDPOINTS = {
    stats: '/admin/stats',
    analytics: '/admin/analytics',
    sessions: '/admin/sessions?status=active&page=1&limit=100',
    payments: '/admin/transactions?page=1&limit=100'
  };

  const demo = {
    overview: {
      connected_count: 28,
      today_revenue: 4270,
      month_revenue: 86350,
      successful_payments: 186,
      monthly_payments: 1248,
      success_rate: 94.6,
      daily_change: 12.8,
      revenue_series: [
        { label: 'Mon', amount: 2450 }, { label: 'Tue', amount: 3180 },
        { label: 'Wed', amount: 2780 }, { label: 'Thu', amount: 3910 },
        { label: 'Fri', amount: 3420 }, { label: 'Sat', amount: 4850 },
        { label: 'Sun', amount: 4270 }
      ],
      packages: [
        { name: '1 Hour', sales: 342, revenue: 1710 },
        { name: '6 Hours', sales: 286, revenue: 2860 },
        { name: '12 Hours', sales: 214, revenue: 4280 },
        { name: '24 Hours', sales: 168, revenue: 8400 }
      ]
    },
    sessions: [
      { id: 's-101', name: 'Customer', phone: '07•• ••• 184', device: 'Android phone', ip: '192.168.10.24', package_name: '6 Hours', connected_since: '10:42 AM', remaining: '4h 18m', status: 'online' },
      { id: 's-102', name: 'Customer', phone: '07•• ••• 527', device: 'iPhone', ip: '192.168.10.31', package_name: '1 Hour', connected_since: '11:05 AM', remaining: '32m', status: 'online' },
      { id: 's-103', name: 'Customer', phone: '01•• ••• 093', device: 'Windows laptop', ip: '192.168.10.46', package_name: '24 Hours', connected_since: '08:17 AM', remaining: '18h 09m', status: 'online' },
      { id: 's-104', name: 'Customer', phone: '07•• ••• 806', device: 'Android phone', ip: '192.168.10.52', package_name: '12 Hours', connected_since: '09:30 AM', remaining: '7h 22m', status: 'online' },
      { id: 's-105', name: 'Customer', phone: '07•• ••• 662', device: 'Tablet', ip: '192.168.10.61', package_name: '6 Hours', connected_since: '11:21 AM', remaining: '5h 39m', status: 'online' }
    ],
    payments: [
      { id: 'p-2048', reference: 'QK7••••A91', name: 'Customer', phone: '07•• ••• 184', package_name: '6 Hours', created_at: 'Today, 10:42 AM', amount: 10, status: 'success' },
      { id: 'p-2047', reference: 'QK7••••B62', name: 'Customer', phone: '07•• ••• 527', package_name: '1 Hour', created_at: 'Today, 10:38 AM', amount: 5, status: 'success' },
      { id: 'p-2046', reference: 'QK7••••C15', name: 'Customer', phone: '01•• ••• 093', package_name: '24 Hours', created_at: 'Today, 10:21 AM', amount: 50, status: 'success' },
      { id: 'p-2045', reference: 'QK7••••D83', name: 'Customer', phone: '07•• ••• 806', package_name: '12 Hours', created_at: 'Today, 10:05 AM', amount: 20, status: 'pending' },
      { id: 'p-2044', reference: 'QK7••••E37', name: 'Customer', phone: '07•• ••• 662', package_name: '6 Hours', created_at: 'Today, 09:54 AM', amount: 10, status: 'success' }
    ]
  };

  const state = { overview: demo.overview, sessions: demo.sessions, payments: demo.payments, analytics: [], demoMode: true, period: 'today', showAllPayments: false, paymentTotal: demo.payments.length, sessionTotal: demo.sessions.length };
  const $ = (id) => document.getElementById(id);
  const kes = (value) => `KES ${Number(value || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
  const safe = (value) => String(value ?? '—').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const initials = (value) => (String(value || 'C').trim()[0] || 'C').toUpperCase();

  async function getJson(url, adminKey) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Admin-Key': adminKey } });
    if (!response.ok) {
      const error = new Error(`${url} returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function adminKey() {
    let key = sessionStorage.getItem('fastwifi-admin-key');
    if (!key) {
      key = window.prompt('Enter the FastWiFi admin API key');
      if (key) sessionStorage.setItem('fastwifi-admin-key', key.trim());
    }
    return key ? key.trim() : '';
  }

  function formatDate(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], options);
  }

  function remainingTime(expiry) {
    const minutes = Math.max(0, Math.floor((new Date(expiry).getTime() - Date.now()) / 60000));
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  }

  function mapSession(session) {
    return {
      ...session,
      name: 'Customer',
      phone: session.phone_number,
      device: 'Hotspot client',
      ip: session.ip_address,
      package_name: '—',
      connected_since: formatDate(session.start_time),
      remaining: remainingTime(session.expiry),
      status: session.status === 'active' ? 'online' : session.status
    };
  }

  function mapTransaction(transaction) {
    return {
      ...transaction,
      reference: transaction.mpesa_ref || transaction.checkout_request_id || `#${transaction.id}`,
      name: 'Customer',
      phone: transaction.phone_number,
      package_name: transaction.package_id ? `Package ${transaction.package_id}` : 'Account top-up',
      created_at: formatDate(transaction.created_at)
    };
  }

  async function loadDashboard(key) {
    const results = await Promise.allSettled([
      getJson(ENDPOINTS.stats, key),
      getJson('/admin/analytics?days=90', key),
      getJson(ENDPOINTS.sessions, key),
      getJson(ENDPOINTS.payments, key)
    ]);
    const authFailure = results.find(result => result.status === 'rejected' && [401, 403].includes(result.reason.status));
    if (authFailure) throw authFailure.reason;

    const stats = results[0].status === 'fulfilled' ? results[0].value : null;
    const analytics = results[1].status === 'fulfilled' ? results[1].value.data || [] : [];
    const hasLiveData = results.some(result => result.status === 'fulfilled');
    state.demoMode = !hasLiveData;
    if (hasLiveData) {
      state.analytics = analytics;
      const thisMonth = new Date().toISOString().slice(0, 7);
      const monthlyRows = analytics.filter(row => row.date.startsWith(thisMonth));
      const selectedRows = state.period === 'today' ? analytics.slice(-1) : analytics.slice(state.period === '7days' ? -7 : -30);
      const yesterday = analytics[analytics.length - 2];
      const yesterdayRevenue = Number(yesterday?.revenue || 0);
      const todayRevenue = Number(stats?.today_revenue ?? analytics[analytics.length - 1]?.revenue ?? 0);
      state.overview = {
        connected_count: Number(stats?.active_sessions ?? 0),
        today_revenue: todayRevenue,
        month_revenue: monthlyRows.reduce((sum, row) => sum + Number(row.revenue || 0), 0),
        successful_payments: selectedRows.reduce((sum, row) => sum + Number(row.transactions || 0), 0),
        monthly_payments: monthlyRows.reduce((sum, row) => sum + Number(row.transactions || 0), 0),
        success_rate: stats?.total_transactions ? (stats.successful_transactions / stats.total_transactions) * 100 : 0,
        daily_change: yesterdayRevenue ? ((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100 : 0,
        revenue_series: analytics.map(row => ({ label: new Date(`${row.date}T00:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric' }), amount: Number(row.revenue || 0) })),
        packages: []
      };
      if (results[2].status === 'fulfilled') {
        state.sessions = (results[2].value.data || []).map(mapSession);
        state.sessionTotal = results[2].value.pagination?.total ?? state.sessions.length;
      } else { state.sessions = []; state.sessionTotal = 0; }
      if (results[3].status === 'fulfilled') {
        state.payments = (results[3].value.data || []).map(mapTransaction);
        state.paymentTotal = results[3].value.pagination?.total ?? state.payments.length;
      } else { state.payments = []; state.paymentTotal = 0; }
    }
  }

  async function refreshDashboard() {
    const button = $('refreshButton');
    button.disabled = true;
    button.textContent = '…';
    let key = adminKey();
    if (!key) {
      state.demoMode = true;
      renderAll();
      toast('Admin key not provided. Showing sample data.');
    } else {
      try {
        await loadDashboard(key);
      } catch (error) {
        if ([401, 403].includes(error.status)) {
          sessionStorage.removeItem('fastwifi-admin-key');
          key = window.prompt('Admin key rejected. Enter a valid FastWiFi admin API key');
          if (key) {
            sessionStorage.setItem('fastwifi-admin-key', key.trim());
            try { await loadDashboard(key.trim()); } catch (retryError) { toast(`Could not load admin data: ${retryError.message}`); }
          } else {
            state.demoMode = true;
          }
        } else {
          toast(`Could not load admin data: ${error.message}`);
        }
      }
      renderAll();
      $('lastUpdated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      if (!state.demoMode) toast('Dashboard refreshed.');
      else if (!key) toast('Admin key not provided. Showing sample data.');
    }
    button.disabled = false;
    button.textContent = '↻';
  }

  function renderAll() {
    renderMetrics();
    renderChart();
    renderPackages();
    renderSessions();
    renderPayments();
    $('demoBanner').classList.toggle('hidden', !state.demoMode);
    $('networkStatus').textContent = state.demoMode ? 'Demo mode' : 'API connected';
    $('navConnectedCount').textContent = String(state.overview.connected_count ?? state.sessions.length);
    $('todayLabel').textContent = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function renderMetrics() {
    const o = state.overview || {};
    $('connectedMetric').textContent = Number(o.connected_count ?? state.sessions.length).toLocaleString();
    $('dailyRevenue').textContent = kes(o.today_revenue);
    $('monthlyRevenue').textContent = kes(o.month_revenue);
    const periodRows = state.period === 'today' ? state.analytics.slice(-1) : state.analytics.slice(state.period === '7days' ? -7 : -30);
    const periodPayments = state.demoMode ? o.successful_payments : periodRows.reduce((sum, row) => sum + Number(row.transactions || 0), 0);
    $('paymentCount').textContent = Number(periodPayments || 0).toLocaleString();
    $('monthlyPayments').textContent = `${Number(o.monthly_payments || 0).toLocaleString()} payments`;
    $('successRate').textContent = `${Number(o.success_rate || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}% success`;
    const change = Number(o.daily_change || 0);
    $('dailyChange').textContent = `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
    $('dailyChange').className = `metric-chip ${change >= 0 ? 'positive' : ''}`;
    $('connectedNote').textContent = 'Active sessions';
  }

  function getSeries() {
    let series = state.overview?.revenue_series;
    if (!Array.isArray(series) || !series.length) series = state.demoMode ? demo.overview.revenue_series : [];
    if (state.period === 'today') return series.slice(-7);
    if (state.period === '7days') return series.slice(-7);
    return series.slice(-30);
  }

  function renderChart() {
    const series = getSeries();
    if (!series.length) {
      $('chartTotal').textContent = kes(0);
      $('chartCaption').textContent = 'No analytics data available';
      $('chartYLabels').innerHTML = '<span>0</span><span>0</span><span>0</span><span>0</span>';
      $('revenueChart').innerHTML = '';
      return;
    }
    const max = Math.max(1, ...series.map(x => Number(x.amount || x.revenue || 0)));
    const total = series.reduce((sum, x) => sum + Number(x.amount || x.revenue || 0), 0);
    $('chartTotal').textContent = kes(total);
    $('chartCaption').textContent = state.period === 'today' ? 'daily trend · last 7 days' : state.period === '7days' ? 'last 7 days' : 'last 30 days';
    $('chartYLabels').innerHTML = [max, max * .67, max * .33, 0].map(v => `<span>${v === 0 ? '0' : (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : Math.round(v))}</span>`).join('');
    $('revenueChart').innerHTML = series.map((item, index) => {
      const amount = Number(item.amount || item.revenue || 0);
      const height = Math.max(3, (amount / max) * 100);
      return `<div class="bar-column" title="${safe(item.label)}: ${kes(amount)}"><div class="bar ${index === series.length - 1 ? 'current' : ''}" style="height:${height}%"></div><span class="bar-label">${safe(item.label)}</span></div>`;
    }).join('');
  }

  function renderPackages() {
    const packages = Array.isArray(state.overview?.packages) ? state.overview.packages : [];
    if (!packages.length) {
      $('packageList').innerHTML = '<p class="empty-cell">No package performance data available.</p>';
      return;
    }
    const max = Math.max(1, ...packages.map(p => Number(p.revenue || p.sales || 0)));
    $('packageList').innerHTML = packages.slice(0, 5).map(p => {
      const measure = Number(p.revenue || p.sales || 0);
      const salesText = `${Number(p.sales || 0).toLocaleString()} sales`;
      return `<div class="package-row"><div><div class="package-name">${safe(p.name || p.package_name || 'WiFi package')}</div><div class="package-sales">${salesText}</div></div><div class="package-price">${kes(p.revenue || 0)}</div><div class="package-progress"><span style="width:${Math.max(3, measure / max * 100)}%"></span></div></div>`;
    }).join('');
  }

  function renderSessions() {
    const query = ($('customerSearch').value || '').toLowerCase().trim();
    const sessions = state.sessions.filter(s => [s.name, s.phone, s.device, s.ip, s.package_name].some(v => String(v || '').toLowerCase().includes(query)));
    $('connectedTableCount').textContent = `${state.sessionTotal} online`;
    $('connectedFooter').textContent = `Showing ${sessions.length} of ${state.sessionTotal} connected sessions (maximum 100 loaded)`;
    if (!sessions.length) {
      $('connectedTableBody').innerHTML = '<tr><td colspan="6" class="empty-cell">No connected customers match your search.</td></tr>';
      return;
    }
    $('connectedTableBody').innerHTML = sessions.map(s => `<tr>
      <td><div class="customer-cell"><span class="mini-avatar">${safe(initials(s.name))}</span><div><div class="customer-name">${safe(s.name || 'Customer')}</div><div class="customer-sub">${safe(s.phone || 'Phone unavailable')}</div></div></div></td>
      <td><div class="device-text">${safe(s.device || 'Unknown device')}</div><div class="device-sub">${safe(s.ip || 'IP unavailable')}</div></td>
      <td>${safe(s.package_name || s.package || '—')}</td><td>${safe(s.connected_since || s.started_at || '—')}</td><td>${safe(s.remaining || s.time_remaining || '—')}</td>
      <td><span class="status-badge ${String(s.status || 'online').toLowerCase() === 'online' ? 'online' : 'expired'}">${safe(s.status || 'Online')}</span></td>
    </tr>`).join('');
  }

  function renderPayments() {
    const payments = state.showAllPayments ? state.payments : state.payments.slice(0, 8);
    $('paymentsFooter').textContent = `Showing ${payments.length} of ${state.paymentTotal} transactions (maximum 100 loaded)`;
    if (!payments.length) {
      $('paymentsTableBody').innerHTML = '<tr><td colspan="6" class="empty-cell">No payments found.</td></tr>';
      return;
    }
    $('paymentsTableBody').innerHTML = payments.map(p => {
      const rawStatus = String(p.status || 'pending').toLowerCase();
      const statusClass = ['success', 'successful', 'completed', 'paid'].includes(rawStatus) ? 'success' : rawStatus === 'failed' || rawStatus === 'cancelled' ? 'failed' : 'pending';
      const statusLabel = statusClass === 'success' ? 'Successful' : statusClass === 'failed' ? 'Failed' : 'Pending';
      return `<tr><td><div class="customer-name">${safe(p.reference || p.transaction_id || p.id || '—')}</div><div class="customer-sub">M-Pesa</div></td>
        <td><div class="customer-name">${safe(p.name || 'Customer')}</div><div class="customer-sub">${safe(p.phone || p.phone_number || 'Phone unavailable')}</div></td>
        <td>${safe(p.package_name || p.package || '—')}</td><td>${safe(p.created_at || p.date || '—')}</td>
        <td class="amount">${kes(p.amount)}</td><td><span class="status-badge ${statusClass}">${statusLabel}</span></td></tr>`;
    }).join('');
  }

  function exportCsv() {
    const rows = [['Transaction', 'Customer', 'Phone', 'Package', 'Date', 'Amount (KES)', 'Status']];
    state.payments.forEach(p => rows.push([
      p.reference || p.transaction_id || p.id || '',
      p.name || 'Customer',
      p.phone || p.phone_number || '',
      p.package_name || p.package || '',
      p.created_at || p.date || '',
      Number(p.amount || 0),
      p.status || ''
    ]));
    const csv = rows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fastwifi-payments-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Payments CSV exported.');
  }

  let toastTimer;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  function setupEvents() {
    $('refreshButton').addEventListener('click', refreshDashboard);
    $('exportButton').addEventListener('click', exportCsv);
    $('periodSelect').addEventListener('change', event => { state.period = event.target.value; renderMetrics(); renderChart(); });
    $('customerSearch').addEventListener('input', renderSessions);
    $('menuButton').addEventListener('click', () => {
      const open = $('sidebar').classList.toggle('open');
      $('menuButton').setAttribute('aria-expanded', String(open));
    });
    document.querySelectorAll('.nav-item').forEach(link => link.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
      link.classList.add('active');
      $('sidebar').classList.remove('open');
      $('menuButton').setAttribute('aria-expanded', 'false');
    }));
    $('viewAllPayments').addEventListener('click', event => {
      event.preventDefault();
      state.showAllPayments = !state.showAllPayments;
      event.currentTarget.innerHTML = state.showAllPayments ? 'Show recent <span>→</span>' : 'View all <span>→</span>';
      renderPayments();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupEvents();
    renderAll();
    refreshDashboard();
  });
})();
