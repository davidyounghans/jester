const DEFAULT_RETRY_MS = 1500;
const MAX_RETRY_MS = 5000;

/**
 * Lightweight WebSocket client with automatic retries and role registration.
 */
export class RealtimeLink {
  /**
   * @param {{role: 'control'|'display', serverUrl: string, token?: string, onStatus?: (string) => void, onFlash?: (payload) => void, onAck?: (payload) => void, onInfo?: (payload) => void}} options
   */
  constructor(options) {
    this.role = options.role;
    this.serverUrl = options.serverUrl;
    this.token = options.token;
    this.onStatus = options.onStatus ?? (() => {});
    this.onFlash = options.onFlash ?? (() => {});
    this.onAck = options.onAck ?? (() => {});
    this.onInfo = options.onInfo ?? (() => {});

    this.ws = null;
    this.shouldRetry = true;
    this.retryTimer = null;
    this.retryDelay = DEFAULT_RETRY_MS;

    this.connect();
  }

  connect() {
    if (!this.serverUrl) {
      this.onStatus('missing-url');
      return;
    }

    this.cleanupSocket();
    this.onStatus('connecting');

    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (error) {
      console.error('Failed to open socket', error);
      this.scheduleReconnect();
      this.onStatus('error');
      return;
    }

    this.ws.addEventListener('open', () => {
      this.retryDelay = DEFAULT_RETRY_MS;
      this.onStatus('open');
      this.send({ type: 'register', role: this.role, token: this.token });
    });

    this.ws.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });

    this.ws.addEventListener('close', () => {
      this.onStatus('closed');
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', (event) => {
      console.error('Socket error:', event);
      this.onStatus('error');
      this.ws?.close();
    });
  }

  /**
   * Helper for sending JSON payloads.
   */
  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /**
   * Control clients invoke this to update the remote display.
   */
  trigger(side) {
    if (this.role !== 'control') {
      throw new Error('Only control clients may trigger events');
    }
    this.send({ type: 'trigger', side });
  }

  handleMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      console.warn('Skipping invalid JSON payload', error);
      return;
    }

    switch (payload.type) {
      case 'flash':
        this.onFlash(payload);
        break;
      case 'ack':
        this.onAck(payload);
        break;
      case 'registered':
      case 'status':
      case 'welcome':
      case 'error':
        this.onInfo(payload);
        break;
      default:
        break;
    }
  }

  scheduleReconnect() {
    if (!this.shouldRetry) {
      return;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryDelay);

    this.retryDelay = Math.min(this.retryDelay * 1.5, MAX_RETRY_MS);
  }

  cleanupSocket() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  dispose() {
    this.shouldRetry = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.cleanupSocket();
  }
}

/**
 * Parse user-provided URLs and coerce http(s) -> ws(s).
 * @param {string} raw
 */
export function normalizeServerUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
