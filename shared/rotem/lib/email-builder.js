'use strict';

const { completedWaterChange } = require('./compare-anomaly');

function fmtNum(n) {
  if (n == null) return '—';
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}

function fmtPct(n) {
  if (n == null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n}%`;
}

function fmtMinutes(m) {
  if (m == null) return '—';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}m`;
  return `${h}h ${min}m`;
}

function severityColor(severity) {
  if (severity === 'critical') return '#dc2626';
  if (severity === 'warning') return '#d97706';
  return '#2563eb';
}

function waterDayHeaders(houses) {
  const sample = (houses || []).find((h) => h.water?.last3Days?.length)?.water.last3Days;
  if (!sample?.length) return ['Day −2', 'Day −1', 'Today'];
  return sample.map((d) => `Day ${d.growthDay}`);
}

function heaterDayHeaders(houses) {
  const sample = (houses || []).find((h) => h.heaters?.last2Days?.length)?.heaters.last2Days;
  if (!sample?.length) return ['Prior day', 'Latest day'];
  return sample.map((d) => `Day ${d.growthDay}`);
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

function stripHousePrefix(message, houseName, houseNumber) {
  const prefix = `${houseName} (#${houseNumber}) `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

function groupAlertsByHouse(alerts) {
  const byHouse = new Map();
  for (const alert of alerts || []) {
    const key = alert.houseNumber ?? alert.houseName ?? 'farm';
    if (!byHouse.has(key)) byHouse.set(key, []);
    byHouse.get(key).push(alert);
  }

  const groups = [];
  for (const list of byHouse.values()) {
    const worst = list.some((a) => a.severity === 'critical') ? 'critical' : list[0].severity;
    const houseName = list[0].houseName;
    const houseNumber = list[0].houseNumber;
    const details = list.map((a) => stripHousePrefix(a.message, houseName, houseNumber));
    groups.push({
      severity: worst,
      houseNumber,
      houseName,
      message:
        houseName != null && houseNumber != null
          ? `${houseName} (#${houseNumber}): ${details.join('; ')}`
          : details.join('; '),
    });
  }

  groups.sort((a, b) => {
    const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (rank !== 0) return rank;
    return (a.houseNumber ?? 0) - (b.houseNumber ?? 0);
  });
  return groups;
}

function buildEmail(report, recipientEmail, reportPeriod) {
  const farmName = report.farmDisplayName || report.farmName || report.farmId;
  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: report.timezone || 'America/Chicago',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const periodLabel = reportPeriod === 'am' ? 'Morning' : 'Evening';
  const subject = `[RotemNet] ${farmName} — ${periodLabel} Report — ${dateStr}`;

  const growthDays = (report.houses || [])
    .map((h) => h.growthDay)
    .filter((d) => d != null);
  const minDay = growthDays.length ? Math.min(...growthDays) : '—';
  const maxDay = growthDays.length ? Math.max(...growthDays) : '—';
  const connected = (report.houses || []).filter((h) => h.connectionStatus === 1).length;
  const total = (report.houses || []).length;

  const wHeaders = waterDayHeaders(report.houses);
  const hHeaders = heaterDayHeaders(report.houses);

  const waterDetailRows = (report.houses || [])
    .map((h) => {
      const days = h.water?.last3Days ?? [];
      const cells = days.length
        ? days.map((d) => `<td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${fmtNum(d.total)}</td>`)
        : wHeaders.map(() => '<td style="padding:8px;border:1px solid #e5e7eb;text-align:right">—</td>');
      const status =
        h.connectionStatus === 1
          ? '<span style="color:#16a34a">Online</span>'
          : '<span style="color:#dc2626">Offline</span>';
      return `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb">${h.houseName}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:center">${fmtNum(h.growthDay)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:center">${status}</td>
        ${cells.join('')}
      </tr>`;
    })
    .join('');

  const heaterDetailRows = (report.houses || [])
    .map((h) => {
      const days = h.heaters?.last2Days ?? [];
      const cells = days.length
        ? days.map(
            (d) =>
              `<td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${fmtMinutes(d.total)}</td>`,
          )
        : hHeaders.map(() => '<td style="padding:8px;border:1px solid #e5e7eb;text-align:right">—</td>');
      const status =
        h.connectionStatus === 1
          ? '<span style="color:#16a34a">Online</span>'
          : '<span style="color:#dc2626">Offline</span>';
      return `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb">${h.houseName}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:center">${fmtNum(h.growthDay)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:center">${status}</td>
        ${cells.join('')}
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;font-weight:600">${fmtMinutes(h.heaters?.last2DaysTotalMinutes)}</td>
      </tr>`;
    })
    .join('');

  const summaryRows = (report.houses || [])
    .map((h) => {
      const status =
        h.connectionStatus === 1
          ? '<span style="color:#16a34a">Online</span>'
          : '<span style="color:#dc2626">Offline</span>';
      return `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb">${h.houseName}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:center">${fmtNum(h.growthDay)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:center">${status}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${fmtNum(h.water?.todayTotal)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${fmtNum(h.water?.yesterdayTotal)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${fmtPct(completedWaterChange(h)?.pct)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${fmtMinutes(h.heaters?.todayTotalMinutes)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${fmtMinutes(h.heaters?.yesterdayTotalMinutes)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${fmtPct(h.heaters?.pctChange)}</td>
      </tr>`;
    })
    .join('');

  const groupedAlerts = groupAlertsByHouse(report.alerts || []);
  const alertsHtml =
    groupedAlerts.length === 0
      ? '<p style="color:#16a34a">No anomalies detected.</p>'
      : `<ul style="padding-left:20px">${groupedAlerts
          .map(
            (a) =>
              `<li style="margin-bottom:6px"><strong style="color:${severityColor(a.severity)}">[${a.severity.toUpperCase()}]</strong> ${a.message}</li>`,
          )
          .join('')}</ul>`;

  const baselineNote = report.isBaseline
    ? `<p style="background:#fef3c7;padding:12px;border-radius:6px"><strong>Baseline run:</strong> ${report.comparisonNote}</p>`
    : `<p style="color:#6b7280;font-size:14px">${report.comparisonNote || ''}</p>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;color:#111827;max-width:960px;margin:0 auto;padding:20px">
  <h1 style="margin-bottom:4px">${farmName} — ${periodLabel} Overview</h1>
  <p style="color:#6b7280;margin-top:0">${dateStr} · ${connected}/${total} houses online · Growth days ${minDay}–${maxDay}</p>
  ${baselineNote}
  <h2 style="margin-top:24px">Alerts (${report.alertCount ?? 0})</h2>
  ${alertsHtml}

  <h2 style="margin-top:28px">Water — Last 3 Flock Days</h2>
  <p style="color:#6b7280;font-size:13px;margin-top:0">Daily water total per house (Rotem history, by flock day).</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:8px">
    <thead>
      <tr style="background:#eff6ff">
        <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">House</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Current day</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Status</th>
        ${wHeaders.map((h) => `<th style="padding:8px;border:1px solid #e5e7eb">${h}</th>`).join('')}
      </tr>
    </thead>
    <tbody>${waterDetailRows}</tbody>
  </table>

  <h2 style="margin-top:28px">Heater Runtime — Last 2 Flock Days</h2>
  <p style="color:#6b7280;font-size:13px;margin-top:0">Per-day heater runtime and 2-day total per house.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:8px">
    <thead>
      <tr style="background:#fff7ed">
        <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">House</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Current day</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Status</th>
        ${hHeaders.map((h) => `<th style="padding:8px;border:1px solid #e5e7eb">${h}</th>`).join('')}
        <th style="padding:8px;border:1px solid #e5e7eb">2-day total</th>
      </tr>
    </thead>
    <tbody>${heaterDetailRows}</tbody>
  </table>

  <h2 style="margin-top:28px">Day-over-Day Summary</h2>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:8px">
    <thead>
      <tr style="background:#f3f4f6">
        <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">House</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Day</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Status</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Water today</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Last full day</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Full-day Δ%</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Heater today</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Heater yday</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Heater Δ%</th>
      </tr>
    </thead>
    <tbody>${summaryRows}</tbody>
  </table>
  <p style="color:#6b7280;font-size:12px;margin-top:8px">Water today is still in progress. Full-day Δ% compares the last completed flock day with the day before it.</p>
  <p style="color:#9ca3af;font-size:12px;margin-top:32px">Generated by n8n Poultry RotemNet workflow · ${report.reportTime}</p>
</body>
</html>`;

  const textLines = [
    `${farmName} — ${periodLabel} Overview`,
    dateStr,
    `${connected}/${total} houses online · Growth days ${minDay}–${maxDay}`,
    '',
    report.isBaseline ? `Baseline: ${report.comparisonNote}` : report.comparisonNote || '',
    '',
    `Alerts (${report.alertCount ?? 0}):`,
  ];

  if (groupedAlerts.length === 0) {
    textLines.push('  No anomalies detected.');
  } else {
    for (const a of groupedAlerts) {
      textLines.push(`  [${a.severity.toUpperCase()}] ${a.message}`);
    }
  }

  textLines.push('', 'Water — Last 3 flock days:');
  for (const h of report.houses || []) {
    const days = (h.water?.last3Days ?? [])
      .map((d) => `day ${d.growthDay}: ${fmtNum(d.total)}`)
      .join(', ');
    textLines.push(`  ${h.houseName}: ${days || '—'}`);
  }

  textLines.push('', 'Heater — Last 2 flock days (total):');
  for (const h of report.houses || []) {
    const days = (h.heaters?.last2Days ?? [])
      .map((d) => `day ${d.growthDay}: ${fmtMinutes(d.total)}`)
      .join(', ');
    textLines.push(
      `  ${h.houseName}: ${days || '—'} | 2-day total: ${fmtMinutes(h.heaters?.last2DaysTotalMinutes)}`,
    );
  }

  textLines.push('', 'Day-over-day summary:');
  for (const h of report.houses || []) {
    textLines.push(
      `  ${h.houseName} | water today ${h.water?.todayTotal} (in progress) | last full day ${h.water?.yesterdayTotal} (${fmtPct(completedWaterChange(h)?.pct)} vs day before) | heater ${fmtMinutes(h.heaters?.todayTotalMinutes)} vs yday ${fmtMinutes(h.heaters?.yesterdayTotalMinutes)} (${fmtPct(h.heaters?.pctChange)})`,
    );
  }

  return {
    subject,
    html,
    text: textLines.join('\n'),
    to: recipientEmail,
    farmId: report.farmId,
    farmName,
    alertCount: report.alertCount ?? 0,
    hasCritical: report.hasCritical ?? false,
  };
}

module.exports = { buildEmail, groupAlertsByHouse };
