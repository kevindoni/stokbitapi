const express = require("express");
require("dotenv").config();
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Sentry = require("@sentry/node");
const swaggerUi = require("swagger-ui-express");
const YF = require("yahoo-finance2").default;
const yahooFinance = new YF({ suppressNotices: ["yahooSurvey"] });
const {
  MACD,
  RSI,
  EMA,
  SMA,
  BollingerBands,
  CrossUp,
  CrossDown,
} = require("technicalindicators");
const candlesticks = require("technicalindicators");

const app = express();
const PORT = process.env.PORT || 3000;

// Path to our own local token/credentials file
const LOCAL_TOKEN_PATH = path.join(__dirname, "token.json");
const CREDENTIALS_PATH = path.join(__dirname, ".credentials.json");

// ==================== ERROR HANDLING UTILITIES ====================

class HttpError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

// Circuit breaker untuk external API calls (mencegah cascade failures)
class CircuitBreaker {
  constructor(url, threshold = 5, timeout = 60000) {
    this.url = url;
    this.failureCount = 0;
    this.threshold = threshold;
    this.state = "CLOSED"; // CLOSED, OPEN, HALF_OPEN
    this.timeout = timeout;
    this.nextRetryTime = null;
  }

  isOpen() {
    if (this.state === "OPEN" && Date.now() > this.nextRetryTime) {
      this.state = "HALF_OPEN";
      this.failureCount = 0;
      console.log(`⚡ Circuit breaker HALF_OPEN for ${this.url}`);
    }
    return this.state === "OPEN";
  }

  recordSuccess() {
    this.failureCount = 0;
    if (this.state !== "CLOSED") {
      this.state = "CLOSED";
      console.log(`✅ Circuit breaker CLOSED for ${this.url}`);
    }
  }

  recordFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold && this.state !== "OPEN") {
      this.state = "OPEN";
      this.nextRetryTime = Date.now() + this.timeout;
      console.log(
        `❌ Circuit breaker OPEN for ${this.url} (${this.failureCount}/${this.threshold} failures)`,
      );
    }
  }
}

const circuitBreakers = new Map();

function getOrCreateCircuitBreaker(url) {
  if (!circuitBreakers.has(url)) {
    circuitBreakers.set(url, new CircuitBreaker(url));
  }
  return circuitBreakers.get(url);
}

// Retry wrapper dengan exponential backoff
async function retryWithBackoff(
  fn,
  maxRetries = 3,
  initialDelay = 1000,
  label = "",
) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isNetworkError =
        error.code === "ECONNREFUSED" ||
        error.code === "ENOTFOUND" ||
        error.code === "ETIMEDOUT" ||
        error.message?.includes("timeout");
      const isRetryableStatus =
        error.response?.status >= 500 || error.response?.status === 429;

      if ((attempt < maxRetries - 1 && isNetworkError) || isRetryableStatus) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.warn(
          `⚠️ ${label} attempt ${attempt + 1}/${maxRetries} failed, retry in ${delay}ms:`,
          error.message,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

// Standardized error response
function formatErrorResponse(error, defaultStatus = 500) {
  let statusCode = defaultStatus;
  let errorType = "InternalError";
  let message = "An unexpected error occurred";
  let details = null;

  if (error instanceof HttpError) {
    statusCode = error.statusCode;
    message = error.message;
    details = error.details;
  } else if (error.response) {
    statusCode = error.response.status || defaultStatus;
    message = error.response.data?.error || error.message;
    details = error.response.data;
    errorType = `HTTP${statusCode}`;
  } else if (error.code === "ECONNREFUSED") {
    statusCode = 503;
    errorType = "ServiceUnavailable";
    message = "External API service unavailable";
  } else if (error.code === "ENOTFOUND") {
    statusCode = 503;
    errorType = "DNSError";
    message = "Cannot resolve API hostname";
  } else if (error.code === "ETIMEDOUT" || error.message?.includes("timeout")) {
    statusCode = 504;
    errorType = "RequestTimeout";
    message = "Request timed out";
  }

  return {
    statusCode,
    error: {
      type: errorType,
      message,
      timestamp: new Date().toISOString(),
      ...(details && { details: details }),
    },
  };
}

let stockbitToken = "";
let refreshToken = "";
let securitiesToken = ""; // Carina Securities JWT (for trading/portfolio)
let securitiesRefreshToken = "";
let refreshTimer = null;
let securitiesRefreshTimer = null;
const SECURITIES_TOKEN_PATH = path.join(__dirname, "securities_token.json");

// ==================== STOCKBIT API HEADERS ====================
// These headers simulate a mobile app to bypass reCAPTCHA
const STOCKBIT_HEADERS = {
  "X-AppVersion": "3.17.3",
  "X-Platform": "android",
  "Accept-Language": "en-US",
  "X-DeviceType": "Pixel 5",
  "Content-Type": "application/json",
};

const ENABLE_SENTRY = !!process.env.SENTRY_DSN;
const MAX_HEAVY_IN_FLIGHT = parseInt(
  process.env.MAX_HEAVY_IN_FLIGHT || "8",
  10,
);
const CACHE_TTL_SHORT_MS = parseInt(
  process.env.CACHE_TTL_SHORT_MS || "30000",
  10,
);
const CACHE_TTL_HEAVY_MS = parseInt(
  process.env.CACHE_TTL_HEAVY_MS || "90000",
  10,
);

if (ENABLE_SENTRY) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
  });
}

const runtimeMetrics = {
  startedAt: new Date().toISOString(),
  requestCount: 0,
  errorCount: 0,
  inFlightHeavy: 0,
};

const responseCache = new Map();

function createRouteCache(ttlMs = CACHE_TTL_SHORT_MS) {
  return (req, res, next) => {
    if (req.method !== "GET") return next();

    const key = `${req.method}:${req.originalUrl}`;
    const hit = responseCache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return res.set("X-Cache", "HIT").status(hit.status).json(hit.body);
    }

    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        responseCache.set(key, {
          status: res.statusCode,
          body,
          expiresAt: Date.now() + ttlMs,
        });
      }
      res.set("X-Cache", "MISS");
      return json(body);
    };

    return next();
  };
}

function createConcurrencyLimiter(maxInFlight = MAX_HEAVY_IN_FLIGHT) {
  return (req, res, next) => {
    if (runtimeMetrics.inFlightHeavy >= maxInFlight) {
      return res.status(503).json({
        type: "ConcurrencyLimitExceeded",
        message:
          "Server is busy processing heavy requests. Please retry shortly.",
        maxInFlight,
      });
    }

    runtimeMetrics.inFlightHeavy++;
    res.on("finish", () => {
      runtimeMetrics.inFlightHeavy = Math.max(
        0,
        runtimeMetrics.inFlightHeavy - 1,
      );
    });

    return next();
  };
}

const validateSymbolParam = (req, res, next, rawSymbol) => {
  const symbol = String(rawSymbol || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9.]{2,12}$/.test(symbol)) {
    return res.status(400).json({
      type: "ValidationError",
      message: "Invalid symbol format. Use alphanumeric ticker (2-12 chars).",
      value: rawSymbol,
    });
  }
  req.params.symbol = symbol;
  return next();
};

const validateISODate = (dateStr) => /^\d{4}-\d{2}-\d{2}$/.test(dateStr);

const validateDateRangeQuery = (req, res, next) => {
  const { start_date, end_date } = req.query;
  if (start_date && !validateISODate(start_date)) {
    return res.status(400).json({
      type: "ValidationError",
      message: "start_date must use YYYY-MM-DD format",
    });
  }
  if (end_date && !validateISODate(end_date)) {
    return res.status(400).json({
      type: "ValidationError",
      message: "end_date must use YYYY-MM-DD format",
    });
  }
  if (start_date && end_date && start_date > end_date) {
    return res.status(400).json({
      type: "ValidationError",
      message: "start_date cannot be greater than end_date",
    });
  }
  return next();
};

// ==================== TOKEN MANAGEMENT ====================

function getCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) return { data: "", tokens: {} };
    const raw = fs.readFileSync(CREDENTIALS_PATH, "utf8");
    const creds = JSON.parse(raw);
    if (!creds.tokens) creds.tokens = {};
    if (!creds.tokens.main) creds.tokens.main = {};
    if (!creds.tokens.securities) creds.tokens.securities = {};
    return creds;
  } catch {
    return { data: "", tokens: {} };
  }
}

function saveMainToken(acc, ref) {
  const creds = getCredentials();
  creds.tokens.main.accessToken = acc;
  if (ref) creds.tokens.main.refreshToken = ref;
  creds.tokens.main.savedAt = new Date().toISOString();
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
  stockbitToken = acc;
  if (ref) refreshToken = ref;
}

// Decode JWT to get expiry info
const decodeToken = (token) => {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString(),
    );
    return {
      user: payload.data?.use || "unknown",
      email: payload.data?.ema || "unknown",
      uid: payload.data?.uid || "unknown",
      iat: payload.iat,
      exp: payload.exp,
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      isExpired: Date.now() > payload.exp * 1000,
      expiresInMs: payload.exp * 1000 - Date.now(),
    };
  } catch {
    return null;
  }
};

// Check if token is expired or about to expire (within 5 minutes)
const isTokenExpiredOrExpiring = () => {
  if (!stockbitToken) return true;
  const info = decodeToken(stockbitToken);
  if (!info) return true;
  return info.expiresInMs < 300000; // 5 minutes
};

// Check if Securities token is expired or about to expire (within 5 minutes)
const isSecuritiesTokenExpiredOrExpiring = () => {
  if (!securitiesToken) return true;
  const info = decodeToken(securitiesToken);
  if (!info) return true;
  return info.expiresInMs < 300000; // 5 minutes
};

// ==================== LOGIN & REFRESH (v6 Mobile API) ====================

let pendingLoginToken = ""; // Stored during 2FA flow

// Login via v6/username endpoint (bypasses reCAPTCHA)
const performLogin = async (username, password, player_id) => {
  console.log("🔑 Attempting login via /login/v6/username ...");

  const response = await axios.post(
    "https://exodus.stockbit.com/login/v6/username",
    {
      user: username,
      password: password,
      player_id: player_id || "stockbit-gateway",
    },
    {
      headers: STOCKBIT_HEADERS,
      timeout: 30000,
    },
  );

  const data = response.data;

  // Check if response requires device verification (2FA)
  // Response can be at data.data.new_device OR data.data.login.new_device
  const newDevice = data?.data?.new_device || data?.data?.login?.new_device;
  const trustedDevice =
    data?.data?.trusted_device || data?.data?.login?.trusted_device;

  if (newDevice || trustedDevice) {
    // Token can be nested: new_device.trusted_device.login_token
    const loginToken =
      trustedDevice?.login_token ||
      newDevice?.trusted_device?.login_token ||
      newDevice?.login_token;
    const deviceName =
      trustedDevice?.device_name ||
      newDevice?.trusted_device?.device_name ||
      newDevice?.device_name ||
      "unknown device";
    pendingLoginToken = loginToken;
    console.log(`📱 Device verification required! Approve on: ${deviceName}`);
    console.log(`🔑 Login token: ${loginToken}`);
    return {
      needsVerification: true,
      loginToken,
      deviceName,
      message: data?.message || "Device verification required",
    };
  }

  // Direct login success (no 2FA needed, e.g. trusted device)
  const accessToken = data?.data?.login?.token_data?.access?.token;
  const newRefreshToken = data?.data?.login?.token_data?.refresh?.token;

  if (accessToken) {
    refreshToken = newRefreshToken || "";
    return { accessToken, refreshToken: newRefreshToken };
  }

  // Fallback: try older response structures
  const fallbackToken = data?.data?.access_token || data?.data?.token;
  if (fallbackToken) {
    return { accessToken: fallbackToken, refreshToken: "" };
  }

  throw new Error(
    "Token not found in login response. Raw: " +
      JSON.stringify(data).substring(0, 200),
  );
};

// Verify new device after user approves on their phone
const verifyNewDevice = async (loginToken) => {
  console.log("📱 Verifying device with login_token...");

  const response = await axios.post(
    "https://api.stockbit.com/login/v5/new-device/verify",
    {
      multi_factor: {
        login_token: loginToken,
      },
      trusted_device: {
        login_token: loginToken,
        acknowledge_token: "",
      },
    },
    {
      headers: STOCKBIT_HEADERS,
      timeout: 30000,
    },
  );

  const data = response.data;

  // Extract tokens from verification response
  const accessToken =
    data?.data?.verify?.token_data?.access?.token ||
    data?.data?.token_data?.access?.token ||
    data?.data?.access?.token;
  const newRefreshToken =
    data?.data?.verify?.token_data?.refresh?.token ||
    data?.data?.token_data?.refresh?.token ||
    data?.data?.refresh?.token;

  if (accessToken) {
    return { accessToken, refreshToken: newRefreshToken || "" };
  }

  // Return the full data for debugging
  return { raw: data };
};

// Refresh token using /login/refresh endpoint
const performRefreshToken = async () => {
  if (!refreshToken) {
    throw new Error("No refresh token available");
  }

  console.log("🔄 Refreshing token via /login/refresh ...");

  const response = await axios.post(
    "https://exodus.stockbit.com/login/refresh",
    null,
    {
      headers: {
        ...STOCKBIT_HEADERS,
        Authorization: `Bearer ${refreshToken}`,
      },
      timeout: 30000,
    },
  );

  const data = response.data;

  // Refresh response: data.refresh.access.token & data.refresh.refresh.token
  const newAccessToken = data?.data?.refresh?.access?.token;
  const newRefreshToken = data?.data?.refresh?.refresh?.token;

  if (newAccessToken) {
    refreshToken = newRefreshToken || refreshToken;
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  }

  throw new Error("Token not found in refresh response");
};

// Auto-refresh: first try refresh token, fallback to re-login
const autoRefreshToken = async () => {
  // Strategy 1: Use refresh token (fast, no credentials needed)
  if (refreshToken) {
    try {
      console.log("🔄 Auto-refreshing via refresh token...");
      const result = await performRefreshToken();
      stockbitToken = result.accessToken;
      refreshToken = result.refreshToken || refreshToken;
      saveMainToken(stockbitToken, refreshToken);
      console.log("✅ Token refreshed via refresh token!");
      scheduleRefresh();
      return true;
    } catch (err) {
      console.warn("⚠️ Refresh token failed:", err.message);
      // Fall through to re-login
    }
  }

  // Strategy 2: Re-login with saved credentials
  const creds = getCredentials();
  if (creds.data) {
    try {
      console.log("🔄 Re-logging in with saved credentials...");
      const decoded = JSON.parse(
        Buffer.from(creds.data, "base64").toString("utf8"),
      );
      const result = await performLogin(
        decoded.username,
        decoded.password,
        decoded.player_id,
      );
      if (result.needsVerification) {
        console.warn(
          "⚠️ Fallback re-login requires 2FA device verification! Cannot auto-refresh.",
        );
        return false;
      }
      stockbitToken = result.accessToken;
      refreshToken = result.refreshToken || "";
      saveMainToken(stockbitToken, refreshToken);
      console.log("✅ Token refreshed via re-login!");
      scheduleRefresh();
      return true;
    } catch (err) {
      console.error("❌ Re-login also failed:", err.message);
    }
  }

  console.error(
    "❌ Auto-refresh failed: No refresh token or credentials available.",
  );
  return false;
};

const scheduleRefresh = () => {
  if (refreshTimer) clearTimeout(refreshTimer);

  const creds = getCredentials();
  const canRefresh = refreshToken || creds.data;
  if (!stockbitToken || !canRefresh) return;

  const info = decodeToken(stockbitToken);
  if (!info) return;

  // Refresh 10 minutes before expiry (like the reference repo)
  const refreshInMs = Math.max(info.expiresInMs - 600000, 10000);
  refreshTimer = setTimeout(autoRefreshToken, refreshInMs);

  const refreshAt = new Date(Date.now() + refreshInMs).toISOString();
  console.log(
    `⏰ Next Main token refresh at: ${refreshAt} (in ${Math.round(refreshInMs / 60000)}min)`,
  );
};

// Schedule securities token auto-refresh
const scheduleSecuritiesRefresh = () => {
  if (securitiesRefreshTimer) clearTimeout(securitiesRefreshTimer);
  if (!securitiesToken || !securitiesRefreshToken) return;

  const info = decodeToken(securitiesToken);
  if (!info) return;

  const refreshInMs = Math.max(info.expiresInMs - 600000, 10000);
  securitiesRefreshTimer = setTimeout(async () => {
    try {
      await performSecuritiesRefresh();
      scheduleSecuritiesRefresh(); // Reschedule after success
    } catch (e) {
      console.warn("⚠️ Scheduled Securities refresh failed:", e.message);
      console.warn(
        "   Securities token may need manual re-capture via capture_token.js",
      );
    }
  }, refreshInMs);

  const refreshAt = new Date(Date.now() + refreshInMs).toISOString();
  console.log(
    `⏰ Next Securities token refresh at: ${refreshAt} (in ${Math.round(refreshInMs / 60000)}min)`,
  );
};

// Ensure token is valid before proxy request
const ensureFreshToken = async () => {
  if (!isTokenExpiredOrExpiring()) return true;
  return await autoRefreshToken();
};

// ==================== BOOT ====================

// Load initial tokens from .credentials.json
try {
  const creds = getCredentials();
  if (creds.tokens?.main?.accessToken) {
    stockbitToken = creds.tokens.main.accessToken;
    console.log("✅ Loaded main token from .credentials.json");

    if (creds.tokens.main.refreshToken) {
      refreshToken = creds.tokens.main.refreshToken;
      console.log("✅ Loaded refresh token for auto-renewal");
    }
  }

  if (creds.tokens?.securities?.accessToken) {
    securitiesToken = creds.tokens.securities.accessToken;
    console.log("✅ Loaded securities token from .credentials.json");

    if (creds.tokens.securities.refreshToken) {
      securitiesRefreshToken = creds.tokens.securities.refreshToken;
      console.log("✅ Loaded securities refresh token for auto-renewal");
    }
  }
} catch (e) {
  console.log("⚠️ No tokens found. Please run: node capture_token.js");
}

// If we have token + refresh capability, schedule refresh
const baseCreds = getCredentials();
if (stockbitToken && (refreshToken || baseCreds.data)) {
  if (isTokenExpiredOrExpiring()) {
    autoRefreshToken().catch((err) =>
      console.error("Boot Main token refresh failed:", err.message),
    );
  } else {
    scheduleRefresh();
  }
}

// If we have securities token + refresh capability, schedule refresh
if (securitiesToken && securitiesRefreshToken) {
  if (isSecuritiesTokenExpiredOrExpiring()) {
    performSecuritiesRefresh().catch((err) => {
      console.error(
        "Boot Securities refresh failed (token expired & refresh endpoint unreachable):",
        err.message,
      );
    });
  } else {
    scheduleSecuritiesRefresh();
  }
}

// ==================== FILE WATCHERS (Hot Reload) ====================
// Watch .credentials.json for external changes (e.g. capture_token.js saves new tokens)
let credentialsWatchDebounce = null;

try {
  fs.watchFile(CREDENTIALS_PATH, { interval: 3000 }, () => {
    if (credentialsWatchDebounce) clearTimeout(credentialsWatchDebounce);
    credentialsWatchDebounce = setTimeout(() => {
      console.log("\n🔄 .credentials.json changed externally. Reloading...");
      const oldStockbitToken = stockbitToken;
      const oldSecuritiesToken = securitiesToken;

      const creds = getCredentials();
      stockbitToken = creds.tokens?.main?.accessToken || "";
      refreshToken = creds.tokens?.main?.refreshToken || "";
      securitiesToken = creds.tokens?.securities?.accessToken || "";
      securitiesRefreshToken = creds.tokens?.securities?.refreshToken || "";

      if (stockbitToken && stockbitToken !== oldStockbitToken) {
        scheduleRefresh();
        console.log("✅ Main token hot-reloaded!");
      }
      if (securitiesToken && securitiesToken !== oldSecuritiesToken) {
        scheduleSecuritiesRefresh();
        console.log("✅ Securities token hot-reloaded!");
      }
    }, 1000);
  });
} catch {
  /* ignore */
}

app.use(helmet());

app.use((req, res, next) => {
  runtimeMetrics.requestCount += 1;
  const start = Date.now();
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, ...args) {
    res.setHeader("X-Response-Time-Ms", String(Date.now() - start));
    return origWriteHead(statusCode, ...args);
  };
  next();
});

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_GLOBAL_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    type: "RateLimitExceeded",
    message: "Too many requests. Try again later.",
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    type: "RateLimitExceeded",
    message: "Too many auth requests. Try again later.",
  },
});

const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PROXY_MAX || 180),
  standardHeaders: true,
  legacyHeaders: false,
  message: { type: "RateLimitExceeded", message: "Proxy rate limit exceeded." },
});

app.use(cors());
app.use(express.json());
app.use(globalLimiter);

app.param("symbol", validateSymbolParam);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeSec: Math.round(process.uptime()),
    startedAt: runtimeMetrics.startedAt,
    timestamp: new Date().toISOString(),
  });
});

app.get("/metrics", (req, res) => {
  res.json({
    requestCount: runtimeMetrics.requestCount,
    errorCount: runtimeMetrics.errorCount,
    inFlightHeavy: runtimeMetrics.inFlightHeavy,
    cacheEntries: responseCache.size,
    uptimeSec: Math.round(process.uptime()),
  });
});

// Swagger Docs Setup
try {
  const swaggerDocument = require("./swagger.json");
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} catch (err) {
  console.warn("⚠️ Could not load swagger.json. API Docs not available.");
}

// Stockbit API base client dengan error handling & retry
const apiProxy = axios.create({
  baseURL: "https://exodus.stockbit.com",
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
  timeout: 15000,
});

// Interceptor untuk retry & circuit breaker
apiProxy.interceptors.response.use(
  (response) => response,
  async (error) => {
    const url = error.config.url;
    const cb = getOrCreateCircuitBreaker(url);

    if (cb.isOpen()) {
      throw new HttpError(503, `External API temporarily unavailable (${url})`);
    }

    const isRetryable =
      error.code === "ECONNREFUSED" ||
      error.code === "ETIMEDOUT" ||
      error.response?.status === 429 ||
      error.response?.status >= 500;

    if (isRetryable && !error.config.__retryCount) {
      error.config.__retryCount = 0;
    }

    if (isRetryable && error.config.__retryCount < 2) {
      error.config.__retryCount++;
      const delay = 1000 * Math.pow(2, error.config.__retryCount - 1);
      await new Promise((r) => setTimeout(r, delay));
      return apiProxy(error.config);
    }

    cb.recordFailure();
    throw error;
  },
);

// ==================== TRADING & PORTFOLIO ENDPOINTS (Requires Securities Token) ====================

app.get("/proxy/order-trade/trade-book/chart", async (req, res) => {
  const { symbol, time_interval } = req.query;

  if (!symbol || !time_interval) {
    return res.status(400).json({
      error: "symbol and time_interval are required",
      example: "?symbol=BBCA&time_interval=1D",
    });
  }

  // This endpoint requires Securities Token (ACN context)
  const token =
    securitiesToken && securitiesToken.length > 50
      ? securitiesToken
      : stockbitToken;
  if (!token) {
    return res.status(401).json({
      error: "No valid token available. Please login first via /auth/login",
    });
  }

  // Use web-style headers (NOT mobile X-AppVersion which triggers forced update check)
  const webHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/plain, */*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Origin: "https://stockbit.com",
    Referer: "https://stockbit.com/",
  };

  try {
    const url = `https://exodus.stockbit.com/order-trade/trade-book/chart?symbol=${symbol}&time_interval=${time_interval}`;
    const sRes = await axios.get(url, { headers: webHeaders, timeout: 15000 });
    return res.json(sRes.data);
  } catch (e) {
    return res
      .status(e.response?.status || 500)
      .json(e.response?.data || { error: e.message });
  }
});

// ==================== MARKET DATA ENDPOINTS (Using stockbitToken) ====================

app.use("/auth", authLimiter);

// Login endpoint - uses v6/username (no reCAPTCHA needed!)
app.post("/auth/login", async (req, res) => {
  const { username, password, player_id } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      error: "Username (email) and password are required",
      example: {
        username: "your_email@gmail.com",
        password: "your_password",
        player_id: "",
      },
    });
  }

  try {
    const result = await performLogin(username, password, player_id);

    // Check if 2FA device verification is needed
    if (result.needsVerification) {
      const creds = getCredentials();
      creds.data = Buffer.from(
        JSON.stringify({ username, password, player_id: player_id || "" }),
      ).toString("base64");
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));

      return res.json({
        status: "pending_verification",
        message: `Approve login on your device: ${result.deviceName}`,
        loginToken: result.loginToken,
        deviceName: result.deviceName,
        nextStep: "POST /auth/verify-device (after approving on phone)",
      });
    }

    // Direct login success
    stockbitToken = result.accessToken;
    refreshToken = result.refreshToken || "";
    saveMainToken(stockbitToken, refreshToken);

    const creds = getCredentials();
    creds.data = Buffer.from(
      JSON.stringify({ username, password, player_id: player_id || "" }),
    ).toString("base64");
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));

    scheduleRefresh();

    const info = decodeToken(stockbitToken);
    res.json({
      status: "ok",
      message: "Login successful! Token saved. Auto-refresh enabled.",
      tokenPreview: stockbitToken.substring(0, 30) + "...",
      expiresAt: info?.expiresAt,
      hasRefreshToken: !!refreshToken,
      autoRefresh: true,
    });
  } catch (error) {
    console.error("❌ Login error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: "Login failed",
        details: error.response.data,
      });
    } else {
      res
        .status(500)
        .json({ error: "Login request failed", details: error.message });
    }
  }
});

// Verify new device after user approves 2FA on phone
app.post("/auth/verify-device", async (req, res) => {
  const loginToken = req.body?.login_token || pendingLoginToken;

  if (!loginToken) {
    return res.status(400).json({
      error: "No pending login token. Call POST /auth/login first.",
    });
  }

  try {
    const result = await verifyNewDevice(loginToken);

    if (result.accessToken) {
      stockbitToken = result.accessToken;
      refreshToken = result.refreshToken || "";
      pendingLoginToken = "";
      saveMainToken(stockbitToken, refreshToken);
      scheduleRefresh();

      const info = decodeToken(stockbitToken);
      res.json({
        status: "ok",
        message: "Device verified! Token saved. Auto-refresh enabled.",
        tokenPreview: stockbitToken.substring(0, 30) + "...",
        expiresAt: info?.expiresAt,
        hasRefreshToken: !!refreshToken,
        autoRefresh: true,
      });
    } else {
      res.json({
        status: "pending",
        message:
          "Device not yet approved. Approve on your phone, then try again.",
        raw: result.raw,
      });
    }
  } catch (error) {
    console.error("❌ Device verification error:", error.message);
    if (error.response) {
      const errData = error.response.data;
      // If still waiting for approval
      if (error.response.status === 400 || error.response.status === 403) {
        res.status(202).json({
          status: "waiting",
          message:
            "Still waiting for device approval. Approve on your phone and try again.",
          details: errData,
        });
      } else {
        res
          .status(error.response.status)
          .json({ error: "Verification failed", details: errData });
      }
    } else {
      res
        .status(500)
        .json({ error: "Verification request failed", details: error.message });
    }
  }
});

// Manual token set endpoint
app.post("/auth/set-token", (req, res) => {
  const { token, refresh_token } = req.body;
  if (!token) {
    return res.status(400).json({
      error:
        'Token is required: { "token": "eyJ...", "refresh_token": "optional" }',
    });
  }
  stockbitToken = token;
  if (refresh_token) refreshToken = refresh_token;
  saveMainToken(token, refreshToken);
  const creds = getCredentials();
  if (refreshToken || creds.data) scheduleRefresh();
  res.json({
    status: "ok",
    message: "Token set successfully!",
    tokenPreview: token.substring(0, 30) + "...",
    autoRefresh: !!(refreshToken || creds.data),
  });
});

app.get("/auth/status", (req, res) => {
  const creds = getCredentials();
  const info = stockbitToken ? decodeToken(stockbitToken) : null;
  res.json({
    loaded: !!stockbitToken,
    ...(info || {}),
    hasRefreshToken: !!refreshToken,
    autoRefreshEnabled: !!(refreshToken || creds.data),
    credentialsSaved: !!creds.data,
    nextRefreshScheduled: !!refreshTimer,
  });
});

// Force refresh token now
app.post("/auth/refresh", async (req, res) => {
  const creds = getCredentials();
  if (!refreshToken && !creds.data) {
    return res.status(400).json({
      error:
        "No refresh token or credentials. Login first via POST /auth/login.",
    });
  }

  const success = await autoRefreshToken();
  if (success) {
    const info = decodeToken(stockbitToken);
    res.json({
      status: "ok",
      message: "Token refreshed!",
      expiresAt: info?.expiresAt,
      tokenPreview: stockbitToken.substring(0, 30) + "...",
      hasRefreshToken: !!refreshToken,
    });
  } else {
    res.status(500).json({ error: "Refresh failed. Check server logs." });
  }
});

app.post("/auth/logout", (req, res) => {
  stockbitToken = "";
  refreshToken = "";
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  securitiesToken = "";
  securitiesRefreshToken = "";
  if (securitiesRefreshTimer) clearTimeout(securitiesRefreshTimer);
  securitiesRefreshTimer = null;

  try {
    const creds = getCredentials();
    creds.data = ""; // Clear saved credentials
    creds.tokens.main = {}; // Clear main token
    creds.tokens.securities = {}; // Clear securities token
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
  } catch {
    /* ignore */
  }
  res.json({
    status: "ok",
    message: "Logged out. Token, refresh token, and credentials cleared.",
  });
});

// ==================== SECURITIES AUTH (CARINA) ====================

// Login to Carina Securities with PIN
app.post("/auth/securities/login", async (req, res) => {
  const { login_token, pin } = req.body;

  if (!pin) {
    return res.status(400).json({ error: "pin is required" });
  }
  if (!login_token) {
    return res.status(400).json({
      error:
        "login_token is required. Get it from browser DevTools Network tab (carina.stockbit.com/auth/v2/login request body)",
    });
  }

  try {
    console.log("🔐 Logging into Carina Securities...");
    const response = await axios.post(
      "https://carina.stockbit.com/auth/v2/login",
      {
        login_token,
        pin,
      },
      {
        headers: {
          Authorization: `Bearer ${stockbitToken}`,
          "Content-Type": "application/json",
          Origin: "https://stockbit.com",
          Referer: "https://stockbit.com/",
        },
        timeout: 10000,
      },
    );

    const data = response.data;
    console.log(
      "📦 Carina Securities response:",
      JSON.stringify(data).substring(0, 200),
    );

    // Extract the securities JWT token from the response
    const secToken =
      data?.data?.token ||
      data?.data?.access_token ||
      data?.token ||
      data?.access_token;
    const secRefresh = data?.data?.refresh_token || data?.refresh_token;

    if (secToken) {
      securitiesToken = secToken;
      if (secRefresh) securitiesRefreshToken = secRefresh;
      saveSecuritiesToken(secToken, secRefresh);
      scheduleSecuritiesRefresh();
      const secInfo = decodeToken(secToken);
      console.log("✅ Securities token acquired!");
      return res.json({
        status: "ok",
        message: "Securities login successful!",
        accountNumber: secInfo?.data?.acn || "unknown",
        expiresAt: secInfo?.expiresAt,
        tokenPreview: secToken.substring(0, 40) + "...",
      });
    }

    // If no token extracted, return the raw response for debugging
    securitiesToken = "";
    res.json({
      status: "raw_response",
      message: "Response received but no token extracted. Check the raw data.",
      raw: data,
    });
  } catch (error) {
    console.error(
      "❌ Securities login failed:",
      error.response?.data || error.message,
    );
    res.status(error.response?.status || 500).json({
      error: "Securities login failed",
      details: error.response?.data || error.message,
    });
  }
});

// Auth: Set Securities Token Manually
app.post("/auth/securities/set-token", (req, res) => {
  const { token, refresh_token } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });
  securitiesToken = token;
  if (refresh_token) securitiesRefreshToken = refresh_token;
  saveSecuritiesToken(token, refresh_token);
  scheduleSecuritiesRefresh();
  const info = decodeToken(token);
  res.json({
    status: "ok",
    message: "Securities token set!",
    expiresAt: info?.expiresAt,
    tokenPreview: token.substring(0, 40) + "...",
  });
});

// Refresh Securities Token
async function performSecuritiesRefresh() {
  if (!securitiesRefreshToken || !securitiesToken) {
    throw new Error("No securities token or refresh token available");
  }

  console.log("🔄 Refreshing Securities token via /auth/v2/refresh ...");

  const response = await axios.post(
    "https://carina.stockbit.com/auth/v2/refresh",
    {
      refresh_token: securitiesRefreshToken,
    },
    {
      headers: {
        Authorization: `Bearer ${stockbitToken}`, // Endpoint usually requires main token
        "Content-Type": "application/json",
        Origin: "https://stockbit.com",
        Referer: "https://stockbit.com/",
      },
      timeout: 15000,
    },
  );

  const data = response.data;
  const newAccessToken =
    data?.data?.token || data?.data?.access_token || data?.access_token;
  const newRefreshToken = data?.data?.refresh_token || data?.refresh_token;

  if (newAccessToken) {
    securitiesToken = newAccessToken;
    securitiesRefreshToken = newRefreshToken || securitiesRefreshToken;
    saveSecuritiesToken(securitiesToken, securitiesRefreshToken);
    console.log("✅ Securities Token refreshed successfully!");
    return true;
  }

  throw new Error("Token not found in Securities refresh response");
}

// Securities token status
app.get("/auth/securities/status", (req, res) => {
  if (!securitiesToken) {
    return res.json({
      loaded: false,
      message:
        "No securities token. Use POST /auth/securities/login or /auth/securities/set-token",
    });
  }
  const info = decodeToken(securitiesToken);
  res.json({ loaded: true, ...info });
});

// ==================== MARKET DATA ENDPOINTS ====================

// Token Info
app.get("/auth/token-info", (req, res) => {
  const mainInfo = decodeToken(stockbitToken);
  const secInfo = decodeToken(securitiesToken);
  res.json({
    main_token: { loaded: !!stockbitToken, ...mainInfo },
    securities_token: { loaded: !!securitiesToken, ...secInfo },
    has_refresh_token: !!refreshToken,
  });
});

// Realtime Quote
app.get("/quote/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    if (!symbol || symbol.length < 1) {
      throw new HttpError(400, "Symbol is required");
    }

    const headers = {
      Authorization: `Bearer ${stockbitToken}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
    };

    const [obRes, histRes] = await Promise.all([
      retryWithBackoff(
        () =>
          axios.get(
            `https://exodus.stockbit.com/company-price-feed/v2/orderbook/companies/${symbol}`,
            { headers, timeout: 12000 },
          ),
        2,
        500,
        `Quote orderbook ${symbol}`,
      ).catch(() => null),
      retryWithBackoff(
        () =>
          axios.get(
            `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=1`,
            { headers, timeout: 12000 },
          ),
        2,
        500,
        `Quote historical ${symbol}`,
      ).catch(() => null),
    ]);

    const ob = obRes?.data?.data || {};
    const hist = histRes?.data?.data?.result?.[0] || {};

    if (!ob.last_price && !hist.close) {
      throw new HttpError(404, `No quote data found for symbol ${symbol}`, {
        symbol,
      });
    }

    res.json({
      symbol,
      price: ob.last_price || hist.close,
      change: ob.change || hist.close - hist.prev,
      change_pct:
        ob.change_percentage || ((hist.close - hist.prev) / hist.prev) * 100,
      open: hist.open,
      high: hist.high,
      low: hist.low,
      close: hist.close,
      volume: hist.volume,
      date: hist.date,
      bid: ob.bid?.[0]?.price,
      offer: ob.offer?.[0]?.price,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// Market Summary (IHSG)
app.get("/market/summary", async (req, res) => {
  try {
    const headers = {
      Authorization: `Bearer ${stockbitToken}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
    };
    const idxRes = await axios.get(
      "https://exodus.stockbit.com/company-price-feed/historical/summary/COMPOSITE?page=1",
      { headers },
    );
    const data = idxRes.data?.data?.result?.[0] || {};
    res.json({
      index: "IHSG (Composite)",
      close: data.close,
      change: data.close - data.prev,
      change_pct: (((data.close - data.prev) / data.prev) * 100).toFixed(2),
      open: data.open,
      high: data.high,
      low: data.low,
      volume: data.volume,
      date: data.date,
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to get market summary", details: e.message });
  }
});

// Proxy: Company Profile
app.get("/proxy/company/profile/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const pRes = await axios.get(
      `https://api.stockbit.com/company/symbol/${symbol}`,
      {
        headers: {
          ...STOCKBIT_HEADERS,
          Authorization: `Bearer ${stockbitToken}`,
        },
      },
    );
    res.json(pRes.data);
  } catch (e) {
    res
      .status(e.response?.status || 500)
      .json(e.response?.data || { error: e.message });
  }
});

// Proxy: Company Financials
app.get("/proxy/company/financials/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const fRes = await axios.get(
      `https://api.stockbit.com/company/v2/financials/${symbol}?type=quarterly&statement=income`,
      {
        headers: {
          ...STOCKBIT_HEADERS,
          Authorization: `Bearer ${stockbitToken}`,
        },
      },
    );
    res.json(fRes.data);
  } catch (e) {
    res
      .status(e.response?.status || 500)
      .json(e.response?.data || { error: e.message });
  }
});

// Proxy: Foreign Flow
app.get("/proxy/foreign/flow/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const ffRes = await axios.get(
      `https://api.stockbit.com/company/foreignflow/${symbol}`,
      {
        headers: {
          ...STOCKBIT_HEADERS,
          Authorization: `Bearer ${stockbitToken}`,
        },
      },
    );
    res.json(ffRes.data);
  } catch (e) {
    res
      .status(e.response?.status || 500)
      .json(e.response?.data || { error: e.message });
  }
});

// ==================== SECURITIES DATA ENDPOINTS ====================

// Securities: Account Balance & Buying Power
app.get("/securities/balance", async (req, res) => {
  if (!securitiesToken || securitiesToken.length < 50) {
    return res.status(401).json({
      error:
        "Securities token not available. POST /auth/securities/login first.",
    });
  }
  try {
    const bRes = await axios.get(
      "https://api.stockbit.com/order-trade/balance",
      {
        headers: {
          ...STOCKBIT_HEADERS,
          Authorization: `Bearer ${securitiesToken}`,
        },
      },
    );
    res.json(bRes.data);
  } catch (e) {
    res
      .status(e.response?.status || 500)
      .json(e.response?.data || { error: e.message });
  }
});

// Securities: Active Portfolio
app.get("/securities/portfolio", async (req, res) => {
  if (!securitiesToken || securitiesToken.length < 50) {
    return res.status(401).json({
      error:
        "Securities token not available. POST /auth/securities/login first.",
    });
  }
  try {
    const pRes = await axios.get(
      "https://api.stockbit.com/order-trade/portfolio",
      {
        headers: {
          ...STOCKBIT_HEADERS,
          Authorization: `Bearer ${securitiesToken}`,
        },
      },
    );
    res.json(pRes.data);
  } catch (e) {
    res
      .status(e.response?.status || 500)
      .json(e.response?.data || { error: e.message });
  }
});

// Securities: Order History
app.get("/securities/orders", async (req, res) => {
  if (!securitiesToken || securitiesToken.length < 50) {
    return res.status(401).json({
      error:
        "Securities token not available. POST /auth/securities/login first.",
    });
  }
  try {
    const oRes = await axios.get(
      "https://api.stockbit.com/order-trade/orders",
      {
        headers: {
          ...STOCKBIT_HEADERS,
          Authorization: `Bearer ${securitiesToken}`,
        },
      },
    );
    res.json(oRes.data);
  } catch (e) {
    res
      .status(e.response?.status || 500)
      .json(e.response?.data || { error: e.message });
  }
});

// ==================== CUSTOM ANALYSIS MIDDLEWARE ====================

app.get("/analysis/technicals/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    let allHistory = [];
    for (let page = 1; page <= 5; page++) {
      const response = await axios.get(
        `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
        {
          headers: {
            Accept: "application/json, text/plain, */*",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Origin: "https://stockbit.com",
            Referer: "https://stockbit.com/",
            Authorization: `Bearer ${stockbitToken}`,
          },
        },
      );
      const pageData = response.data?.data?.result || [];
      allHistory = allHistory.concat(pageData);
      if (!response.data?.data?.paginate?.next_page) break;
    }

    if (allHistory.length < 5)
      return res.status(400).json({ error: "Not enough historical data" });

    // Stockbit returns descending order (newest first). Indicators usually need ascending (oldest first).
    const ascHistory = [...allHistory].reverse();

    const closes = ascHistory.map((d) => d.close);
    const highs = ascHistory.map((d) => d.high);
    const lows = ascHistory.map((d) => d.low);
    const times = ascHistory.map((d) => {
      // convert "YYYY-MM-DD" or similar to unix timestamp for compatibility
      return new Date(d.date).getTime() / 1000;
    });

    // MACD (12, 26, 9)
    let latestMacd = { MACD: 0, signal: 0, histogram: 0 };
    if (closes.length >= 26) {
      const macdInput = {
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      };
      const macdResult = MACD.calculate(macdInput);
      latestMacd = macdResult[macdResult.length - 1] || latestMacd;
    }

    // RSI (14)
    let latestRsi = 50;
    if (closes.length >= 15) {
      const rsiInput = { values: closes, period: 14 };
      const rsiResult = RSI.calculate(rsiInput);
      latestRsi = rsiResult[rsiResult.length - 1] || 50;
    }

    // EMA 20 & 50
    const latestClose = closes[closes.length - 1];
    let latestEma20 = latestClose;
    let latestEma50 = latestClose;
    if (closes.length >= 20) {
      const ema20Result = EMA.calculate({ period: 20, values: closes });
      latestEma20 = ema20Result[ema20Result.length - 1] || latestClose;
    }
    if (closes.length >= 50) {
      const ema50Result = EMA.calculate({ period: 50, values: closes });
      latestEma50 = ema50Result[ema50Result.length - 1] || latestClose;
    }

    // Support & Resistance (Classic Pivot Points based on previous day)
    // Since array is ascending, previous day is length - 2
    const prevIdx = closes.length >= 2 ? closes.length - 2 : closes.length - 1;
    const pHigh = highs[prevIdx];
    const pLow = lows[prevIdx];
    const pClose = closes[prevIdx];

    const pivot = (pHigh + pLow + pClose) / 3;
    const s1 = pivot * 2 - pHigh;
    const s2 = pivot - (pHigh - pLow);
    const s3 = pLow - 2 * (pHigh - pivot);
    const r1 = pivot * 2 - pLow;
    const r2 = pivot + (pHigh - pLow);
    const r3 = pHigh + 2 * (pivot - pLow);

    const latestDateStr = new Date(times[times.length - 1] * 1000)
      .toISOString()
      .split("T")[0];

    res.json({
      message: "Custom Technical Analysis",
      symbol: symbol,
      date: latestDateStr,
      price: latestClose,
      indicators: {
        EMA20: latestEma20,
        EMA50: latestEma50,
        EMA_Trend:
          latestEma20 > latestEma50 ? "Bullish Trend ↗" : "Bearish Trend ↘",
        RSI_14: latestRsi,
        RSI_Signal:
          latestRsi > 70
            ? "Overbought"
            : latestRsi < 30
              ? "Oversold"
              : "Neutral Signal",
        MACD_Line: latestMacd.MACD,
        MACD_Signal: latestMacd.signal,
        MACD_Trend: latestMacd.histogram > 0 ? "Bullish" : "Bearish",
      },
      support_resistance: {
        pivot: Math.round(pivot),
        S1: Math.round(s1),
        S2: Math.round(s2),
        S3: Math.round(s3),
        R1: Math.round(r1),
        R2: Math.round(r2),
        R3: Math.round(r3),
      },
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to calculate analysis", details: e.message });
  }
});

// ==================== FUNDAMENTALS ANALYSIS ====================

app.get("/analysis/fundamentals/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    // Fetch info + historical in parallel for speed
    const [infoRes, histRes] = await Promise.all([
      axios.get(`https://exodus.stockbit.com/emitten/${symbol}/info`, {
        headers,
      }),
      axios.get(
        `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}`,
        { headers },
      ),
    ]);

    const info = infoRes.data?.data || {};
    const history = histRes.data?.data?.result || [];

    // Calculate Market Cap from price * shares (if listing_information exists)
    const price = info.price || 0;
    const volume = info.volume || 0;
    const avgVolume = info.average || 0;

    // Calculate average daily value from history
    let avgDailyVolume = 0;
    let avgDailyValue = 0;
    if (history.length > 0) {
      avgDailyVolume = Math.round(
        history.reduce((sum, d) => sum + (d.volume || 0), 0) / history.length,
      );
      avgDailyValue = Math.round(
        history.reduce((sum, d) => sum + (d.value || 0), 0) / history.length,
      );
    }

    // Calculate volatility (standard deviation of daily returns)
    let volatility = 0;
    if (history.length > 2) {
      const returns = [];
      for (let i = 1; i < history.length; i++) {
        if (history[i - 1].close > 0) {
          returns.push(
            (history[i].close - history[i - 1].close) / history[i - 1].close,
          );
        }
      }
      const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
      volatility =
        Math.sqrt(
          returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) /
            returns.length,
        ) * 100;
    }

    // 52-week high/low from historical data (up to 5 pages)
    let allHistory = [...history];
    let nextPage = histRes.data?.data?.paginate?.next_page;
    for (let page = 2; page <= 22 && nextPage; page++) {
      try {
        const pageRes = await axios.get(
          `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
          { headers },
        );
        const pageData = pageRes.data?.data?.result || [];
        allHistory = allHistory.concat(pageData);
        nextPage = pageRes.data?.data?.paginate?.next_page;
      } catch {
        break;
      }
    }

    const high52w =
      allHistory.length > 0
        ? Math.max(...allHistory.map((d) => d.high || 0))
        : price;
    const low52w =
      allHistory.length > 0
        ? Math.min(...allHistory.map((d) => d.low || Infinity))
        : price;
    const fromHigh52w =
      price > 0 && high52w > 0
        ? (((price - high52w) / high52w) * 100).toFixed(2)
        : 0;

    res.json({
      message: "Fundamental Analysis",
      symbol: symbol,
      company_name: info.name || symbol,
      sector: info.sector || "N/A",
      sub_sector: info.sub_sector || "N/A",
      type: info.type_company || "Saham",
      market_summary: {
        price: price,
        change: info.change || "0",
        change_pct: info.percentage || 0,
        volume: volume,
        avg_volume: avgDailyVolume,
        avg_daily_value: avgDailyValue,
        high_52w: high52w,
        low_52w: low52w,
        from_high_52w: `${fromHigh52w}%`,
        volatility: `${volatility.toFixed(2)}%`,
        followers: info.followers || 0,
      },
      sentiment: info.sentiment || {},
      trading_info: {
        tradeable: info.tradeable || false,
        trade_type: info.trade_type || "N/A",
        margin_info: info.margin_info || {},
        day_trade_multiplier: info.day_trade_multiplier || 0,
      },
      corporate_action: info.corp_action || null,
      indexes: info.indexes_data || info.indexes || [],
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to get fundamentals", details: e.message });
  }
});

// ==================== COMPANY PROFILE ====================

app.get("/analysis/company/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    const profileRes = await axios.get(
      `https://exodus.stockbit.com/emitten/${symbol}/profile`,
      { headers },
    );
    const data = profileRes.data?.data || {};

    // Parse shareholders
    const shareholders = (data.shareholder || []).map((s) => ({
      name: s.name || "Unknown",
      percentage: s.percentage || "0%",
    }));

    // Parse key executives
    const commissioners = (data.key_executive?.commissioner || []).map((e) => ({
      name: e.name || "",
      position: e.position_key || "Commissioner",
      updated: e.lastupdate || "",
    }));
    const directors = (data.key_executive?.director || []).map((e) => ({
      name: e.name || "",
      position: e.position_key || "Director",
      updated: e.lastupdate || "",
    }));

    // Parse subsidiaries
    const subsidiaries = (data.subsidiary || []).map((s) => ({
      name: s.name || "",
      percentage: s.percentage || "",
    }));

    res.json({
      message: "Company Profile",
      symbol: symbol,
      about: data.background || "No description available",
      history: data.history || "No history available",
      address: data.address || {},
      listing_information: data.listing_information || {},
      shareholders: shareholders,
      shareholder_numbers: data.shareholder_numbers || null,
      key_executives: {
        commissioners: commissioners,
        directors: directors,
      },
      subsidiaries: subsidiaries,
      secretary: data.secretary || {},
      beneficiary: data.beneficiary || [],
      badges: data.badges || [],
      fee: data.fee || null,
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to get company profile", details: e.message });
  }
});

// ==================== FOREIGN FLOW ANALYSIS ====================

app.get("/analysis/foreign-flow/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    // Fetch foreign flow + historical in parallel
    const [flowRes, histRes] = await Promise.all([
      axios.get(
        `https://exodus.stockbit.com/findata-view/foreign-domestic/v1/chart-data/${symbol}`,
        { headers },
      ),
      axios.get(
        `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}`,
        { headers },
      ),
    ]);

    const flowData = flowRes.data?.data || {};
    const history = histRes.data?.data?.result || [];

    // Calculate cumulative net foreign from history
    let cumulativeNetForeign = 0;
    const foreignTimeline = history.map((d) => {
      cumulativeNetForeign += d.net_foreign || 0;
      return {
        date: d.date,
        foreign_buy: d.foreign_buy || 0,
        foreign_sell: d.foreign_sell || 0,
        net_foreign: d.net_foreign || 0,
        cumulative: cumulativeNetForeign,
      };
    });

    // Determine foreign sentiment
    const todayNetForeign = history[0]?.net_foreign || 0;
    const foreignSentiment =
      todayNetForeign > 0
        ? "Net Foreign BUY 🟢"
        : todayNetForeign < 0
          ? "Net Foreign SELL 🔴"
          : "Neutral ⚪";

    // Count consecutive days of foreign buy/sell
    let consecutiveDays = 0;
    let direction = todayNetForeign > 0 ? "buy" : "sell";
    for (const d of history) {
      if (
        (direction === "buy" && d.net_foreign > 0) ||
        (direction === "sell" && d.net_foreign < 0)
      ) {
        consecutiveDays++;
      } else break;
    }

    res.json({
      message: "Foreign Flow Analysis",
      symbol: symbol,
      date: flowData.summary?.date_range || history[0]?.date || "N/A",
      summary: flowData.summary || {},
      sentiment: foreignSentiment,
      consecutive_days: `${consecutiveDays} hari berturut-turut ${direction === "buy" ? "Net Buy" : "Net Sell"}`,
      chart_data: {
        value: flowData.value || [],
        volume: flowData.volume || [],
        frequency: flowData.frequency || [],
      },
      daily_breakdown: foreignTimeline,
      period: {
        from: flowData.from || "",
        to: flowData.to || "",
      },
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to get foreign flow", details: e.message });
  }
});

// ==================== BROKER SUMMARY (Market Detectors) ====================

app.get(
  "/analysis/broker-summary/:symbol",
  validateDateRangeQuery,
  async (req, res) => {
    const symbol = req.params.symbol;
    const { start_date, end_date } = req.query;
    try {
      const headers = {
        Authorization: `Bearer ${stockbitToken}`,
        Origin: "https://stockbit.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      };

      const today = new Date().toISOString().split("T")[0];
      const startDate = start_date || today;
      const endDate = end_date || today;

      const url = `https://exodus.stockbit.com/marketdetectors/${symbol}?start_date=${startDate}&end_date=${endDate}&transaction_type=TRANSACTION_TYPE_NET&market_board=MARKET_BOARD_REGULER&investor_type=INVESTOR_TYPE_ALL&limit=100`;

      const broksumRes = await axios.get(url, { headers });
      const data = broksumRes.data?.data || {};

      const brokerSummary = data.broker_summary || {};
      const bandarDetector = data.bandar_detector || {};

      res.json({
        message: "Broker Summary (Net Buy/Sell)",
        symbol: symbol,
        date_range: { start: startDate, end: endDate },
        top_buyers: (brokerSummary.brokers_buy || []).slice(0, 5).map((b) => ({
          broker: b.netbs_broker_code,
          name: b.type,
          net_lot: parseInt(b.blot),
          net_value: parseFloat(b.bval),
          avg_price: parseFloat(b.netbs_buy_avg_price),
        })),
        top_sellers: (brokerSummary.brokers_sell || [])
          .slice(0, 5)
          .map((s) => ({
            broker: s.netbs_broker_code,
            name: s.type,
            net_lot: -parseInt(s.slot),
            net_value: parseFloat(s.sval),
            avg_price: parseFloat(s.netbs_sell_avg_price),
          })),
        bandar_detector: {
          total_buyer_brokers: bandarDetector.total_buyer,
          total_seller_brokers: bandarDetector.total_seller,
          status: bandarDetector.broker_accdist || "NEUTRAL",
          top1_acc_dist: bandarDetector.top1?.accdist || "NEUTRAL",
          top5_acc_dist: bandarDetector.top5?.accdist || "NEUTRAL",
        },
      });
    } catch (e) {
      res
        .status(500)
        .json({ error: "Failed to get broker summary", details: e.message });
    }
  },
);

// ==================== COMPLETE ANALYSIS (All-in-One ) ====================

app.get(
  "/analysis/complete/:symbol",
  createConcurrencyLimiter(4),
  createRouteCache(CACHE_TTL_HEAVY_MS),
  async (req, res) => {
    const symbol = req.params.symbol;
    try {
      // Fetch all analysis endpoints internally using Promise.all
      const baseUrl = `http://localhost:${PORT}/analysis`;
      const [
        techRes,
        fundRes,
        compRes,
        flowRes,
        obRes,
        bandRes,
        brokRes,
        yfRes,
      ] = await Promise.all([
        axios
          .get(`${baseUrl}/technicals/${symbol}`)
          .catch((e) => ({ data: { error: e.message } })),
        axios
          .get(`${baseUrl}/fundamentals/${symbol}`)
          .catch((e) => ({ data: { error: e.message } })),
        axios
          .get(`${baseUrl}/company/${symbol}`)
          .catch((e) => ({ data: { error: e.message } })),
        axios
          .get(`${baseUrl}/foreign-flow/${symbol}`)
          .catch((e) => ({ data: { error: e.message } })),
        axios
          .get(`${baseUrl}/orderbook/${symbol}`)
          .catch((e) => ({ data: { error: e.message } })),
        axios
          .get(`${baseUrl}/bandarmology/${symbol}`)
          .catch((e) => ({ data: { error: e.message } })),
        axios
          .get(`${baseUrl}/broker-summary/${symbol}`)
          .catch((e) => ({ data: { error: e.message } })),
        axios
          .get(`${baseUrl}/yfinance/${symbol}`)
          .catch((e) => ({ data: { error: e.message } })),
      ]);

      res.json({
        message: `Complete Analysis for ${symbol}`,
        symbol: symbol,
        generated_at: new Date().toISOString(),
        technicals: techRes.data,
        fundamentals: fundRes.data,
        company: compRes.data,
        foreign_flow: flowRes.data,
        broker_summary: brokRes.data,
        orderbook: obRes.data,
        bandarmology: bandRes.data,
        yfinance_deep_fundamentals: yfRes.data,
      });
    } catch (e) {
      res.status(500).json({
        error: "Failed to generate complete analysis",
        details: e.message,
      });
    }
  },
);

// ==================== DEEP FUNDAMENTALS (YAHOO FINANCE) ====================

app.get("/analysis/yfinance/:symbol", async (req, res) => {
  // Append .JK for Indonesian stocks
  let symbol = req.params.symbol.toUpperCase();
  const yfSymbol = symbol.endsWith(".JK") ? symbol : `${symbol}.JK`;

  try {
    // Fetch Quote Summary modules
    const queryOptions = {
      modules: ["financialData", "defaultKeyStatistics", "assetProfile"],
    };
    const result = await yahooFinance.quoteSummary(yfSymbol, queryOptions);

    const finData = result.financialData || {};
    const keyStats = result.defaultKeyStatistics || {};
    const profile = result.assetProfile || {};

    res.json({
      message: "Deep Fundamentals & KeyStats",
      symbol: symbol,
      company_profile: {
        sector: profile.sector,
        industry: profile.industry,
        website: profile.website,
        full_employees: profile.fullTimeEmployees,
      },
      valuation: {
        forward_pe: keyStats.forwardPE,
        trailing_pe: keyStats.trailingPE,
        price_to_book: keyStats.priceToBook,
        enterprise_value: keyStats.enterpriseValue,
        ev_to_ebitda: keyStats.enterpriseToEbitda,
        ev_to_revenue: keyStats.enterpriseToRevenue,
        peg_ratio: keyStats.pegRatio,
      },
      profitability: {
        profit_margin: finData.profitMargins,
        operating_margin: finData.operatingMargins,
        return_on_assets: finData.returnOnAssets,
        return_on_equity: finData.returnOnEquity,
      },
      financial_health: {
        current_ratio: finData.currentRatio,
        quick_ratio: finData.quickRatio,
        debt_to_equity: finData.debtToEquity,
        total_cash: finData.totalCash,
        total_debt: finData.totalDebt,
        total_revenue: finData.totalRevenue,
        gross_profits: finData.grossProfits,
      },
      dividends: {
        dividend_rate: finData.dividendRate,
        dividend_yield: finData.dividendYield,
        ex_dividend_date: keyStats.exDividendDate,
      },
    });
  } catch (e) {
    res.status(500).json({
      error: "Failed to fetch Yahoo Finance data",
      details: e.message,
    });
  }
});

// ==================== ORDERBOOK DEPTH ANALYSIS ====================

app.get("/analysis/orderbook/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    const obRes = await axios.get(
      `https://exodus.stockbit.com/company-price-feed/v2/orderbook/companies/${symbol}`,
      { headers },
    );
    const ob = obRes.data?.data || {};

    const bids = ob.bid || [];
    const offers = ob.offer || [];

    // Calculate total bid volume & total offer volume
    const totalBidVol = bids.reduce((s, b) => s + (parseInt(b.volume) || 0), 0);
    const totalOfferVol = offers.reduce(
      (s, o) => s + (parseInt(o.volume) || 0),
      0,
    );
    const totalBidQueue = bids.reduce(
      (s, b) => s + (parseInt(b.que_num) || 0),
      0,
    );
    const totalOfferQueue = offers.reduce(
      (s, o) => s + (parseInt(o.que_num) || 0),
      0,
    );

    // Buy/Sell pressure ratio
    const buyPressure =
      totalBidVol + totalOfferVol > 0
        ? ((totalBidVol / (totalBidVol + totalOfferVol)) * 100).toFixed(2)
        : 50;

    // Bid-Ask spread
    const bestBid = parseInt(bids[0]?.price) || 0;
    const bestOffer = parseInt(offers[0]?.price) || 0;
    const spread = bestOffer - bestBid;
    const spreadPct = bestBid > 0 ? ((spread / bestBid) * 100).toFixed(3) : 0;

    // Top 5 bid/offer levels
    const top5Bids = bids.slice(0, 5).map((b) => ({
      price: parseInt(b.price),
      lots: parseInt(b.volume),
      queue: parseInt(b.que_num),
    }));
    const top5Offers = offers.slice(0, 5).map((o) => ({
      price: parseInt(o.price),
      lots: parseInt(o.volume),
      queue: parseInt(o.que_num),
    }));

    // Accumulation zones (bid levels with > 1% of total volume)
    const significantBids = bids
      .filter((b) => parseInt(b.volume) / totalBidVol > 0.05)
      .map((b) => ({
        price: parseInt(b.price),
        lots: parseInt(b.volume),
        pct_of_total:
          ((parseInt(b.volume) / totalBidVol) * 100).toFixed(1) + "%",
      }));

    // Distribution zones (offer levels with > 1% of total volume)
    const significantOffers = offers
      .filter((o) => parseInt(o.volume) / totalOfferVol > 0.05)
      .map((o) => ({
        price: parseInt(o.price),
        lots: parseInt(o.volume),
        pct_of_total:
          ((parseInt(o.volume) / totalOfferVol) * 100).toFixed(1) + "%",
      }));

    res.json({
      message: "Orderbook Depth Analysis",
      symbol: symbol,
      current_price: ob.close || ob.previous || 0,
      market_status: {
        open: ob.open,
        high: ob.high,
        low: ob.low,
        close: ob.close,
        volume: ob.volume,
        frequency: ob.frequency,
        previous: ob.previous,
      },
      spread: {
        best_bid: bestBid,
        best_offer: bestOffer,
        spread_rupiah: spread,
        spread_pct: `${spreadPct}%`,
      },
      pressure: {
        buy_pressure: `${buyPressure}%`,
        sell_pressure: `${(100 - parseFloat(buyPressure)).toFixed(2)}%`,
        signal:
          parseFloat(buyPressure) > 55
            ? "Strong BUY Pressure 🟢"
            : parseFloat(buyPressure) < 45
              ? "Strong SELL Pressure 🔴"
              : "Balanced ⚖️",
        total_bid_lots: totalBidVol,
        total_offer_lots: totalOfferVol,
        total_bid_queue: totalBidQueue,
        total_offer_queue: totalOfferQueue,
      },
      depth: {
        bid_levels: bids.length,
        offer_levels: offers.length,
        top5_bids: top5Bids,
        top5_offers: top5Offers,
      },
      accumulation_zones: significantBids,
      distribution_zones: significantOffers,
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to analyze orderbook", details: e.message });
  }
});

// ==================== BANDARMOLOGY / VOLUME ANOMALY ====================

app.get(
  "/analysis/bandarmology/:symbol",
  createConcurrencyLimiter(6),
  createRouteCache(CACHE_TTL_HEAVY_MS),
  async (req, res) => {
    const symbol = req.params.symbol;
    try {
      const headers = {
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Origin: "https://stockbit.com",
        Referer: "https://stockbit.com/",
        Authorization: `Bearer ${stockbitToken}`,
      };

      // Fetch 5 pages of historical data for volume analysis
      let allHistory = [];
      for (let page = 1; page <= 5; page++) {
        const response = await axios.get(
          `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
          { headers },
        );
        const pageData = response.data?.data?.result || [];
        allHistory = allHistory.concat(pageData);
        if (!response.data?.data?.paginate?.next_page) break;
      }

      if (allHistory.length < 5)
        return res.status(400).json({ error: "Not enough historical data" });

      // Calculate average volume (20-day)
      const volumes = allHistory.map((d) => d.volume || 0);
      const avg20Vol =
        volumes.slice(0, 20).reduce((s, v) => s + v, 0) /
        Math.min(20, volumes.length);
      const todayVol = volumes[0] || 0;
      const volRatio = avg20Vol > 0 ? todayVol / avg20Vol : 1;

      // Detect volume anomalies (days where volume > 2x average)
      const anomalies = allHistory
        .filter((d) => d.volume > avg20Vol * 2)
        .map((d) => ({
          date: d.date,
          volume: d.volume,
          ratio: (d.volume / avg20Vol).toFixed(2) + "x",
          close: d.close,
          change_pct: d.change_percentage,
        }));

      // Accumulation/Distribution analysis (using net_foreign as proxy for big player movement)
      let accumulationScore = 0;
      const recentDays = allHistory.slice(0, 10);
      for (const d of recentDays) {
        if (d.net_foreign > 0 && d.change_percentage > 0)
          accumulationScore += 2; // Foreign buy + price up = accumulation
        else if (d.net_foreign > 0 && d.change_percentage <= 0)
          accumulationScore += 1; // Foreign buy + price down = quiet accumulation
        else if (d.net_foreign < 0 && d.change_percentage < 0)
          accumulationScore -= 2; // Foreign sell + price down = distribution
        else if (d.net_foreign < 0 && d.change_percentage >= 0)
          accumulationScore -= 1; // Foreign sell + price up = quiet distribution
      }

      const accDistSignal =
        accumulationScore > 5
          ? "Strong Accumulation 🟢"
          : accumulationScore > 0
            ? "Mild Accumulation 🟡"
            : accumulationScore > -5
              ? "Mild Distribution 🟠"
              : "Strong Distribution 🔴";

      // Price-Volume divergence (price up but volume down = weak rally, price down but volume down = weak selling)
      let divergences = [];
      for (let i = 0; i < Math.min(10, allHistory.length - 1); i++) {
        const curr = allHistory[i];
        const prev = allHistory[i + 1];
        const priceUp = curr.close > prev.close;
        const volUp = curr.volume > prev.volume;
        if (priceUp && !volUp)
          divergences.push({
            date: curr.date,
            type: "Bearish Divergence (Price ↑ Volume ↓)",
            close: curr.close,
            volume: curr.volume,
          });
        else if (!priceUp && volUp)
          divergences.push({
            date: curr.date,
            type: "Potential Reversal (Price ↓ Volume ↑)",
            close: curr.close,
            volume: curr.volume,
          });
      }

      // Money flow analysis from historical data
      const moneyFlowIn = allHistory
        .slice(0, 20)
        .filter((d) => d.change_percentage > 0)
        .reduce((s, d) => s + (d.value || 0), 0);
      const moneyFlowOut = allHistory
        .slice(0, 20)
        .filter((d) => d.change_percentage < 0)
        .reduce((s, d) => s + (d.value || 0), 0);
      const mfRatio =
        moneyFlowOut > 0 ? (moneyFlowIn / moneyFlowOut).toFixed(2) : "N/A";

      res.json({
        message: "Bandarmology / Volume Analysis",
        symbol: symbol,
        date: allHistory[0]?.date,
        volume_analysis: {
          today_volume: todayVol,
          avg_20d_volume: Math.round(avg20Vol),
          volume_ratio: volRatio.toFixed(2) + "x",
          signal:
            volRatio > 3
              ? "🚨 EXTREMELY HIGH VOLUME"
              : volRatio > 2
                ? "⚠️ Unusual High Volume"
                : volRatio > 1.5
                  ? "📈 Above Average"
                  : volRatio > 0.5
                    ? "📊 Normal"
                    : "📉 Below Average",
        },
        volume_anomalies: anomalies,
        accumulation_distribution: {
          score: accumulationScore,
          signal: accDistSignal,
          analysis_period: `${recentDays.length} hari terakhir`,
        },
        price_volume_divergence: divergences,
        money_flow: {
          inflow_20d: moneyFlowIn,
          outflow_20d: moneyFlowOut,
          ratio: mfRatio,
          signal:
            parseFloat(mfRatio) > 1.5
              ? "Strong Inflow 🟢"
              : parseFloat(mfRatio) > 1
                ? "Mild Inflow"
                : parseFloat(mfRatio) > 0.5
                  ? "Mild Outflow"
                  : "Strong Outflow 🔴",
        },
        daily_detail: allHistory.slice(0, 10).map((d) => ({
          date: d.date,
          close: d.close,
          volume: d.volume,
          value: d.value,
          net_foreign: d.net_foreign,
          change_pct: d.change_percentage,
        })),
      });
    } catch (e) {
      res
        .status(500)
        .json({ error: "Failed to analyze bandarmology", details: e.message });
    }
  },
);

// ==================== PERFORMANCE ANALYSIS (Multi-Period Returns) ====================

app.get("/analysis/performance/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    // Fetch maximum historical data (22 pages ≈ 264 days ≈ 1 year)
    let allHistory = [];
    for (let page = 1; page <= 22; page++) {
      const response = await axios.get(
        `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
        { headers },
      );
      const pageData = response.data?.data?.result || [];
      allHistory = allHistory.concat(pageData);
      if (!response.data?.data?.paginate?.next_page) break;
    }

    if (allHistory.length < 5)
      return res.status(400).json({ error: "Not enough historical data" });

    const todayPrice = allHistory[0]?.close || 0;

    // Calculate returns for different periods
    const calcReturn = (daysAgo) => {
      const target = allHistory[Math.min(daysAgo, allHistory.length - 1)];
      if (!target || !target.close) return null;
      return {
        from_price: target.close,
        from_date: target.date,
        return_pct:
          (((todayPrice - target.close) / target.close) * 100).toFixed(2) + "%",
        return_rp: todayPrice - target.close,
      };
    };

    // YTD calculation
    const currentYear = new Date().getFullYear();
    const ytdEntry =
      allHistory.find((d) => new Date(d.date).getFullYear() < currentYear) ||
      allHistory[allHistory.length - 1];
    const ytdReturn = ytdEntry
      ? {
          from_price: ytdEntry.close,
          from_date: ytdEntry.date,
          return_pct:
            (((todayPrice - ytdEntry.close) / ytdEntry.close) * 100).toFixed(
              2,
            ) + "%",
          return_rp: todayPrice - ytdEntry.close,
        }
      : null;

    // Max Drawdown from peak
    let peak = 0;
    let maxDrawdown = 0;
    let maxDrawdownDate = "";
    const reversed = [...allHistory].reverse();
    for (const d of reversed) {
      if (d.close > peak) peak = d.close;
      const dd = ((d.close - peak) / peak) * 100;
      if (dd < maxDrawdown) {
        maxDrawdown = dd;
        maxDrawdownDate = d.date;
      }
    }

    // Win rate (days with positive returns)
    let greenDays = 0,
      redDays = 0;
    for (const d of allHistory) {
      if (d.change_percentage > 0) greenDays++;
      else if (d.change_percentage < 0) redDays++;
    }
    const winRate =
      allHistory.length > 0
        ? ((greenDays / allHistory.length) * 100).toFixed(1)
        : 0;

    // Best/Worst days
    const bestDay = allHistory.reduce(
      (best, d) =>
        d.change_percentage > (best?.change_percentage || -999) ? d : best,
      allHistory[0],
    );
    const worstDay = allHistory.reduce(
      (worst, d) =>
        d.change_percentage < (worst?.change_percentage || 999) ? d : worst,
      allHistory[0],
    );

    // Average daily return
    const avgDailyReturn =
      allHistory.length > 0
        ? (
            allHistory.reduce((s, d) => s + (d.change_percentage || 0), 0) /
            allHistory.length
          ).toFixed(3)
        : 0;

    res.json({
      message: "Performance Analysis",
      symbol: symbol,
      current_price: todayPrice,
      date: allHistory[0]?.date,
      data_points: allHistory.length + " trading days",
      returns: {
        "1_week": calcReturn(5),
        "2_weeks": calcReturn(10),
        "1_month": calcReturn(22),
        "3_months": calcReturn(66),
        "6_months": calcReturn(132),
        "1_year": calcReturn(allHistory.length - 1),
        YTD: ytdReturn,
      },
      statistics: {
        green_days: greenDays,
        red_days: redDays,
        win_rate: winRate + "%",
        avg_daily_return: avgDailyReturn + "%",
        best_day: {
          date: bestDay?.date,
          change: bestDay?.change_percentage + "%",
          close: bestDay?.close,
        },
        worst_day: {
          date: worstDay?.date,
          change: worstDay?.change_percentage + "%",
          close: worstDay?.close,
        },
      },
      drawdown: {
        max_drawdown: maxDrawdown.toFixed(2) + "%",
        max_drawdown_date: maxDrawdownDate,
        peak_price: peak,
      },
      high_52w: Math.max(...allHistory.map((d) => d.high || 0)),
      low_52w: Math.min(...allHistory.map((d) => d.low || Infinity)),
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to analyze performance", details: e.message });
  }
});

// ==================== STOCK COMPARISON (Side-by-Side) ====================

app.get("/analysis/comparison/:symbol1/:symbol2", async (req, res) => {
  const { symbol1, symbol2 } = req.params;
  try {
    const baseUrl = `http://localhost:${PORT}/analysis`;

    // Fetch technicals + fundamentals for both stocks in parallel
    const [tech1, tech2, fund1, fund2, flow1, flow2] = await Promise.all([
      axios
        .get(`${baseUrl}/technicals/${symbol1}`)
        .catch((e) => ({ data: { error: e.message } })),
      axios
        .get(`${baseUrl}/technicals/${symbol2}`)
        .catch((e) => ({ data: { error: e.message } })),
      axios
        .get(`${baseUrl}/fundamentals/${symbol1}`)
        .catch((e) => ({ data: { error: e.message } })),
      axios
        .get(`${baseUrl}/fundamentals/${symbol2}`)
        .catch((e) => ({ data: { error: e.message } })),
      axios
        .get(`${baseUrl}/foreign-flow/${symbol1}`)
        .catch((e) => ({ data: { error: e.message } })),
      axios
        .get(`${baseUrl}/foreign-flow/${symbol2}`)
        .catch((e) => ({ data: { error: e.message } })),
    ]);

    const t1 = tech1.data?.indicators || {};
    const t2 = tech2.data?.indicators || {};
    const f1 = fund1.data?.market_summary || {};
    const f2 = fund2.data?.market_summary || {};

    res.json({
      message: `Stock Comparison: ${symbol1} vs ${symbol2}`,
      generated_at: new Date().toISOString(),
      comparison: {
        price: { [symbol1]: tech1.data?.price, [symbol2]: tech2.data?.price },
        sector: {
          [symbol1]: fund1.data?.sector,
          [symbol2]: fund2.data?.sector,
        },
        sub_sector: {
          [symbol1]: fund1.data?.sub_sector,
          [symbol2]: fund2.data?.sub_sector,
        },
        change_pct: { [symbol1]: f1.change_pct, [symbol2]: f2.change_pct },
        volume: { [symbol1]: f1.volume, [symbol2]: f2.volume },
        high_52w: { [symbol1]: f1.high_52w, [symbol2]: f2.high_52w },
        low_52w: { [symbol1]: f1.low_52w, [symbol2]: f2.low_52w },
        volatility: { [symbol1]: f1.volatility, [symbol2]: f2.volatility },
        followers: { [symbol1]: f1.followers, [symbol2]: f2.followers },
        EMA20: { [symbol1]: t1.EMA20, [symbol2]: t2.EMA20 },
        EMA50: { [symbol1]: t1.EMA50, [symbol2]: t2.EMA50 },
        EMA_Trend: { [symbol1]: t1.EMA_Trend, [symbol2]: t2.EMA_Trend },
        RSI_14: { [symbol1]: t1.RSI_14, [symbol2]: t2.RSI_14 },
        RSI_Signal: { [symbol1]: t1.RSI_Signal, [symbol2]: t2.RSI_Signal },
        MACD_Trend: { [symbol1]: t1.MACD_Trend, [symbol2]: t2.MACD_Trend },
        foreign_sentiment: {
          [symbol1]: flow1.data?.sentiment,
          [symbol2]: flow2.data?.sentiment,
        },
      },
      verdict: {
        technical_edge: t1.RSI_14 > t2.RSI_14 ? symbol1 : symbol2,
        momentum:
          t1.EMA_Trend === "Bullish Trend ↗" &&
          t2.EMA_Trend !== "Bullish Trend ↗"
            ? symbol1
            : t2.EMA_Trend === "Bullish Trend ↗" &&
                t1.EMA_Trend !== "Bullish Trend ↗"
              ? symbol2
              : "Draw",
      },
      raw: {
        [symbol1]: {
          technicals: tech1.data,
          fundamentals: fund1.data,
          foreign_flow: flow1.data,
        },
        [symbol2]: {
          technicals: tech2.data,
          fundamentals: fund2.data,
          foreign_flow: flow2.data,
        },
      },
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to compare stocks", details: e.message });
  }
});

// ==================== STOCK SCREENER (Filter by Criteria) ====================

app.get("/analysis/screening", async (req, res) => {
  try {
    // Default watchlist of popular IDX stocks to screen
    const defaultSymbols = req.query.symbols
      ? req.query.symbols.split(",")
      : [
          "BBCA",
          "BBRI",
          "BMRI",
          "TLKM",
          "ASII",
          "UNVR",
          "BBNI",
          "ICBP",
          "INDF",
          "GOTO",
        ];

    const baseUrl = `http://localhost:${PORT}/analysis`;
    const results = [];

    for (const symbol of defaultSymbols) {
      try {
        const [techRes, fundRes, flowRes] = await Promise.all([
          axios
            .get(`${baseUrl}/technicals/${symbol}`)
            .catch(() => ({ data: {} })),
          axios
            .get(`${baseUrl}/fundamentals/${symbol}`)
            .catch(() => ({ data: {} })),
          axios
            .get(`${baseUrl}/foreign-flow/${symbol}`)
            .catch(() => ({ data: {} })),
        ]);

        const tech = techRes.data?.indicators || {};
        const fund = fundRes.data || {};
        const flow = flowRes.data || {};

        results.push({
          symbol: symbol,
          name: fund.company_name || symbol,
          price: techRes.data?.price || 0,
          sector: fund.sector || "N/A",
          RSI: tech.RSI_14 || 50,
          RSI_Signal: tech.RSI_Signal || "N/A",
          EMA_Trend: tech.EMA_Trend || "N/A",
          MACD_Trend: tech.MACD_Trend || "N/A",
          change_pct: fund.market_summary?.change_pct || 0,
          foreign_sentiment: flow.sentiment || "N/A",
          volume: fund.market_summary?.volume || 0,
        });
      } catch {
        /* skip failed symbols */
      }
    }

    // Apply filters from query params
    let filtered = results;
    if (req.query.rsi_below)
      filtered = filtered.filter(
        (r) => r.RSI < parseFloat(req.query.rsi_below),
      );
    if (req.query.rsi_above)
      filtered = filtered.filter(
        (r) => r.RSI > parseFloat(req.query.rsi_above),
      );
    if (req.query.trend)
      filtered = filtered.filter((r) =>
        r.EMA_Trend.toLowerCase().includes(req.query.trend.toLowerCase()),
      );
    if (req.query.foreign)
      filtered = filtered.filter((r) =>
        r.foreign_sentiment
          .toLowerCase()
          .includes(req.query.foreign.toLowerCase()),
      );

    // Sort results
    const sortBy = req.query.sort || "RSI";
    filtered.sort((a, b) => (a[sortBy] || 0) - (b[sortBy] || 0));

    res.json({
      message: "Stock Screener",
      screened: filtered.length,
      total_analyzed: results.length,
      filters_applied: {
        rsi_below: req.query.rsi_below || null,
        rsi_above: req.query.rsi_above || null,
        trend: req.query.trend || null,
        foreign: req.query.foreign || null,
        sort: sortBy,
      },
      usage_hint:
        "Add ?symbols=BBCA,BBRI&rsi_below=30&trend=bullish&foreign=buy&sort=RSI",
      results: filtered,
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to screen stocks", details: e.message });
  }
});

// ==================== WATCHLIST REPORT (Bulk Analysis) ====================

app.get(
  "/analysis/watchlist-report",
  createConcurrencyLimiter(4),
  createRouteCache(CACHE_TTL_HEAVY_MS),
  async (req, res) => {
    try {
      const headers = {
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Origin: "https://stockbit.com",
        Referer: "https://stockbit.com/",
        Authorization: `Bearer ${stockbitToken}`,
      };

      // Fetch user's actual watchlist from Stockbit
      const watchlistRes = await axios.get(
        "https://exodus.stockbit.com/watchlist",
        { headers },
      );
      const watchlistData = watchlistRes.data?.data || {};

      // Extract symbols from watchlist
      const watchlists = watchlistData.watchlists || watchlistData || [];
      let symbols = [];
      if (Array.isArray(watchlists)) {
        for (const wl of watchlists) {
          const items = wl.items || wl.symbols || [];
          for (const item of items) {
            const sym = item.symbol || item.company_symbol || item;
            if (typeof sym === "string" && sym.length > 0 && sym.length <= 6) {
              symbols.push(sym);
            }
          }
        }
      }

      if (symbols.length === 0) {
        return res.json({
          message: "No symbols found in watchlist",
          watchlist_raw: watchlistData,
        });
      }

      // Analyze each symbol using our technicals endpoint
      const baseUrl = `http://localhost:${PORT}/analysis`;
      const analyses = [];

      for (const symbol of symbols.slice(0, 20)) {
        // Limit to 20 to avoid rate limits
        try {
          const [techRes, fundRes] = await Promise.all([
            axios
              .get(`${baseUrl}/technicals/${symbol}`)
              .catch(() => ({ data: {} })),
            axios
              .get(`${baseUrl}/fundamentals/${symbol}`)
              .catch(() => ({ data: {} })),
          ]);

          analyses.push({
            symbol: symbol,
            name: fundRes.data?.company_name || symbol,
            price: techRes.data?.price || 0,
            RSI: techRes.data?.indicators?.RSI_14 || "N/A",
            EMA_Trend: techRes.data?.indicators?.EMA_Trend || "N/A",
            MACD_Trend: techRes.data?.indicators?.MACD_Trend || "N/A",
            change_pct: fundRes.data?.market_summary?.change_pct || 0,
            sector: fundRes.data?.sector || "N/A",
          });
        } catch {
          /* skip */
        }
      }

      // Summary statistics
      const bullish = analyses.filter((a) =>
        a.EMA_Trend?.includes("Bullish"),
      ).length;
      const bearish = analyses.filter((a) =>
        a.EMA_Trend?.includes("Bearish"),
      ).length;
      const oversold = analyses.filter(
        (a) => typeof a.RSI === "number" && a.RSI < 30,
      ).length;
      const overbought = analyses.filter(
        (a) => typeof a.RSI === "number" && a.RSI > 70,
      ).length;

      res.json({
        message: "Watchlist Report",
        generated_at: new Date().toISOString(),
        total_stocks: analyses.length,
        summary: {
          bullish_trend: bullish,
          bearish_trend: bearish,
          oversold_rsi: oversold,
          overbought_rsi: overbought,
          market_mood:
            bullish > bearish
              ? "🟢 Mostly Bullish"
              : bearish > bullish
                ? "🔴 Mostly Bearish"
                : "⚖️ Mixed",
        },
        stocks: analyses,
      });
    } catch (e) {
      res.status(500).json({
        error: "Failed to generate watchlist report",
        details: e.message,
      });
    }
  },
);

// ==================== RISK METRICS (Beta, Sharpe, VaR) ====================

app.get("/analysis/risk/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    // Fetch historical data for risk calculation
    let allHistory = [];
    for (let page = 1; page <= 10; page++) {
      const response = await axios.get(
        `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
        { headers },
      );
      const pageData = response.data?.data?.result || [];
      allHistory = allHistory.concat(pageData);
      if (!response.data?.data?.paginate?.next_page) break;
    }

    if (allHistory.length < 10)
      return res
        .status(400)
        .json({ error: "Not enough data for risk analysis" });

    // Calculate daily returns
    const returns = [];
    for (let i = 0; i < allHistory.length - 1; i++) {
      if (allHistory[i + 1].close > 0) {
        returns.push(
          (allHistory[i].close - allHistory[i + 1].close) /
            allHistory[i + 1].close,
        );
      }
    }

    // Mean return
    const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;

    // Standard deviation (volatility)
    const variance =
      returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) /
      returns.length;
    const stdDev = Math.sqrt(variance);
    const annualizedVol = (stdDev * Math.sqrt(252) * 100).toFixed(2);

    // Sharpe Ratio (risk-free rate ~4% IDR government bonds)
    const riskFreeDaily = 0.04 / 252;
    const sharpeRatio =
      stdDev > 0
        ? (((meanReturn - riskFreeDaily) / stdDev) * Math.sqrt(252)).toFixed(3)
        : 0;

    // Value at Risk (95% confidence, 1-day)
    const var95 = (meanReturn - 1.645 * stdDev) * 100;
    const var99 = (meanReturn - 2.326 * stdDev) * 100;

    // Max Drawdown
    let peak = 0;
    let maxDrawdown = 0;
    let ddStart = "",
      ddEnd = "";
    const reversed = [...allHistory].reverse();
    for (const d of reversed) {
      if (d.close > peak) {
        peak = d.close;
        ddStart = d.date;
      }
      const dd = ((d.close - peak) / peak) * 100;
      if (dd < maxDrawdown) {
        maxDrawdown = dd;
        ddEnd = d.date;
      }
    }

    // Sortino Ratio (only downside deviation)
    const negReturns = returns.filter((r) => r < 0);
    const downsideVar =
      negReturns.length > 0
        ? negReturns.reduce((s, r) => s + Math.pow(r, 2), 0) / negReturns.length
        : 0;
    const downsideDev = Math.sqrt(downsideVar);
    const sortinoRatio =
      downsideDev > 0
        ? (
            ((meanReturn - riskFreeDaily) / downsideDev) *
            Math.sqrt(252)
          ).toFixed(3)
        : 0;

    // Calmar Ratio (annualized return / max drawdown)
    const annReturn = meanReturn * 252 * 100;
    const calmarRatio =
      maxDrawdown !== 0 ? (annReturn / Math.abs(maxDrawdown)).toFixed(3) : 0;

    // Risk classification
    const riskLevel =
      parseFloat(annualizedVol) > 40
        ? "🔴 Very High Risk"
        : parseFloat(annualizedVol) > 25
          ? "🟠 High Risk"
          : parseFloat(annualizedVol) > 15
            ? "🟡 Medium Risk"
            : "🟢 Low Risk";

    res.json({
      message: "Risk Metrics Analysis",
      symbol: symbol,
      date: allHistory[0]?.date,
      data_points: allHistory.length + " trading days",
      risk_level: riskLevel,
      volatility: {
        daily: (stdDev * 100).toFixed(3) + "%",
        annualized: annualizedVol + "%",
      },
      ratios: {
        sharpe_ratio: parseFloat(sharpeRatio),
        sharpe_interpretation:
          parseFloat(sharpeRatio) > 1
            ? "Good risk-adjusted return"
            : parseFloat(sharpeRatio) > 0
              ? "Positive but below market"
              : "Negative risk-adjusted return",
        sortino_ratio: parseFloat(sortinoRatio),
        calmar_ratio: parseFloat(calmarRatio),
      },
      value_at_risk: {
        var_95_1day: var95.toFixed(3) + "%",
        var_99_1day: var99.toFixed(3) + "%",
        meaning_95: `On 95% of days, daily loss will not exceed ${Math.abs(var95).toFixed(2)}%`,
        meaning_99: `On 99% of days, daily loss will not exceed ${Math.abs(var99).toFixed(2)}%`,
      },
      drawdown: {
        max_drawdown: maxDrawdown.toFixed(2) + "%",
        peak_price: peak,
        drawdown_period: `${ddStart} to ${ddEnd}`,
      },
      returns: {
        mean_daily: (meanReturn * 100).toFixed(4) + "%",
        annualized: annReturn.toFixed(2) + "%",
        best_day: (Math.max(...returns) * 100).toFixed(2) + "%",
        worst_day: (Math.min(...returns) * 100).toFixed(2) + "%",
      },
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to calculate risk metrics", details: e.message });
  }
});

// ==================== CANDLESTICK PATTERN RECOGNITION ====================

app.get("/analysis/candlestick/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    // Fetch 3 pages for pattern recognition
    let allHistory = [];
    for (let page = 1; page <= 3; page++) {
      const response = await axios.get(
        `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
        { headers },
      );
      const pageData = response.data?.data?.result || [];
      allHistory = allHistory.concat(pageData);
      if (!response.data?.data?.paginate?.next_page) break;
    }

    if (allHistory.length < 5)
      return res.status(400).json({ error: "Not enough data" });

    // Reverse to ascending order
    const asc = [...allHistory].reverse();
    const ohlc = {
      open: asc.map((d) => d.open),
      high: asc.map((d) => d.high),
      low: asc.map((d) => d.low),
      close: asc.map((d) => d.close),
    };

    // Define all candlestick pattern checkers
    const patternChecks = [
      {
        name: "Bullish Engulfing",
        fn: "bullishengulfingpattern",
        type: "bullish",
      },
      {
        name: "Bearish Engulfing",
        fn: "bearishengulfingpattern",
        type: "bearish",
      },
      { name: "Doji", fn: "doji", type: "neutral" },
      { name: "Hammer", fn: "hammerpattern", type: "bullish" },
      { name: "Hanging Man", fn: "hangingman", type: "bearish" },
      { name: "Morning Star", fn: "morningstar", type: "bullish" },
      { name: "Evening Star", fn: "eveningstar", type: "bearish" },
      {
        name: "Three White Soldiers",
        fn: "threewhitesoldiers",
        type: "bullish",
      },
      { name: "Three Black Crows", fn: "threeblackcrows", type: "bearish" },
      { name: "Bullish Harami", fn: "bullishharami", type: "bullish" },
      { name: "Bearish Harami", fn: "bearishharami", type: "bearish" },
      { name: "Dark Cloud Cover", fn: "darkcloudcover", type: "bearish" },
      { name: "Piercing Line", fn: "piercingline", type: "bullish" },
      { name: "Bullish Marubozu", fn: "bullishmarubozu", type: "bullish" },
      { name: "Bearish Marubozu", fn: "bearishmarubozu", type: "bearish" },
      { name: "Dragonfly Doji", fn: "dragonflydoji", type: "bullish" },
      { name: "Gravestone Doji", fn: "gravestonedoji", type: "bearish" },
      { name: "Shooting Star", fn: "shootingstar", type: "bearish" },
      { name: "Tweezer Top", fn: "tweezertop", type: "bearish" },
      { name: "Tweezer Bottom", fn: "tweezerbottom", type: "bullish" },
      {
        name: "Bullish Spinning Top",
        fn: "bullishspinningtop",
        type: "neutral",
      },
      {
        name: "Bearish Spinning Top",
        fn: "bearishspinningtop",
        type: "neutral",
      },
      { name: "Abandoned Baby", fn: "abandonedbaby", type: "reversal" },
      { name: "Morning Doji Star", fn: "morningdojistar", type: "bullish" },
      { name: "Evening Doji Star", fn: "eveningdojistar", type: "bearish" },
    ];

    const detected = [];
    for (const check of patternChecks) {
      try {
        if (typeof candlesticks[check.fn] === "function") {
          const result = candlesticks[check.fn](ohlc);
          if (
            result === true ||
            (Array.isArray(result) && result[result.length - 1] === true)
          ) {
            detected.push({
              pattern: check.name,
              type: check.type,
              signal:
                check.type === "bullish"
                  ? "🟢 Bullish Signal"
                  : check.type === "bearish"
                    ? "🔴 Bearish Signal"
                    : "⚪ Neutral",
            });
          }
        }
      } catch {
        /* pattern check failed, skip */
      }
    }

    // Overall signal based on pattern counts
    const bullishCount = detected.filter((d) => d.type === "bullish").length;
    const bearishCount = detected.filter((d) => d.type === "bearish").length;

    res.json({
      message: "Candlestick Pattern Recognition",
      symbol: symbol,
      date: allHistory[0]?.date,
      patterns_checked: patternChecks.length,
      patterns_detected: detected.length,
      overall_signal:
        bullishCount > bearishCount
          ? "🟢 Bullish Patterns Dominant"
          : bearishCount > bullishCount
            ? "🔴 Bearish Patterns Dominant"
            : "⚖️ Mixed / Neutral",
      bullish_patterns: bullishCount,
      bearish_patterns: bearishCount,
      detected_patterns: detected,
      latest_candle: {
        date: allHistory[0]?.date,
        open: allHistory[0]?.open,
        high: allHistory[0]?.high,
        low: allHistory[0]?.low,
        close: allHistory[0]?.close,
        volume: allHistory[0]?.volume,
        body_type:
          allHistory[0]?.close > allHistory[0]?.open
            ? "Green (Bullish)"
            : "Red (Bearish)",
      },
    });
  } catch (e) {
    res.status(500).json({
      error: "Failed to analyze candlestick patterns",
      details: e.message,
    });
  }
});

// ==================== GOLDEN CROSS / DEATH CROSS DETECTION ====================

app.get("/analysis/crossover/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    // Need lots of data for 50/200 SMA crossover
    let allHistory = [];
    for (let page = 1; page <= 22; page++) {
      const response = await axios.get(
        `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
        { headers },
      );
      const pageData = response.data?.data?.result || [];
      allHistory = allHistory.concat(pageData);
      if (!response.data?.data?.paginate?.next_page) break;
    }

    if (allHistory.length < 50)
      return res
        .status(400)
        .json({ error: "Not enough data for crossover analysis" });

    const asc = [...allHistory].reverse();
    const closes = asc.map((d) => d.close);

    // Calculate multiple MAs
    const ema20 = EMA.calculate({ period: 20, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const sma50 = SMA.calculate({ period: 50, values: closes });
    const sma200 =
      closes.length >= 200
        ? SMA.calculate({ period: 200, values: closes })
        : [];

    // Detect EMA 20/50 crossovers
    const ema2050Crosses = [];
    const ema20Aligned = ema20.slice(ema20.length - ema50.length);
    for (let i = 1; i < ema50.length && i < ema20Aligned.length; i++) {
      const prevAbove = ema20Aligned[i - 1] > ema50[i - 1];
      const currAbove = ema20Aligned[i] > ema50[i];
      if (prevAbove !== currAbove) {
        const idx = asc.length - ema50.length + i;
        ema2050Crosses.push({
          date: asc[idx]?.date || "Unknown",
          type: currAbove
            ? "🟢 Golden Cross (EMA20 ↗ crosses above EMA50)"
            : "🔴 Death Cross (EMA20 ↘ crosses below EMA50)",
          price: asc[idx]?.close || 0,
        });
      }
    }

    // Detect SMA 50/200 crossovers (if enough data)
    const sma50200Crosses = [];
    if (sma200.length > 1) {
      const sma50Aligned = sma50.slice(sma50.length - sma200.length);
      for (let i = 1; i < sma200.length && i < sma50Aligned.length; i++) {
        const prevAbove = sma50Aligned[i - 1] > sma200[i - 1];
        const currAbove = sma50Aligned[i] > sma200[i];
        if (prevAbove !== currAbove) {
          const idx = asc.length - sma200.length + i;
          sma50200Crosses.push({
            date: asc[idx]?.date || "Unknown",
            type: currAbove
              ? "🟢 MAJOR Golden Cross (SMA50 ↗ crosses above SMA200)"
              : "🔴 MAJOR Death Cross (SMA50 ↘ crosses below SMA200)",
            price: asc[idx]?.close || 0,
          });
        }
      }
    }

    // Current status
    const latestEma20 = ema20[ema20.length - 1];
    const latestEma50 = ema50[ema50.length - 1];
    const latestSma50 = sma50[sma50.length - 1];
    const latestSma200 = sma200.length > 0 ? sma200[sma200.length - 1] : null;

    res.json({
      message: "Golden Cross / Death Cross Detection",
      symbol: symbol,
      date: allHistory[0]?.date,
      data_points: allHistory.length + " trading days",
      current_status: {
        price: allHistory[0]?.close,
        EMA20: Math.round(latestEma20),
        EMA50: Math.round(latestEma50),
        SMA50: Math.round(latestSma50),
        SMA200: latestSma200 ? Math.round(latestSma200) : "Insufficient data",
        ema20_vs_ema50:
          latestEma20 > latestEma50
            ? "🟢 EMA20 above EMA50 (Bullish)"
            : "🔴 EMA20 below EMA50 (Bearish)",
        sma50_vs_sma200: latestSma200
          ? latestSma50 > latestSma200
            ? "🟢 SMA50 above SMA200 (Bullish)"
            : "🔴 SMA50 below SMA200 (Bearish)"
          : "N/A",
      },
      ema_20_50_crossovers: ema2050Crosses.reverse().slice(0, 10),
      sma_50_200_crossovers: sma50200Crosses.reverse().slice(0, 5),
      latest_signal:
        ema2050Crosses.length > 0
          ? ema2050Crosses[0]
          : "No recent crossover detected",
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to detect crossovers", details: e.message });
  }
});

// ==================== SECTOR HEATMAP ====================

app.get(
  "/analysis/sector-heatmap/:sector",
  createConcurrencyLimiter(6),
  createRouteCache(CACHE_TTL_HEAVY_MS),
  async (req, res) => {
    const sectorQuery = req.params.sector.toLowerCase();
    try {
      // Map sector names to symbol groups
      const sectorMap = {
        bank: [
          "BBCA",
          "BBRI",
          "BMRI",
          "BBNI",
          "BRIS",
          "BTPS",
          "MEGA",
          "NISP",
          "BNGA",
          "BDMN",
        ],
        keuangan: [
          "BBCA",
          "BBRI",
          "BMRI",
          "BBNI",
          "BRIS",
          "BTPS",
          "MEGA",
          "NISP",
          "BNGA",
          "BDMN",
        ],
        finance: [
          "BBCA",
          "BBRI",
          "BMRI",
          "BBNI",
          "BRIS",
          "BTPS",
          "MEGA",
          "NISP",
          "BNGA",
          "BDMN",
        ],
        consumer: [
          "UNVR",
          "ICBP",
          "INDF",
          "MYOR",
          "KLBF",
          "HMSP",
          "GGRM",
          "SIDO",
          "CPIN",
          "ULTJ",
        ],
        teknologi: ["GOTO", "BUKA", "EMTK", "DCII", "MTDL"],
        tech: ["GOTO", "BUKA", "EMTK", "DCII", "MTDL"],
        mining: [
          "ADRO",
          "PTBA",
          "ITMG",
          "MDKA",
          "ANTM",
          "INCO",
          "TINS",
          "UNTR",
        ],
        tambang: [
          "ADRO",
          "PTBA",
          "ITMG",
          "MDKA",
          "ANTM",
          "INCO",
          "TINS",
          "UNTR",
        ],
        property: ["BSDE", "CTRA", "SMRA", "PWON", "LPKR", "DMAS"],
        properti: ["BSDE", "CTRA", "SMRA", "PWON", "LPKR", "DMAS"],
        telco: ["TLKM", "EXCL", "ISAT", "FREN", "TOWR", "MTEL"],
        telekomunikasi: ["TLKM", "EXCL", "ISAT", "FREN", "TOWR", "MTEL"],
        infra: ["JSMR", "WIKA", "WSKT", "PTPP", "ADHI", "WTON"],
        infrastruktur: ["JSMR", "WIKA", "WSKT", "PTPP", "ADHI", "WTON"],
        bluechip: [
          "BBCA",
          "BBRI",
          "BMRI",
          "TLKM",
          "ASII",
          "UNVR",
          "BBNI",
          "ICBP",
          "INDF",
          "KLBF",
        ],
        lq45: [
          "BBCA",
          "BBRI",
          "BMRI",
          "TLKM",
          "ASII",
          "UNVR",
          "BBNI",
          "ICBP",
          "INDF",
          "GOTO",
          "ADRO",
          "CPIN",
          "MDKA",
          "TOWR",
          "KLBF",
        ],
      };

      const symbols = sectorMap[sectorQuery] || sectorMap["bluechip"];
      const baseUrl = `http://localhost:${PORT}/analysis`;
      const results = [];

      for (const symbol of symbols) {
        try {
          const [techRes, fundRes] = await Promise.all([
            axios
              .get(`${baseUrl}/technicals/${symbol}`, { timeout: 10000 })
              .catch(() => ({ data: {} })),
            axios
              .get(`${baseUrl}/fundamentals/${symbol}`, { timeout: 10000 })
              .catch(() => ({ data: {} })),
          ]);

          results.push({
            symbol: symbol,
            name: fundRes.data?.company_name || symbol,
            price: techRes.data?.price || 0,
            change_pct: fundRes.data?.market_summary?.change_pct || 0,
            RSI: techRes.data?.indicators?.RSI_14 || 0,
            EMA_Trend: techRes.data?.indicators?.EMA_Trend || "N/A",
            MACD_Trend: techRes.data?.indicators?.MACD_Trend || "N/A",
            heat:
              (fundRes.data?.market_summary?.change_pct || 0) > 2
                ? "🟢🟢 Hot"
                : (fundRes.data?.market_summary?.change_pct || 0) > 0
                  ? "🟢 Warm"
                  : (fundRes.data?.market_summary?.change_pct || 0) > -2
                    ? "🔴 Cool"
                    : "🔴🔴 Cold",
          });
        } catch {
          /* skip */
        }
      }

      // Sort by change_pct (best performers first)
      results.sort((a, b) => (b.change_pct || 0) - (a.change_pct || 0));

      const avgChange =
        results.length > 0
          ? (
              results.reduce((s, r) => s + (r.change_pct || 0), 0) /
              results.length
            ).toFixed(2)
          : 0;

      res.json({
        message: `Sector Heatmap: ${sectorQuery.toUpperCase()}`,
        sector: sectorQuery,
        stocks_analyzed: results.length,
        sector_avg_change: avgChange + "%",
        sector_mood:
          parseFloat(avgChange) > 1
            ? "🟢 Sector Bullish"
            : parseFloat(avgChange) < -1
              ? "🔴 Sector Bearish"
              : "⚖️ Sector Neutral",
        best_performer: results[0] || null,
        worst_performer: results[results.length - 1] || null,
        available_sectors: Object.keys(sectorMap).join(", "),
        heatmap: results,
      });
    } catch (e) {
      res.status(500).json({
        error: "Failed to generate sector heatmap",
        details: e.message,
      });
    }
  },
);

// ==================== ADVANCED MATRIX TA (PURE JS - PANDAS ALTERNATIVE) ====================

app.get(
  "/analysis/advanced-ta/:symbol",
  createConcurrencyLimiter(6),
  createRouteCache(CACHE_TTL_HEAVY_MS),
  async (req, res) => {
    const symbol = req.params.symbol;
    try {
      const headers = {
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Origin: "https://stockbit.com",
        Referer: "https://stockbit.com/",
        Authorization: `Bearer ${stockbitToken}`,
      };

      // Fetch extensive historical data to build our 'DataFrame'-like structure
      let allHistory = [];
      for (let page = 1; page <= 5; page++) {
        const response = await axios.get(
          `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
          { headers },
        );
        const pageData = response.data?.data?.result || [];
        allHistory = allHistory.concat(pageData);
        if (!response.data?.data?.paginate?.next_page) break;
      }

      if (allHistory.length < 30)
        return res
          .status(400)
          .json({ error: "Not enough data for Advanced TA matrix" });

      // Clean & reverse to temporal order (oldest -> newest) for accurate rolling math
      const df = [...allHistory].reverse();

      // Pandas-style Column Extraction
      const closeSeries = df.map((row) => row.close);
      const dates = df.map((row) => row.date);

      // Calculate Daily Returns (Pandas: `pctChange().mul(100)`)
      const returns = [0]; // First day has 0% return
      for (let i = 1; i < closeSeries.length; i++) {
        const prev = closeSeries[i - 1];
        const curr = closeSeries[i];
        returns.push(prev > 0 ? ((curr - prev) / prev) * 100 : 0);
      }

      // Rolling Window Volatility (20-day standard deviation)
      const volatility20d = [...Array(19).fill(0)];
      for (let i = 19; i < returns.length; i++) {
        const window = returns.slice(i - 19, i + 1);
        const mean = window.reduce((a, b) => a + b, 0) / 20;
        const variance =
          window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
        volatility20d.push(Math.sqrt(variance));
      }

      // Native Technical Indicators mapping
      const sma10 = SMA.calculate({ period: 10, values: closeSeries });
      const sma30 = SMA.calculate({ period: 30, values: closeSeries });

      // Align arrays to the most recent day (latestRowIndex)
      const latestIdx = closeSeries.length - 1;
      const latestClose = closeSeries[latestIdx];
      const latestReturn = returns[latestIdx];
      const latestVol20 = volatility20d[latestIdx];

      const latestSma10 = sma10[sma10.length - 1];
      const latestSma30 = sma30[sma30.length - 1];

      // Generate Statistical Summary (Pandas `.describe()`)
      const meanClose =
        closeSeries.reduce((a, b) => a + b, 0) / closeSeries.length;
      const minClose = Math.min(...closeSeries);
      const maxClose = Math.max(...closeSeries);
      const stdClose = Math.sqrt(
        closeSeries.reduce((a, b) => a + Math.pow(b - meanClose, 2), 0) /
          closeSeries.length,
      );

      res.json({
        message: "Pure Node.js High-Performance Analysis (Pandas Alternative)",
        symbol: symbol,
        engine: "V8 JavaScript JIT Vectorization",
        dataframe_shape: `Rows: ${closeSeries.length}, Simulated Columns: 6`,
        latest_metrics: {
          date: dates[latestIdx],
          close: latestClose,
          daily_return_pct: latestReturn.toFixed(2) + "%",
          rolling_volatility_20d: latestVol20.toFixed(2) + "%",
          SMA_10: latestSma10.toFixed(0),
          SMA_30: latestSma30.toFixed(0),
          crossover_signal:
            latestSma10 > latestSma30
              ? "🟢 Buy (Short-term > Mid-term)"
              : "🔴 Sell (Short-term < Mid-term)",
        },
        statistical_summary: {
          mean_close: meanClose.toFixed(2),
          std_close: stdClose.toFixed(2),
          min_close: minClose.toFixed(2),
          max_close: maxClose.toFixed(2),
        },
      });
    } catch (e) {
      res.status(500).json({
        error: "Advanced TA DataFrame simulation failed",
        details: e.message,
      });
    }
  },
);

// ==================== CORRELATION MATRIX ====================

app.get("/analysis/correlation", async (req, res) => {
  try {
    const symbolsParam = req.query.symbols || "BBCA,BBRI,BMRI,TLKM,ASII";
    const symbols = symbolsParam.split(",").slice(0, 8); // Max 8 stocks

    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    // Fetch historical data for each symbol (3 pages = ~36 days)
    const stockData = {};
    for (const symbol of symbols) {
      try {
        let history = [];
        for (let page = 1; page <= 3; page++) {
          const response = await axios.get(
            `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
            { headers },
          );
          const pageData = response.data?.data?.result || [];
          history = history.concat(pageData);
          if (!response.data?.data?.paginate?.next_page) break;
        }
        // Calculate daily returns
        const returns = [];
        for (let i = 0; i < history.length - 1; i++) {
          if (history[i + 1].close > 0) {
            returns.push(
              (history[i].close - history[i + 1].close) / history[i + 1].close,
            );
          }
        }
        stockData[symbol] = returns;
      } catch {
        /* skip */
      }
    }

    // Calculate Pearson correlation between all pairs
    const pearson = (x, y) => {
      const n = Math.min(x.length, y.length);
      if (n < 5) return null;
      const xSlice = x.slice(0, n);
      const ySlice = y.slice(0, n);
      const meanX = xSlice.reduce((s, v) => s + v, 0) / n;
      const meanY = ySlice.reduce((s, v) => s + v, 0) / n;
      let num = 0,
        denX = 0,
        denY = 0;
      for (let i = 0; i < n; i++) {
        const dx = xSlice[i] - meanX;
        const dy = ySlice[i] - meanY;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
      }
      const den = Math.sqrt(denX * denY);
      return den > 0 ? parseFloat((num / den).toFixed(4)) : 0;
    };

    const matrix = {};
    const pairs = [];
    const validSymbols = Object.keys(stockData);
    for (const s1 of validSymbols) {
      matrix[s1] = {};
      for (const s2 of validSymbols) {
        const corr = s1 === s2 ? 1.0 : pearson(stockData[s1], stockData[s2]);
        matrix[s1][s2] = corr;
        if (s1 < s2 && corr !== null) {
          pairs.push({
            pair: `${s1} ↔ ${s2}`,
            correlation: corr,
            strength:
              Math.abs(corr) > 0.7
                ? "Strong"
                : Math.abs(corr) > 0.4
                  ? "Moderate"
                  : "Weak",
            direction:
              corr > 0
                ? "Positive (move together)"
                : "Negative (move opposite)",
          });
        }
      }
    }

    pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    res.json({
      message: "Correlation Matrix",
      symbols: validSymbols,
      usage_hint: "Add ?symbols=BBCA,BBRI,BMRI,TLKM,GOTO to customize",
      most_correlated: pairs[0] || null,
      least_correlated: pairs[pairs.length - 1] || null,
      matrix: matrix,
      pairs: pairs,
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to calculate correlation", details: e.message });
  }
});

// ==================== DIVIDEND HISTORY TRACKER ====================

app.get("/analysis/dividends/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Origin: "https://stockbit.com",
      Referer: "https://stockbit.com/",
      Authorization: `Bearer ${stockbitToken}`,
    };

    // Try to fetch corporate action data (dividends are part of corp actions)
    let corpActionData = null;
    try {
      const caRes = await axios.get(
        `https://exodus.stockbit.com/emitten/${symbol}/info`,
        { headers },
      );
      corpActionData = caRes.data?.data?.corp_action || null;
    } catch {
      /* no corp action */
    }

    // Fetch historical to generate approximate dividend yield calculation
    let allHistory = [];
    for (let page = 1; page <= 22; page++) {
      const response = await axios.get(
        `https://exodus.stockbit.com/company-price-feed/historical/summary/${symbol}?page=${page}`,
        { headers },
      );
      const pageData = response.data?.data?.result || [];
      allHistory = allHistory.concat(pageData);
      if (!response.data?.data?.paginate?.next_page) break;
    }

    // Detect possible ex-dividend dates: Look for days with negative gaps that don't match market movement
    const possibleDivDates = [];
    for (let i = 0; i < allHistory.length - 1; i++) {
      const curr = allHistory[i];
      const prev = allHistory[i + 1];
      // Ex-dividend signature: price drops by a fixed amount at open, but volume is normal
      const gap = curr.open - prev.close;
      const gapPct = prev.close > 0 ? (gap / prev.close) * 100 : 0;

      if (gapPct < -1.5 && curr.open < prev.low && curr.volume > 0) {
        possibleDivDates.push({
          date: curr.date,
          gap: gap,
          gap_pct: gapPct.toFixed(2) + "%",
          prev_close: prev.close,
          open: curr.open,
          estimated_div: Math.abs(gap),
          note: "Possible ex-dividend (gap down at open)",
        });
      }
    }

    // Current price and estimated yield
    const currentPrice = allHistory[0]?.close || 0;
    const totalEstDiv = possibleDivDates.reduce(
      (s, d) => s + d.estimated_div,
      0,
    );
    const estYield =
      currentPrice > 0 ? ((totalEstDiv / currentPrice) * 100).toFixed(2) : 0;

    res.json({
      message: "Dividend / Corporate Action Tracker",
      symbol: symbol,
      current_price: currentPrice,
      corporate_action: corpActionData,
      dividend_analysis: {
        possible_ex_dividend_dates: possibleDivDates.length,
        total_estimated_dividend: totalEstDiv,
        estimated_yield: estYield + "%",
        analysis_period: allHistory.length + " trading days",
        note: "Dividend dates are estimated from gap-down patterns. For exact data, refer to IDX announcements.",
      },
      detected_events: possibleDivDates,
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to analyze dividends", details: e.message });
  }
});

// ==================== PROXY MIDDLEWARE ====================

// Determine if a path should be routed to carina.stockbit.com
const isCarinaPath = (path) => {
  return (
    path.startsWith("/portfolio") ||
    path.startsWith("/formula") ||
    path.startsWith("/order/") ||
    path.startsWith("/carina")
  );
};

// Determine if a path needs Securities token (even if on exodus)
// order-trade lives on exodus but needs a token with ACN (trading context)
const needsSecuritiesToken = (path) => {
  return (
    path.startsWith("/portfolio") ||
    path.startsWith("/formula") ||
    path.startsWith("/carina") ||
    path.startsWith("/order/") ||
    path.startsWith("/order-trade")
  );
};

app.use("/proxy", proxyLimiter, async (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/proxy/, "");
  const useCarina = isCarinaPath(targetPath);
  const useSecToken = needsSecuritiesToken(targetPath);
  const baseUrl = useCarina
    ? "https://carina.stockbit.com"
    : "https://exodus.stockbit.com";
  const targetUrl = targetPath;
  let token = useSecToken ? securitiesToken || stockbitToken : stockbitToken;
  const hostHeader = useCarina ? "carina.stockbit.com" : "exodus.stockbit.com";

  if (useSecToken && !securitiesToken) {
    console.warn(
      "⚠️ Securities endpoint requested but no securities token. Falling back to standard token.",
    );
  }

  // Auto-refresh main token if expired
  if (!useCarina && isTokenExpiredOrExpiring()) {
    const refreshed = await ensureFreshToken();
    if (!refreshed && !stockbitToken) {
      return res.status(401).json({
        error:
          "Main Token expired and auto-refresh failed. Login via POST /auth/login",
      });
    }
  }

  // Auto-refresh securities token if expired
  if (
    useSecToken &&
    securitiesToken &&
    securitiesRefreshToken &&
    isSecuritiesTokenExpiredOrExpiring()
  ) {
    try {
      await performSecuritiesRefresh();
      token = securitiesToken; // update the token to be sent
    } catch (e) {
      console.warn("⚠️ Securities auto-refresh failed:", e.message);
    }
  }

  try {
    console.log(
      `\n[PROXY] ${req.method} ${targetPath} -> ${baseUrl} (${useCarina ? "CARINA" : "EXODUS"})`,
    );

    const response = await apiProxy({
      method: req.method,
      url: `${baseUrl}${targetUrl}`,
      data: req.method !== "GET" ? req.body : undefined,
      headers: { Authorization: `Bearer ${token}` },
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    // If 401 on exodus - try auto-refresh and retry once
    if (
      !useCarina &&
      !useSecToken &&
      error.response?.status === 401 &&
      refreshToken
    ) {
      console.log("🔄 Got 401, attempting auto-refresh and retry...");
      const refreshed = await autoRefreshToken();
      if (refreshed) {
        try {
          const retryResponse = await apiProxy({
            method: req.method,
            url: `${baseUrl}${targetUrl}`,
            data: req.method !== "GET" ? req.body : undefined,
            headers: { Authorization: `Bearer ${stockbitToken}` },
          });
          return res.status(retryResponse.status).json(retryResponse.data);
        } catch (retryError) {
          console.error("❌ Retry also failed:", retryError.message);
          if (retryError.response) {
            return res
              .status(retryError.response.status)
              .json(retryError.response.data);
          }
        }
      }
    }

    // If 401 on Carina/Securities - try Securities token auto-refresh
    if (
      useSecToken &&
      error.response?.status === 401 &&
      securitiesRefreshToken
    ) {
      console.log(
        "🔄 Securities endpoint got 401, attempting Securities auto-refresh...",
      );
      try {
        await performSecuritiesRefresh();

        const retryResponse = await apiProxy({
          method: req.method,
          url: `${baseUrl}${targetUrl}`,
          data: req.method !== "GET" ? req.body : undefined,
          headers: { Authorization: `Bearer ${securitiesToken}` },
        });
        return res.status(retryResponse.status).json(retryResponse.data);
      } catch (retryError) {
        console.error("❌ Securities Retry also failed:", retryError.message);
        if (retryError.response) {
          return res
            .status(retryError.response.status)
            .json(retryError.response.data);
        }
      }
    }

    console.error(
      `❌ Proxy error [${req.method} ${baseUrl}${targetUrl}]:`,
      error.message,
    );
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res
        .status(500)
        .json({ error: "Internal Server Error", details: error.message });
    }
  }
});

// ==================== ROOT ====================

app.get("/", (req, res) => {
  const info = stockbitToken ? decodeToken(stockbitToken) : null;
  res.send({
    status: "ok",
    message: "Stockbit Gateway API is running",
    tokenLoaded: !!stockbitToken,
    tokenExpired: info?.isExpired ?? null,
    hasRefreshToken: !!refreshToken,
    autoRefreshEnabled: !!refreshToken,
    endpoints: {
      docs: "/api-docs",
      login: "POST /auth/login",
      setToken: "POST /auth/set-token",
      tokenStatus: "GET /auth/status",
      refresh: "POST /auth/refresh",
      logout: "POST /auth/logout",
      proxy: "/proxy/...",
    },
  });
});

// ==================== GLOBAL ERROR HANDLER MIDDLEWARE ====================
// Must be last middleware, after all other app.use() and routes
app.use((err, req, res, next) => {
  runtimeMetrics.errorCount += 1;
  if (ENABLE_SENTRY) {
    Sentry.captureException(err, {
      tags: { route: req.path, method: req.method },
    });
  }
  const { statusCode, error } = formatErrorResponse(err, 500);
  console.error(
    `❌ [${req.method} ${req.path}] ${error.type}: ${error.message}`,
  );
  res.status(statusCode).json(error);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    type: "NotFound",
    message: `Endpoint ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📖 Swagger UI available at http://localhost:${PORT}/api-docs`);
});
