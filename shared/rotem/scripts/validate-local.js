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
const {
  parseLiveHouseData,
  parseWaterHistoryRows,
  parseHeaterHistoryRows,
  applyControllerSnapshot,
} = require(path.join(ROOT, 'lib', 'rotem-client'));

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
      conditions: {
        averageTemperature: 29.7,
        setTemperature: 27.7,
        outsideTemperature: 27.3,
        temperatureUnit: 'C°',
        insideHumidity: 64,
        co2: 850,
        staticPressure: 24,
        targetPressure: 24.9,
        pressureUnit: 'Pa',
        ventLevel: 17,
        ventLevelMin: 6,
        ventLevelMax: 25,
        heatersNow: 'Off',
        birds: 20000,
        livability: 99,
        dailyFeed: 37,
        feedUnit: 'KG',
        averageWeight: null,
        mortality: null,
        alarm: null,
        siren: false,
        controllerAlarms: [],
      },
      water: {
        todayTotal: 1500,
        yesterdayTotal: 1200,
        pctChange: 25,
        rotemPctChange: 25,
        last3Days: [
          { growthDay: 19, total: 1100, waterPerBird: 0 },
          { growthDay: 20, total: 1200, waterPerBird: 0.08, lines: [] },
          {
            growthDay: 21,
            total: 1500,
            waterPerBird: 0,
            lines: [
              { line: 1, total: 400 },
              { line: 2, total: 350 },
              { line: 3, total: 0 },
            ],
            cooling: 0,
            fogger: 12,
          },
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
        devices: [{ device: 1, minutes: 120 }],
        yesterdayDevices: [{ device: 1, minutes: 90 }, { device: 4, minutes: 30 }],
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

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} missing ${JSON.stringify(needle)}`);
  }
}

function assertParsers() {
  const live = parseLiveHouseData({
    dsData: {
      General: [
        { ParameterKeyName: 'Growth_Day', ParameterValue: '21' },
        { ParameterKeyName: 'Average_Temperature', ParameterValue: '29.71' },
        { ParameterKeyName: 'Set_Temperature', ParameterValue: '27.65' },
        { ParameterKeyName: 'Outside_Temperature', ParameterValue: '27.33' },
        { ParameterKeyName: 'Inside_Humidity', ParameterValue: '64' },
        { ParameterKeyName: 'CO2', ParameterValue: '' },
        { ParameterKeyName: 'Static_Pressure', ParameterValue: '24' },
        { ParameterKeyName: 'Target_Pressure', ParameterValue: '24.9' },
        { ParameterKeyName: 'Vent_Level', ParameterValue: '17' },
        { ParameterKeyName: 'Min_Vent_Level', ParameterValue: '6' },
        { ParameterKeyName: 'Max_Vent_Level', ParameterValue: '25' },
        { ParameterKeyName: 'Current_Birds_Count_In_House', ParameterValue: '0' },
        { ParameterKeyName: 'Birds_Livability', ParameterValue: '100' },
        { ParameterKeyName: 'Siren', ParameterValue: 'False' },
        { ParameterKeyName: 'Alarm', ParameterValue: null },
      ],
      Consumption: [
        { ParameterKeyName: 'Daily_Water', ParameterValue: '989' },
        { ParameterKeyName: 'Daily_Feed', ParameterValue: '37' },
      ],
      DigitalOut: [{ ParameterKeyName: 'Heaters', ParameterValue: 'LangKey_Off' }],
      General_DisplayValues: [{ Average_Temperature_Sign: 'C°', Static_Pressure_Sign: 'Pa' }],
      Consumption_View: [{ Daily_Feed_Sign: 'KG' }],
      AvgWeight: [{ ParameterKeyName: 'Average_Weight', ParameterValue: '0' }],
    },
  });
  if (live.growthDay !== 21 || live.dailyWater !== 989) {
    throw new Error(`live totals parsed wrong: ${JSON.stringify(live)}`);
  }
  if (live.conditions.averageTemperature !== 29.71 || live.conditions.temperatureUnit !== 'C°') {
    throw new Error('temperature not parsed from command 0');
  }
  if (live.conditions.co2 != null || live.conditions.heatersNow !== 'Off') {
    throw new Error(`unexpected live conditions ${JSON.stringify(live.conditions)}`);
  }
  if (live.conditions.birds !== 0 || live.conditions.dailyFeed !== 37 || live.conditions.feedUnit !== 'KG') {
    throw new Error('birds or feed not parsed');
  }
  if (live.conditions.averageWeight != null) {
    throw new Error('zero average weight should stay off the report');
  }

  const water = parseWaterHistoryRows([
    {
      HistoryRecord_GrowthDay: 21,
      HistoryRecord_TotalDrink: '998.4',
      HistoryRecord_ChangeTotal: -9999,
      HistoryRecord_WaterPerBird: '0.12',
      HistoryRecord_DailyWater_1: '516.7',
      HistoryRecord_DailyWater_2: '0',
      HistoryRecord_DailyWater_3: -9999,
      HistoryRecord_Cooling: '4',
      HistoryRecord_Fogger: '0',
      Flushing: '',
    },
  ]);
  if (water[0].changeTotal != null || water[0].waterPerBird !== 0.12) {
    throw new Error(`water extras parsed wrong: ${JSON.stringify(water[0])}`);
  }
  if (water[0].lines.length !== 2 || water[0].cooling !== 4 || water[0].fogger !== 0) {
    throw new Error(`water lines parsed wrong: ${JSON.stringify(water[0])}`);
  }

  const heaters = parseHeaterHistoryRows([
    {
      HistoryRecord_Heaters_GrowthDay: 21,
      HistoryRecord_Heaters_HeaterDevice_1: '00:00',
      HistoryRecord_Heaters_HeaterDevice_3: '03:43',
      HistoryRecord_Heaters_TotalRuntime: '04:00',
    },
    {
      HistoryRecord_Heaters_GrowthDay: 20,
      HistoryRecord_Heaters_HeaterDevice_4: '02:31',
    },
  ]);
  if (heaters[1].totalMinutes !== 240 || heaters[1].devices.length !== 1) {
    throw new Error(`heater total should win over devices: ${JSON.stringify(heaters[1])}`);
  }
  if (heaters[0].totalMinutes !== 151 || heaters[0].devices[0].device !== 4) {
    throw new Error(`heater devices should sum when no total: ${JSON.stringify(heaters[0])}`);
  }

  const fromController = applyControllerSnapshot(
    {
      averageTemperature: null,
      setTemperature: null,
      temperatureUnit: null,
      insideHumidity: 64,
      co2: null,
      staticPressure: null,
      targetPressure: null,
      pressureUnit: null,
      ventLevel: null,
      birds: 0,
      livability: null,
      dailyFeed: null,
      feedUnit: null,
      averageWeight: null,
      weightUnit: null,
      mortality: null,
      controllerAlarms: [],
    },
    {
      Data: {
        Temperature: {
          CurrentNumericValue: 0,
          CurrentValue: null,
          TargetNumericValue: 0,
          TargetValue: null,
          IsLowAlarmActive: true,
          IsHighAlarmActive: false,
        },
        Humidity: {
          CurrentNumericValue: 70,
          CurrentValue: null,
          IsLowAlarmActive: false,
          IsHighAlarmActive: false,
        },
        Mortality: {
          CurrentNumericValue: 3,
          CurrentValue: '3',
          IsLowAlarmActive: false,
          IsHighAlarmActive: false,
        },
      },
    },
  );
  if (fromController.averageTemperature != null || fromController.insideHumidity !== 64) {
    throw new Error('controller snapshot overwrote command 0 or invented a zero temp');
  }
  if (fromController.mortality !== 3 || !fromController.controllerAlarms.includes('Temp low')) {
    throw new Error(`controller fallback missed mortality/alarm: ${JSON.stringify(fromController)}`);
  }
}

async function main() {
  assertParsers();
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

    const html = second.email.html;
    const text = second.email.text;
    for (const needle of [
      'Live conditions',
      '29.7 / 27.7 / 27.3 C°',
      '64%',
      '24 / 24.9 Pa',
      'Heaters now',
      '20,000 · 99%',
      '37 KG',
      '>CO2<',
      '0.08 / bird',
      '1: 400 · 2: 350 · fog 12',
      'Lines today',
      'H1 2h 0m',
      'yday H1 1h 30m, H4 30m',
      'On today',
      'disconnected',
    ]) {
      assertIncludes(html, needle, 'html');
    }
    if (html.includes('>Mortality<') || html.includes('>Avg weight<')) {
      throw new Error('empty mortality/weight columns should stay hidden');
    }
    for (const needle of [
      'Temp avg / set / out: 29.7 / 27.7 / 27.3 C°',
      'lines today 1: 400 · 2: 350 · fog 12',
      'on today H1 2h 0m',
      'day 20: 1,200 (0.08 / bird)',
    ]) {
      assertIncludes(text, needle, 'text');
    }
    if (!compareAnomaly.completedWaterChange) {
      throw new Error('compare-anomaly export missing');
    }

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
