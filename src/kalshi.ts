import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type TriggerSide = 'home' | 'away' | 'cancel';

export interface KalshiConfig {
  enabled: boolean;
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

const API_BASE = process.env.KALSHI_API_BASE ?? 'https://trading-api.kalshi.com';
const ACCESS_KEY = process.env.KALSHI_ACCESS_KEY ?? process.env.KALSHI_API_KEY;
const PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY ?? '';

const defaultConfig: KalshiConfig = {
  enabled: false,
  league: '',
  homeTeam: '',
  homeCode: '',
  awayTeam: '',
  awayCode: '',
  betUnitSize: 1,
  testMode: true
};

let runtimeConfig: KalshiConfig = loadConfigFromDisk();
const testEventLog: Array<{ at: number; side: TriggerSide; ticker: string; count: number }> = [];

export function getKalshiConfig(): KalshiConfig {
  return runtimeConfig;
}

export function updateKalshiConfig(partial: Partial<KalshiConfig>): KalshiConfig {
  const next: KalshiConfig = {
    ...runtimeConfig,
    ...partial,
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

  const ticker = buildMoneylineTicker(cfg, side);
  if (!ticker) {
    logger('Kalshi skipped: insufficient matchup metadata for', side);
    return { ok: true, skippedReason: 'missing-ticker' };
  }

  const orderBody = {
    ticker,
    side: 'yes',
    action: 'buy',
    count: cfg.betUnitSize,
    type: 'limit',
    yes_price: 50
  };

  if (cfg.testMode) {
    recordTestEvent({ ticker, side, count: cfg.betUnitSize });
    logger('Kalshi test mode: skipping order', ticker);
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
      logger('Kalshi order rejected', response.status, text);
      return { ok: false, error: `Kalshi request failed (${response.status})` };
    }

    logger('Kalshi order placed', ticker, cfg.betUnitSize);
    return { ok: true };
  } catch (error) {
    logger('Kalshi request error', error);
    return { ok: false, error: (error as Error).message };
  }
}

async function signedFetch(pathname: string, method: string, body: unknown): Promise<Response> {
  const url = new URL(pathname, API_BASE);
  const serializedBody = body ? JSON.stringify(body) : '';
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

  return fetch(url, {
    method,
    headers,
    body: serializedBody
  });
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

function recordTestEvent(event: { ticker: string; side: TriggerSide; count: number }) {
  testEventLog.push({ ...event, at: Date.now() });
  if (testEventLog.length > 100) {
    testEventLog.splice(0, testEventLog.length - 100);
  }
}
