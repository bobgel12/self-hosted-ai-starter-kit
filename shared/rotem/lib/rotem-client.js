'use strict';

const { runPool, parseConcurrencyEnv } = require('./concurrency');

const API_BASE_URL = 'https://rotemnetweb.com/api/';
const LOGIN_URL = `${API_BASE_URL}Login`;
const UI_ORIGIN = 'https://ui.rotemnetweb.com';
const LOGIN_REFERER = `${UI_ORIGIN}/RotemWebApp/User.html`;
const MAIN_REFERER = `${UI_ORIGIN}/RotemWebApp/Main.html`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** Rotem eCheckLoginResultCode.LoginOk — ConnectToGateway uses the same enum. */
const LOGIN_RESULT_OK = 0;
const LOGIN_RESULT_FAILED = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultCodeOf(body) {
  const payload = unwrapResponse(body);
  const code = payload?.ResultCode ?? body?.ResultCode;
  return typeof code === 'number' ? code : null;
}

function parseSetCookie(setCookieHeader) {
  if (!setCookieHeader) return {};
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const cookies = {};
  for (const header of headers) {
    const part = header.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) {
      cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function unwrapResponse(body) {
  return body?.reponseObj ?? body?.responseObj ?? body;
}

function responseSucceeded(body) {
  if (!body || typeof body !== 'object') return false;
  return (
    body.isSucceed === true ||
    body.reponseObj?.isSucceed === true ||
    body.responseObj?.isSucceed === true
  );
}

function describeHttpFailure(statusCode, body, url) {
  const endpoint = url ? url.split('/').pop() : 'request';
  if (typeof body === 'string') {
    const titleMatch = body.match(/<TITLE>([^<]+)<\/TITLE>/i);
    const title = titleMatch?.[1]?.trim();
    if (title) {
      return `HTTP ${statusCode} ${title} (${endpoint})`;
    }
    return `HTTP ${statusCode} non-JSON response (${endpoint})`;
  }
  return `HTTP ${statusCode} (${endpoint})`;
}

function extractLoginArtifacts(body) {
  const ro = unwrapResponse(body);
  const farmUser = ro?.FarmUser ?? body?.FarmUser ?? {};
  const farmConn = ro?.FarmConnectionInfo ?? body?.FarmConnectionInfo ?? {};

  let webServerUrl = body?.WebServerUrl ?? ro?.WebServerUrl ?? farmConn?.WebServerUrl ?? '';
  if (!webServerUrl) webServerUrl = API_BASE_URL;
  if (webServerUrl && !webServerUrl.endsWith('/')) webServerUrl += '/';
  if (webServerUrl && !webServerUrl.startsWith('http')) {
    webServerUrl = `https://rotemnetweb.com/${webServerUrl.replace(/^\//, '')}`;
  }

  return {
    webServerUrl,
    userToken: farmUser?.UserToken ?? ro?.UserToken ?? '',
    connectionToken: farmConn?.ConnectionToken ?? ro?.ConnectionToken ?? '',
    gatewayName: farmConn?.GatewayName ?? farmUser?.GatewayName ?? ro?.GatewayName ?? '',
    gatewayAliasName:
      farmConn?.GatewayAliasName ?? farmUser?.GatewayAliasName ?? ro?.GatewayAliasName ?? '',
    contextId: body?.contextId ?? ro?.contextId ?? '',
  };
}

function parseDurationToMinutes(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  const str = String(value).trim();
  if (!str) return 0;
  if (str.includes(':')) {
    const parts = str.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    // Rotem heater strings are H:MM (e.g. "04:23" = 4h 23m, "00:32" = 32m).
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    // Some captures use H:MM:SS — convert to fractional minutes.
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
  }
  const num = parseFloat(str);
  return Number.isNaN(num) ? 0 : num;
}

function parseNumeric(value) {
  if (value == null || value === '') return 0;
  const num = parseFloat(String(value).replace(/,/g, ''));
  return Number.isNaN(num) ? 0 : num;
}

/** Null for blank, N/A, and Rotem placeholders. Zero stays zero. */
function optionalNumber(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str || str === 'N/A' || str === '- - -' || str.startsWith('LangKey_')) return null;
  const num = parseFloat(str.replace(/,/g, ''));
  return Number.isNaN(num) ? null : num;
}

function indexParams(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (row?.ParameterKeyName) map.set(row.ParameterKeyName, row.ParameterValue);
  }
  return map;
}

function firstView(rows) {
  return Array.isArray(rows) && rows[0] && typeof rows[0] === 'object' ? rows[0] : {};
}

function unitFromView(view, key) {
  const sign = view?.[`${key}_Sign`];
  if (sign == null || String(sign).trim() === '') return null;
  return String(sign).trim();
}

function blankConditions() {
  return {
    averageTemperature: null,
    setTemperature: null,
    outsideTemperature: null,
    temperatureUnit: null,
    insideHumidity: null,
    staticPressure: null,
    pressureUnit: null,
    targetPressure: null,
    ventLevel: null,
  };
}

/**
 * Ignore the all-zero controller card Rotem sends when a metric has no reading.
 * A real zero still counts when CurrentValue / TargetValue is filled in.
 */
function meaningfulControllerNumber(block, field) {
  if (!block) return null;
  const numeric = block[field];
  if (numeric == null || numeric === '') return null;
  const num = Number(numeric);
  if (Number.isNaN(num)) return null;
  const display = field === 'CurrentNumericValue' ? block.CurrentValue : block.TargetValue;
  if (num === 0 && (display == null || display === '')) return null;
  return num;
}

function applyControllerSnapshot(conditions, house) {
  const data = house?.Data || {};
  const fill = (section, currentKey, targetKey, unitKey) => {
    const block = data[section];
    if (!block) return;
    if (currentKey && conditions[currentKey] == null) {
      const current = meaningfulControllerNumber(block, 'CurrentNumericValue');
      if (current != null) conditions[currentKey] = current;
    }
    if (targetKey && conditions[targetKey] == null) {
      const target = meaningfulControllerNumber(block, 'TargetNumericValue');
      if (target != null) conditions[targetKey] = target;
    }
    if (unitKey && conditions[unitKey] == null && block.UnitsStr) {
      conditions[unitKey] = String(block.UnitsStr);
    }
  };

  fill('Temperature', 'averageTemperature', 'setTemperature', 'temperatureUnit');
  fill('Humidity', 'insideHumidity', null, null);
  fill('Pressure', 'staticPressure', 'targetPressure', 'pressureUnit');
  fill('VentLevel', 'ventLevel', null, null);
  return conditions;
}

function parseLiveHouseData(responseObj) {
  const ds = responseObj?.dsData ?? {};
  const general = indexParams(ds.General);
  const consumption = indexParams(ds.Consumption);
  const generalView = firstView(ds.General_DisplayValues);

  const growthDay = optionalNumber(general.get('Growth_Day'));
  const dailyWater = optionalNumber(consumption.get('Daily_Water'));

  const conditions = blankConditions();
  conditions.averageTemperature = optionalNumber(general.get('Average_Temperature'));
  conditions.setTemperature = optionalNumber(general.get('Set_Temperature'));
  conditions.outsideTemperature = optionalNumber(general.get('Outside_Temperature'));
  conditions.temperatureUnit =
    unitFromView(generalView, 'Average_Temperature') ||
    unitFromView(generalView, 'Set_Temperature');
  conditions.insideHumidity = optionalNumber(general.get('Inside_Humidity'));
  conditions.staticPressure = optionalNumber(general.get('Static_Pressure'));
  conditions.pressureUnit = unitFromView(generalView, 'Static_Pressure');
  conditions.targetPressure = optionalNumber(general.get('Target_Pressure'));
  conditions.ventLevel = optionalNumber(general.get('Vent_Level'));

  return { growthDay, dailyWater, conditions };
}

function resolveCurrentGrowthDay(liveGrowthDay, controllerGrowthDay, waterHistory, heaterHistory) {
  if (liveGrowthDay != null && !Number.isNaN(liveGrowthDay)) return liveGrowthDay;
  if (controllerGrowthDay != null && !Number.isNaN(Number(controllerGrowthDay))) {
    return Number(controllerGrowthDay);
  }
  const historyDays = [
    ...(waterHistory || []).map((r) => r.growthDay),
    ...(heaterHistory || []).map((r) => r.growthDay),
  ].filter((d) => d != null && d >= 0);
  return historyDays.length ? Math.max(...historyDays) : null;
}

function pctChange(current, previous) {
  if (previous == null || previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function parseWaterHistoryRows(rows) {
  const parsed = [];
  for (const row of rows || []) {
    const growthDay = row.HistoryRecord_GrowthDay ?? row.GrowthDay;
    if (growthDay == null || growthDay < 0) continue;
    const total =
      row.HistoryRecord_TotalDrink ??
      row.HistoryRecord_TotalWater ??
      row.TotalDrink ??
      row.TotalWater ??
      0;
    parsed.push({
      growthDay: Number(growthDay),
      total: parseNumeric(total),
      changeTotal: row.HistoryRecord_ChangeTotal ?? null,
      waterPerBird: row.HistoryRecord_WaterPerBird ?? null,
    });
  }
  return parsed.sort((a, b) => a.growthDay - b.growthDay);
}

function parseHeaterHistoryRows(rows) {
  const parsed = [];
  for (const row of rows || []) {
    const growthDay = row.HistoryRecord_Heaters_GrowthDay ?? row.HistoryRecord_GrowthDay;
    if (growthDay == null || growthDay < 0) continue;

    let totalMinutes =
      parseDurationToMinutes(row.HistoryRecord_Heaters_TotalRuntime) ||
      parseDurationToMinutes(row.HistoryRecord_Heaters_Total);

    const devices = [];
    if (!totalMinutes) {
      for (let i = 1; i <= 16; i++) {
        const key = `HistoryRecord_Heaters_HeaterDevice_${i}`;
        const mins = parseDurationToMinutes(row[key]);
        if (mins > 0) {
          devices.push({ device: i, minutes: mins });
          totalMinutes += mins;
        }
      }
    }

    parsed.push({
      growthDay: Number(growthDay),
      totalMinutes: Math.round(totalMinutes),
      devices,
    });
  }
  return parsed.sort((a, b) => a.growthDay - b.growthDay);
}

function valueForGrowthDay(history, growthDay) {
  if (growthDay == null) return null;
  const matches = (history || []).filter((r) => r.growthDay === growthDay);
  return matches.length ? matches[matches.length - 1] : null;
}

/** Last N flock days ending at currentGrowthDay (inclusive), oldest first. */
function lastNGrowthDays(history, currentGrowthDay, count, valueField = 'total') {
  if (currentGrowthDay == null || count < 1) return [];
  const rows = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const growthDay = currentGrowthDay - offset;
    const row = valueForGrowthDay(history, growthDay);
    rows.push({
      growthDay,
      total: valueField === 'totalMinutes' ? (row?.totalMinutes ?? null) : (row?.total ?? null),
    });
  }
  return rows;
}

function commandDataReady(body) {
  const payload = unwrapResponse(body);
  const ds = payload?.dsData;
  if (!ds) return false;
  // eRNBLResult-only payloads (e.g. Value 5) mean the controller command failed.
  return Boolean(
    (Array.isArray(ds.General) && ds.General.length) ||
      (Array.isArray(ds.Data) && ds.Data.length) ||
      (Array.isArray(ds.Consumption) && ds.Consumption.length),
  );
}

function emptyHouseReport(house, errorMessage, liveData) {
  const houseNumber = house.HouseNumber;
  const seeded = {
    ...blankConditions(),
    ...(liveData?.conditions || {}),
  };
  return {
    houseNumber,
    houseName: house.HouseName ?? `House ${houseNumber}`,
    growthDay: liveData?.growthDay ?? house.GrowthDay ?? null,
    connectionStatus: house.ConnectionStatus ?? 0,
    fetchError: errorMessage,
    conditions: applyControllerSnapshot(seeded, house),
    water: {
      todayTotal: null,
      yesterdayTotal: null,
      pctChange: null,
      last3Days: [],
      historyRows: [],
    },
    heaters: {
      todayTotalMinutes: null,
      yesterdayTotalMinutes: null,
      pctChange: null,
      last3Days: [],
      devices: [],
      historyRows: [],
    },
  };
}

class RotemClient {
  constructor(httpRequest, options = {}) {
    this.httpRequest = httpRequest;
    this.delayMs = options.delayMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.houseConcurrency =
      options.houseConcurrency ?? parseConcurrencyEnv('ROTEM_HOUSE_CONCURRENCY', 2);
    this.cookies = {};
    this.session = null;
    this._cookieLock = Promise.resolve();
  }

  async post(url, body, extraHeaders = {}) {
    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      Origin: UI_ORIGIN,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': USER_AGENT,
      userLanguage: 'ENGLISH',
      ...extraHeaders,
    };
    if (this.session?.userToken && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${this.session.userToken}`;
    }
    if (Object.keys(this.cookies).length) {
      headers.Cookie = cookieHeader(this.cookies);
    }

    const response = await this.httpRequest({
      method: 'POST',
      url,
      headers,
      body,
      json: true,
      returnFullResponse: true,
      timeout: this.timeoutMs,
    });

    const statusCode = response.statusCode ?? 0;
    const responseBody = response.body ?? response;

    if (statusCode >= 400 || typeof responseBody === 'string') {
      throw new Error(
        `RotemNet ${describeHttpFailure(statusCode, responseBody, url)}`,
      );
    }

    const setCookie =
      response.headers?.['set-cookie'] ?? response.headers?.['Set-Cookie'];
    if (setCookie) {
      const parsed = parseSetCookie(setCookie);
      this._cookieLock = this._cookieLock.then(() => {
        Object.assign(this.cookies, parsed);
      });
      await this._cookieLock;
    }

    return responseBody;
  }

  buildAuthHeaders(referer = MAIN_REFERER) {
    return {
      userToken: this.session.userToken,
      Authorization: `Bearer ${this.session.userToken}`,
      ...(this.session.connectionToken
        ? { farmConnectionToken: this.session.connectionToken }
        : {}),
      Referer: referer,
      ...(this.session.contextId ? { contextId: this.session.contextId } : {}),
    };
  }

  serviceUrl(endpoint) {
    return `${this.session.webServerUrl}${endpoint}`;
  }

  async login(username, password, options = {}) {
    this._username = username;
    this._password = password;
    const gatewayOverride = options.gatewayCode || this._gatewayCode || '';
    this._gatewayCode = gatewayOverride;
    // FarmConnectionInfo (ConnectionToken) is often null unless KeepMeSignedIn
    // is true — especially for multi-account users who land on My Farm Groups.
    // Without farmConnectionToken, GetSiteControllersInfo returns empty houses.
    // Gateway may also be temporarily "disconnected from cloud"; retry with backoff.
    const maxAttempts = options.maxAttempts ?? 10;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const body = await this.post(
        LOGIN_URL,
        {
          prmUsername: username,
          prmPassword: password,
          prmIsNativeAppLogin: false,
          // Required for FarmConnectionInfo/ConnectionToken on current Rotem API.
          prmIsKeepMeSignedIn: true,
        },
        { userToken: 'null', Referer: LOGIN_REFERER },
      );

      if (!responseSucceeded(body)) {
        const msg =
          body?.ErrorObj?.ErrorMessage ??
          body?.ErrorObj ??
          body?.reponseObj?.ErrorObj?.ErrorMessage ??
          body?.reponseObj?.ErrorObj ??
          'Login failed — check username and password';
        throw new Error(`RotemNet login failed: ${JSON.stringify(msg)}`);
      }

      const artifacts = extractLoginArtifacts(body);
      if (!artifacts.userToken) {
        throw new Error(
          'RotemNet login succeeded but farm context is missing (UserToken)',
        );
      }

      if (!artifacts.gatewayName && gatewayOverride) {
        artifacts.gatewayName = gatewayOverride;
      }

      this.session = artifacts;

      // Multi-account logins omit FarmConnectionInfo. Resolve GatewayCode +
      // GatewayAliasName from GetUserAccounts (UI "My Farm Groups" path).
      if (!this.session.gatewayName || !this.session.gatewayAliasName) {
        try {
          await this.resolveGatewayFromAccounts(gatewayOverride || this.session.gatewayName);
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            await sleep(Math.min(30000, 1500 * attempt));
            continue;
          }
          throw err;
        }
      }

      if (!this.session.gatewayName) {
        lastError = new Error(
          'RotemNet login succeeded but no gateway found. Set rotemGatewayCode in farms.json',
        );
        if (attempt < maxAttempts) {
          await sleep(Math.min(30000, 1500 * attempt));
          continue;
        }
        throw lastError;
      }

      // ConnectionToken may already be present from Login (single-farm / KeepMeSignedIn).
      // Still call ConnectToGateway — without it RNBL returns empty/denied payloads.
      try {
        await this.connectToGateway();
      } catch (err) {
        lastError = err;
        // If Login already gave a ConnectionToken, keep going — controllers may work.
        if (this.session.connectionToken) {
          return this.session;
        }
        if (attempt < maxAttempts) {
          // Gateway "disconnected from cloud" needs longer backoff than auth flapping.
          const disconnect = err && err.code === 'GATEWAY_DISCONNECTED';
          await sleep(disconnect ? Math.min(45000, 5000 * attempt) : Math.min(15000, 800 * attempt));
          continue;
        }
        throw err;
      }

      // farmConnectionToken is required for non-empty FarmHouses.
      if (this.session.connectionToken) {
        return this.session;
      }

      lastError = new Error(
        'RotemNet ConnectToGateway returned no ConnectionToken',
      );
      if (attempt < maxAttempts) {
        await sleep(Math.min(30000, 1500 * attempt));
      }
    }

    throw (
      lastError ||
      new Error(
        'RotemNet login succeeded but farm connection is missing (ConnectionToken/GatewayName). Retry or set rotemGatewayCode in farms.json',
      )
    );
  }

  /**
   * Look up GatewayCode + GatewayAliasName from the account hierarchy when Login
   * omits FarmConnectionInfo (My Farm Groups accounts such as bobby-angel).
   */
  async resolveGatewayFromAccounts(preferredCode = '') {
    const body = await this.callService('GetUserAccounts', {
      prmIsOnlyAdminAccounts: false,
    });
    const payload = unwrapResponse(body);
    const accounts = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? Object.values(payload)
        : [];
    const gateways = accounts.flatMap((account) => account?.LstGateways || []);
    if (!gateways.length) {
      throw new Error('RotemNet GetUserAccounts returned no gateways');
    }

    const normalized = String(preferredCode || '').toLowerCase();
    const match = normalized
      ? gateways.find(
          (gw) =>
            String(gw.GatewayCode || '').toLowerCase() === normalized ||
            String(gw.GatewayName || '').toLowerCase() === normalized,
        )
      : null;
    const gateway = match || (gateways.length === 1 ? gateways[0] : null);
    if (!gateway) {
      throw new Error(
        `RotemNet could not match gateway ${preferredCode || '(none)'}; set rotemGatewayCode in farms.json`,
      );
    }

    this.session.gatewayName = gateway.GatewayCode || gateway.GatewayName || this.session.gatewayName;
    this.session.gatewayAliasName =
      gateway.GatewayAliasName || this.session.gatewayAliasName || this.session.gatewayName;
    return gateway;
  }

  /**
   * Required after login on the new Rotem API. Without it, RNBL_GetCommandData
   * returns empty eRNBLResult payloads and all metrics look like zeros.
   * UI checks ResultCode === LoginOk (0); isSucceed alone is NOT enough —
   * a disconnected gateway returns isSucceed=true with ResultCode=LoginFailed.
   */
  async connectToGateway() {
    if (!this.session?.gatewayName) return null;
    const alias =
      this.session.gatewayAliasName || this.session.gatewayName;
    const body = await this.post(
      this.serviceUrl('Gateways/ConnectToGateway'),
      {
        prmGatewayCode: this.session.gatewayName,
        prmGatewayAliasName: alias,
      },
      this.buildAuthHeaders(),
    );
    const payload = unwrapResponse(body);
    const resultCode = resultCodeOf(body);

    if (!responseSucceeded(body) || (resultCode != null && resultCode !== LOGIN_RESULT_OK)) {
      const err = new Error(
        resultCode === LOGIN_RESULT_FAILED
          ? 'RotemNet ConnectToGateway failed: gateway disconnected from cloud or still connecting — retry shortly'
          : `RotemNet ConnectToGateway failed: ResultCode=${resultCode} ${JSON.stringify(
              payload?.ResultMessage ?? body?.ErrorObj ?? payload?.ErrorObj ?? null,
            )}`,
      );
      if (resultCode === LOGIN_RESULT_FAILED) err.code = 'GATEWAY_DISCONNECTED';
      throw err;
    }

    const connected = extractLoginArtifacts(body);
    if (!connected.connectionToken) {
      const err = new Error(
        'RotemNet ConnectToGateway succeeded but ConnectionToken is missing',
      );
      err.code = 'MISSING_CONNECTION_TOKEN';
      throw err;
    }

    this.session.connectionToken = connected.connectionToken;
    if (connected.gatewayName) {
      this.session.gatewayName = connected.gatewayName;
    }
    if (connected.gatewayAliasName) {
      this.session.gatewayAliasName = connected.gatewayAliasName;
    }
    return body;
  }

  ensureAuthorized(body) {
    if (body?.isAuthorize === false || body?.isInSession === false) {
      return false;
    }
    if (body?.isSucceed === false) {
      throw new Error(`RotemNet request failed: ${JSON.stringify(body?.ErrorObj ?? body)}`);
    }
    return true;
  }

  async callService(endpoint, payload, retried = false) {
    const body = await this.post(this.serviceUrl(endpoint), payload, this.buildAuthHeaders());
    if (!this.ensureAuthorized(body) && !retried) {
      await this.login(this._username, this._password);
      return this.callService(endpoint, payload, true);
    }
    return body;
  }

  async getSiteControllersInfo() {
    const payload = this.session.gatewayName
      ? { prmSiteControllersInfoParams: { GatewayCode: this.session.gatewayName } }
      : {};
    return this.callService('GetSiteControllersInfo', payload);
  }

  async getFarmRegistration() {
    return this.callService('GetFarmRegistration', {
      prmFarmRegistrationParams: { GatewayCode: this.session.gatewayName },
    });
  }

  async getCommandData(houseNumber, commandId) {
    const payload = {
      prmGetCommandDataParams: {
        CommandID: String(commandId),
        IsSetPointCommand: false,
        HouseNumber: String(houseNumber),
        RoomNumber: -1,
        ClientLanguageIndex: 1,
        // Cached/empty responses return only eRNBLResult; ignore cache for live totals.
        IsIgnoreCache: true,
        PageNumber: -1,
        IsLoadPageFromCache: false,
      },
    };

    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      last = await this.callService('RNBL_GetCommandData', payload);
      if (commandDataReady(last)) return last;
      if (attempt === 2) {
        await this.login(this._username, this._password, {
          gatewayCode: this._gatewayCode || this.session?.gatewayName,
        });
      } else if (attempt === 1) {
        try {
          await this.connectToGateway();
        } catch {
          // login retry on next attempt
        }
      }
      if (attempt < 3) await sleep(1000 * attempt);
    }
    return last;
  }

  async fetchHouseReport(house) {
    const houseNumber = house.HouseNumber;
    const growthDay = house.GrowthDay ?? house.Data?.GrowthDay?.CurrentNumericValue;
    const connectionStatus = house.ConnectionStatus ?? 0;
    const houseName = house.HouseName ?? `House ${houseNumber}`;

    let waterHistory = [];
    let heaterHistory = [];
    let liveData = { growthDay: null, dailyWater: null, conditions: blankConditions() };

    if (connectionStatus === 1) {
      const liveBody = await this.getCommandData(houseNumber, '0');
      if (!commandDataReady(liveBody)) {
        return emptyHouseReport(
          house,
          'RotemNet returned no live data after retries',
        );
      }
      liveData = parseLiveHouseData(unwrapResponse(liveBody));
      await sleep(this.delayMs);

      const waterBody = await this.getCommandData(houseNumber, '40');
      await sleep(this.delayMs);
      const heaterBody = await this.getCommandData(houseNumber, '43');
      await sleep(this.delayMs);

      if (!commandDataReady(waterBody) || !commandDataReady(heaterBody)) {
        return emptyHouseReport(
          house,
          'RotemNet returned no history after retries',
          liveData,
        );
      }

      waterHistory = parseWaterHistoryRows(
        unwrapResponse(waterBody)?.dsData?.Data ?? [],
      );
      heaterHistory = parseHeaterHistoryRows(
        unwrapResponse(heaterBody)?.dsData?.Data ?? [],
      );
    }

    const currentGrowthDay = resolveCurrentGrowthDay(
      liveData.growthDay,
      growthDay,
      waterHistory,
      heaterHistory,
    );
    const todayWater = valueForGrowthDay(waterHistory, currentGrowthDay);
    const yesterdayWater = valueForGrowthDay(waterHistory, currentGrowthDay - 1);
    const todayHeater = valueForGrowthDay(heaterHistory, currentGrowthDay);
    const yesterdayHeater = valueForGrowthDay(heaterHistory, currentGrowthDay - 1);

    const todayWaterTotal = todayWater?.total ?? liveData.dailyWater ?? 0;
    const yesterdayWaterTotal = yesterdayWater?.total ?? 0;
    const todayHeaterMinutes = todayHeater?.totalMinutes ?? 0;
    const yesterdayHeaterMinutes = yesterdayHeater?.totalMinutes ?? 0;

    const waterLast3Days = lastNGrowthDays(waterHistory, currentGrowthDay, 3, 'total');
    const heaterLast3Days = lastNGrowthDays(heaterHistory, currentGrowthDay, 3, 'totalMinutes');
    const conditions = applyControllerSnapshot(
      {
        ...blankConditions(),
        ...(liveData.conditions || {}),
      },
      house,
    );

    return {
      houseNumber,
      houseName,
      growthDay: currentGrowthDay,
      connectionStatus,
      conditions,
      liveDailyWater:
        liveData.dailyWater ??
        house.Data?.DailyWater?.CurrentNumericValue ??
        null,
      growthDaySource:
        liveData.growthDay != null
          ? 'command0'
          : growthDay != null
            ? 'controller'
            : 'history',
      water: {
        todayTotal: todayWaterTotal,
        yesterdayTotal: yesterdayWaterTotal,
        pctChange: pctChange(todayWaterTotal, yesterdayWaterTotal),
        rotemPctChange: todayWater?.changeTotal ?? null,
        last3Days: waterLast3Days,
        historyRows: waterHistory,
      },
      heaters: {
        todayTotalMinutes: todayHeaterMinutes,
        yesterdayTotalMinutes: yesterdayHeaterMinutes,
        // In-progress today versus the prior flock day. The email's day-to-day
        // delta does not use this; it compares the last two completed days.
        pctChange: pctChange(todayHeaterMinutes, yesterdayHeaterMinutes),
        last3Days: heaterLast3Days,
        devices: todayHeater?.devices ?? [],
        historyRows: heaterHistory,
      },
    };
  }

  async fetchFarmReport(farm) {
    this._username = farm.rotemUsername;
    this._password = farm.rotemPassword;

    if (farm.dataSource === 'django_proxy') {
      throw new Error('django_proxy dataSource is not wired yet; use rotem_direct');
    }

    await this.login(farm.rotemUsername, farm.rotemPassword, {
      gatewayCode: farm.rotemGatewayCode,
    });

    let controllersBody = await this.getSiteControllersInfo();
    let controllers = unwrapResponse(controllersBody);
    let houses = controllers?.FarmHouses ?? [];
    if (houses.length === 0) {
      await this.login(farm.rotemUsername, farm.rotemPassword, {
        gatewayCode: farm.rotemGatewayCode,
      });
      controllersBody = await this.getSiteControllersInfo();
      controllers = unwrapResponse(controllersBody);
      houses = controllers?.FarmHouses ?? [];
    }

    const registrationBody = await this.getFarmRegistration();
    const registration = unwrapResponse(registrationBody)?.FarmRegistration ?? {};
    const farmName =
      registration.FarmName ??
      registration.GatewayAliasName ??
      farm.displayName ??
      farm.id;
    if (houses.length === 0) {
      throw new Error(
        'RotemNet returned no houses — need farmConnectionToken after ConnectToGateway (gateway may be disconnected from cloud, or set rotemGatewayCode + alias via GetUserAccounts)',
      );
    }

    const reportHouses = await runPool(houses, this.houseConcurrency, async (house) => {
      try {
        return await this.fetchHouseReport(house);
      } catch (err) {
        return emptyHouseReport(house, err.message);
      }
    });

    return {
      farmId: farm.id,
      farmName,
      farmDisplayName: farm.displayName,
      timezone: farm.timezone,
      recipientEmail: farm.recipientEmail,
      reportTime: new Date().toISOString(),
      registration: {
        country: registration.Country ?? null,
        integrator: registration.Integrator ?? null,
        segment: registration.Segment ?? null,
      },
      houses: reportHouses,
    };
  }
}

module.exports = {
  RotemClient,
  parseWaterHistoryRows,
  parseHeaterHistoryRows,
  parseLiveHouseData,
  applyControllerSnapshot,
  parseDurationToMinutes,
  parseNumeric,
  pctChange,
  valueForGrowthDay,
  resolveCurrentGrowthDay,
  lastNGrowthDays,
};
