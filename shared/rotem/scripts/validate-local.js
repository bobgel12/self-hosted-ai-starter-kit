#!/usr/bin/env node
'use strict';

/**
 * Local validation without RotemNet credentials.
 * Usage: node shared/rotem/scripts/validate-local.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = process.env.ROTEM_DATA_ROOT || ROOT;

process.env.ROTEM_DATA_ROOT = DATA_ROOT;
process.env.ROTEM_SKIP_FETCH = '1';

const orchestrator = require(path.join(ROOT, 'lib', 'orchestrator'));
const compareAnomaly = require(path.join(ROOT, 'lib', 'compare-anomaly'));

const mockReport = {
  farmId: 'farm-test',
  farmName: 'Test Farm',
  farmDisplayName: 'Test Farm',
  timezone: 'America/New_York',
  reportTime: new Date().toISOString(),
  registration: { country: 'US', integrator: null, segment: 'Broiler' },
  houses: [
    {
      houseNumber: 1,
      houseName: 'House 1',
      growthDay: 21,
      connectionStatus: 1,
      water: {
        todayTotal: 1500,
        yesterdayTotal: 1200,
        pctChange: 25,
        rotemPctChange: 25,
        last3Days: [
          { growthDay: 19, total: 1100 },
          { growthDay: 20, total: 1200 },
          { growthDay: 21, total: 1500 },
        ],
        historyRows: [],
      },
      heaters: {
        todayTotalMinutes: 500,
        yesterdayTotalMinutes: 400,
        pctChange: 25,
        last2Days: [
          { growthDay: 20, total: 400 },
          { growthDay: 21, total: 500 },
        ],
        last2DaysTotalMinutes: 900,
        devices: [],
        historyRows: [],
      },
    },
    {
      houseNumber: 2,
      houseName: 'House 2',
      growthDay: 21,
      connectionStatus: 0,
      water: { todayTotal: 0, yesterdayTotal: 0, pctChange: null, historyRows: [] },
      heaters: { todayTotalMinutes: 0, yesterdayTotalMinutes: 0, pctChange: null, devices: [], historyRows: [] },
    },
  ],
};

async function main() {
  const farmsExample = path.join(DATA_ROOT, 'farms.json.example');
  const thresholdsPath = path.join(DATA_ROOT, 'thresholds.json');
  const testConfigPath = path.join(DATA_ROOT, 'farms.test.json');

  if (!fs.existsSync(testConfigPath)) {
    const example = JSON.parse(fs.readFileSync(farmsExample, 'utf8'));
    example.farms = [
      {
        id: 'farm-test',
        displayName: 'Test Farm',
        timezone: 'America/New_York',
        rotemUsername: 'test',
        rotemPassword: 'test',
        dataSource: 'rotem_direct',
        djangoBaseUrl: null,
      },
    ];
    fs.writeFileSync(testConfigPath, JSON.stringify(example, null, 2));
  }

  const configDir = DATA_ROOT;
  const origConfig = path.join(configDir, 'farms.json');
  const backup = fs.existsSync(origConfig) ? fs.readFileSync(origConfig, 'utf8') : null;

  fs.copyFileSync(testConfigPath, origConfig);

  try {
    const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));
    const config = JSON.parse(fs.readFileSync(origConfig, 'utf8'));
    const farm = config.farms[0];

    console.log('1. Baseline run (no prior snapshot)...');
    const baseline = await orchestrator.processFarm(farm, config, thresholds, {
      skipScheduleCheck: true,
      mockReport,
    });
    console.log('   Alerts:', baseline.report.alertCount);
    console.log('   Baseline:', baseline.report.isBaseline);

    console.log('2. Second run (with snapshot comparison)...');
    const second = await orchestrator.processFarm(farm, config, thresholds, {
      skipScheduleCheck: true,
      mockReport: {
        ...mockReport,
        houses: mockReport.houses.map((h) =>
          h.houseNumber === 1
            ? {
                ...h,
                water: { ...h.water, todayTotal: 1800, pctChange: 20 },
                heaters: { ...h.heaters, todayTotalMinutes: 650, pctChange: 30 },
              }
            : h,
        ),
      },
    });
    console.log('   Alerts:', second.report.alertCount);
    console.log('   Email subject:', second.email.subject);
    console.log('   Snapshot saved:', second.snapshotSaved);

    const historyFile = path.join(DATA_ROOT, 'history', 'farm-test', 'latest.json');
    if (fs.existsSync(historyFile)) {
      console.log('3. History file written:', historyFile);
    } else {
      console.error('FAIL: history file missing');
      process.exit(1);
    }

    console.log('\nValidation passed.');
  } finally {
    if (backup) {
      fs.writeFileSync(origConfig, backup);
    } else if (fs.existsSync(origConfig)) {
      fs.unlinkSync(origConfig);
    }
  }
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
