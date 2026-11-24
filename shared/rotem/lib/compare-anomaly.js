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
        snapshotGrowthDay: prev.growthDay ?? null,
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

function lastNAllNull(rows) {
  if (!rows || !rows.length) return true;
  return rows.every((r) => r.total == null);
}

/**
 * Water % uses the last two finished flock days. The newest history row is the
 * in-progress day and is not comparable to a completed day.
 */
function completedWaterChange(house) {
  const days = house.water?.last3Days;
  if (!Array.isArray(days) || days.length < 3) return null;
  const prior = days[days.length - 3];
  const completed = days[days.length - 2];
  if (prior?.total == null || completed?.total == null) return null;
  const priorTotal = Number(prior.total);
  const completedTotal = Number(completed.total);
  if (!(priorTotal > 0) || Number.isNaN(completedTotal)) return null;
  return {
    completedDay: completed.growthDay,
    priorDay: prior.growthDay,
    completedTotal,
    priorTotal,
    pct: Math.round(((completedTotal - priorTotal) / priorTotal) * 1000) / 10,
  };
}

function snapshotAgeHours(savedAt) {
  if (!savedAt) return Infinity;
  const ageMs = Date.now() - new Date(savedAt).getTime();
  if (Number.isNaN(ageMs) || ageMs < 0) return Infinity;
  return ageMs / (1000 * 60 * 60);
}

function isSnapshotComparable(house, thresholds) {
  const comparison = house.comparison;
  if (!comparison?.hasPrevious) return false;
  const maxAgeHours = thresholds?.snapshot?.maxAgeHours ?? 36;
  const maxGrowthDayDelta = thresholds?.snapshot?.maxGrowthDayDelta ?? 1;
  if (snapshotAgeHours(comparison.previousSavedAt) > maxAgeHours) return false;
  const currentDay = house.growthDay;
  const prevDay = comparison.snapshotGrowthDay;
  if (currentDay == null || prevDay == null) return false;
  if (Math.abs(currentDay - prevDay) > maxGrowthDayDelta) return false;
  return true;
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

    if (house.fetchError) {
      alerts.push({
        severity: 'warning',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'fetch',
        message: `${label} history could not be loaded (${house.fetchError}).`,
      });
      continue;
    }

    const growthDay = house.growthDay;
    if (growthDay == null || growthDay < 1) {
      continue;
    }

    const waterToday = house.water?.todayTotal ?? 0;
    const waterYesterday = house.water?.yesterdayTotal ?? 0;
    const heaterToday = house.heaters?.todayTotalMinutes ?? 0;
    const heaterYesterday = house.heaters?.yesterdayTotalMinutes ?? 0;
    const waterHistoryMissing = lastNAllNull(house.water?.last3Days);
    const heaterHistoryMissing = lastNAllNull(house.heaters?.last2Days);
    const skipWaterRules = waterHistoryMissing && waterToday === 0;
    const skipHeaterRules = heaterHistoryMissing && heaterToday === 0;

    const completedWater = completedWaterChange(house);
    const heaterPct = house.heaters?.pctChange;
    let flockHeaterPctAlert = false;

    if (
      !skipWaterRules &&
      t.waterZeroWithBirds?.enabled &&
      growthDay >= (t.waterZeroWithBirds.minGrowthDay ?? 1) &&
      waterToday === 0
    ) {
      alerts.push({
        severity: t.waterZeroWithBirds.severity || 'critical',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'water',
        message: `${label} has zero water consumption on growth day ${growthDay}.`,
      });
    }

    const heaterZero = t.heaterZeroWithBirds || {};
    const minHeaterDay = heaterZero.minGrowthDay ?? 3;
    const maxHeaterDay = heaterZero.maxGrowthDay ?? 14;
    const minYesterdayMinutes = heaterZero.minYesterdayMinutes ?? 30;
    if (
      !skipHeaterRules &&
      heaterZero.enabled &&
      growthDay >= minHeaterDay &&
      growthDay <= maxHeaterDay &&
      heaterToday === 0 &&
      heaterYesterday >= minYesterdayMinutes
    ) {
      alerts.push({
        severity: heaterZero.severity || 'warning',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'heater',
        message: `${label} has zero heater runtime on growth day ${growthDay}.`,
      });
    }

    const waterPctRule = t.waterPctChange || {};
    const waterMinBaseline = waterPctRule.minBaseline ?? 100;
    if (
      !skipWaterRules &&
      waterPctRule.enabled &&
      completedWater &&
      completedWater.priorTotal >= waterMinBaseline
    ) {
      const limit = waterPctRule.threshold ?? 20;
      if (Math.abs(completedWater.pct) >= limit) {
        alerts.push({
          severity: waterPctRule.severity || 'warning',
          houseNumber: house.houseNumber,
          houseName: house.houseName,
          metric: 'water',
          message: `${label} water changed ${completedWater.pct}% vs prior completed growth day (day ${completedWater.completedDay} vs day ${completedWater.priorDay}, threshold ±${limit}%). Today's total is still in progress.`,
          value: completedWater.pct,
        });
      }
    }

    const heaterPctRule = t.heaterPctChange || {};
    const heaterMinBaseline = heaterPctRule.minBaseline ?? 30;
    const heaterPctMaxDay = heaterPctRule.maxGrowthDay ?? heaterZero.maxGrowthDay ?? 14;
    const heaterPctMinDay = heaterPctRule.minGrowthDay ?? heaterZero.minGrowthDay ?? 3;
    if (
      !skipHeaterRules &&
      heaterPctRule.enabled &&
      heaterPct != null &&
      growthDay >= heaterPctMinDay &&
      growthDay <= heaterPctMaxDay &&
      heaterYesterday >= heaterMinBaseline
    ) {
      const limit = heaterPctRule.threshold ?? 50;
      if (Math.abs(heaterPct) >= limit) {
        flockHeaterPctAlert = true;
        alerts.push({
          severity: heaterPctRule.severity || 'warning',
          houseNumber: house.houseNumber,
          houseName: house.houseName,
          metric: 'heater',
          message: `${label} heater runtime changed ${heaterPct}% vs prior growth day (threshold ±${limit}%).`,
          value: heaterPct,
        });
      }
    }

    if (isSnapshotComparable(house, t)) {
      const snapHeaterPct = house.comparison.snapshotHeaterPct;
      const snapHeaterBaseline = house.comparison.snapshotHeaterMinutes ?? 0;
      if (
        !skipHeaterRules &&
        !flockHeaterPctAlert &&
        heaterPctRule.enabled &&
        snapHeaterPct != null &&
        growthDay >= heaterPctMinDay &&
        growthDay <= heaterPctMaxDay &&
        snapHeaterBaseline >= heaterMinBaseline &&
        Math.abs(snapHeaterPct) >= (heaterPctRule.threshold ?? 50)
      ) {
        alerts.push({
          severity: heaterPctRule.severity || 'warning',
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
  lastNAllNull,
  isSnapshotComparable,
  completedWaterChange,
};
