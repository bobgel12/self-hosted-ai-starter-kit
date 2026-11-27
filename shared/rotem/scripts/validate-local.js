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
const { buildFailureEmail } = require(path.join(ROOT, 'lib', 'email-builder'));
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
        staticPressure: 24,
        pressureUnit: 'Pa',
        ventLevel: 17,
      },
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
        last3Days: [
          { growthDay: 19, total: 320 },
          { growthDay: 20, total: 400 },
          { growthDay: 21, total: 500 },
        ],
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

function assertFailureEmails() {
  const cases = [
    ['timeout of 1200000ms exceeded', 'Runner timeout'],
    ['Task execution timed out', 'Runner timeout'],
    ['RotemNet ConnectToGateway returned no ConnectionToken', 'No ConnectionToken'],
    ['RotemNet ConnectToGateway succeeded but ConnectionToken is missing', 'No ConnectionToken'],
    [
      'RotemNet login succeeded but farm connection is missing (ConnectionToken/GatewayName). Retry or set rotemGatewayCode in farms.json',
      'No ConnectionToken',
    ],
    [
      'RotemNet ConnectToGateway failed: gateway disconnected from cloud or still connecting — retry shortly',
      'Gateway disconnected',
    ],
  ];
  for (const [message, label] of cases) {
    const email = buildFailureEmail({
      item: { message, farmName: 'Bobby Angel Farm', farmId: 'bobby-angel' },
      config: { recipientEmail: 'a@example.com', senderEmail: 'a@example.com' },
      stamp: 'builtAt=2026-11-25T03:02:42Z | lib=abc',
    });
    if (!email.subject.startsWith(`[RotemNet] ${label} — Bobby Angel Farm`)) {
      throw new Error(`subject for ${label}: ${email.subject}`);
    }
    if (email.subject.includes('[RotemNet] Error')) {
      throw new Error(`generic error subject for ${message}`);
    }
    if (!email.html.includes('Image stamp') || !email.html.includes('builtAt=2026-11-25T03:02:42Z')) {
      throw new Error(`stamp missing for ${label}`);
    }
    if (!email.text.includes('Image stamp: builtAt=2026-11-25T03:02:42Z | lib=abc')) {
      throw new Error(`text stamp missing for ${label}`);
    }
  }

  const fromNode = buildFailureEmail({
    item: { error: { message: 'timeout of 1200000ms exceeded' }, farmId: 'bobby-angel' },
    farm: { id: 'bobby-angel', displayName: 'Bobby Angel Farm' },
    config: { recipientEmail: 'a@example.com' },
    stamp: 'stamp-from-http-node',
  });
  if (!fromNode.subject.startsWith('[RotemNet] Runner timeout — Bobby Angel Farm')) {
    throw new Error(`http-node timeout subject: ${fromNode.subject}`);
  }
  if (!fromNode.html.includes('stamp-from-http-node')) {
    throw new Error('http-node error dropped the image stamp');
  }

  const rotelTimeout = buildFailureEmail({
    item: { error: true, message: 'Request timeout after 120000ms', farmName: 'Bobby Angel Farm' },
    config: { recipientEmail: 'a@example.com' },
    stamp: 'stamp-rotem-http',
  });
  if (rotelTimeout.cause === 'Runner timeout' || rotelTimeout.subject.includes('[RotemNet] Error —')) {
    throw new Error(`Rotem request timeout classified wrong: ${rotelTimeout.subject}`);
  }
  if (!rotelTimeout.html.includes('stamp-rotem-http')) {
    throw new Error('Rotem request timeout dropped the image stamp');
  }

  const missingStamp = buildFailureEmail({
    item: { message: 'timeout of 1200000ms exceeded', farmName: 'Bobby Angel Farm' },
    config: { recipientEmail: 'a@example.com' },
  });
  if (!missingStamp.html.includes('IMAGE_STAMP missing') || !missingStamp.text.includes('IMAGE_STAMP missing')) {
    throw new Error('missing image stamp should be named');
  }
}

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
  const kept = ['averageTemperature', 'setTemperature', 'outsideTemperature', 'temperatureUnit', 'insideHumidity', 'staticPressure', 'pressureUnit', 'targetPressure', 'ventLevel'];
  const extra = Object.keys(live.conditions).filter((key) => !kept.includes(key));
  if (extra.length) {
    throw new Error(`live conditions has extra fields: ${extra.join(', ')}`);
  }
  if (live.conditions.averageTemperature !== 29.71 || live.conditions.temperatureUnit !== 'C°') {
    throw new Error('temperature not parsed from command 0');
  }
  if (live.conditions.insideHumidity !== 64 || live.conditions.staticPressure !== 24 || live.conditions.pressureUnit !== 'Pa') {
    throw new Error(`humidity or pressure parsed wrong: ${JSON.stringify(live.conditions)}`);
  }
  if (live.conditions.targetPressure !== 24.9) {
    throw new Error(`target pressure not parsed from command 0: ${JSON.stringify(live.conditions)}`);
  }
  if (live.conditions.ventLevel !== 17) {
    throw new Error('vent level not parsed');
  }

  const water = parseWaterHistoryRows([
    {
      HistoryRecord_GrowthDay: 21,
      HistoryRecord_TotalDrink: '998.4',
      HistoryRecord_ChangeTotal: 3,
      HistoryRecord_WaterPerBird: '0.12',
    },
  ]);
  if (water[0].total !== 998.4 || water[0].lines || water[0].cooling != null) {
    throw new Error(`water row should stay totals only: ${JSON.stringify(water[0])}`);
  }

  const heaters = parseHeaterHistoryRows([
    {
      HistoryRecord_Heaters_GrowthDay: 20,
      HistoryRecord_Heaters_HeaterDevice_4: '02:31',
    },
  ]);
  if (heaters[0].totalMinutes !== 151) {
    throw new Error(`heater devices should sum when no total: ${JSON.stringify(heaters[0])}`);
  }

  const fromController = applyControllerSnapshot(
    {
      averageTemperature: null,
      setTemperature: 27.7,
      temperatureUnit: null,
      insideHumidity: 64,
      staticPressure: null,
      pressureUnit: null,
      ventLevel: null,
    },
    {
      Data: {
        Temperature: {
          CurrentNumericValue: 0,
          CurrentValue: null,
          TargetNumericValue: 80,
          TargetValue: '80',
        },
        Pressure: {
          CurrentNumericValue: 0.12,
          CurrentValue: '0.12',
          UnitsStr: 'inWC',
        },
        VentLevel: {
          CurrentNumericValue: 8,
          CurrentValue: '8',
        },
        Mortality: {
          CurrentNumericValue: 3,
          CurrentValue: '3',
        },
      },
    },
  );
  if (fromController.averageTemperature != null || fromController.insideHumidity !== 64) {
    throw new Error('controller snapshot overwrote command 0 or invented a zero temp');
  }
  if (fromController.setTemperature !== 27.7) {
    throw new Error('controller target should not replace a command 0 set point');
  }
  if (fromController.staticPressure !== 0.12 || fromController.pressureUnit !== 'inWC' || fromController.ventLevel !== 8) {
    throw new Error(`controller fallback missed pressure/vent: ${JSON.stringify(fromController)}`);
  }
  if ('mortality' in fromController) {
    throw new Error('controller fallback should not add mortality');
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
      'Temp avg / set / out',
      '29.7 / 27.7 / 27.3 C°',
      'Humidity',
      '64%',
      'Static pressure',
      '>24 Pa<',
      'Vent level',
      '>17<',
      'disconnected',
    ]) {
      assertIncludes(html, needle, 'html');
    }
    for (const banned of [
      'Heaters now',
      'Birds',
      'Feed today',
      'CO2',
      'Avg weight',
      'Mortality',
      'Alarms',
      'Lines today',
      '/ bird',
      'On today',
      'yday H',
    ]) {
      if (html.includes(banned)) {
        throw new Error(`html still includes removed field ${JSON.stringify(banned)}`);
      }
    }
    for (const needle of [
      'Temp avg / set / out: 29.7 / 27.7 / 27.3 C°',
      'Humidity: 64%',
      'Static pressure: 24 Pa',
      'Vent level: 17',
      'day 20: 1,200',
    ]) {
      assertIncludes(text, needle, 'text');
    }
    if (!compareAnomaly.completedWaterChange || !compareAnomaly.loadSameSlotSnapshot) {
      throw new Error('compare-anomaly export missing');
    }
    for (const needle of [
      'Water — Last 3 Flock Days',
      'Heater Runtime — Last 3 Flock Days',
      'Day-over-Day Summary',
      'Yesterday this time',
      'Heater today',
      'Heater full day',
      'Day-to-day Δ%',
      'Last full day',
      'Completed days total',
    ]) {
      assertIncludes(html, needle, 'full tables');
    }
    if (html.includes('2-day total') || html.includes('Last 2 Flock')) {
      throw new Error('heater block still labels a 2-day total beside 3 flock days');
    }
    const heaterHtml = html.split('Heater Runtime — Last 3 Flock Days')[1]?.split('Day-over-Day Summary')[0] || '';
    for (const needle of ['House 1', 'House 2', '5h 20m', '6h 40m', '8h 20m', '12h 0m', '+25%', 'day 20 vs day 19']) {
      assertIncludes(heaterHtml, needle, 'house heater html');
    }
    const waterBlock = text.split('Water — Last 3 flock days:')[1]?.split('Heater — Last 3 flock days:')[0] || '';
    const heaterBlock = text.split('Heater — Last 3 flock days:')[1]?.split('Day-over-day summary:')[0] || '';
    const summaryBlock = text.split('Day-over-day summary:')[1] || '';
    assertIncludes(
      heaterBlock,
      'House 1: day 19: 5h 20m, day 20: 6h 40m, day 21: 8h 20m',
      'three heater days',
    );
    assertIncludes(heaterBlock, 'day-to-day +25% · day 20 vs day 19', 'completed-day heater delta');
    assertIncludes(summaryBlock, 'heater today 10h 50m', 'in-progress heater today');
    assertIncludes(summaryBlock, 'day-to-day +25% · day 20 vs day 19', 'summary completed-day delta');
    for (const houseName of ['House 1', 'House 2']) {
      assertIncludes(waterBlock, `${houseName}:`, 'every-house water');
      assertIncludes(heaterBlock, `${houseName}:`, 'every-house heater');
      assertIncludes(summaryBlock, `${houseName} |`, 'every-house summary');
    }
    assertIncludes(text, 'House 1 | day 21', 'collapsed house');
    assertIncludes(text, 'yesterday this time —', 'missing same-slot compare');
    assertIncludes(html, 'Needs attention', 'expanded section');
    assertIncludes(html, 'Live conditions', 'live conditions heading');
    if (html.includes('+80%')) {
      throw new Error('same-slot percent appeared before a 24h snapshot existed');
    }
    if ((second.report.alerts || []).some((a) => a.houseNumber === 1)) {
      throw new Error(`healthy house should stay collapsed, alerts: ${second.report.alerts.map((a) => a.message).join(' | ')}`);
    }
    const secondHeaterHtml =
      second.email.html.split('Heater Runtime — Last 3 Flock Days')[1]?.split('Day-over-Day Summary')[0] || '';
    assertIncludes(secondHeaterHtml, 'day 20 vs day 19', 'delta stays on completed days');
    assertIncludes(secondHeaterHtml, '+25%', 'completed-day percent');
    if (second.email.html.includes('+30%') || second.email.text.includes('vs prior')) {
      throw new Error('day-to-day heater delta followed in-progress today instead of completed days');
    }

    assertFailureEmails();

    console.log('4. Same-slot water from the prior run...');
    const period = compareAnomaly.getReportPeriod(farm.timezone);
    const savedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const historyDir = path.join(DATA_ROOT, 'history', 'farm-test');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(
      path.join(historyDir, `${savedAt.slice(0, 10)}-${period}.json`),
      JSON.stringify(
        {
          savedAt,
          reportPeriod: period,
          farmId: 'farm-test',
          houses: [
            {
              houseNumber: 1,
              houseName: 'House 1',
              growthDay: 21,
              waterTodayTotal: 1000,
              heaterTodayMinutes: 400,
            },
          ],
        },
        null,
        2,
      ),
    );
    const third = await orchestrator.processFarm(farm, config, thresholds, {
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
    assertIncludes(third.email.html, '1,000', 'yesterday same slot');
    assertIncludes(third.email.html, '+800', 'same-slot gallons');
    assertIncludes(third.email.html, '+80%', 'same-slot percent');
    assertIncludes(third.email.html, '+9.1%', 'full-day change');
    assertIncludes(third.email.text, 'water so far 1,800', 'water so far');
    assertIncludes(third.email.text, 'yesterday this time 1,000', 'yesterday same slot text');
    assertIncludes(third.email.text, 'same-time +800 gal (+80%)', 'same-slot difference');
    assertIncludes(third.email.text, 'House 2 (#2) [expanded]', 'alert house stays expanded');
    assertIncludes(third.email.text, 'yesterday this time —', 'house without snapshot stays blank');
    if ((third.report.alerts || []).some((a) => /zero water/i.test(a.message))) {
      throw new Error('unfinished water must not raise a zero-water alert');
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
