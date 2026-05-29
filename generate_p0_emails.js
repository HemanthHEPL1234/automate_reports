/**
 * OpenProject P0 Bug Email Notifier
 * Runs daily via GitHub Actions — sends each dev only their own pending P0 bugs.
 * "Pending" = any status except: Developed, In Testing, Test Passed, Closed, Ready for Testing
 */

const https    = require('node:https');
const nodemailer = require('nodemailer');

const TOKEN      = process.env.OP_TOKEN;
const PROJECT_ID = 3;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const TYPE_BUG   = 7;
const PRIORITY_P0 = 10;

// Excluded statuses — Developed=8, In Testing=9, Test Passed=10, Closed=12, Ready for Testing=16
const EXCLUDED_STATUSES = ['8', '9', '10', '12', '16'];

// OpenProject assignee name → work email
const ASSIGNEE_EMAILS = {
  'Mubarak K':          'ghr30042001@gmail.com',
  'Retchagaraj D':      'retchagaraj.d@hepl.com',
  'Divya Priya T':      'divya.t@hepl.com',
  'Prakash Kannan':     'prakash.k@hepl.com',
  'Premkumar L':        'prem.l@hepl.com',
  'Thanneeru Mahendra': 'thanneeru.m@hepl.com',
  'Mani Veerendra':     'mani.v@hepl.com',
  'Hemanth A':          'hemanth.a@hepl.com',
  'Aruna S':            'aruna.s@hepl.com',
  'Rajesh C':           'rajesh.c@hepl.com',
  'Akhilesh P':         'akhilesh.p@hepl.com',
  'Nannuri K':          'nannuri.k@hepl.com',
  'Dhamotharan M':      'dhamotharan.m@hepl.com',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`apikey:${TOKEN}`).toString('base64');
    const req = https.request(
      { hostname: 'pmt.cavininfotech.com', path, method: 'GET',
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse failed (HTTP ${res.statusCode}): ${data.slice(0, 200)}`, { cause: e })); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function formatIST(utcStr) {
  if (!utcStr) return '—';
  const istMs = new Date(utcStr).getTime() + IST_OFFSET_MS;
  const d = new Date(istMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

function ageDays(utcStr) {
  return Math.floor((Date.now() - new Date(utcStr).getTime()) / 864e5);
}

function todayIST() {
  const istMs = Date.now() + IST_OFFSET_MS;
  const d = new Date(istMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ── OpenProject fetchers ──────────────────────────────────────────────────────

async function fetchP0Bugs() {
  const filters = JSON.stringify([
    { type:     { operator: '=', values: [String(TYPE_BUG)] } },
    { priority: { operator: '=', values: [String(PRIORITY_P0)] } },
    { status:   { operator: '!', values: EXCLUDED_STATUSES } },
  ]);
  const pageSize = 500;
  let offset = 1;
  let all = [];
  while (true) {
    const url = `/api/v3/projects/${PROJECT_ID}/work_packages?filters=${encodeURIComponent(filters)}&pageSize=${pageSize}&offset=${offset}`;
    const resp = await apiGet(url);
    const items = resp._embedded?.elements || [];
    all = all.concat(items);
    if (all.length >= (resp.total || 0) || items.length === 0) break;
    offset += pageSize;
  }
  return all;
}

async function fetchLastStatusChange(wpId) {
  const resp = await apiGet(`/api/v3/work_packages/${wpId}/activities`);
  const activities = resp._embedded?.elements || [];
  let lastDate = null;
  for (const act of activities) {
    const changed = (act.details || []).some(d =>
      typeof d.raw === 'string' && d.raw.toLowerCase().startsWith('status changed')
    );
    if (changed) lastDate = act.createdAt;
  }
  return lastDate;
}

// ── Email builder ─────────────────────────────────────────────────────────────

function buildEmailHtml(assigneeName, bugs) {
  const rows = bugs.map(b => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#1d4ed8;font-weight:600">
        <a href="https://pmt.cavininfotech.com/work_packages/${b.id}" style="color:#1d4ed8;text-decoration:none">#${b.id}</a>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;max-width:400px">${b.subject}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap">
        <span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:9999px;font-size:12px">${b.status}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap;font-size:13px">${b.createdOn}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap;font-size:13px">${b.lastStatusChange}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:600;color:${b.ageDays > 30 ? '#dc2626' : '#374151'}">${b.ageDays}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:#374151">${b.daysInStatus}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f9fafb">
  <div style="max-width:960px;margin:24px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">

    <div style="background:#1e3a5f;padding:24px 32px">
      <h1 style="margin:0;color:#ffffff;font-size:20px">🚨 P0 Bug Alert</h1>
      <p style="margin:6px 0 0;color:#93c5fd;font-size:14px">
        Hi ${assigneeName} — you have <strong>${bugs.length}</strong> pending P0 bug${bugs.length > 1 ? 's' : ''} as of ${todayIST()} IST
      </p>
    </div>

    <div style="padding:24px 32px;overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1e3a5f">
            <th style="padding:10px 12px;color:#fff;text-align:left;font-weight:600">ID</th>
            <th style="padding:10px 12px;color:#fff;text-align:left;font-weight:600">Subject</th>
            <th style="padding:10px 12px;color:#fff;text-align:left;font-weight:600">Status</th>
            <th style="padding:10px 12px;color:#fff;text-align:left;font-weight:600">Created On (IST)</th>
            <th style="padding:10px 12px;color:#fff;text-align:left;font-weight:600">Last Status Change (IST)</th>
            <th style="padding:10px 12px;color:#fff;text-align:center;font-weight:600">Age (days)</th>
            <th style="padding:10px 12px;color:#fff;text-align:center;font-weight:600">Days in Current Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
      This is an automated daily report generated at 8:00 AM IST. Please resolve or update the status of these bugs.
    </div>
  </div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching P0 pending bugs...');
  const wps = await fetchP0Bugs();
  console.log(`  Found ${wps.length} bugs.`);

  console.log('Fetching last status-change timestamps...');
  const lastChanges = await Promise.all(wps.map(wp => fetchLastStatusChange(wp.id)));

  // Build per-bug data
  const bugData = wps.map((wp, i) => ({
    id:               wp.id,
    subject:          wp.subject || '',
    status:           wp._links?.status?.title || '',
    assignee:         wp._links?.assignee?.title || 'Unassigned',
    createdOn:        formatIST(wp.createdAt),
    lastStatusChange: formatIST(lastChanges[i]),
    ageDays:          ageDays(wp.createdAt),
    daysInStatus:     lastChanges[i] ? ageDays(lastChanges[i]) : ageDays(wp.createdAt),
  }));

  // Group by assignee
  const byAssignee = {};
  bugData.forEach(b => {
    if (!byAssignee[b.assignee]) byAssignee[b.assignee] = [];
    byAssignee[b.assignee].push(b);
  });

  // Set up Gmail transporter
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  // Send one email per assignee who has bugs + a known email
  let sent = 0;
  let skipped = 0;
  for (const [assignee, bugs] of Object.entries(byAssignee)) {
    const toEmail = ASSIGNEE_EMAILS[assignee];
    if (!toEmail) {
      console.log(`  Skipped: "${assignee}" — no email mapping.`);
      skipped++;
      continue;
    }
    const html = buildEmailHtml(assignee, bugs);
    await transporter.sendMail({
      from:    `"CADP Bug Tracker" <${process.env.GMAIL_USER}>`,
      to:      toEmail,
      subject: `[P0 Alert] ${bugs.length} pending P0 bug${bugs.length > 1 ? 's' : ''} — ${todayIST()}`,
      html,
    });
    console.log(`  ✅ Sent to ${assignee} <${toEmail}> — ${bugs.length} bug(s)`);
    sent++;
  }

  console.log(`\nDone. Emails sent: ${sent} | Skipped (no mapping): ${skipped}`);
  if (bugData.length === 0) console.log('No pending P0 bugs today — no emails sent.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
