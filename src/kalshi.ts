import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type TriggerSide = 'home' | 'away' | 'cancel';

export interface KalshiConfig {
  enabled: boolean;
  moneylineEnabled: boolean;
  spreadEnabled: boolean;
  league: string;
  homeTeam: string;
  homeCode: string;
  awayTeam: string;
  awayCode: string;
  betUnitSize: number;
  testMode: boolean;
}

interface PersistedKalshiConfig extends KalshiConfig {}

interface KalshiResult {
  ok: boolean;
  skippedReason?: string;
  error?: string;
}

const CONFIG_PATH = process.env.KALSHI_CONFIG_PATH
  ? path.resolve(process.env.KALSHI_CONFIG_PATH)
  : path.resolve(process.cwd(), 'kalshi.config.json');

// Default to the current Kalshi API base (v2); override via KALSHI_API_BASE if needed.
const API_BASE = process.env.KALSHI_API_BASE ?? 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT_MS = 8000;
const ACCESS_KEY = process.env.KALSHI_ACCESS_KEY ?? process.env.KALSHI_API_KEY;
const PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY ?? '';

const defaultConfig: KalshiConfig = {
  enabled: false,
  moneylineEnabled: true,
  spreadEnabled: false,
  league: '',
  homeTeam: '',
  homeCode: '',
  awayTeam: '',
  awayCode: '',
  betUnitSize: 1,
  testMode: true
};

let runtimeConfig: KalshiConfig = loadConfigFromDisk();
const testEventLog: Array<{ at: number; side: TriggerSide; ticker: string; count: number; body: unknown }> = [];

export function getKalshiConfig(): KalshiConfig {
  return runtimeConfig;
}

export function updateKalshiConfig(partial: Partial<KalshiConfig>): KalshiConfig {
  const next: KalshiConfig = {
    ...runtimeConfig,
    ...partial,
    moneylineEnabled: partial.moneylineEnabled ?? runtimeConfig.moneylineEnabled,
    spreadEnabled: partial.spreadEnabled ?? runtimeConfig.spreadEnabled,
    betUnitSize: normalizeUnitSize(partial.betUnitSize ?? runtimeConfig.betUnitSize),
    league: sanitizeToken(partial.league ?? runtimeConfig.league),
    homeTeam: (partial.homeTeam ?? runtimeConfig.homeTeam).trim(),
    awayTeam: (partial.awayTeam ?? runtimeConfig.awayTeam).trim(),
    homeCode: sanitizeToken(partial.homeCode ?? runtimeConfig.homeCode),
    awayCode: sanitizeToken(partial.awayCode ?? runtimeConfig.awayCode),
    testMode: partial.testMode ?? runtimeConfig.testMode
  };

  runtimeConfig = next;
  persistConfig(next);
  return runtimeConfig;
}

export function getTestEvents() {
  return [...testEventLog].reverse();
}

export function clearTestEvents() {
  testEventLog.length = 0;
}

export async function handleKalshiTrigger(side: TriggerSide, logger: (...args: unknown[]) => void): Promise<KalshiResult> {
  if (side === 'cancel') {
    return { ok: true, skippedReason: 'cancel-action' };
  }

  const cfg = runtimeConfig;
  if (!cfg.enabled) {
    return { ok: true, skippedReason: 'module-disabled' };
  }

  const results: KalshiResult[] = [];

  if (cfg.moneylineEnabled) {
    results.push(await placeMoneyline(cfg, side, logger));
  }

  if (cfg.spreadEnabled) {
    results.push(await placeSpread(cfg, side, logger));
  }

  if (results.length === 0) {
    return { ok: true, skippedReason: 'no-modules-enabled' };
  }

  return results.every((r) => r.ok) ? { ok: true } : { ok: false, error: 'one-or-more-orders-failed' };
}

async function signedFetch(pathname: string, method: string, body: unknown, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const url = new URL(pathname, API_BASE);
  const isBodyAllowed = method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD';
  const serializedBody = isBodyAllowed && body ? JSON.stringify(body) : '';
  const timestamp = Date.now().toString();
  const signaturePayload = `${timestamp}${method.toUpperCase()}${url.pathname}${url.search ?? ''}${serializedBody}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signaturePayload);
  signer.end();
  const signature = signer.sign({
    key: PRIVATE_KEY,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });

  const headers = {
    'Content-Type': 'application/json',
    'KALSHI-ACCESS-KEY': ACCESS_KEY!,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    'KALSHI-ACCESS-TIMESTAMP': timestamp
  };

  const fetchOptions: RequestInit = {
    method,
    headers
  };
  if (isBodyAllowed && serializedBody) {
    fetchOptions.body = serializedBody;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error('fetch-timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function loadConfigFromDisk(): KalshiConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedKalshiConfig>;
      return {
        ...defaultConfig,
        ...parsed,
        betUnitSize: normalizeUnitSize(parsed?.betUnitSize ?? defaultConfig.betUnitSize)
      };
    }
  } catch (error) {
    console.warn('Failed to read Kalshi config file, using defaults', error);
  }

  return { ...defaultConfig };
}

function persistConfig(config: KalshiConfig) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    console.warn('Unable to persist Kalshi config', error);
  }
}

function normalizeUnitSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
}

async function safeReadText(response: Response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sanitizeToken(value: string | undefined) {
  return (value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, '');
}

function buildMoneylineTicker(config: KalshiConfig, side: TriggerSide) {
  if (!config.league || !config.homeCode || !config.awayCode) {
    return null;
  }
  const league = sanitizeToken(config.league);
  const homeCode = sanitizeToken(config.homeCode);
  const awayCode = sanitizeToken(config.awayCode);
  if (!league || !homeCode || !awayCode) {
    return null;
  }
  const suffix = side === 'home' ? 'H' : 'A';
  return `${league}.${awayCode}.${homeCode}.ML.${suffix}`;
}

function recordTestEvent(event: { ticker: string; side: TriggerSide; count: number; body: unknown }) {
  testEventLog.push({ ...event, at: Date.now() });
  if (testEventLog.length > 100) {
    testEventLog.splice(0, testEventLog.length - 100);
  }
}

async function placeMoneyline(cfg: KalshiConfig, side: TriggerSide, logger: (...args: unknown[]) => void): Promise<KalshiResult> {
  const ticker = buildMoneylineTicker(cfg, side);
  if (!ticker) {
    logger('Kalshi skipped: insufficient matchup metadata for moneyline', side);
    return { ok: true, skippedReason: 'missing-ticker' };
  }

  const orderBody = {
    ticker,
    side: 'yes',
    action: 'buy',
    count: cfg.betUnitSize,
    type: 'market'
  };

  if (cfg.testMode) {
    recordTestEvent({ ticker, side, count: cfg.betUnitSize, body: orderBody });
    logger('Kalshi test mode: skipping moneyline order', ticker);
    return { ok: true, skippedReason: 'test-mode' };
  }

  if (!ACCESS_KEY || !PRIVATE_KEY) {
    logger('Kalshi disabled: missing API key or private key');
    return { ok: false, skippedReason: 'missing-credentials', error: 'Missing KALSHI_ACCESS_KEY or KALSHI_PRIVATE_KEY' };
  }

  try {
    const response = await signedFetch('/portfolio/orders', 'POST', orderBody);
    if (!response.ok) {
      const text = await safeReadText(response);
      logger('Kalshi moneyline rejected', response.status, text);
      return { ok: false, error: `Kalshi request failed (${response.status})` };
    }

    logger('Kalshi moneyline placed', ticker, cfg.betUnitSize);
    return { ok: true };
  } catch (error) {
    logger('Kalshi moneyline error', error);
    return { ok: false, error: (error as Error).message };
  }
}

async function placeSpread(cfg: KalshiConfig, side: TriggerSide, logger: (...args: unknown[]) => void): Promise<KalshiResult> {
  const eventTicker = buildEventTicker(cfg);
  if (!eventTicker) {
    logger('Kalshi skipped: missing event ticker for spread');
    if (cfg.testMode) {
      recordTestEvent({
        ticker: 'unknown',
        side,
        count: cfg.betUnitSize,
        body: { note: 'spread skipped: missing event ticker' }
      });
    }
    return { ok: true, skippedReason: 'missing-event-ticker' };
  }

  const sideCode = side === 'home' ? 'H' : 'A';
  let chosenTicker: string | null = null;
  let chosenPrice: number | null = null;

  if (!cfg.testMode && (!ACCESS_KEY || !PRIVATE_KEY)) {
    logger('Kalshi spread disabled: missing credentials');
    if (cfg.testMode) {
      recordTestEvent({
        ticker: 'unknown',
        side,
        count: cfg.betUnitSize,
        body: { note: 'spread skipped: missing credentials' }
      });
    }
    return { ok: false, skippedReason: 'missing-credentials', error: 'Missing KALSHI_ACCESS_KEY or KALSHI_PRIVATE_KEY' };
  }

  try {
    if (cfg.testMode && (!ACCESS_KEY || !PRIVATE_KEY)) {
      const fallbackTicker = `${eventTicker}.SP.${sideCode}`;
      recordTestEvent({
        ticker: fallbackTicker,
        side,
        count: cfg.betUnitSize,
        body: { note: 'test-mode no credentials; markets not fetched' }
      });
      logger('Kalshi test mode: logged spread without credentials', fallbackTicker);
      return { ok: true, skippedReason: 'test-mode-no-creds' };
    }

    const markets = await fetchMarketsByEvent(eventTicker, logger);
    const candidates = markets.filter((m) => m.ticker?.includes('.SP.') && m.ticker?.includes(`.${sideCode}.`));
    const scored = candidates
      .map((m) => {
        const price = pickPrice(m);
        return { ticker: m.ticker, price };
      })
      .filter((m) => m.ticker && m.price !== null) as Array<{ ticker: string; price: number }>;

    if (scored.length === 0) {
      logger('Kalshi spread skipped: no spreads found');
      if (cfg.testMode) {
        recordTestEvent({
          ticker: eventTicker,
          side,
          count: cfg.betUnitSize,
          body: { note: 'spread skipped: no spreads found' }
        });
      }
      return { ok: true, skippedReason: 'no-spreads' };
    }

    const inBand = scored.filter((s) => s.price >= 40 && s.price <= 60);
    const pick = (inBand.length ? inBand : scored).reduce((best, cur) => {
      const target = Math.abs(cur.price - 50);
      const bestScore = Math.abs(best.price - 50);
      return target < bestScore ? cur : best;
    });

    chosenTicker = pick.ticker;
    chosenPrice = pick.price;

    const orderBody = {
      ticker: chosenTicker,
      side: 'yes',
      action: 'buy',
      count: cfg.betUnitSize,
      type: 'market'
    };

    if (cfg.testMode) {
      recordTestEvent({
        ticker: chosenTicker,
        side,
        count: cfg.betUnitSize,
        body: { ...orderBody, observed_price: chosenPrice }
      });
      logger('Kalshi test mode: skipping spread order', chosenTicker);
      return { ok: true, skippedReason: 'test-mode' };
    }

    const response = await signedFetch('/portfolio/orders', 'POST', orderBody);
    if (!response.ok) {
      const text = await safeReadText(response);
      logger('Kalshi spread rejected', response.status, text);
      if (cfg.testMode) {
        recordTestEvent({
          ticker: chosenTicker,
          side,
          count: cfg.betUnitSize,
          body: { error: `rejected ${response.status}`, response: text, observed_price: chosenPrice }
        });
      }
      return { ok: false, error: `Kalshi request failed (${response.status})` };
    }

    logger('Kalshi spread placed', chosenTicker, cfg.betUnitSize, 'at~', chosenPrice);
    return { ok: true };
  } catch (error) {
    const message = (error as Error).message ?? 'spread-error';
    logger('Kalshi spread error', message);
    if (cfg.testMode) {
      recordTestEvent({
        ticker: chosenTicker ?? eventTicker ?? 'unknown',
        side,
        count: cfg.betUnitSize,
        body: { note: 'spread error', error: message }
      });
    }
    return { ok: false, error: message };
  }
}

function buildEventTicker(config: KalshiConfig) {
  if (!config.league || !config.homeCode || !config.awayCode) {
    return null;
  }
  const league = sanitizeToken(config.league);
  const homeCode = sanitizeToken(config.homeCode);
  const awayCode = sanitizeToken(config.awayCode);
  if (!league || !homeCode || !awayCode) {
    return null;
  }
  return `${league}.${awayCode}.${homeCode}`;
}

async function fetchMarketsByEvent(eventTicker: string, logger: (...args: unknown[]) => void) {
  const url = `/markets?event_ticker=${encodeURIComponent(eventTicker)}&status=open`;
  try {
    const res = await signedFetch(url, 'GET', '');
    if (!res.ok) {
      if (res.status === 404) {
        logger('Kalshi markets fetch returned 404 for event', eventTicker);
        return [];
      }
      const text = await safeReadText(res);
      logger('Kalshi markets fetch failed', res.status, text);
      throw new Error(`markets-fetch-failed:${res.status}`);
    }
    try {
      const json = (await res.json()) as { markets?: Array<{ ticker: string; yes_bid?: number; yes_ask?: number; last_price?: number }> };
      return json.markets ?? [];
    } catch (parseError) {
      logger('Kalshi markets parse failed', (parseError as Error).message);
      throw new Error('markets-parse-failed');
    }
  } catch (error) {
    if ((error as Error).message === 'fetch-timeout') {
      logger('Kalshi markets fetch timed out', eventTicker);
      throw new Error('markets-fetch-timeout');
    }
    throw error;
  }
}

function pickPrice(market: { yes_bid?: number; yes_ask?: number; last_price?: number }): number | null {
  const bid = coerceNum(market.yes_bid);
  const ask = coerceNum(market.yes_ask);
  const last = coerceNum(market.last_price);
  if (bid !== null && ask !== null) {
    return Math.round((bid + ask) / 2);
  }
  if (bid !== null) return bid;
  if (ask !== null) return ask;
  if (last !== null) return last;
  return null;
}

function coerceNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}
