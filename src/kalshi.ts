import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type TriggerSide = 'home' | 'away' | 'cancel';

export interface KalshiConfig {
  enabled: boolean;
  moneylineEnabled: boolean;
  spreadEnabled: boolean;
  sport: string; // e.g., Basketball
  competition: string; // e.g., Pro Basketball (M)
  scope: string; // e.g., Games
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
  sport: 'Basketball',
  competition: 'Pro Basketball (M)',
  scope: 'Games',
  homeTeam: '',
  homeCode: '',
  awayTeam: '',
  awayCode: '',
  betUnitSize: 1,
  testMode: true
};

let runtimeConfig: KalshiConfig = loadConfigFromDisk();
const testEventLog: Array<{ at: number; side: TriggerSide; ticker: string; count: number; body: unknown }> = [];
const liveEventLog: Array<{
  at: number;
  side: TriggerSide;
  kind: 'moneyline' | 'spread';
  ticker?: string | null;
  count?: number;
  status?: number;
  responseBody?: string;
  error?: string;
  note?: string;
  details?: unknown;
}> = [];

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
    sport: (partial.sport ?? runtimeConfig.sport).trim(),
    competition: (partial.competition ?? runtimeConfig.competition).trim(),
    scope: (partial.scope ?? runtimeConfig.scope).trim(),
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

export function getLiveEvents() {
  return [...liveEventLog].reverse();
}

export function clearLiveEvents() {
  liveEventLog.length = 0;
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

function recordTestEvent(event: { ticker: string; side: TriggerSide; count: number; body: unknown }) {
  testEventLog.push({ ...event, at: Date.now() });
  if (testEventLog.length > 100) {
    testEventLog.splice(0, testEventLog.length - 100);
  }
}

function recordLiveEvent(event: {
  side: TriggerSide;
  kind: 'moneyline' | 'spread';
  ticker?: string | null;
  count?: number;
  status?: number;
  responseBody?: string;
  error?: string;
  note?: string;
  details?: unknown;
}) {
  liveEventLog.push({ ...event, at: Date.now() });
  if (liveEventLog.length > 100) {
    liveEventLog.splice(0, liveEventLog.length - 100);
  }
}

async function placeMoneyline(cfg: KalshiConfig, side: TriggerSide, logger: (...args: unknown[]) => void): Promise<KalshiResult> {
  const sport = cfg.sport.trim();
  const competition = cfg.competition.trim();
  const scope = cfg.scope.trim();
  const homeCode = sanitizeToken(cfg.homeCode);
  const awayCode = sanitizeToken(cfg.awayCode);
  if (!sport || !competition || !scope || !homeCode || !awayCode) {
    logger('Kalshi skipped: insufficient matchup metadata for moneyline', side);
    return { ok: true, skippedReason: 'missing-ticker' };
  }

  const sideCode = side === 'home' ? 'H' : 'A';

  // Fetch all open markets for the sport/competition/scope and pick the ML ticker containing both team codes.
  const markets = await fetchOpenMarkets({ sport, competition, scope }, logger);
  if (!markets.length) {
    logger('Kalshi moneyline skipped: no markets found for sport/competition/scope', sport, competition, scope);
    recordLiveEvent({
      side,
      kind: 'moneyline',
      ticker: null,
      count: cfg.betUnitSize,
      note: 'no-markets',
      details: { sample: markets.slice(0, 5).map((m) => m.ticker).filter(Boolean) }
    });
    return { ok: true, skippedReason: 'no-markets' };
  }

  const mlCandidates = markets
    .map((m) => {
      const ticker = m.ticker ?? '';
      const segments = normalizeSegments(ticker);
      return { ticker, segments, sideSeg: extractSide(segments) };
    })
    .filter((m) => hasTeamCodes(m.ticker, homeCode, awayCode) && isMoneyline(m.segments) && m.sideSeg === sideCode);

  // Prefer candidates sorted by ticker (stable) so we have deterministic pick.
  mlCandidates.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const ticker = mlCandidates[0]?.ticker ?? null;
  if (!ticker) {
    logger('Kalshi moneyline skipped: no ML market found for teams', homeCode, awayCode, 'side', sideCode);
    const pairMarkets = markets.filter((m) => hasTeamCodes(m.ticker ?? '', homeCode, awayCode)).slice(0, 5).map((m) => m.ticker);
    recordLiveEvent({
      side,
      kind: 'moneyline',
      ticker: null,
      count: cfg.betUnitSize,
      note: `no-moneyline-market (${homeCode}/${awayCode})`,
      details: { pairMarkets, sample: markets.slice(0, 5).map((m) => m.ticker).filter(Boolean) }
    });
    return { ok: true, skippedReason: 'no-moneyline' };
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
      const rawText = await safeReadText(response);
      const text = rawText && rawText.trim() ? rawText : '(empty body)';
      logger('Kalshi moneyline rejected', response.status, text);
      recordLiveEvent({
        side,
        kind: 'moneyline',
        ticker,
        count: cfg.betUnitSize,
        status: response.status,
        responseBody: text || undefined
      });
      return { ok: false, error: `Kalshi request failed (${response.status})` };
    }

    logger('Kalshi moneyline placed', ticker, cfg.betUnitSize);
    recordLiveEvent({ side, kind: 'moneyline', ticker, count: cfg.betUnitSize, status: response.status });
    return { ok: true };
  } catch (error) {
    logger('Kalshi moneyline error', error);
    recordLiveEvent({ side, kind: 'moneyline', ticker, count: cfg.betUnitSize, error: (error as Error).message });
    return { ok: false, error: (error as Error).message };
  }
}

async function placeSpread(cfg: KalshiConfig, side: TriggerSide, logger: (...args: unknown[]) => void): Promise<KalshiResult> {
  const sport = cfg.sport.trim();
  const competition = cfg.competition.trim();
  const scope = cfg.scope.trim();
  const homeCode = sanitizeToken(cfg.homeCode);
  const awayCode = sanitizeToken(cfg.awayCode);
  if (!sport || !competition || !scope || !homeCode || !awayCode) {
    logger('Kalshi skipped: missing matchup metadata for spread');
    if (cfg.testMode) {
      recordTestEvent({
        ticker: 'unknown',
        side,
        count: cfg.betUnitSize,
        body: { note: 'spread skipped: missing matchup metadata' }
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
      const fallbackTicker = `${sport}.${awayCode}.${homeCode}.SP.${sideCode}`;
      recordTestEvent({
        ticker: fallbackTicker,
        side,
        count: cfg.betUnitSize,
        body: { note: 'test-mode no credentials; markets not fetched' }
      });
      logger('Kalshi test mode: logged spread without credentials', fallbackTicker);
      return { ok: true, skippedReason: 'test-mode-no-creds' };
    }

    const markets = await fetchOpenMarkets({ sport, competition, scope }, logger);
    if (!markets.length) {
      logger('Kalshi spread skipped: no markets found for sport/competition/scope', sport, competition, scope);
      if (cfg.testMode) {
        recordTestEvent({
          ticker: `${sport}.${competition}.${scope}`,
          side,
          count: cfg.betUnitSize,
          body: { note: 'spread skipped: no markets found' }
        });
      }
      recordLiveEvent({
        side,
        kind: 'spread',
        ticker: null,
        count: cfg.betUnitSize,
        note: 'no-markets',
        details: { sample: markets.slice(0, 5).map((m) => m.ticker).filter(Boolean) }
      });
      return { ok: true, skippedReason: 'no-markets' };
    }

    const candidates = markets
      .map((m) => {
        const ticker = m.ticker ?? '';
        const segments = normalizeSegments(ticker);
        return { ticker, segments, sideSeg: extractSide(segments), market: m };
      })
      .filter((m) => hasTeamCodes(m.ticker, homeCode, awayCode) && isSpread(m.segments) && m.sideSeg === sideCode);
    const scored = candidates
      .map((m) => {
        const price = pickPrice(m.market);
        return { ticker: m.ticker, price };
      })
      .filter((m) => m.ticker && m.price !== null) as Array<{ ticker: string; price: number }>;

    if (scored.length === 0) {
      logger('Kalshi spread skipped: no spreads found');
      if (cfg.testMode) {
        recordTestEvent({
        ticker: `${sport}.${competition}.${scope}`,
        side,
        count: cfg.betUnitSize,
        body: { note: 'spread skipped: no spreads found' }
        });
      }
      recordLiveEvent({
        side,
        kind: 'spread',
        ticker: null,
        count: cfg.betUnitSize,
        note: 'no-spreads',
        details: {
          pairMarkets: markets
            .filter((m) => hasTeamCodes(m.ticker ?? '', homeCode, awayCode))
            .slice(0, 5)
            .map((m) => m.ticker),
          sample: markets.slice(0, 5).map((m) => m.ticker).filter(Boolean)
        }
      });
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
      const rawText = await safeReadText(response);
      const text = rawText && rawText.trim() ? rawText : '(empty body)';
      logger('Kalshi spread rejected', response.status, text);
      if (cfg.testMode) {
        recordTestEvent({
          ticker: chosenTicker,
          side,
          count: cfg.betUnitSize,
          body: { error: `rejected ${response.status}`, response: text, observed_price: chosenPrice }
        });
      }
      recordLiveEvent({
        side,
        kind: 'spread',
        ticker: chosenTicker,
        count: cfg.betUnitSize,
        status: response.status,
        responseBody: text || undefined
      });
      return { ok: false, error: `Kalshi request failed (${response.status})` };
    }

      logger('Kalshi spread placed', chosenTicker, cfg.betUnitSize, 'at~', chosenPrice);
      recordLiveEvent({ side, kind: 'spread', ticker: chosenTicker, count: cfg.betUnitSize, status: response.status, note: `price~${chosenPrice}` });
      return { ok: true };
    } catch (error) {
      const message = (error as Error).message ?? 'spread-error';
      logger('Kalshi spread error', message);
      recordLiveEvent({ side, kind: 'spread', ticker: chosenTicker, count: cfg.betUnitSize, error: message });
      if (cfg.testMode) {
        recordTestEvent({
          ticker: chosenTicker ?? 'unknown',
          side,
          count: cfg.betUnitSize,
          body: { note: 'spread error', error: message }
        });
      }
      return { ok: false, error: message };
    }
  }

async function fetchOpenMarkets(
  params: { sport: string; competition: string; scope: string },
  logger: (...args: unknown[]) => void
) {
  const now = Date.now();
  const start = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // yesterday
  const end = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(); // next 7 days
  const all: Array<{ ticker: string; yes_bid?: number; yes_ask?: number; last_price?: number }> = [];
  let cursor: string | undefined;
  let page = 0;
  const maxPages = 10;

  while (page < maxPages) {
    const qs = new URLSearchParams();
    qs.set('type', 'sports');
    qs.set('status', 'open');
    qs.set('limit', '500');
    qs.set('sport', params.sport);
    qs.set('competition', params.competition);
    qs.set('scope', params.scope);
    qs.set('start_time', start);
    qs.set('end_time', end);
    if (cursor) qs.set('cursor', cursor);
    const url = `/markets?${qs.toString()}`;
    page += 1;

    try {
      const res = await signedFetch(url, 'GET', '');
      if (!res.ok) {
        if (res.status === 404) {
          logger('Kalshi markets fetch returned 404 for sports query', params);
          return all;
        }
        const text = await safeReadText(res);
        logger('Kalshi markets fetch failed', res.status, text);
        throw new Error(`markets-fetch-failed:${res.status}`);
      }
      const json = (await res.json()) as {
        markets?: Array<{ ticker: string; yes_bid?: number; yes_ask?: number; last_price?: number }>;
        cursor?: string;
      };
      if (json.markets?.length) {
        all.push(...json.markets);
      }
      if (json.cursor) {
        cursor = json.cursor;
        continue;
      }
      break;
    } catch (error) {
      if ((error as Error).message === 'fetch-timeout') {
        logger('Kalshi markets fetch timed out', params);
        throw new Error('markets-fetch-timeout');
      }
      throw error;
    }
  }

  return all;
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

function normalizeSegments(ticker: string) {
  return ticker.toUpperCase().split('.');
}

function hasTeamCodes(ticker: string, homeCode: string, awayCode: string) {
  const segments = normalizeSegments(ticker);
  const home = homeCode.toUpperCase();
  const away = awayCode.toUpperCase();
  return segments.includes(home) && segments.includes(away);
}

function extractSide(segments: string[]): 'H' | 'A' | null {
  const last = segments[segments.length - 1];
  if (last === 'H' || last === 'A') return last;
  const secondLast = segments[segments.length - 2];
  if (secondLast === 'H' || secondLast === 'A') return secondLast;
  const found = segments.find((s) => s === 'H' || s === 'A');
  return found === 'H' || found === 'A' ? found : null;
}

function isMoneyline(segments: string[]) {
  return segments.includes('ML');
}

function isSpread(segments: string[]) {
  return segments.includes('SP');
}
