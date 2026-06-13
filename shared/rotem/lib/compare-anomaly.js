'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.ROTEM_DATA_ROOT || '/data/shared/rotem';
const HISTORY_DIR = path.join(CONFIG_DIR, 'history');

function historyPath(farmId) {
  return path.join(HISTORY_DIR, farmId, 'latest.json');
}

function archivePath(farmId, reportPeriod) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(HISTORY_DIR, farmId, `${date}-${reportPeriod}.json`);
}

function loadSnapshot(farmId) {
  const filePath = historyPath(farmId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveSnapshot(report, reportPeriod) {
  const farmId = report.farmId;
  const dir = path.join(HISTORY_DIR, farmId);
  fs.mkdirSync(dir, { recursive: true });

  const snapshot = {
    savedAt: new Date().toISOString(),
    reportPeriod,
    farmId: report.farmId,
    farmName: report.farmName,
    houses: (report.houses || []).map((h) => ({
      houseNumber: h.houseNumber,
      houseName: h.houseName,
      growthDay: h.growthDay,
      connectionStatus: h.connectionStatus,
      waterTodayTotal: h.water?.todayTotal ?? 0,
      heaterTodayMinutes: h.heaters?.todayTotalMinutes ?? 0,
    })),
  };

  fs.writeFileSync(historyPath(farmId), JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(archivePath(farmId, reportPeriod), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

function compareWithSnapshot(currentReport, previousSnapshot) {
  if (!previousSnapshot) {
    return {
      ...currentReport,
      isBaseline: true,
      comparisonNote: 'First run — no prior snapshot for day-over-day comparison.',
      houses: currentReport.houses.map((h) => ({
        ...h,
        comparison: { hasPrevious: false },
      })),
    };
  }

  const prevByHouse = {};
  for (const h of previousSnapshot.houses || []) {
    prevByHouse[h.houseNumber] = h;
  }

  const houses = currentReport.houses.map((house) => {
    const prev = prevByHouse[house.houseNumber];
    if (!prev) {
      return { ...house, comparison: { hasPrevious: false } };
    }

    const waterDelta = house.water.todayTotal - prev.waterTodayTotal;
    const heaterDelta = house.heaters.todayTotalMinutes - prev.heaterTodayMinutes;
    const waterPct =
      prev.waterTodayTotal > 0
        ? Math.round((waterDelta / prev.waterTodayTotal) * 1000) / 10
        : null;
    const heaterPct =
      prev.heaterTodayMinutes > 0
        ? Math.round((heaterDelta / prev.heaterTodayMinutes) * 1000) / 10
        : null;

    return {
      ...house,
      comparison: {
        hasPrevious: true,
        previousSavedAt: previousSnapshot.savedAt,
        previousReportPeriod: previousSnapshot.reportPeriod,
        snapshotWaterTotal: prev.waterTodayTotal,
        snapshotHeaterMinutes: prev.heaterTodayMinutes,
        snapshotWaterDelta: waterDelta,
        snapshotHeaterDelta: heaterDelta,
        snapshotWaterPct: waterPct,
        snapshotHeaterPct: heaterPct,
      },
    };
  });

  return {
    ...currentReport,
    isBaseline: false,
    comparisonNote: `Compared against snapshot from ${previousSnapshot.savedAt}.`,
    houses,
  };
}

function detectAnomalies(report, thresholds) {
  const alerts = [];
  const t = thresholds || {};

  for (const house of report.houses || []) {
    const label = `${house.houseName} (#${house.houseNumber})`;

    if (t.houseDisconnected?.enabled && house.connectionStatus !== 1) {
      alerts.push({
        severity: t.houseDisconnected.severity || 'critical',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'connection',
        message: `${label} is disconnected (status ${house.connectionStatus}).`,
      });
      continue;
    }

    const growthDay = house.growthDay ?? 0;
    const waterPct = house.water?.pctChange;
    const heaterPct = house.heaters?.pctChange;

    if (
      t.waterZeroWithBirds?.enabled &&
      growthDay >= (t.waterZeroWithBirds.minGrowthDay ?? 1) &&
      (house.water?.todayTotal ?? 0) === 0
    ) {
      alerts.push({
        severity: t.waterZeroWithBirds.severity || 'critical',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'water',
        message: `${label} has zero water consumption on growth day ${growthDay}.`,
      });
    }

    if (
      t.heaterZeroWithBirds?.enabled &&
      growthDay >= (t.heaterZeroWithBirds.minGrowthDay ?? 3) &&
      (house.heaters?.todayTotalMinutes ?? 0) === 0
    ) {
      alerts.push({
        severity: t.heaterZeroWithBirds.severity || 'warning',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'heater',
        message: `${label} has zero heater runtime on growth day ${growthDay}.`,
      });
    }

    if (t.waterPctChange?.enabled && waterPct != null) {
      const limit = t.waterPctChange.threshold ?? 20;
      if (Math.abs(waterPct) >= limit) {
        alerts.push({
          severity: t.waterPctChange.severity || 'warning',
          houseNumber: house.houseNumber,
          houseName: house.houseName,
          metric: 'water',
          message: `${label} water changed ${waterPct}% vs prior growth day (threshold ±${limit}%).`,
          value: waterPct,
        });
      }
    }

    if (t.heaterPctChange?.enabled && heaterPct != null) {
      const limit = t.heaterPctChange.threshold ?? 25;
      if (Math.abs(heaterPct) >= limit) {
        alerts.push({
          severity: t.heaterPctChange.severity || 'warning',
          houseNumber: house.houseNumber,
          houseName: house.houseName,
          metric: 'heater',
          message: `${label} heater runtime changed ${heaterPct}% vs prior growth day (threshold ±${limit}%).`,
          value: heaterPct,
        });
      }
    }

    if (house.comparison?.hasPrevious) {
      const snapWaterPct = house.comparison.snapshotWaterPct;
      const snapHeaterPct = house.comparison.snapshotHeaterPct;
      if (
        t.waterPctChange?.enabled &&
        snapWaterPct != null &&
        Math.abs(snapWaterPct) >= (t.waterPctChange.threshold ?? 20)
      ) {
        alerts.push({
          severity: t.waterPctChange.severity || 'warning',
          houseNumber: house.houseNumber,
          houseName: house.houseName,
          metric: 'water_snapshot',
          message: `${label} water changed ${snapWaterPct}% since last report run.`,
          value: snapWaterPct,
        });
      }
      if (
        t.heaterPctChange?.enabled &&
        snapHeaterPct != null &&
        Math.abs(snapHeaterPct) >= (t.heaterPctChange.threshold ?? 25)
      ) {
        alerts.push({
          severity: t.heaterPctChange.severity || 'warning',
          houseNumber: house.houseNumber,
          houseName: house.houseName,
          metric: 'heater_snapshot',
          message: `${label} heater runtime changed ${snapHeaterPct}% since last report run.`,
          value: snapHeaterPct,
        });
      }
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const alert of alerts) {
    const key = `${alert.houseNumber}:${alert.metric}:${alert.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(alert);
    }
  }

  return {
    ...report,
    alerts: deduped,
    alertCount: deduped.length,
    hasCritical: deduped.some((a) => a.severity === 'critical'),
  };
}

function getReportPeriod(timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'America/Chicago',
    hour: 'numeric',
    hour12: false,
  });
  const hour = Number(formatter.format(new Date()));
  return hour < 12 ? 'am' : 'pm';
}

function filterFarmsForSchedule(farms, timezone) {
  const tz = timezone || 'America/Chicago';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  });
  const hour = Number(formatter.format(new Date()));
  return hour === 6 || hour === 18;
}

module.exports = {
  HISTORY_DIR,
  loadSnapshot,
  saveSnapshot,
  compareWithSnapshot,
  detectAnomalies,
  getReportPeriod,
  filterFarmsForSchedule,
};
