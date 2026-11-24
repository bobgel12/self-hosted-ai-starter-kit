#!/usr/bin/env node
'use strict';

/**
 * Replay Aug 9 evening house totals through detectAnomalies.
 * Usage: node shared/rotem/scripts/replay-aug9-alerts.js
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { detectAnomalies, compareWithSnapshot } = require(path.join(ROOT, 'lib', 'compare-anomaly.js'));
const thresholds = require(path.join(ROOT, 'thresholds.json'));

function house({
  n,
  name,
  day,
  waterToday,
  waterYday,
  waterPct,
  waterLast3,
  heaterToday,
  heaterYday,
  heaterPct,
  heaterLast2,
}) {
  return {
    houseNumber: n,
    houseName: name || `House ${n}`,
    growthDay: day,
    connectionStatus: 1,
    water: {
      todayTotal: waterToday,
      yesterdayTotal: waterYday,
      pctChange: waterPct,
      last3Days: waterLast3,
    },
    heaters: {
      todayTotalMinutes: heaterToday,
      yesterdayTotalMinutes: heaterYday,
      pctChange: heaterPct,
      last2Days: heaterLast2,
    },
  };
}

function days(pairs) {
  return pairs.map(([growthDay, total]) => ({ growthDay, total }));
}

const vistaridge = {
  farmId: 'vistaridge',
  farmName: 'Vistaridge Farm',
  houses: [
    house({
      n: 1,
      day: 16,
      waterToday: 1588.1,
      waterYday: 1425.1,
      waterPct: 11.4,
      waterLast3: days([[14, 1078.5], [15, 1425.1], [16, 1588.1]]),
      heaterToday: 37,
      heaterYday: 132,
      heaterPct: -72,
      heaterLast2: days([[15, 132], [16, 37]]),
    }),
    house({
      n: 2,
      day: 0,
      waterToday: 49.1,
      waterYday: 0,
      waterPct: null,
      waterLast3: days([[-2, null], [-1, null], [0, 49.1]]),
      heaterToday: 0,
      heaterYday: 0,
      heaterPct: 0,
      heaterLast2: days([[-1, null], [0, null]]),
    }),
    house({
      n: 3,
      day: 16,
      waterToday: 1598.9,
      waterYday: 1367.1,
      waterPct: 17,
      waterLast3: days([[14, 1099.7], [15, 1367.1], [16, 1598.9]]),
      heaterToday: 0,
      heaterYday: 2,
      heaterPct: -100,
      heaterLast2: days([[15, 2], [16, 0]]),
    }),
    house({
      n: 4,
      day: 16,
      waterToday: 1422.6,
      waterYday: 1296.4,
      waterPct: 9.7,
      waterLast3: days([[14, 1062.4], [15, 1296.4], [16, 1422.6]]),
      heaterToday: 0,
      heaterYday: 0,
      heaterPct: 0,
      heaterLast2: days([[15, 0], [16, 0]]),
    }),
    house({
      n: 5,
      day: 15,
      waterToday: 1315.1,
      waterYday: 1088.9,
      waterPct: 20.8,
      waterLast3: days([[13, 1067.7], [14, 1088.9], [15, 1315.1]]),
      heaterToday: 22,
      heaterYday: 16,
      heaterPct: 37.5,
      heaterLast2: days([[14, 16], [15, 22]]),
    }),
    house({
      n: 6,
      day: 15,
      waterToday: 1447.3,
      waterYday: 1216.9,
      waterPct: 18.9,
      waterLast3: days([[13, 1083], [14, 1216.9], [15, 1447.3]]),
      heaterToday: 0,
      heaterYday: 2,
      heaterPct: -100,
      heaterLast2: days([[14, 2], [15, 0]]),
    }),
  ],
};

const bobby = {
  farmId: 'bobby-angel',
  farmName: 'Bobby Angel Farm',
  houses: [
    house({
      n: 1,
      day: 37,
      waterToday: 3212,
      waterYday: 0,
      waterPct: null,
      waterLast3: days([[35, null], [36, null], [37, null]]),
      heaterToday: 0,
      heaterYday: 0,
      heaterPct: 0,
      heaterLast2: days([[36, null], [37, null]]),
    }),
    house({
      n: 2,
      day: 37,
      waterToday: 3169,
      waterYday: 0,
      waterPct: null,
      waterLast3: days([[35, null], [36, null], [37, null]]),
      heaterToday: 0,
      heaterYday: 0,
      heaterPct: 0,
      heaterLast2: days([[36, null], [37, null]]),
    }),
    house({
      n: 3,
      day: 0,
      waterToday: 0,
      waterYday: 0,
      waterPct: 0,
      waterLast3: days([[-2, null], [-1, null], [0, null]]),
      heaterToday: 0,
      heaterYday: 0,
      heaterPct: 0,
      heaterLast2: days([[-1, null], [0, null]]),
    }),
    house({
      n: 8,
      day: 33,
      waterToday: 2962,
      waterYday: 3047,
      waterPct: -2.8,
      waterLast3: days([[31, 3033], [32, 3047], [33, 2962]]),
      heaterToday: 0,
      heaterYday: 0,
      heaterPct: 0,
      heaterLast2: days([[32, null], [33, null]]),
    }),
  ],
};

const staleSnapshot = {
  savedAt: '2026-06-25T03:10:01.380Z',
  houses: [
    { houseNumber: 1, growthDay: 8, waterTodayTotal: 2, heaterTodayMinutes: 51 },
    { houseNumber: 2, growthDay: 8, waterTodayTotal: 1960, heaterTodayMinutes: 40 },
    { houseNumber: 5, growthDay: 8, waterTodayTotal: 1954, heaterTodayMinutes: 16 },
  ],
};

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function main() {
  const vistaCompared = compareWithSnapshot(vistaridge, staleSnapshot);
  const vista = detectAnomalies(vistaCompared, thresholds);
  const bobbyCompared = compareWithSnapshot(bobby, {
    savedAt: '2026-06-25T03:11:25.711Z',
    houses: [{ houseNumber: 1, growthDay: 39, waterTodayTotal: 2, heaterTodayMinutes: 0 }],
  });
  const bobbyResult = detectAnomalies(bobbyCompared, thresholds);

  console.log('Vistaridge alerts:', vista.alertCount);
  for (const a of vista.alerts) console.log('  -', a.message);
  console.log('Bobby Angel alerts:', bobbyResult.alertCount);
  for (const a of bobbyResult.alerts) console.log('  -', a.message);

  const vistaHouses = vista.alerts.map((a) => a.houseNumber).sort((a, b) => a - b);
  assert(
    vista.alertCount === 3 && vistaHouses.join(',') === '1,3,4',
    `expected completed-day alerts on houses 1, 3, 4, got ${vista.alertCount}: ${vista.alerts.map((a) => a.message).join(' | ')}`,
  );
  assert(
    vista.alerts.every((a) => a.metric === 'water' && a.message.includes('day 15 vs day 14')),
    'Vistaridge water alerts must compare completed days, not the in-progress day',
  );
  assert(bobbyResult.alertCount === 0, `expected 0 Bobby alerts, got ${bobbyResult.alertCount}`);

  const partialDayDrop = detectAnomalies(
    {
      houses: [
        house({
          n: 5,
          day: 15,
          waterToday: 400,
          waterYday: 1088.9,
          waterPct: -63.3,
          waterLast3: days([[13, 1067.7], [14, 1088.9], [15, 400]]),
          heaterToday: 0,
          heaterYday: 0,
          heaterPct: 0,
          heaterLast2: days([[14, 0], [15, 0]]),
        }),
      ],
    },
    thresholds,
  );
  assert(
    partialDayDrop.alertCount === 0,
    'in-progress day must not alert against a completed prior day',
  );

  const completedDrop = detectAnomalies(
    {
      houses: [
        house({
          n: 5,
          day: 15,
          waterToday: 200,
          waterYday: 700,
          waterPct: -71.4,
          waterLast3: days([[13, 1000], [14, 700], [15, 200]]),
          heaterToday: 0,
          heaterYday: 0,
          heaterPct: 0,
          heaterLast2: days([[14, 0], [15, 0]]),
        }),
      ],
    },
    thresholds,
  );
  assert(
    completedDrop.alerts.some((a) => a.metric === 'water' && String(a.message).includes('-30%')),
    'completed-day water drop (1000 to 700) should still alert',
  );

  const broodDrop = detectAnomalies(
    {
      houses: [
        house({
          n: 1,
          day: 8,
          waterToday: 800,
          waterYday: 700,
          waterPct: 14.3,
          waterLast3: days([[6, 600], [7, 700], [8, 800]]),
          heaterToday: 0,
          heaterYday: 120,
          heaterPct: -100,
          heaterLast2: days([[7, 120], [8, 0]]),
        }),
      ],
    },
    thresholds,
  );
  assert(
    broodDrop.alerts.some((a) => a.metric === 'heater' && a.message.includes('zero heater')),
    'brood house dropping from 2h heat to 0 should still alert',
  );
  assert(
    broodDrop.alerts.some((a) => a.metric === 'heater' && a.message.includes('changed')),
    'brood house heater % vs prior day should still alert (baseline 120m, -100%)',
  );

  const disconnected = detectAnomalies(
    {
      houses: [
        {
          houseNumber: 9,
          houseName: 'House 9',
          growthDay: 10,
          connectionStatus: 0,
          water: { todayTotal: 0, yesterdayTotal: 0, pctChange: null, last3Days: [] },
          heaters: { todayTotalMinutes: 0, yesterdayTotalMinutes: 0, pctChange: null, last2Days: [] },
        },
      ],
    },
    thresholds,
  );
  assert(
    disconnected.alerts.length === 1 && disconnected.alerts[0].metric === 'connection',
    'disconnected house should only emit connection alert',
  );

  console.log('\nReplay passed.');
}

main();
