'use strict';

const { runPool, parseConcurrencyEnv } = require('./concurrency');

const API_BASE_URL = 'https://rotemnetweb.com/api/';
const LOGIN_URL = `${API_BASE_URL}Login`;
const UI_ORIGIN = 'https://ui.rotemnetweb.com';
const LOGIN_REFERER = `${UI_ORIGIN}/RotemWebApp/User.html`;
const MAIN_REFERER = `${UI_ORIGIN}/RotemWebApp/Main.html`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function parseLiveHouseData(responseObj) {
  const general = responseObj?.dsData?.General ?? [];
  const consumption = responseObj?.dsData?.Consumption ?? [];

  const growthDayRow = general.find((g) => g.ParameterKeyName === 'Growth_Day');
  const dailyWaterRow = consumption.find((c) => c.ParameterKeyName === 'Daily_Water');

  const growthDay =
    growthDayRow?.ParameterValue != null && growthDayRow.ParameterValue !== ''
      ? Number(growthDayRow.ParameterValue)
      : null;
  const dailyWater =
    dailyWaterRow?.ParameterValue != null && dailyWaterRow.ParameterValue !== ''
      ? parseNumeric(dailyWaterRow.ParameterValue)
      : null;

  return { growthDay, dailyWater };
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

function sumLastNDays(rows) {
  return rows.reduce((sum, r) => sum + (r.total ?? 0), 0);
}

function commandDataReady(body) {
  const payload = unwrapResponse(body);
  return Boolean(payload && payload.dsData);
}

function emptyHouseReport(house, errorMessage) {
  const houseNumber = house.HouseNumber;
  return {
    houseNumber,
    houseName: house.HouseName ?? `House ${houseNumber}`,
    growthDay: house.GrowthDay ?? null,
    connectionStatus: house.ConnectionStatus ?? 0,
    fetchError: errorMessage,
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
      last2Days: [],
      last2DaysTotalMinutes: null,
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

    for (let attempt = 1; attempt <= 3; attempt++) {
      const body = await this.post(
        LOGIN_URL,
        {
          prmUsername: username,
          prmPassword: password,
          prmIsNativeAppLogin: false,
          prmIsKeepMeSignedIn: false,
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

      if (artifacts.gatewayName) {
        this.session = artifacts;
        return artifacts;
      }

      if (attempt < 3) {
        await sleep(500 * attempt);
      }
    }

    throw new Error(
      'RotemNet login succeeded but farm gateway is missing (GatewayName). Retry or set rotemGatewayCode in farms.json',
    );
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
        IsIgnoreCache: false,
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
    let liveData = { growthDay: null, dailyWater: null };

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
    const heaterLast2Days = lastNGrowthDays(heaterHistory, currentGrowthDay, 2, 'totalMinutes');
    const heaterLast2DaysTotal = sumLastNDays(heaterLast2Days);

    return {
      houseNumber,
      houseName,
      growthDay: currentGrowthDay,
      connectionStatus,
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
        pctChange: pctChange(todayHeaterMinutes, yesterdayHeaterMinutes),
        last2Days: heaterLast2Days,
        last2DaysTotalMinutes: heaterLast2DaysTotal,
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

    const controllersBody = await this.getSiteControllersInfo();
    const registrationBody = await this.getFarmRegistration();

    const controllers = unwrapResponse(controllersBody);
    const registration = unwrapResponse(registrationBody)?.FarmRegistration ?? {};
    const farmName =
      registration.FarmName ??
      registration.GatewayAliasName ??
      farm.displayName ??
      farm.id;
    const houses = controllers?.FarmHouses ?? [];
    if (houses.length === 0) {
      throw new Error(
        'RotemNet returned no houses — gateway context may be missing; retry or set rotemGatewayCode in farms.json',
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
  parseDurationToMinutes,
  parseNumeric,
  pctChange,
  valueForGrowthDay,
  resolveCurrentGrowthDay,
  lastNGrowthDays,
  sumLastNDays,
};
