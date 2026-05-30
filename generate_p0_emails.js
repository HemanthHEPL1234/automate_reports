/**
 * OpenProject Daily Bug Email Notifier
 * 1. P0 pending bugs — HTML email per assignee
 * 2. Status report — personalized XLSX (Developed / In-Progress / New + Pivots) per assignee
 */

const https      = require('node:https');
const nodemailer = require('nodemailer');
const XLSX       = require('xlsx');

const TOKEN           = process.env.OP_TOKEN;
const PROJECT_ID      = 3;
const IST_OFFSET_MS   = (5 * 60 + 30) * 60 * 1000;
const TYPE_BUG        = 7;
const PRIORITY_P0     = 10;
const EXCLUDED_P0     = ['8', '9', '10', '12', '16']; // Developed, In Testing, Test Passed, Closed, RfT

const STATUS_NEW          = 1;
const STATUS_IN_PROGRESS  = 7;
const STATUS_DEVELOPED    = 8;

// OpenProject assignee name → work email
const TEST_RECIPIENTS = 'hemanth.a@hepl.com, ghr30042001@gmail.com';
const ASSIGNEE_EMAILS = {
  'Mubarak K':          TEST_RECIPIENTS,
  'Retchagaraj D':      TEST_RECIPIENTS,
  'Divya Priya T':      TEST_RECIPIENTS,
  'Prakash Kannan':     TEST_RECIPIENTS,
  'Premkumar L':        TEST_RECIPIENTS,
  'Thanneeru Mahendra': TEST_RECIPIENTS,
  'Mani Veerendra':     TEST_RECIPIENTS,
  'Hemanth A':          TEST_RECIPIENTS,
  'Aruna S':            TEST_RECIPIENTS,
  'Rajesh C':           TEST_RECIPIENTS,
  'Akhilesh P':         TEST_RECIPIENTS,
  'Nannuri K':          TEST_RECIPIENTS,
  'Dhamotharan M':      TEST_RECIPIENTS,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const d = new Date(Date.now() + IST_OFFSET_MS);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ── OpenProject fetchers ──────────────────────────────────────────────────────

async function fetchBugsByFilter(filters) {
  const encoded = encodeURIComponent(JSON.stringify(filters));
  const pageSize = 500;
  let offset = 1;
  let all = [];
  while (true) {
    const resp = await apiGet(`/api/v3/projects/${PROJECT_ID}/work_packages?filters=${encoded}&pageSize=${pageSize}&offset=${offset}`);
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

// ── XLSX builder ──────────────────────────────────────────────────────────────

function applyHeaderStyle(ws, headers) {
  headers.forEach((_, col) => {
    const ref = XLSX.utils.encode_cell({ r: 0, c: col });
    if (!ws[ref]) return;
    ws[ref].s = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '1F4E79' } },
      alignment: { horizontal: 'center' },
    };
  });
}

function makeSheet(data, colWidths) {
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = colWidths;
  applyHeaderStyle(ws, data[0]);
  return ws;
}

function buildStatusReport(assignee, devBugs, ipBugs, newBugs) {
  const mine = bugs => bugs.filter(wp => (wp._links?.assignee?.title || 'Unassigned') === assignee);
  const myDev  = mine(devBugs);
  const myIP   = mine(ipBugs);
  const myNew  = mine(newBugs);
  const allMine = [...myNew, ...myIP, ...myDev];

  if (allMine.length === 0) return null;

  const row = wp => [
    wp.id,
    wp.subject || '',
    wp._links?.status?.title || '',
    wp._links?.priority?.title || '',
    formatIST(wp.createdAt),
    ageDays(wp.createdAt),
  ];
  const baseHeaders = ['ID', 'Subject', 'Status', 'Priority', 'Created on (IST)', 'Age (days)'];
  const baseCols    = [{ wch: 8 }, { wch: 55 }, { wch: 16 }, { wch: 16 }, { wch: 26 }, { wch: 12 }];

  const wb = XLSX.utils.book_new();

  // Sheet 1 — Developed (only if bugs exist)
  if (myDev.length > 0) {
    const s1 = [baseHeaders, ...myDev.map(row), [], ['Total', myDev.length]];
    XLSX.utils.book_append_sheet(wb, makeSheet(s1, baseCols), 'Developed Bugs');
  }

  // Sheet 2 — In-Progress (only if bugs exist)
  if (myIP.length > 0) {
    const s2 = [baseHeaders, ...myIP.map(row), [], ['Total', myIP.length]];
    XLSX.utils.book_append_sheet(wb, makeSheet(s2, baseCols), 'In-Progress Bugs');
  }

  // Sheet 3 — New (only if bugs exist)
  if (myNew.length > 0) {
    const s3 = [baseHeaders, ...myNew.map(row), [], ['Total', myNew.length]];
    XLSX.utils.book_append_sheet(wb, makeSheet(s3, baseCols), 'New Bugs');
  }

  // Sheet 4 — Pivot Assignee × Status (only their bugs)
  const statusCounts = {};
  allMine.forEach(wp => {
    const s = wp._links?.status?.title || 'Unknown';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });
  const statuses = Object.keys(statusCounts).sort((a, b) => a.localeCompare(b));
  const pivotS   = [['Assignee', ...statuses], [assignee, ...statuses.map(s => statusCounts[s] || 0)]];
  XLSX.utils.book_append_sheet(wb, makeSheet(pivotS, [{ wch: 25 }, ...statuses.map(() => ({ wch: 18 }))]), 'Pivot - Status');

  // Sheet 5 — Pivot Assignee × Priority (only their bugs)
  const priorityCounts = {};
  allMine.forEach(wp => {
    const p = wp._links?.priority?.title || 'Unknown';
    priorityCounts[p] = (priorityCounts[p] || 0) + 1;
  });
  const priorities = Object.keys(priorityCounts).sort((a, b) => a.localeCompare(b));
  const pivotP     = [['Assignee', ...priorities], [assignee, ...priorities.map(p => priorityCounts[p] || 0)]];
  XLSX.utils.book_append_sheet(wb, makeSheet(pivotP, [{ wch: 25 }, ...priorities.map(() => ({ wch: 18 }))]), 'Pivot - Priority');

  return {
    buffer: XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }),
    counts: { dev: myDev.length, ip: myIP.length, newB: myNew.length, total: allMine.length },
  };
}

// ── P0 HTML email ─────────────────────────────────────────────────────────────

function buildP0Html(assigneeName, bugs) {
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
  <div style="max-width:960px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
    <div style="background:#1e3a5f;padding:24px 32px">
      <h1 style="margin:0;color:#fff;font-size:20px">🚨 P0 Bug Alert</h1>
      <p style="margin:6px 0 0;color:#93c5fd;font-size:14px">
        Hi ${assigneeName} — you have <strong>${bugs.length}</strong> pending P0 bug${bugs.length > 1 ? 's' : ''} as of ${todayIST()} IST
      </p>
    </div>
    <div style="padding:24px 32px;overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1e3a5f">
            <th style="padding:10px 12px;color:#fff;text-align:left">ID</th>
            <th style="padding:10px 12px;color:#fff;text-align:left">Subject</th>
            <th style="padding:10px 12px;color:#fff;text-align:left">Status</th>
            <th style="padding:10px 12px;color:#fff;text-align:left">Created On (IST)</th>
            <th style="padding:10px 12px;color:#fff;text-align:left">Last Status Change (IST)</th>
            <th style="padding:10px 12px;color:#fff;text-align:center">Age (days)</th>
            <th style="padding:10px 12px;color:#fff;text-align:center">Days in Current Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
      This is an automated daily report. Please resolve or update the status of these bugs.
    </div>
  </div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  // ── Part 1: P0 emails ──────────────────────────────────────────────────────
  console.log('\n── P0 Bug Emails ──');
  const p0Bugs = await fetchBugsByFilter([
    { type:     { operator: '=', values: [String(TYPE_BUG)] } },
    { priority: { operator: '=', values: [String(PRIORITY_P0)] } },
    { status:   { operator: '!', values: EXCLUDED_P0 } },
  ]);
  console.log(`  Found ${p0Bugs.length} P0 pending bugs.`);

  const lastChanges = await Promise.all(p0Bugs.map(wp => fetchLastStatusChange(wp.id)));

  const p0ByAssignee = {};
  p0Bugs.forEach((wp, i) => {
    const assignee = wp._links?.assignee?.title || 'Unassigned';
    if (!p0ByAssignee[assignee]) p0ByAssignee[assignee] = [];
    p0ByAssignee[assignee].push({
      id:               wp.id,
      subject:          wp.subject || '',
      status:           wp._links?.status?.title || '',
      createdOn:        formatIST(wp.createdAt),
      lastStatusChange: formatIST(lastChanges[i]),
      ageDays:          ageDays(wp.createdAt),
      daysInStatus:     lastChanges[i] ? ageDays(lastChanges[i]) : ageDays(wp.createdAt),
    });
  });

  let p0Sent = 0;
  for (const [assignee, bugs] of Object.entries(p0ByAssignee)) {
    const to = ASSIGNEE_EMAILS[assignee];
    if (!to) { console.log(`  Skipped P0: "${assignee}" — no email mapping.`); continue; }
    await transporter.sendMail({
      from:    `"CADP Bug Tracker" <${process.env.GMAIL_USER}>`,
      to,
      subject: `[P0 Alert] ${bugs.length} pending P0 bug${bugs.length > 1 ? 's' : ''} — ${todayIST()}`,
      html:    buildP0Html(assignee, bugs),
    });
    console.log(`  ✅ P0 sent to ${assignee} — ${bugs.length} bug(s)`);
    p0Sent++;
  }
  console.log(`  P0 emails sent: ${p0Sent}`);

  // ── Part 2: Status report XLSX emails ─────────────────────────────────────
  console.log('\n── Status Report Emails ──');
  const [devBugs, ipBugs, newBugs] = await Promise.all([
    fetchBugsByFilter([{ type: { operator: '=', values: [String(TYPE_BUG)] } }, { status: { operator: '=', values: [String(STATUS_DEVELOPED)] } }]),
    fetchBugsByFilter([{ type: { operator: '=', values: [String(TYPE_BUG)] } }, { status: { operator: '=', values: [String(STATUS_IN_PROGRESS)] } }]),
    fetchBugsByFilter([{ type: { operator: '=', values: [String(TYPE_BUG)] } }, { status: { operator: '=', values: [String(STATUS_NEW)] } }]),
  ]);
  console.log(`  Developed: ${devBugs.length} | In-Progress: ${ipBugs.length} | New: ${newBugs.length}`);

  const allAssignees = new Set([
    ...devBugs.map(wp => wp._links?.assignee?.title || 'Unassigned'),
    ...ipBugs.map(wp =>  wp._links?.assignee?.title || 'Unassigned'),
    ...newBugs.map(wp => wp._links?.assignee?.title || 'Unassigned'),
  ]);

  let reportSent = 0;
  for (const assignee of allAssignees) {
    const to = ASSIGNEE_EMAILS[assignee];
    if (!to) { console.log(`  Skipped report: "${assignee}" — no email mapping.`); continue; }

    const result = buildStatusReport(assignee, devBugs, ipBugs, newBugs);
    if (!result) continue;

    const { buffer, counts } = result;
    await transporter.sendMail({
      from:    `"CADP Bug Tracker" <${process.env.GMAIL_USER}>`,
      to,
      subject: `[Bug Status Report] ${counts.total} bug${counts.total > 1 ? 's' : ''} — ${todayIST()}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
          <div style="background:#1e3a5f;padding:24px 32px">
            <h1 style="margin:0;color:#fff;font-size:20px">📊 Bug Status Report</h1>
            <p style="margin:6px 0 0;color:#93c5fd;font-size:14px">Hi ${assignee} — your daily bug status report is attached.</p>
          </div>
          <div style="padding:24px 32px">
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr style="background:#f3f4f6">
                <td style="padding:10px 16px;font-weight:600">New</td>
                <td style="padding:10px 16px;text-align:right;font-weight:700;color:#dc2626">${counts.newB}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;font-weight:600">In-Progress</td>
                <td style="padding:10px 16px;text-align:right;font-weight:700;color:#d97706">${counts.ip}</td>
              </tr>
              <tr style="background:#f3f4f6">
                <td style="padding:10px 16px;font-weight:600">Developed</td>
                <td style="padding:10px 16px;text-align:right;font-weight:700;color:#16a34a">${counts.dev}</td>
              </tr>
              <tr style="border-top:2px solid #e5e7eb">
                <td style="padding:10px 16px;font-weight:700">Total</td>
                <td style="padding:10px 16px;text-align:right;font-weight:700">${counts.total}</td>
              </tr>
            </table>
          </div>
          <div style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
            This is an automated daily report. Please resolve and if resolved, update the status of these bugs. The full breakdown is in the attached XLSX file.
          </div>
        </div>`,
      attachments: [{
        filename: `Bug_Report_${assignee.replace(/\s+/g, '_')}_${todayIST()}.xlsx`,
        content:  buffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    });
    console.log(`  ✅ Report sent to ${assignee} — Dev:${counts.dev} IP:${counts.ip} New:${counts.newB}`);
    reportSent++;
  }
  console.log(`  Report emails sent: ${reportSent}`);
  console.log('\nDone.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
