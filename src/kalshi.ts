import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type TriggerSide = 'home' | 'away' | 'cancel';

export interface KalshiConfig {
  enabled: boolean;
  moneylineEnabled: boolean;
  spreadEnabled: boolean;
  slug: string; // Event ticker slug, e.g., KXNBAGAME-25DEC12ATLDET
  yesTeamCode: string; // team code to back with "yes" for HOME press
  noTeamCode: string; // team code to back with "yes" for AWAY press
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

// Base host (no path); the trade API prefix is added in signedFetch.
const API_BASE = process.env.KALSHI_API_BASE ?? 'https://api.elections.kalshi.com';
const API_PREFIX = '/trade-api/v2';
const FETCH_TIMEOUT_MS = 8000;
const ACCESS_KEY = process.env.KALSHI_ACCESS_KEY ?? process.env.KALSHI_API_KEY;
const PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY ?? '';

const defaultConfig: KalshiConfig = {
  enabled: false,
  moneylineEnabled: true,
  spreadEnabled: false,
  slug: '',
  yesTeamCode: '',
  noTeamCode: '',
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
    slug: sanitizeSlug(partial.slug ?? runtimeConfig.slug),
    yesTeamCode: sanitizeSlug(partial.yesTeamCode ?? runtimeConfig.yesTeamCode),
    noTeamCode: sanitizeSlug(partial.noTeamCode ?? runtimeConfig.noTeamCode),
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

export async function getKalshiBalanceSnapshot(): Promise<{ balance?: number | null; error?: string }> {
  if (!ACCESS_KEY || !PRIVATE_KEY) {
    return { error: 'missing-credentials' };
  }
  try {
    const res = await signedFetch('/portfolio/balance', 'GET', '');
    const text = await safeReadText(res);
    if (!res.ok) {
      return { error: `balance-${res.status}`, balance: null };
    }
    const json = JSON.parse(text) as { balance?: number };
    return { balance: json.balance ?? null };
  } catch (error) {
    return { error: (error as Error).message ?? 'balance-error' };
  }
}

export async function handleKalshiTrigger(side: TriggerSide, logger: (...args: unknown[]) => void): Promise<KalshiResult> {
  if (side === 'cancel') {
    return { ok: true, skippedReason: 'cancel-action' };
  }

  const cfg = runtimeConfig;
  if (!cfg.enabled) {
    return { ok: true, skippedReason: 'module-disabled' };
  }

  if (!cfg.slug) return { ok: true, skippedReason: 'missing-slug' };
  if (!cfg.yesTeamCode || !cfg.noTeamCode) return { ok: true, skippedReason: 'missing-team-codes' };

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

function normalizeApiPath(pathname: string) {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  // If API_BASE already contains /trade-api/, avoid double prefix
  const baseHasPrefix = API_BASE.includes('/trade-api/');
  const prefix = baseHasPrefix ? '' : API_PREFIX;
  return {
    fullPath: `${prefix}${normalizedPath}`,
    baseHasPrefix
  };
}

async function signedFetch(pathname: string, method: string, body: unknown, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const { fullPath } = normalizeApiPath(pathname);
  const url = new URL(fullPath, API_BASE);
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
        betUnitSize: normalizeUnitSize(parsed?.betUnitSize ?? defaultConfig.betUnitSize),
        slug: sanitizeSlug(parsed?.slug ?? defaultConfig.slug)
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

function sanitizeSlug(value: string | undefined) {
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

async function fetchMarketsBySlug(slug: string, logger: (...args: unknown[]) => void) {
  const safeSlug = sanitizeSlug(slug);
  if (!safeSlug) return { markets: [], eventTicker: undefined, note: 'missing-slug' };

  // First try the event endpoint with nested markets
  const eventUrl = `/events/${encodeURIComponent(safeSlug)}?with_nested_markets=true`;
  try {
    const res = await signedFetch(eventUrl, 'GET', '');
    if (res.status === 404) {
      return { markets: [], eventTicker: safeSlug, note: 'not-found' };
    }
    if (res.ok) {
      const json = (await res.json()) as {
        markets?: Array<{ ticker: string; yes_bid?: number; yes_ask?: number; last_price?: number }>;
        event_ticker?: string;
        ticker?: string;
        event?: { markets?: Array<{ ticker: string; yes_bid?: number; yes_ask?: number; last_price?: number }>; event_ticker?: string };
      };
      const markets = json.markets ?? json.event?.markets ?? [];
      const eventTicker = json.ticker ?? json.event_ticker ?? json.event?.event_ticker ?? safeSlug;
      if (markets.length) return { markets, eventTicker };
    } else {
      const text = await safeReadText(res);
      logger('Kalshi event fetch failed', res.status, text);
    }
  } catch (error) {
    logger('Kalshi event fetch error', (error as Error).message ?? 'event-fetch-error');
  }

  // Fallback: direct markets query by event_ticker
  try {
    const qs = new URLSearchParams({
      event_ticker: safeSlug,
      status: 'open',
      limit: '500'
    });
    const res = await signedFetch(`/markets?${qs.toString()}`, 'GET', '');
    if (!res.ok) {
      const text = await safeReadText(res);
      logger('Kalshi markets-by-event fetch failed', res.status, text);
      return { markets: [], eventTicker: safeSlug, note: `markets-fetch-${res.status}` };
    }
    const json = (await res.json()) as { markets?: Array<{ ticker: string; yes_bid?: number; yes_ask?: number; last_price?: number }> };
    return { markets: json.markets ?? [], eventTicker: safeSlug };
  } catch (error) {
    const message = (error as Error).message ?? 'fetch-error';
    logger('Kalshi markets fallback error', message);
    return { markets: [], eventTicker: safeSlug, note: message };
  }
}

async function placeMoneyline(cfg: KalshiConfig, side: TriggerSide, logger: (...args: unknown[]) => void): Promise<KalshiResult> {
  const slug = cfg.slug;
  if (!slug) {
    logger('Kalshi skipped: missing event slug for moneyline');
    return { ok: true, skippedReason: 'missing-slug' };
  }
  const yesCode = sanitizeSlug(cfg.yesTeamCode);
  const noCode = sanitizeSlug(cfg.noTeamCode);
  if (!yesCode || !noCode) {
    logger('Kalshi skipped: missing team codes for moneyline');
    return { ok: true, skippedReason: 'missing-team-codes' };
  }

  const desiredCode = side === 'home' ? yesCode : noCode;

  const { markets, eventTicker, note } = await fetchMarketsBySlug(slug, logger);
  if (!markets.length) {
    logger('Kalshi moneyline skipped: no markets found for slug', slug, note ?? '');
    recordLiveEvent({
      side,
      kind: 'moneyline',
      ticker: null,
      count: cfg.betUnitSize,
      note: note ?? 'no-markets',
      details: { sample: markets.slice(0, 5).map((m) => m.ticker).filter(Boolean), slug }
    });
    return { ok: true, skippedReason: 'no-markets' };
  }

  const mlCandidates = markets
    .map((m) => {
      const ticker = m.ticker ?? '';
      return { ticker };
    })
    .filter((m) => isMoneylineTicker(m.ticker) && m.ticker.toUpperCase().includes(desiredCode));

  mlCandidates.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const ticker = mlCandidates[0]?.ticker ?? null;
  if (!ticker) {
    logger('Kalshi moneyline skipped: no ML market found for slug/team', slug, desiredCode);
    recordLiveEvent({
      side,
      kind: 'moneyline',
      ticker: null,
      count: cfg.betUnitSize,
      note: `no-moneyline-market`,
      details: { slug, team: desiredCode, sample: markets.slice(0, 10).map((m) => m.ticker).filter(Boolean) }
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
        responseBody: text || undefined,
        note: eventTicker ?? undefined
      });
      return { ok: false, error: `Kalshi request failed (${response.status})` };
    }

    logger('Kalshi moneyline placed', ticker, cfg.betUnitSize);
    recordLiveEvent({ side, kind: 'moneyline', ticker, count: cfg.betUnitSize, status: response.status, note: eventTicker ?? undefined });
    return { ok: true };
  } catch (error) {
    logger('Kalshi moneyline error', error);
    recordLiveEvent({ side, kind: 'moneyline', ticker, count: cfg.betUnitSize, error: (error as Error).message });
    return { ok: false, error: (error as Error).message };
  }
}

async function placeSpread(cfg: KalshiConfig, side: TriggerSide, logger: (...args: unknown[]) => void): Promise<KalshiResult> {
  const slug = cfg.slug;
  if (!slug) {
    logger('Kalshi skipped: missing event slug for spread');
    if (cfg.testMode) {
      recordTestEvent({
        ticker: 'unknown',
        side,
        count: cfg.betUnitSize,
        body: { note: 'spread skipped: missing slug' }
      });
    }
    return { ok: true, skippedReason: 'missing-slug' };
  }
  const yesCode = sanitizeSlug(cfg.yesTeamCode);
  const noCode = sanitizeSlug(cfg.noTeamCode);
  if (!yesCode || !noCode) {
    logger('Kalshi skipped: missing team codes for spread');
    if (cfg.testMode) {
      recordTestEvent({
        ticker: 'unknown',
        side,
        count: cfg.betUnitSize,
        body: { note: 'spread skipped: missing team codes' }
      });
    }
    return { ok: true, skippedReason: 'missing-team-codes' };
  }

  const desiredCode = side === 'home' ? yesCode : noCode;
  let chosenTicker: string | null = null;
  let chosenPrice: number | null = null;

  if (!cfg.testMode && (!ACCESS_KEY || !PRIVATE_KEY)) {
    logger('Kalshi spread disabled: missing credentials');
    return { ok: false, skippedReason: 'missing-credentials', error: 'Missing KALSHI_ACCESS_KEY or KALSHI_PRIVATE_KEY' };
  }

  try {
    if (cfg.testMode && (!ACCESS_KEY || !PRIVATE_KEY)) {
      const fallbackTicker = `${slug}.SP.${desiredCode}`;
      recordTestEvent({
        ticker: fallbackTicker,
        side,
        count: cfg.betUnitSize,
        body: { note: 'test-mode no credentials; markets not fetched' }
      });
      logger('Kalshi test mode: logged spread without credentials', fallbackTicker);
      return { ok: true, skippedReason: 'test-mode-no-creds' };
    }

    const { markets, note } = await fetchMarketsBySlug(slug, logger);
    if (!markets.length) {
      logger('Kalshi spread skipped: no markets found for slug', slug, note ?? '');
      if (cfg.testMode) {
        recordTestEvent({
          ticker: `${slug}`,
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
        note: note ?? 'no-markets',
        details: { sample: markets.slice(0, 5).map((m) => m.ticker).filter(Boolean) }
      });
      return { ok: true, skippedReason: 'no-markets' };
    }

    const candidates = markets
      .map((m) => {
        const ticker = m.ticker ?? '';
        return { ticker, market: m };
      })
      .filter((m) => isSpreadTicker(m.ticker) && m.ticker.toUpperCase().includes(desiredCode));
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
          ticker: `${slug}`,
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
      recordLiveEvent({
        side,
        kind: 'spread',
        ticker: chosenTicker,
        count: cfg.betUnitSize,
        status: response.status,
        responseBody: text || undefined,
        note: chosenPrice !== null ? `price~${chosenPrice}` : undefined
      });
      return { ok: false, error: `Kalshi request failed (${response.status})` };
    }

    logger('Kalshi spread placed', chosenTicker, cfg.betUnitSize, 'at~', chosenPrice);
    recordLiveEvent({
      side,
      kind: 'spread',
      ticker: chosenTicker,
      count: cfg.betUnitSize,
      status: response.status,
      note: chosenPrice !== null ? `price~${chosenPrice}` : undefined
    });
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

function isMoneylineTicker(ticker: string) {
  const up = ticker.toUpperCase();
  if (up.includes('SP')) return false;
  if (up.includes('.ML') || up.includes('-ML') || up.includes('ML.')) return true;
  // Fallback: for event-level tickers like KXNBAGAME-...-TEAM with no ML marker, treat as moneyline.
  return true;
}

function isSpreadTicker(ticker: string) {
  const up = ticker.toUpperCase();
  return up.includes('SP');
}
