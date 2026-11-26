'use strict';

const { completedWaterChange } = require('./compare-anomaly');

function fmtNum(n) {
  if (n == null) return '—';
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n}%`;
}

function fmtSignedNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const num = Number(n);
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMeasure(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function withUnit(text, unit, html) {
  if (!unit) return text;
  const suffix = html ? ` ${escapeHtml(unit)}` : ` ${unit}`;
  return `${text}${suffix}`;
}

function fmtTempTrio(conditions, html) {
  const c = conditions || {};
  if (c.averageTemperature == null && c.setTemperature == null && c.outsideTemperature == null) {
    return '—';
  }
  const parts = [c.averageTemperature, c.setTemperature, c.outsideTemperature].map((n) =>
    n == null ? '—' : fmtMeasure(n),
  );
  return withUnit(parts.join(' / '), c.temperatureUnit, html);
}

function fmtHumidity(conditions) {
  if (conditions?.insideHumidity == null) return '—';
  return `${fmtMeasure(conditions.insideHumidity)}%`;
}

function fmtPressure(conditions, html) {
  const c = conditions || {};
  if (c.staticPressure == null) return '—';
  return withUnit(fmtMeasure(c.staticPressure), c.pressureUnit, html);
}

function fmtVent(conditions) {
  if (conditions?.ventLevel == null) return '—';
  return fmtMeasure(conditions.ventLevel);
}

const LIVE_COLUMNS = [
  { key: 'temp', label: 'Temp avg / set / out' },
  { key: 'humidity', label: 'Humidity' },
  { key: 'pressure', label: 'Static pressure' },
  { key: 'vent', label: 'Vent level' },
];

function conditionsCell(house, key, html) {
  const c = house.conditions || {};
  if (key === 'temp') return fmtTempTrio(c, html);
  if (key === 'humidity') return fmtHumidity(c);
  if (key === 'pressure') return fmtPressure(c, html);
  if (key === 'vent') return fmtVent(c);
  return '—';
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

function sameSlotFields(house) {
  const slot = house.sameSlot || {};
  const soFar = slot.waterSoFar != null ? slot.waterSoFar : house.water?.todayTotal;
  if (!slot.hasPrevious) {
    return {
      soFarText: fmtNum(soFar),
      yesterdayText: '—',
      deltaGalText: '—',
      deltaPctText: '—',
    };
  }
  return {
    soFarText: fmtNum(slot.waterSoFar),
    yesterdayText: fmtNum(slot.yesterdayWater),
    deltaGalText: fmtSignedNum(slot.deltaGallons),
    deltaPctText: fmtPct(slot.deltaPct),
  };
}

function fullDayPctText(house) {
  return fmtPct(completedWaterChange(house)?.pct);
}

function waterHistoryText(house) {
  const days = house.water?.last3Days ?? [];
  if (!days.length) return '—';
  return days.map((d) => `day ${d.growthDay}: ${fmtNum(d.total)}`).join(', ');
}

function heaterHistoryText(house) {
  const days = house.heaters?.last2Days ?? [];
  if (!days.length) return '—';
  return days.map((d) => `day ${d.growthDay}: ${fmtMinutes(d.total)}`).join(', ');
}

function climateText(house, html) {
  return LIVE_COLUMNS.map((col) => `${col.label}: ${conditionsCell(house, col.key, html)}`).join(' | ');
}

function connectionHtml(house) {
  return house.connectionStatus === 1
    ? '<span style="color:#16a34a">Online</span>'
    : '<span style="color:#dc2626">Offline</span>';
}

function worstSeverity(alerts) {
  if ((alerts || []).some((a) => a.severity === 'critical')) return 'critical';
  if ((alerts || []).some((a) => a.severity === 'warning')) return 'warning';
  return 'info';
}

function partitionHouses(houses, alerts) {
  const expanded = [];
  const healthy = [];
  for (const house of houses || []) {
    const list = (alerts || []).filter((a) => a.houseNumber === house.houseNumber);
    if (list.length) expanded.push({ house, alerts: list });
    else healthy.push(house);
  }
  expanded.sort((a, b) => {
    const rank = (SEVERITY_RANK[worstSeverity(a.alerts)] ?? 9) - (SEVERITY_RANK[worstSeverity(b.alerts)] ?? 9);
    if (rank !== 0) return rank;
    return (a.house.houseNumber ?? 0) - (b.house.houseNumber ?? 0);
  });
  healthy.sort((a, b) => (a.houseNumber ?? 0) - (b.houseNumber ?? 0));
  return { expanded, healthy };
}

function collapsedRow(house) {
  const slot = sameSlotFields(house);
  const climate = LIVE_COLUMNS.map(
    (col) =>
      `<td style="padding:8px;border:1px solid #e5e7eb;text-align:center">${conditionsCell(house, col.key, true)}</td>`,
  ).join('');
  return `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb">${house.houseName}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:center">${fmtNum(house.growthDay)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${slot.soFarText}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${slot.yesterdayText}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${slot.deltaGalText}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${slot.deltaPctText}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${fullDayPctText(house)}</td>
        ${climate}
      </tr>`;
}

function collapsedLine(house) {
  const slot = sameSlotFields(house);
  return `${house.houseName} | day ${fmtNum(house.growthDay)} | water so far ${slot.soFarText} | yesterday this time ${slot.yesterdayText} | same-time ${slot.deltaGalText} gal (${slot.deltaPctText}) | full-day ${fullDayPctText(house)} | ${waterHistoryText(house)} | ${climateText(house, false)}`;
}

function expandedHouseHtml(entry) {
  const house = entry.house;
  const slot = sameSlotFields(house);
  const reasons = entry.alerts
    .map(
      (a) =>
        `<li style="margin-bottom:4px"><strong style="color:${severityColor(a.severity)}">[${a.severity.toUpperCase()}]</strong> ${stripHousePrefix(a.message, house.houseName, house.houseNumber)}</li>`,
    )
    .join('');
  return `<section style="border:1px solid #fecaca;border-radius:8px;padding:12px 14px;margin:12px 0">
      <h3 style="margin:0 0 8px">${house.houseName} · day ${fmtNum(house.growthDay)} · ${connectionHtml(house)}</h3>
      <ul style="margin:0 0 8px;padding-left:18px">${reasons}</ul>
      <p style="margin:4px 0">Water so far <strong>${slot.soFarText}</strong> gal · yesterday this time <strong>${slot.yesterdayText}</strong> · ${slot.deltaGalText} gal (${slot.deltaPctText})</p>
      <p style="margin:4px 0">Full-day Δ% <strong>${fullDayPctText(house)}</strong> · last 3 flock days: ${waterHistoryText(house)}</p>
      <p style="margin:4px 0">Heater runtime: ${heaterHistoryText(house)} · 2-day total ${fmtMinutes(house.heaters?.last2DaysTotalMinutes)}</p>
      <p style="margin:4px 0">${climateText(house, true)}</p>
    </section>`;
}

function expandedHouseText(entry) {
  const house = entry.house;
  const slot = sameSlotFields(house);
  const lines = [`  ${house.houseName} (#${house.houseNumber}) [expanded] day ${fmtNum(house.growthDay)}`];
  for (const alert of entry.alerts) {
    lines.push(`    [${alert.severity.toUpperCase()}] ${stripHousePrefix(alert.message, house.houseName, house.houseNumber)}`);
  }
  lines.push(
    `    water so far ${slot.soFarText} | yesterday this time ${slot.yesterdayText} | same-time ${slot.deltaGalText} gal (${slot.deltaPctText}) | full-day ${fullDayPctText(house)} | ${waterHistoryText(house)}`,
  );
  lines.push(
    `    heater ${heaterHistoryText(house)} | 2-day total ${fmtMinutes(house.heaters?.last2DaysTotalMinutes)}`,
  );
  lines.push(`    ${climateText(house, false)}`);
  return lines.join('\n');
}

function failureTextFrom(item, itemError) {
  const chunks = [];
  const add = (value) => {
    if (value == null || value === '' || typeof value === 'boolean' || typeof value === 'number') return;
    if (typeof value === 'string') {
      chunks.push(value);
      return;
    }
    if (typeof value === 'object') {
      if (value.message) chunks.push(String(value.message));
      if (value.description && value.description !== value.message) chunks.push(String(value.description));
    }
  };
  add(item && item.message);
  add(item && item.error);
  add(itemError);
  const text = chunks.map((part) => String(part).trim()).filter(Boolean).join('\n');
  return text || 'Unknown error';
}

function isRunnerTimeout(text) {
  const s = String(text || '');
  if (/Request timeout after \d+ms/i.test(s)) return false;
  return /task runner|task execution timed out|timeout of \d+ms exceeded|ECONNABORTED|connection timed out|execution timed out|N8N_RUNNERS_TASK_TIMEOUT/i.test(
    s,
  );
}

function classifyFailure(text) {
  const s = String(text || '');
  if (/ConnectionToken/i.test(s)) {
    return { code: 'no_connection_token', label: 'No ConnectionToken' };
  }
  if (/gateway disconnected/i.test(s) || /GATEWAY_DISCONNECTED/.test(s)) {
    return { code: 'gateway_disconnected', label: 'Gateway disconnected' };
  }
  if (isRunnerTimeout(s)) {
    return { code: 'runner_timeout', label: 'Runner timeout' };
  }
  const line = s.split('\n').map((part) => part.trim()).find(Boolean) || 'Unknown error';
  const label = line.length > 80 ? `${line.slice(0, 77)}...` : line;
  return { code: 'other', label };
}

function buildFailureEmail({ item, itemError, farm, config, stamp } = {}) {
  const source = item || {};
  const farmLabel =
    source.farmName || farm?.displayName || source.farmId || farm?.id || 'unknown farm';
  const to = (config && config.recipientEmail) || 'you@example.com';
  const from = (config && config.senderEmail) || to;
  const detail = failureTextFrom(source, itemError);
  const cause = classifyFailure(detail);
  const imageStamp = (stamp && String(stamp).trim()) || source.libStamp || 'IMAGE_STAMP missing';
  const subject = `[RotemNet] ${cause.label} — ${farmLabel}`;
  const html = `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;color:#111827">
  <h2>${escapeHtml(cause.label)}</h2>
  <p><strong>Farm:</strong> ${escapeHtml(farmLabel)}</p>
  <p><strong>Cause:</strong> ${escapeHtml(cause.label)}</p>
  <p><strong>Image stamp:</strong> ${escapeHtml(imageStamp)}</p>
  <pre style="background:#fef2f2;padding:12px;border-radius:6px;white-space:pre-wrap">${escapeHtml(detail)}</pre>
</body>
</html>`;
  const text = [
    cause.label,
    `Farm: ${farmLabel}`,
    `Cause: ${cause.label}`,
    `Image stamp: ${imageStamp}`,
    '',
    detail,
  ].join('\n');
  return {
    to,
    from,
    subject,
    html,
    text,
    cause: cause.label,
    causeCode: cause.code,
    imageStamp,
    causeDetail: detail,
  };
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

  const { expanded, healthy } = partitionHouses(report.houses, report.alerts);
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

  <h2 style="margin-top:28px">Needs attention</h2>
  ${
    expanded.length
      ? expanded.map((entry) => expandedHouseHtml(entry)).join('')
      : '<p style="color:#16a34a">No house alerts. Every house is one line below.</p>'
  }

  <h2 style="margin-top:28px">Other houses</h2>
  <p style="color:#6b7280;font-size:13px;margin-top:0">Live conditions and water on one line. Growth day, water so far, yesterday at this time, and full-day change.</p>
  <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px">
    <thead>
      <tr style="background:#f0fdf4">
        <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">House</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Day</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Water so far</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Yesterday this time</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Δ gal</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Δ %</th>
        <th style="padding:8px;border:1px solid #e5e7eb">Full-day Δ%</th>
        ${LIVE_COLUMNS.map((col) => `<th style="padding:8px;border:1px solid #e5e7eb">${col.label}</th>`).join('')}
      </tr>
    </thead>
    <tbody>${healthy.length ? healthy.map((house) => collapsedRow(house)).join('') : '<tr><td colspan="11" style="padding:8px;border:1px solid #e5e7eb;color:#6b7280">None</td></tr>'}</tbody>
  </table>
  <p style="color:#6b7280;font-size:12px;margin-top:8px">Water so far is this run’s in-progress total. Yesterday this time is the same 6 AM or 6 PM snapshot from about 24 hours earlier. If that snapshot is missing, today’s number stays and the compare is left blank. Full-day Δ% compares the last two completed flock days. An unfinished day at zero is not an alert.</p>
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

  textLines.push('', 'Needs attention:');
  if (expanded.length === 0) {
    textLines.push('  None.');
  } else {
    for (const entry of expanded) textLines.push(expandedHouseText(entry));
  }

  textLines.push('', 'Other houses:');
  if (healthy.length === 0) {
    textLines.push('  None.');
  } else {
    for (const house of healthy) textLines.push(`  ${collapsedLine(house)}`);
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

module.exports = {
  buildEmail,
  buildFailureEmail,
  classifyFailure,
  groupAlertsByHouse,
};
