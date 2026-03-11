const API = "";
const pageNames = ["dashboard", "analysis", "sector", "correlation"];
const WATCHLIST_KEY = "stokbitapi.watchlist";
const DEFAULT_WATCHLIST = ["BBCA", "BBRI", "TLKM", "ASII"];
let reqChart = null;

function getWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
    const normalized = saved
      .map((ticker) =>
        String(ticker || "")
          .trim()
          .toUpperCase(),
      )
      .filter((ticker) => /^[A-Z0-9.]{2,12}$/.test(ticker));
    return normalized.length ? normalized.slice(0, 16) : [...DEFAULT_WATCHLIST];
  } catch {
    return [...DEFAULT_WATCHLIST];
  }
}

function saveWatchlist(list) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list.slice(0, 16)));
}

function setWatchlistCount(list) {
  const badge = document.getElementById("watchlist-count");
  if (badge) {
    badge.textContent = `${list.length} ticker`;
  }
}

async function renderWatchlist() {
  const container = document.getElementById("watchlist-list");
  if (!container) return;

  const watchlist = getWatchlist();
  setWatchlistCount(watchlist);
  container.innerHTML =
    '<div class="loading"><span class="spinner"></span>Memuat watchlist...</div>';

  const rows = await Promise.all(
    watchlist.map(async (symbol) => {
      try {
        const [quote, tech] = await Promise.all([
          fetch(`${API}/quote/${symbol}`).then(safeJson),
          fetch(`${API}/analysis/technicals/${symbol}`)
            .then((r) => r.json())
            .catch(() => ({})),
        ]);

        const price = Number(
          quote?.price || quote?.last_price || tech?.price || 0,
        );
        const change = Number(quote?.change_pct || quote?.percent_change || 0);
        const rsi = tech?.indicators?.RSI_14
          ? Number(tech.indicators.RSI_14)
          : null;
        return { symbol, price, change, rsi };
      } catch {
        return { symbol, price: 0, change: 0, rsi: null, failed: true };
      }
    }),
  );

  container.innerHTML = rows
    .map((row) => {
      const changeClass = row.change >= 0 ? "green" : "red";
      return `
        <div class="watch-item">
          <div class="watch-top">
            <div>
              <div class="watch-symbol">${row.symbol}</div>
              <div class="muted" style="font-size:11px">${row.failed ? "Data belum tersedia" : `RSI ${typeof row.rsi === "number" ? row.rsi.toFixed(1) : "-"}`}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:13px;font-weight:700">${row.price ? formatRupiah(row.price) : "-"}</div>
              <div class="${changeClass}" style="font-size:12px">${row.change >= 0 ? "+" : ""}${row.change.toFixed(2)}%</div>
            </div>
          </div>
          <div class="watch-actions">
            <button class="btn btn-secondary" data-quote="${row.symbol}">Quote</button>
            <button class="btn btn-secondary" data-analysis="${row.symbol}">Analisis</button>
            <button class="btn btn-secondary" data-remove-watchlist="${row.symbol}">Hapus</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function addWatchlistTicker() {
  const input = document.getElementById("watchlist-input");
  if (!input) return;
  const symbol = input.value.trim().toUpperCase();
  if (!/^[A-Z0-9.]{2,12}$/.test(symbol)) {
    toast("Ticker tidak valid");
    return;
  }
  const list = getWatchlist();
  if (list.includes(symbol)) {
    toast("Ticker sudah ada di watchlist");
    return;
  }
  list.unshift(symbol);
  saveWatchlist(list);
  input.value = "";
  renderWatchlist();
}

function removeWatchlistTicker(symbol) {
  const list = getWatchlist().filter((ticker) => ticker !== symbol);
  saveWatchlist(list.length ? list : DEFAULT_WATCHLIST);
  renderWatchlist();
}

async function fetchMarketPulse() {
  const container = document.getElementById("market-pulse-list");
  if (!container) return;
  container.innerHTML =
    '<div class="loading"><span class="spinner"></span>Mengambil market pulse...</div>';

  try {
    const [lq45, banking] = await Promise.all([
      fetch(`${API}/analysis/sector-heatmap/lq45`).then(safeJson),
      fetch(`${API}/analysis/sector-heatmap/bank`).then(safeJson),
    ]);
    const picks = [
      ...(lq45.heatmap || []).slice(0, 4),
      ...(banking.heatmap || []).slice(0, 2),
    ]
      .filter(Boolean)
      .slice(0, 6);

    container.innerHTML = picks
      .map((stock) => {
        const chg = Number(stock.change_pct || 0);
        const cls = chg >= 0 ? "green" : "red";
        return `
          <div class="pulse-item">
            <div class="pulse-top">
              <div>
                <div class="pulse-symbol">${stock.symbol}</div>
                <div class="muted" style="font-size:11px">${stock.name || "-"}</div>
              </div>
              <div class="${cls}" style="font-weight:700">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</div>
            </div>
            <div class="pulse-metrics">
              <span class="pulse-metric">RSI ${stock.RSI ? Number(stock.RSI).toFixed(1) : "-"}</span>
              <span class="pulse-metric">EMA ${stock.EMA_Trend || "-"}</span>
              <span class="pulse-metric">${stock.heat || "Signal"}</span>
            </div>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    container.innerHTML = `<div class="red">Gagal memuat market pulse: ${error.message}</div>`;
  }
}

function formatRupiah(value) {
  const number = Number(value || 0);
  return `Rp ${number.toLocaleString("id")}`;
}

function recommendationFromSignals({ rsi, macdTrend, emaTrend, changePct }) {
  let score = 0;
  if (typeof rsi === "number") {
    if (rsi < 35) score += 1;
    else if (rsi > 70) score -= 1;
  }
  if ((macdTrend || "").toLowerCase().includes("bull")) score += 1;
  if ((macdTrend || "").toLowerCase().includes("bear")) score -= 1;
  if ((emaTrend || "").toLowerCase().includes("bull")) score += 1;
  if ((emaTrend || "").toLowerCase().includes("bear")) score -= 1;
  if (typeof changePct === "number") {
    if (changePct >= 5) score += 1;
    if (changePct <= -5) score -= 1;
  }

  if (score >= 3)
    return { label: "STRONG BUY", css: "badge-green", bias: [1.06, 1.1, 1.16] };
  if (score >= 1)
    return { label: "BUY", css: "badge-blue", bias: [1.04, 1.08, 1.12] };
  if (score <= -2)
    return {
      label: "SELL / AVOID",
      css: "badge-red",
      bias: [0.96, 0.92, 0.88],
    };
  return { label: "HOLD", css: "badge-yellow", bias: [1.03, 1.06, 1.09] };
}

function buildTargets(price, multipliers) {
  const base = Number(price || 0);
  if (!base) return ["-", "-", "-"];
  return multipliers.map((m) => formatRupiah(Math.round(base * m)));
}

function safeJson(response) {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function showPage(name) {
  document
    .querySelectorAll(".page")
    .forEach((page) => page.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === name);
  });
  document.getElementById(`page-${name}`).classList.add("active");
  if (name === "sector") {
    const activePill =
      document.querySelector(".pill.active") || document.querySelector(".pill");
    if (activePill) {
      fetchSector(activePill.dataset.sector, activePill);
    }
  }
}

function showDashboardWithSymbol(symbol) {
  showPage("dashboard");
  fetchQuote(symbol);
}

function toast(message, duration = 3000) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.style.display = "block";
  setTimeout(() => {
    element.style.display = "none";
  }, duration);
}

function fmtUptime(seconds) {
  if (!seconds) return "0s";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}j ${Math.floor((seconds % 3600) / 60)}m`;
}

async function checkStatus() {
  try {
    const [health, metrics, auth] = await Promise.all([
      fetch(`${API}/health`).then(safeJson),
      fetch(`${API}/metrics`).then(safeJson),
      fetch(`${API}/auth/status`).then(safeJson),
    ]);

    document.getElementById("server-status").textContent = "Live";
    renderStatCards(health, metrics, auth);
    renderMetricsChart(metrics);
    fetchTopIdeas();
    fetchMarketPulse();
    renderWatchlist();
  } catch (error) {
    document.getElementById("server-status").textContent = "Offline";
  }
}

async function fetchTopIdeas() {
  const container = document.getElementById("ideas-list");
  if (!container) return;

  try {
    const sector = await fetch(`${API}/analysis/sector-heatmap/lq45`).then(
      safeJson,
    );
    const picks = (sector.heatmap || []).slice(0, 6);

    if (!picks.length) {
      container.innerHTML =
        '<div class="muted">Belum ada data rekomendasi.</div>';
      return;
    }

    const rows = await Promise.all(
      picks.map(async (stock) => {
        const symbol = stock.symbol;
        const [tech, fund] = await Promise.all([
          fetch(`${API}/analysis/technicals/${symbol}`)
            .then((r) => r.json())
            .catch(() => ({})),
          fetch(`${API}/analysis/fundamentals/${symbol}`)
            .then((r) => r.json())
            .catch(() => ({})),
        ]);

        const price = Number(tech.price || stock.price || 0);
        const rsi = tech?.indicators?.RSI_14
          ? Number(tech.indicators.RSI_14)
          : null;
        const macd = tech?.indicators?.MACD_Trend || "-";
        const ema = tech?.indicators?.EMA_Trend || "-";
        const chg = Number(stock.change_pct || 0);

        const rec = recommendationFromSignals({
          rsi,
          macdTrend: macd,
          emaTrend: ema,
          changePct: chg,
        });
        const targets = buildTargets(price, rec.bias);

        return {
          symbol,
          name: fund.company_name || stock.name || symbol,
          price,
          change: chg,
          rsi,
          rec,
          targets,
        };
      }),
    );

    container.innerHTML = rows
      .map((row) => {
        const changeClass = row.change >= 0 ? "green" : "red";
        return `
          <div class="idea-card" data-symbol="${row.symbol}">
            <div class="idea-top">
              <div>
                <div class="idea-symbol">${row.symbol}</div>
                <div class="idea-company">${row.name}</div>
              </div>
              <div>
                <span class="badge ${row.rec.css}">${row.rec.label}</span>
                <div class="idea-price">${formatRupiah(row.price)}</div>
              </div>
            </div>
            <div class="idea-metrics">
              <span class="idea-metric ${changeClass}">Change ${row.change >= 0 ? "+" : ""}${row.change.toFixed(2)}%</span>
              <span class="idea-metric">RSI ${typeof row.rsi === "number" ? row.rsi.toFixed(1) : "-"}</span>
              <span class="idea-metric">Momentum ${(row.rec.label || "-").replace(" / AVOID", "")}</span>
            </div>
            <div class="idea-targets">
              <div class="target-pill">Conservative<br><b>${row.targets[0]}</b></div>
              <div class="target-pill">Moderate<br><b>${row.targets[1]}</b></div>
              <div class="target-pill">Aggressive<br><b>${row.targets[2]}</b></div>
            </div>
          </div>
        `;
      })
      .join("");

    container.querySelectorAll(".idea-card").forEach((card) => {
      card.addEventListener("click", () =>
        showDashboardWithSymbol(card.dataset.symbol),
      );
    });
  } catch (error) {
    container.innerHTML = `<div class="red">Gagal memuat ide saham: ${error.message}</div>`;
  }
}

function renderStatCards(health, metrics, auth) {
  const container = document.getElementById("stat-cards");

  fetch(`${API}/market/summary`)
    .then(safeJson)
    .then((market) => {
      const ihsg = market?.COMPOSITE || market?.data || {};
      const close = ihsg?.close || ihsg?.last_price || "-";
      const changePct = ihsg?.change_pct ?? ihsg?.percent_change ?? null;
      const changeClass =
        changePct === null ? "" : changePct >= 0 ? "green" : "red";
      const changeText =
        changePct !== null
          ? `${changePct >= 0 ? "+" : ""}${(+changePct).toFixed(2)}%`
          : "";

      container.innerHTML = `
        <div class="card">
          <div class="card-title">IHSG</div>
          <div class="stat-value ${changeClass}">${close}</div>
          <div class="stat-sub ${changeClass}">${changeText}</div>
        </div>
        <div class="card">
          <div class="card-title">Token Status</div>
          <div class="stat-value" style="font-size:18px">${auth.loaded ? '<span class="green">Aktif</span>' : '<span class="red">Tidak Aktif</span>'}</div>
          <div class="stat-sub">${auth.user || "-"} | Exp: ${auth.expiresAt ? new Date(auth.expiresAt).toLocaleDateString("id") : "-"}</div>
        </div>
        <div class="card">
          <div class="card-title">API Status</div>
          <div class="stat-value green">Online</div>
          <div class="stat-sub">Uptime: ${fmtUptime(health.uptimeSec)}</div>
        </div>
        <div class="card">
          <div class="card-title">Total Request</div>
          <div class="stat-value blue">${(metrics.requestCount || 0).toLocaleString("id")}</div>
          <div class="stat-sub">Dalam session ini</div>
        </div>
      `;
    })
    .catch(() => {
      container.innerHTML = `
        <div class="card"><div class="card-title">IHSG</div><div class="stat-value">-</div><div class="stat-sub">Gagal memuat</div></div>
        <div class="card"><div class="card-title">Token Status</div><div class="stat-value" style="font-size:18px">${auth.loaded ? '<span class="green">Aktif</span>' : '<span class="red">Tidak Aktif</span>'}</div><div class="stat-sub">${auth.user || "-"}</div></div>
        <div class="card"><div class="card-title">API Status</div><div class="stat-value green">Online</div><div class="stat-sub">Uptime: ${fmtUptime(health.uptimeSec)}</div></div>
        <div class="card"><div class="card-title">Total Request</div><div class="stat-value blue">${(metrics.requestCount || 0).toLocaleString("id")}</div><div class="stat-sub">Dalam session ini</div></div>
      `;
    });

  pingEndpoints();
}

function renderMetricsChart(metrics) {
  const canvas = document.getElementById("req-chart");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const hours = Array.from({ length: 12 }, (_, index) => {
    const value = new Date();
    value.setHours(value.getHours() - 11 + index);
    return `${value.getHours()}:00`;
  });
  const counts = Array.from({ length: 11 }, () =>
    Math.floor(Math.random() * 40 + 5),
  );
  counts.push(metrics.requestCount % 50 || 8);

  if (reqChart) reqChart.destroy();
  reqChart = new Chart(context, {
    type: "line",
    data: {
      labels: hours,
      datasets: [
        {
          data: counts,
          borderColor: "#58a6ff",
          backgroundColor: "rgba(88,166,255,.08)",
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.4,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          ticks: { color: "#8b949e", font: { size: 10 } },
          grid: { color: "#21262d" },
        },
        y: {
          ticks: { color: "#8b949e", font: { size: 10 } },
          grid: { color: "#21262d" },
        },
      },
    },
  });
}

async function pingEndpoints() {
  const endpoints = [
    { name: "Auth Status", url: "/auth/status" },
    { name: "Token Info", url: "/auth/token-info" },
    { name: "Market Summary", url: "/market/summary" },
    { name: "Quote BBCA", url: "/quote/BBCA" },
    { name: "Analysis Technicals", url: "/analysis/technicals/BBCA" },
  ];
  const container = document.getElementById("endpoint-status-list");
  container.innerHTML =
    '<table><thead><tr><th>Endpoint</th><th>Status</th><th>Waktu</th></tr></thead><tbody id="ep-tbody"></tbody></table>';
  const tbody = document.getElementById("ep-tbody");

  for (const endpoint of endpoints) {
    const startTime = Date.now();
    try {
      const response = await fetch(`${API}${endpoint.url}`, {
        signal: AbortSignal.timeout(8000),
      });
      const elapsed = Date.now() - startTime;
      const ok = response.status < 400;
      tbody.innerHTML += `<tr><td>${endpoint.name}</td><td><span class="badge ${ok ? "badge-green" : "badge-red"}">${response.status}</span></td><td>${elapsed}ms</td></tr>`;
    } catch {
      tbody.innerHTML += `<tr><td>${endpoint.name}</td><td><span class="badge badge-red">ERR</span></td><td>-</td></tr>`;
    }
  }
}

async function fetchQuote(explicitSymbol) {
  const input = document.getElementById("quote-input");
  const symbol = (explicitSymbol || input.value || "").trim().toUpperCase();
  if (!symbol) {
    toast("Masukkan kode saham");
    return;
  }
  input.value = symbol;

  const element = document.getElementById("quote-result");
  element.innerHTML = `<div class="card"><div class="loading"><span class="spinner"></span>Memuat data ${symbol}...</div></div>`;

  try {
    const [quoteRes, techRes, fundRes] = await Promise.all([
      fetch(`${API}/quote/${symbol}`).then(safeJson),
      fetch(`${API}/analysis/technicals/${symbol}`).then(safeJson),
      fetch(`${API}/analysis/fundamentals/${symbol}`).then(safeJson),
    ]);

    const price =
      quoteRes?.price ?? quoteRes?.last_price ?? techRes?.price ?? 0;
    const changePct = quoteRes?.change_pct ?? quoteRes?.percent_change ?? null;
    const changeClass =
      changePct === null ? "" : changePct >= 0 ? "green" : "red";
    const changeText =
      changePct !== null
        ? `${changePct >= 0 ? "+" : ""}${(+changePct).toFixed(2)}%`
        : "";

    const indicators = techRes?.indicators || {};
    const supportResistance = techRes?.support_resistance || {};
    const rsi = indicators.RSI_14 ? +indicators.RSI_14 : null;
    const rsiColor =
      rsi === null
        ? "#8b949e"
        : rsi > 70
          ? "#f85149"
          : rsi < 30
            ? "#3fb950"
            : "#58a6ff";
    const rsiSignal =
      rsi === null
        ? "-"
        : rsi > 70
          ? "Overbought"
          : rsi < 30
            ? "Oversold"
            : "Neutral";
    const macdTrend = indicators.MACD_Trend || "-";
    const emaTrend = indicators.EMA_Trend || "-";
    const volatility = fundRes?.volatility_pct
      ? `${(+fundRes.volatility_pct).toFixed(2)}%`
      : "-";
    const high52 = fundRes?.["52w_high"] || "-";
    const low52 = fundRes?.["52w_low"] || "-";

    let score = 0;
    if (rsi !== null) {
      if (rsi < 40) score += 1;
      else if (rsi > 65) score -= 1;
    }
    if (macdTrend.toLowerCase().includes("bull")) score += 1;
    if (macdTrend.toLowerCase().includes("bear")) score -= 1;
    if (emaTrend.toLowerCase().includes("bull")) score += 1;
    if (emaTrend.toLowerCase().includes("bear")) score -= 1;
    const signal =
      score >= 2
        ? '<span class="signal signal-buy">BUY</span>'
        : score <= -2
          ? '<span class="signal signal-sell">SELL</span>'
          : '<span class="signal signal-neutral">HOLD</span>';

    element.innerHTML = `
      <div class="card">
        <div class="panel-header" style="align-items:center;justify-content:space-between;">
          <div>
            <div style="font-size:22px;font-weight:700">${symbol}</div>
            <div class="muted" style="font-size:13px">${fundRes?.company_name || ""}</div>
          </div>
          <div style="text-align:right">
            <div class="stat-value ${changeClass}">Rp ${(+price).toLocaleString("id")}</div>
            <div class="${changeClass}" style="font-size:14px;font-weight:600">${changeText} ${signal}</div>
          </div>
        </div>
        <hr class="divider">
        <div class="analysis-grid">
          <div class="metric-item"><div class="metric-label">RSI (14)</div><div class="metric-value" style="color:${rsiColor}">${rsi !== null ? rsi.toFixed(1) : "-"}</div><div class="muted" style="font-size:11px">${rsiSignal}</div>${rsi !== null ? `<div class="rsi-bar"><div class="rsi-fill" style="width:${Math.max(0, Math.min(rsi, 100))}%;background:${rsiColor}"></div></div>` : ""}</div>
          <div class="metric-item"><div class="metric-label">MACD Trend</div><div class="metric-value ${(macdTrend || "").toLowerCase().includes("bull") ? "green" : "red"}">${macdTrend}</div><div class="muted" style="font-size:11px">Line: ${indicators.MACD_Line ? (+indicators.MACD_Line).toFixed(2) : "-"}</div></div>
          <div class="metric-item"><div class="metric-label">EMA Trend</div><div class="metric-value ${(emaTrend || "").toLowerCase().includes("bull") ? "green" : "red"}">${emaTrend.replace(" Trend", "")}</div><div class="muted" style="font-size:11px">EMA20: ${indicators.EMA20 ? (+indicators.EMA20).toLocaleString("id") : "-"}</div></div>
          <div class="metric-item"><div class="metric-label">Support / Resistance</div><div class="metric-value">${supportResistance.S1 ? `S1: ${supportResistance.S1.toLocaleString("id")}` : "-"}</div><div class="muted" style="font-size:11px">${supportResistance.R1 ? `R1: ${supportResistance.R1.toLocaleString("id")}` : ""}</div></div>
          <div class="metric-item"><div class="metric-label">52-Week Range</div><div class="metric-value" style="font-size:13px">${high52} / ${low52}</div><div class="muted" style="font-size:11px">High / Low</div></div>
          <div class="metric-item"><div class="metric-label">Volatilitas</div><div class="metric-value">${volatility}</div><div class="muted" style="font-size:11px">Avg Vol: ${typeof fundRes?.average_daily_volume === "number" ? fundRes.average_daily_volume.toLocaleString("id") : "-"}</div></div>
        </div>
      </div>
    `;
  } catch (error) {
    element.innerHTML = `<div class="card"><div class="red">Gagal memuat data: ${error.message}</div></div>`;
  }
}

async function fetchAnalysis(explicitSymbol) {
  const input = document.getElementById("analysis-input");
  const symbol = (explicitSymbol || input.value || "").trim().toUpperCase();
  if (!symbol) {
    toast("Masukkan kode saham");
    return;
  }
  input.value = symbol;

  const element = document.getElementById("analysis-result");
  element.innerHTML = `<div class="card"><div class="loading"><span class="spinner"></span>Analisis lengkap ${symbol}...</div></div>`;

  try {
    const [techRes, fundRes, compRes, divRes, perfRes] = await Promise.all([
      fetch(`${API}/analysis/technicals/${symbol}`).then(safeJson),
      fetch(`${API}/analysis/fundamentals/${symbol}`).then(safeJson),
      fetch(`${API}/analysis/company/${symbol}`).then(safeJson),
      fetch(`${API}/analysis/dividends/${symbol}`)
        .then((res) => res.json())
        .catch(() => ({})),
      fetch(`${API}/analysis/performance/${symbol}`)
        .then((res) => res.json())
        .catch(() => ({})),
    ]);

    const indicators = techRes?.indicators || {};
    const supportResistance = techRes?.support_resistance || {};
    const fundamentals = fundRes || {};
    const company = compRes || {};

    element.innerHTML = `
      <div class="grid-2">
        <div class="card">
          <div class="card-title">Indikator Teknikal - ${symbol}</div>
          <table><tbody>
            <tr><td>Harga Terakhir</td><td><b>Rp ${(techRes?.price || 0).toLocaleString("id")}</b></td></tr>
            <tr><td>RSI (14)</td><td><b>${indicators.RSI_14 ? (+indicators.RSI_14).toFixed(1) : "-"}</b> <span class="signal ${+indicators.RSI_14 > 70 ? "signal-sell" : +indicators.RSI_14 < 30 ? "signal-buy" : "signal-neutral"}">${indicators.RSI_Signal || ""}</span></td></tr>
            <tr><td>EMA 20</td><td>${indicators.EMA20 ? (+indicators.EMA20).toLocaleString("id") : "-"}</td></tr>
            <tr><td>EMA 50</td><td>${indicators.EMA50 ? (+indicators.EMA50).toLocaleString("id") : "-"}</td></tr>
            <tr><td>EMA Trend</td><td class="${(indicators.EMA_Trend || "").toLowerCase().includes("bull") ? "green" : "red"}">${indicators.EMA_Trend || "-"}</td></tr>
            <tr><td>MACD Line</td><td>${indicators.MACD_Line ? (+indicators.MACD_Line).toFixed(4) : "-"}</td></tr>
            <tr><td>MACD Signal</td><td>${indicators.MACD_Signal ? (+indicators.MACD_Signal).toFixed(4) : "-"}</td></tr>
            <tr><td>MACD Trend</td><td class="${(indicators.MACD_Trend || "").toLowerCase().includes("bull") ? "green" : "red"}">${indicators.MACD_Trend || "-"}</td></tr>
            <tr><td>Pivot</td><td>${supportResistance.pivot ? supportResistance.pivot.toLocaleString("id") : "-"}</td></tr>
            <tr><td>Support 1 / 2</td><td>${supportResistance.S1 || "-"} / ${supportResistance.S2 || "-"}</td></tr>
            <tr><td>Resistance 1 / 2</td><td>${supportResistance.R1 || "-"} / ${supportResistance.R2 || "-"}</td></tr>
          </tbody></table>
        </div>
        <div class="card">
          <div class="card-title">Fundamental - ${symbol}</div>
          <table><tbody>
            <tr><td>Nama Perusahaan</td><td><b>${fundamentals.company_name || company.name || "-"}</b></td></tr>
            <tr><td>Sektor</td><td>${fundamentals.sector || company.sector || "-"}</td></tr>
            <tr><td>52W High</td><td class="green">${fundamentals["52w_high"] || "-"}</td></tr>
            <tr><td>52W Low</td><td class="red">${fundamentals["52w_low"] || "-"}</td></tr>
            <tr><td>Volatilitas</td><td>${fundamentals.volatility_pct ? `${(+fundamentals.volatility_pct).toFixed(3)}%` : "-"}</td></tr>
            <tr><td>Avg Daily Volume</td><td>${fundamentals.average_daily_volume ? (+fundamentals.average_daily_volume).toLocaleString("id") : "-"}</td></tr>
            <tr><td>Avg Daily Value</td><td>${fundamentals.average_daily_value ? `Rp ${(+fundamentals.average_daily_value).toLocaleString("id")}` : "-"}</td></tr>
            <tr><td>Dividen Terakhir</td><td>${divRes?.dividends?.[0]?.amount ? `Rp ${divRes.dividends[0].amount}` : "-"}</td></tr>
            <tr><td>Return 1M</td><td class="${(+perfRes?.return_1m || 0) >= 0 ? "green" : "red"}">${perfRes?.return_1m ? `${(+perfRes.return_1m).toFixed(2)}%` : "-"}</td></tr>
            <tr><td>Return 3M</td><td class="${(+perfRes?.return_3m || 0) >= 0 ? "green" : "red"}">${perfRes?.return_3m ? `${(+perfRes.return_3m).toFixed(2)}%` : "-"}</td></tr>
            <tr><td>Return YTD</td><td class="${(+perfRes?.return_ytd || 0) >= 0 ? "green" : "red"}">${perfRes?.return_ytd ? `${(+perfRes.return_ytd).toFixed(2)}%` : "-"}</td></tr>
          </tbody></table>
        </div>
      </div>
    `;
  } catch (error) {
    element.innerHTML = `<div class="card"><div class="red">Gagal analisis: ${error.message}</div></div>`;
  }
}

async function fetchSector(sector, pill) {
  if (pill) {
    document
      .querySelectorAll(".pill")
      .forEach((current) => current.classList.remove("active"));
    pill.classList.add("active");
  }

  const element = document.getElementById("sector-result");
  element.innerHTML = `<div class="card"><div class="loading"><span class="spinner"></span>Memuat heatmap sektor ${sector.toUpperCase()}...</div></div>`;

  try {
    const data = await fetch(`${API}/analysis/sector-heatmap/${sector}`).then(
      safeJson,
    );
    const avg = parseFloat(data.sector_avg_change) || 0;
    const avgClass = avg >= 0 ? "green" : "red";
    const heatCells = (data.heatmap || [])
      .map((stock) => {
        const change = parseFloat(stock.change_pct) || 0;
        const heatClass =
          change > 2
            ? "heat-hot"
            : change > 0
              ? "heat-warm"
              : change > -2
                ? "heat-cool"
                : "heat-cold";
        const changeColor = change >= 0 ? "var(--accent-2)" : "var(--danger)";
        return `<div class="heat-cell ${heatClass}" data-symbol="${stock.symbol}"><div class="symbol">${stock.symbol}</div><div class="chg" style="color:${changeColor}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</div><div class="muted" style="font-size:10px;margin-top:2px">${stock.RSI ? `RSI ${stock.RSI.toFixed(0)}` : ""}</div></div>`;
      })
      .join("");

    element.innerHTML = `
      <div class="card">
        <div class="panel-header" style="justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div><div style="font-size:18px;font-weight:700">${data.sector?.toUpperCase()}</div><div class="muted" style="font-size:13px">${data.stocks_analyzed} saham dianalisis</div></div>
          <div style="text-align:right"><div class="muted" style="font-size:13px">Rata-rata</div><div class="${avgClass}" style="font-size:22px;font-weight:700">${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%</div><div style="font-size:13px">${data.sector_mood || ""}</div></div>
        </div>
        <div class="heatmap-grid">${heatCells}</div>
        ${data.best_performer ? `<hr class="divider"><div class="panel-inline"><div><span class="muted" style="font-size:11px">Best</span> <b>${data.best_performer.symbol}</b> <span class="green">${(+data.best_performer.change_pct).toFixed(2)}%</span></div><div><span class="muted" style="font-size:11px">Worst</span> <b>${data.worst_performer.symbol}</b> <span class="red">${(+data.worst_performer.change_pct).toFixed(2)}%</span></div></div>` : ""}
      </div>
    `;

    element.querySelectorAll(".heat-cell").forEach((cell) => {
      cell.addEventListener("click", () =>
        showDashboardWithSymbol(cell.dataset.symbol),
      );
    });
  } catch (error) {
    element.innerHTML = `<div class="card"><div class="red">Gagal memuat heatmap: ${error.message}</div></div>`;
  }
}

async function fetchCorrelation() {
  const input = document.getElementById("corr-input");
  const symbols = input.value.trim().toUpperCase();
  if (!symbols) {
    toast("Masukkan kode saham, dipisah koma");
    return;
  }

  const element = document.getElementById("correlation-result");
  element.innerHTML = `<div class="card"><div class="loading"><span class="spinner"></span>Menghitung korelasi...</div></div>`;

  try {
    const data = await fetch(
      `${API}/analysis/correlation?symbols=${encodeURIComponent(symbols)}`,
    ).then(safeJson);
    const matrix = data.correlation_matrix || {};
    const symbolsList = Object.keys(matrix);
    if (!symbolsList.length) {
      throw new Error("Data tidak tersedia");
    }

    const headerRow = `<tr><th>Symbol</th>${symbolsList.map((symbol) => `<th>${symbol}</th>`).join("")}</tr>`;
    const bodyRows = symbolsList
      .map((left) => {
        const cells = symbolsList
          .map((right) => {
            const value = matrix[left]?.[right];
            if (value === undefined || value === null) {
              return "<td>-</td>";
            }
            const numeric = +value;
            const color =
              numeric >= 0.7
                ? "var(--accent-2)"
                : numeric >= 0.3
                  ? "var(--accent)"
                  : numeric >= -0.3
                    ? "var(--muted)"
                    : numeric >= -0.7
                      ? "var(--warning)"
                      : "var(--danger)";
            return `<td style="color:${color};font-weight:${left === right ? "700" : "400"}">${numeric.toFixed(3)}</td>`;
          })
          .join("");
        return `<tr><td><b>${left}</b></td>${cells}</tr>`;
      })
      .join("");

    element.innerHTML = `
      <div class="card">
        <div class="card-title">Matrix Korelasi - ${symbolsList.join(" · ")} <span class="badge badge-blue">${data.data_period || ""}</span></div>
        <div style="overflow-x:auto"><table>${headerRow}<tbody>${bodyRows}</tbody></table></div>
        <hr class="divider">
        <div class="muted" style="font-size:11px"><span style="color:var(--accent-2)">■</span> >= 0.7 Sangat korelasi <span style="color:var(--accent)">■</span> 0.3-0.7 Korelasi <span style="color:var(--muted)">■</span> -0.3-0.3 Lemah <span style="color:var(--warning)">■</span> -0.7--0.3 Negatif <span style="color:var(--danger)">■</span> <= -0.7 Sangat negatif</div>
      </div>
    `;
  } catch (error) {
    element.innerHTML = `<div class="card"><div class="red">Gagal menghitung korelasi: ${error.message}</div></div>`;
  }
}

function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.page));
  });

  document.querySelectorAll(".pill").forEach((pill) => {
    pill.addEventListener("click", () =>
      fetchSector(pill.dataset.sector, pill),
    );
  });

  document
    .getElementById("quote-search-btn")
    .addEventListener("click", () => fetchQuote());
  document
    .getElementById("analysis-search-btn")
    .addEventListener("click", () => fetchAnalysis());
  document
    .getElementById("correlation-search-btn")
    .addEventListener("click", () => fetchCorrelation());
  document.getElementById("corr-example-btn").addEventListener("click", () => {
    document.getElementById("corr-input").value = "BBCA,BBRI,BMRI,TLKM";
    fetchCorrelation();
  });

  document
    .getElementById("quote-input")
    .addEventListener("keydown", (event) => {
      if (event.key === "Enter") fetchQuote();
    });
  document
    .getElementById("analysis-input")
    .addEventListener("keydown", (event) => {
      if (event.key === "Enter") fetchAnalysis();
    });
  document.getElementById("corr-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") fetchCorrelation();
  });

  const watchlistAddBtn = document.getElementById("watchlist-add-btn");
  const watchlistInput = document.getElementById("watchlist-input");
  if (watchlistAddBtn) {
    watchlistAddBtn.addEventListener("click", addWatchlistTicker);
  }
  if (watchlistInput) {
    watchlistInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") addWatchlistTicker();
    });
  }

  document.body.addEventListener("click", (event) => {
    const quoteButton = event.target.closest("[data-quote]");
    if (quoteButton) {
      fetchQuote(quoteButton.dataset.quote);
      return;
    }

    const analysisButton = event.target.closest("[data-analysis]");
    if (analysisButton) {
      showPage("analysis");
      fetchAnalysis(analysisButton.dataset.analysis);
      return;
    }

    const removeWatchBtn = event.target.closest("[data-remove-watchlist]");
    if (removeWatchBtn) {
      removeWatchlistTicker(removeWatchBtn.dataset.removeWatchlist);
    }
  });
}

bindEvents();
checkStatus();
setInterval(checkStatus, 30000);
setInterval(fetchTopIdeas, 120000);
setInterval(fetchMarketPulse, 120000);
