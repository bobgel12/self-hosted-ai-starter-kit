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

/**
 * Prior 6 AM or 6 PM run, about 24h earlier. Command 40 is daily history, so
 * "yesterday at this time" is our own snapshot, not another Rotem call.
 * latest.json is the most recent run (often 12h ago) and is not this slot.
 */
function loadSameSlotSnapshot(farmId, reportPeriod, now = new Date()) {
  if (!farmId || (reportPeriod !== 'am' && reportPeriod !== 'pm')) return null;
  const dir = path.join(HISTORY_DIR, farmId);
  if (!fs.existsSync(dir)) return null;

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const suffix = `-${reportPeriod}.json`;
  const target = now.getTime() - 24 * 60 * 60 * 1000;
  const minMs = 18 * 60 * 60 * 1000;
  const maxMs = 30 * 60 * 60 * 1000;
  let best = null;
  let bestDist = Infinity;

  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (snapshot.reportPeriod && snapshot.reportPeriod !== reportPeriod) continue;

    const savedMs = snapshot.savedAt ? new Date(snapshot.savedAt).getTime() : NaN;
    let when = savedMs;
    if (Number.isNaN(when)) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})-/);
      if (!match) continue;
      when = new Date(`${match[1]}T12:00:00Z`).getTime();
    }
    const age = now.getTime() - when;
    if (age < minMs || age > maxMs) continue;
    const dist = Math.abs(when - target);
    if (dist < bestDist) {
      best = snapshot;
      bestDist = dist;
    }
  }

  return best;
}

function attachSameSlotWater(report, snapshot) {
  const prevByHouse = {};
  for (const house of snapshot?.houses || []) {
    prevByHouse[house.houseNumber] = house;
  }

  const houses = (report.houses || []).map((house) => {
    const today = house.water?.todayTotal;
    const prev = prevByHouse[house.houseNumber];
    const yesterday = prev?.waterTodayTotal;
    const todayMissing = today == null || Number.isNaN(Number(today));
    const yesterdayMissing = prev == null || yesterday == null || Number.isNaN(Number(yesterday));
    if (todayMissing || yesterdayMissing) {
      return {
        ...house,
        sameSlot: {
          hasPrevious: false,
          waterSoFar: todayMissing ? null : Number(today),
        },
      };
    }

    const waterSoFar = Number(today);
    const yesterdayWater = Number(yesterday);
    const delta = waterSoFar - yesterdayWater;
    return {
      ...house,
      sameSlot: {
        hasPrevious: true,
        savedAt: snapshot.savedAt || null,
        waterSoFar,
        yesterdayWater,
        deltaGallons: Math.round(delta * 10) / 10,
        deltaPct: yesterdayWater > 0 ? Math.round((delta / yesterdayWater) * 1000) / 10 : null,
      },
    };
  });

  return { ...report, houses };
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

/**
 * Heater day-to-day % uses the last two finished flock days. The newest
 * history row is the in-progress day and is not the delta.
 * Both days at zero is 0%. A zero prior day with a later total has no percent.
 */
function completedHeaterChange(house) {
  const days = house.heaters?.last3Days;
  if (!Array.isArray(days) || days.length < 3) return null;
  const prior = days[days.length - 3];
  const completed = days[days.length - 2];
  if (prior?.total == null || completed?.total == null) return null;
  const priorTotal = Number(prior.total);
  const completedTotal = Number(completed.total);
  if (Number.isNaN(priorTotal) || Number.isNaN(completedTotal)) return null;
  const pct =
    priorTotal === 0
      ? completedTotal === 0
        ? 0
        : null
      : Math.round(((completedTotal - priorTotal) / priorTotal) * 1000) / 10;
  return {
    completedDay: completed.growthDay,
    priorDay: prior.growthDay,
    completedTotal,
    priorTotal,
    pct,
    totalMinutes: priorTotal + completedTotal,
  };
}

function snapshotAgeHours(savedAt) {
  if (!savedAt) return Infinity;
  const ageMs = Date.now() - new Date(savedAt).getTime();
  if (Number.isNaN(ageMs) || ageMs < 0) return Infinity;
  return ageMs / (1000 * 60 * 60);
}

function looksLikeFahrenheit(unit) {
  const text = String(unit || '').toLowerCase();
  return text.includes('f') && !text.includes('c');
}

function pushClimateAlerts(alerts, house, thresholds) {
  const rules = thresholds || {};
  const label = `${house.houseName} (#${house.houseNumber})`;
  const conditions = house.conditions || {};

  const tempRule = rules.temperatureFromSetPoint || {};
  if (
    tempRule.enabled &&
    conditions.averageTemperature != null &&
    conditions.setTemperature != null
  ) {
    const delta =
      Math.round((Number(conditions.averageTemperature) - Number(conditions.setTemperature)) * 10) /
      10;
    const limit = looksLikeFahrenheit(conditions.temperatureUnit)
      ? (tempRule.maxDeltaFahrenheit ?? 5)
      : (tempRule.maxDelta ?? 3);
    if (Math.abs(delta) >= limit) {
      alerts.push({
        severity: tempRule.severity || 'warning',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'temperature',
        message: `${label} average temperature ${conditions.averageTemperature} is ${delta} from set point ${conditions.setTemperature} (threshold ±${limit}).`,
        value: delta,
      });
    }
  }

  const humidityRule = rules.humidityExtreme || {};
  if (humidityRule.enabled && conditions.insideHumidity != null) {
    const min = humidityRule.min ?? 40;
    const max = humidityRule.max ?? 85;
    const humidity = Number(conditions.insideHumidity);
    if (humidity < min || humidity > max) {
      alerts.push({
        severity: humidityRule.severity || 'warning',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'humidity',
        message: `${label} humidity ${humidity}% is outside ${min}–${max}%.`,
        value: humidity,
      });
    }
  }

  const pressureRule = rules.staticPressureFromTarget || {};
  if (
    pressureRule.enabled &&
    conditions.staticPressure != null &&
    conditions.targetPressure != null &&
    Number(conditions.targetPressure) !== 0
  ) {
    const pct =
      Math.round(
        ((Number(conditions.staticPressure) - Number(conditions.targetPressure)) /
          Number(conditions.targetPressure)) *
          1000,
      ) / 10;
    const limit = pressureRule.maxPct ?? 30;
    if (Math.abs(pct) >= limit) {
      const unit = conditions.pressureUnit ? ` ${conditions.pressureUnit}` : '';
      alerts.push({
        severity: pressureRule.severity || 'warning',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'static_pressure',
        message: `${label} static pressure ${conditions.staticPressure}${unit} is ${pct}% from target ${conditions.targetPressure}${unit} (threshold ±${limit}%).`,
        value: pct,
      });
    }
  }
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

    pushClimateAlerts(alerts, house, t);

    const growthDay = house.growthDay;
    if (growthDay == null || growthDay < 1) {
      continue;
    }

    const waterToday = house.water?.todayTotal ?? 0;
    const waterYesterday = house.water?.yesterdayTotal ?? 0;
    const heaterToday = house.heaters?.todayTotalMinutes ?? 0;
    const heaterYesterday = house.heaters?.yesterdayTotalMinutes ?? 0;
    const waterHistoryMissing = lastNAllNull(house.water?.last3Days);
    const heaterHistoryMissing = lastNAllNull(house.heaters?.last3Days);
    const skipWaterRules = waterHistoryMissing && waterToday === 0;
    const skipHeaterRules = heaterHistoryMissing && heaterToday === 0;

    const completedWater = completedWaterChange(house);
    const completedHeater = completedHeaterChange(house);
    let flockHeaterPctAlert = false;

    // Today's total is still in progress at 6 AM and 6 PM. A zero so far is
    // not an alert. Only a finished flock day that ended at zero is.
    const waterDays = house.water?.last3Days;
    const finishedWaterDay =
      Array.isArray(waterDays) && waterDays.length >= 3 ? waterDays[waterDays.length - 2] : null;
    if (
      !skipWaterRules &&
      t.waterZeroWithBirds?.enabled &&
      finishedWaterDay &&
      finishedWaterDay.total === 0 &&
      (finishedWaterDay.growthDay ?? 0) >= (t.waterZeroWithBirds.minGrowthDay ?? 1)
    ) {
      alerts.push({
        severity: t.waterZeroWithBirds.severity || 'critical',
        houseNumber: house.houseNumber,
        houseName: house.houseName,
        metric: 'water',
        message: `${label} had zero water on completed growth day ${finishedWaterDay.growthDay}. Today's total is still in progress and is not a zero-water alert.`,
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
      completedHeater &&
      completedHeater.pct != null &&
      growthDay >= heaterPctMinDay &&
      growthDay <= heaterPctMaxDay &&
      completedHeater.priorTotal >= heaterMinBaseline
    ) {
      const limit = heaterPctRule.threshold ?? 50;
      if (Math.abs(completedHeater.pct) >= limit) {
        flockHeaterPctAlert = true;
        alerts.push({
          severity: heaterPctRule.severity || 'warning',
          houseNumber: house.houseNumber,
          houseName: house.houseName,
          metric: 'heater',
          message: `${label} heater runtime changed ${completedHeater.pct}% vs prior completed growth day (day ${completedHeater.completedDay} vs day ${completedHeater.priorDay}, threshold ±${limit}%). Today's runtime is still in progress.`,
          value: completedHeater.pct,
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
  loadSameSlotSnapshot,
  attachSameSlotWater,
  saveSnapshot,
  compareWithSnapshot,
  detectAnomalies,
  getReportPeriod,
  filterFarmsForSchedule,
  lastNAllNull,
  isSnapshotComparable,
  completedWaterChange,
  completedHeaterChange,
};
