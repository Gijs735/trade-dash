const lightweightChartsScriptUrl = 'vendor/lightweight-charts.standalone.production.js?v=5.2.0';
const chartHistoryMonths = 24;
const weeklyChartBars = Math.ceil((chartHistoryMonths * 365.25) / 12 / 7);
const dailyChartBars = Math.ceil(chartHistoryMonths * 365.25 / 12);
const coinbaseDailyCandleLimit = 290;
const dayInSeconds = 86400;
const candleCacheTtlMs = 3 * 60 * 60 * 1000;
const candleCacheKey = `bully:BTC-EUR:daily-candles:${chartHistoryMonths}m:v1`;
const chartUpColor = '#4aa38c';
const chartDownColor = '#ef5350';
const tradingViewScanUrl = 'https://scanner.tradingview.com/america/scan';
const fallbackMstrPriceUsd = 124.80;
const defaultStrategyMnavInputs = {
    btcHoldings: 845050,
    usdAssets: 6710000000,
    debt: 6754000000,
    preferred: 14810282300,
    dilutedShares: 424431421
};
const strategyInputsUrl = 'strategy-inputs.json';
const strategyInputsCacheTtlMs = 15 * 60 * 1000;
const tradingViewMstrColumns = [
    'close',
    'currency',
    'premarket_close',
    'postmarket_close'
];
let mstrShares = 3332;
let mstrAveragePriceUsd = 123.70;
let strategyInputsCache;
let hasLoadedPriceChart = false;
let hasPreloadedPriceChart = false;
let lightweightChartsLoadPromise;
const priceChartState = {
    chart: null,
    candlestickSeries: null,
    volumeSeries: null,
    resizeObserver: null,
    timeframe: 'weekly',
    activeCandles: [],
    dailyCandles: [],
    weeklyCandles: []
};

async function getBTCPriceEUR() {
    const url = 'https://api.coinbase.com/v2/prices/BTC-EUR/spot';

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Request Failed. Status Code: ${response.status}`);
        }
        const json = await response.json();
        const price = Number(json?.data?.amount);
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('BTC price not found in response');
        }
        return Math.round(price);
    } catch (e) {
        throw new Error('Error fetching or parsing response: ' + e.message);
    }
}

async function getUsdEurRate() {
    const url = 'https://api.frankfurter.dev/v1/latest?from=USD&to=EUR';

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Request Failed. Status Code: ${response.status}`);
        }
        const json = await response.json();
        const rate = Number(json?.rates?.EUR);
        if (!Number.isFinite(rate) || rate <= 0) {
            throw new Error('USD/EUR rate not found in response');
        }
        return rate;
    } catch (e) {
        throw new Error('Error fetching or parsing USD/EUR response: ' + e.message);
    }
}

async function getMstrPriceUsd() {
    try {
        const response = await fetch(tradingViewScanUrl, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'text/plain'
            },
            body: JSON.stringify({
                symbols: {
                    tickers: ['NASDAQ:MSTR'],
                    query: { types: [] }
                },
                columns: tradingViewMstrColumns
            })
        });
        if (!response.ok) {
            throw new Error(`Request Failed. Status Code: ${response.status}`);
        }

        const row = (await response.json())?.data?.[0]?.d;
        const price = Array.isArray(row) ? parseMstrPrice(row) : NaN;
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('MSTR price not found in response');
        }
        return price;
    } catch (err) {
        console.warn('Live MSTR price unavailable; using fallback price', err);
        return fallbackMstrPriceUsd;
    }
}

function parseMstrPrice(row) {
    const [closePrice, currency, premarketPrice, postmarketPrice] = row;
    if (currency && currency !== 'USD') {
        throw new Error(`Unexpected MSTR quote currency: ${currency}`);
    }

    const session = getNewYorkMarketSession();
    const regular = Number(closePrice);
    const pre = Number(premarketPrice);
    const post = Number(postmarketPrice);
    const usePre = session === 'pre-market' && Number.isFinite(pre) && pre > 0;
    const usePost = ['after-hours', 'overnight'].includes(session) && Number.isFinite(post) && post > 0;

    return usePre ? pre : usePost ? post : regular;
}

function getNewYorkMarketSession(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekday = partMap.weekday;
    const minutes = (Number(partMap.hour) * 60) + Number(partMap.minute);
    const isWeekday = !['Sat', 'Sun'].includes(weekday);

    if (!isWeekday) {
        return 'overnight';
    }
    if (minutes >= 4 * 60 && minutes < (9 * 60) + 30) {
        return 'pre-market';
    }
    if (minutes >= (9 * 60) + 30 && minutes < 16 * 60) {
        return 'regular';
    }
    if (minutes >= 16 * 60 && minutes < 20 * 60) {
        return 'after-hours';
    }
    return 'overnight';
}

async function evaluateMstrPosition(shares, averagePriceUsd) {
    const [btcPriceEur, usdEurRate, mstrPriceUsd, strategyInputs] = await Promise.all([
        getBTCPriceEUR(),
        getUsdEurRate(),
        getMstrPriceUsd(),
        getStrategyMnavInputs()
    ]);
    const mstrPriceEur = mstrPriceUsd * usdEurRate;
    const positionValueEur = shares * mstrPriceEur;
    const costBasisEur = shares * averagePriceUsd * usdEurRate;
    const profitLossEur = positionValueEur - costBasisEur;
    const profitLossPercent = ((mstrPriceUsd - averagePriceUsd) / averagePriceUsd) * 100;
    const btcPriceUsd = btcPriceEur / usdEurRate;
    const { mnav, netBtcPerShare } = calculateStrategyMnav(strategyInputs, mstrPriceUsd, btcPriceUsd);
    const netBtcExposure = netBtcPerShare * shares;

    return {
        mstrPriceUsd,
        btcPriceEur,
        positionValueEur,
        profitLossEur,
        profitLossPercent,
        netBtcPerShare,
        netBtcExposure,
        mnav,
        isProfitable: profitLossEur >= 0
    };
}

async function getStrategyMnavInputs() {
    if (strategyInputsCache && Date.now() - strategyInputsCache.fetchedAt < strategyInputsCacheTtlMs) {
        return strategyInputsCache.inputs;
    }

    try {
        const response = await fetch(strategyInputsUrl, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Request Failed. Status Code: ${response.status}`);
        }

        const inputs = normalizeStrategyInputs(await response.json());
        strategyInputsCache = {
            fetchedAt: Date.now(),
            inputs
        };
        return inputs;
    } catch (err) {
        console.warn('Strategy filing inputs unavailable; using embedded fallback', err);
        return defaultStrategyMnavInputs;
    }
}

function normalizeStrategyInputs(inputs) {
    const normalized = {
        btcHoldings: Number(inputs?.btcHoldings),
        usdAssets: Number(inputs?.usdAssets),
        debt: Number(inputs?.debt),
        preferred: Number(inputs?.preferred),
        dilutedShares: Number(inputs?.dilutedShares)
    };

    if (Object.values(normalized).every((value) => Number.isFinite(value) && value > 0)) {
        return normalized;
    }

    throw new Error('Strategy filing inputs are incomplete');
}

function calculateStrategyMnav(strategyMnavInputs, mstrPriceUsd, btcPriceUsd) {
    const netReserveUsd = (
        strategyMnavInputs.btcHoldings * btcPriceUsd
        + strategyMnavInputs.usdAssets
        - strategyMnavInputs.debt
        - strategyMnavInputs.preferred
    );
    const netReservePerShareUsd = netReserveUsd / strategyMnavInputs.dilutedShares;

    return {
        netBtcPerShare: netReservePerShareUsd / btcPriceUsd,
        mnav: mstrPriceUsd / netReservePerShareUsd
    };
}

async function updateTradeInfo() {
    try {
        syncMstrSharesFromInput();
        syncMstrAveragePriceFromInput();
        const result = await evaluateMstrPosition(mstrShares, mstrAveragePriceUsd);
        const color = result.isProfitable ? '#22c55e' : '#ef4444';
        const plusminus = result.isProfitable ? '+' : '';
        const metricText = {
            total: formatEur(result.positionValueEur, 0),
            currentPrice: `$${formatNumber(result.mstrPriceUsd, 2)}`,
            delta: formatSats(result.netBtcPerShare),
            percent: plusminus + result.profitLossPercent.toFixed(2) + '%'
        };
        const metricDetails = {
            delta: `${formatBtc(result.netBtcExposure, 4)} net BTC exposure · ${result.mnav.toFixed(2)}x current mNAV`,
            percent: `${formatSignedEur(result.profitLossEur, 0)} vs entry`
        };

        Object.entries(metricText).forEach(([id, text]) => {
            const element = document.getElementById(id);
            element.textContent = text;
            element.style.color = color;
        });
        Object.entries(metricDetails).forEach(([id, text]) => {
            const element = document.getElementById(`${id}Detail`);
            if (element) {
                element.textContent = text;
            }
        });
        updateLiveChartPrice(result.btcPriceEur);

        return result;
    } catch (err) {
        ['delta', 'total', 'currentPrice', 'percent'].forEach((id) => {
            document.getElementById(id).textContent = 'Error';
            const detail = document.getElementById(`${id}Detail`);
            if (detail) {
                detail.textContent = '';
            }
        });
        console.error(err);
        return null;
    }
}

function syncMstrSharesFromInput() {
    mstrShares = readPositiveInput('mstrShares', mstrShares);
    return mstrShares;
}

function syncMstrAveragePriceFromInput() {
    mstrAveragePriceUsd = readPositiveInput('mstrAveragePrice', mstrAveragePriceUsd);
    return mstrAveragePriceUsd;
}

function readPositiveInput(id, fallback) {
    const input = document.getElementById(id);
    const value = input?.value.trim();
    if (!value) {
        return fallback;
    }

    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function setupMstrSharesInput(onChange) {
    setupNumberInput('mstrShares', mstrShares, syncMstrSharesFromInput, onChange, Math.round);
}

function setupMstrAveragePriceInput(onChange) {
    setupNumberInput('mstrAveragePrice', mstrAveragePriceUsd, syncMstrAveragePriceFromInput, onChange, (value) => Number(value).toFixed(2));
}

function setupNumberInput(id, initialValue, syncValue, onChange, formatValue = String) {
    const input = document.getElementById(id);
    if (!input) {
        return;
    }

    let debounceId;
    input.value = formatValue(initialValue);
    input.addEventListener('input', () => {
        syncValue();
        window.clearTimeout(debounceId);
        debounceId = window.setTimeout(onChange, 350);
    });
}

function setupPriceChart() {
    const panel = document.getElementById('priceChartPanel');
    if (!panel) {
        return;
    }

    const docsLink = panel.querySelector('.chart-tab-source');
    docsLink?.addEventListener('click', (event) => {
        event.stopPropagation();
    });

    setupChartTimeframeControls();
    schedulePriceChartPreload();

    panel.addEventListener('toggle', () => {
        if (panel.open) {
            loadPriceChart();
        }
    });
}

function setupChartTimeframeControls() {
    document.querySelectorAll('[data-chart-period]').forEach((button) => {
        button.addEventListener('click', () => {
            setChartTimeframe(button.dataset.chartPeriod);
        });
    });
    syncChartTimeframeControls();
}

function schedulePriceChartPreload() {
    if (hasPreloadedPriceChart) {
        return;
    }

    hasPreloadedPriceChart = true;
    const preload = () => {
        addResourceHint('preconnect', 'https://api.exchange.coinbase.com');
        addResourceHint('preload', lightweightChartsScriptUrl, 'script');
        document.getElementById('btcEurChart')?.classList.add('is-warmed');
    };

    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(preload, { timeout: 2000 });
        return;
    }

    window.setTimeout(preload, 600);
}

function addResourceHint(rel, href, as) {
    const existingHint = document.querySelector(`link[rel="${rel}"][href="${href}"]`);
    if (existingHint) {
        return;
    }

    const link = document.createElement('link');
    link.rel = rel;
    link.href = href;
    if (as) {
        link.as = as;
    }
    document.head.appendChild(link);
}

async function loadPriceChart() {
    const chartHost = document.getElementById('btcEurChart');
    if (hasLoadedPriceChart || !chartHost) {
        return;
    }

    hasLoadedPriceChart = true;
    setChartStatus('Chart loading...');

    try {
        await loadLightweightCharts();
        const dailyCandles = await fetchCoinbaseDailyCandles();
        const weeklyCandles = aggregateDailyCandlesToWeeks(dailyCandles);
        initializePriceChart(dailyCandles, weeklyCandles);
        try {
            updateLiveChartPrice(await getBTCPriceEUR());
        } catch (err) {
            console.warn('Live chart price unavailable', err);
        }
        setChartStatus('');
    } catch (err) {
        hasLoadedPriceChart = false;
        setChartStatus('Chart unavailable');
        console.error(err);
    }
}

function loadLightweightCharts() {
    if (window.LightweightCharts) {
        return Promise.resolve();
    }

    if (lightweightChartsLoadPromise) {
        return lightweightChartsLoadPromise;
    }

    lightweightChartsLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = lightweightChartsScriptUrl;
        script.async = true;
        script.onload = () => {
            if (window.LightweightCharts) {
                resolve();
                return;
            }
            reject(new Error('Lightweight Charts failed to initialize'));
        };
        script.onerror = () => reject(new Error('Lightweight Charts failed to load'));
        document.head.appendChild(script);
    });

    return lightweightChartsLoadPromise;
}

function createDarkChart(chartElement, options) {
    const LightweightCharts = window.LightweightCharts;
    const rightPriceScale = {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        scaleMargins: {
            top: 0.08,
            bottom: options.bottomMargin
        }
    };
    if (options.autoScale) {
        rightPriceScale.autoScale = true;
    }

    return LightweightCharts.createChart(chartElement, {
        autoSize: true,
        layout: {
            background: { type: 'solid', color: options.backgroundColor },
            textColor: '#b8b8bd',
            fontFamily: 'Arial, sans-serif'
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.06)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.06)' }
        },
        rightPriceScale,
        timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.08)',
            timeVisible: false,
            secondsVisible: false
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode?.Normal ?? 0
        },
        localization: {
            priceFormatter: options.priceFormatter
        }
    });
}

async function fetchCoinbaseDailyCandles() {
    const cachedCandles = getCachedDailyCandles();
    if (cachedCandles) {
        return cachedCandles;
    }

    const end = new Date();
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - chartHistoryMonths);

    const candles = [];
    let cursor = new Date(start);
    while (cursor < end) {
        const chunkEnd = new Date(Math.min(
            end.getTime(),
            cursor.getTime() + (coinbaseDailyCandleLimit * dayInSeconds * 1000)
        ));
        candles.push(...await fetchCoinbaseDailyCandleChunk(cursor, chunkEnd));
        cursor = new Date(chunkEnd.getTime() + 1000);
    }

    const dailyCandles = normalizeCoinbaseDailyCandles(candles);
    cacheDailyCandles(dailyCandles);
    return dailyCandles;
}

function normalizeCoinbaseDailyCandles(candles) {
    const seenTimes = new Set();
    return candles
        .map(([time, low, high, open, close, volume]) => ({
            time: Number(time),
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume)
        }))
        .filter((candle) => {
            if (!isValidDailyCandle(candle) || seenTimes.has(candle.time)) {
                return false;
            }
            seenTimes.add(candle.time);
            return true;
        })
        .sort((a, b) => a.time - b.time);
}

function getCachedDailyCandles() {
    try {
        const cache = JSON.parse(localStorage.getItem(candleCacheKey));
        if (
            !cache
            || !Number.isFinite(cache.fetchedAt)
            || Date.now() - cache.fetchedAt > candleCacheTtlMs
            || !Array.isArray(cache.candles)
            || cache.candles.length === 0
            || !cache.candles.every(isValidDailyCandle)
        ) {
            return null;
        }

        return cache.candles;
    } catch (err) {
        return null;
    }
}

function cacheDailyCandles(candles) {
    try {
        localStorage.setItem(candleCacheKey, JSON.stringify({
            fetchedAt: Date.now(),
            candles
        }));
    } catch (err) {
        // Cache failures should never block the live chart.
    }
}

function isValidDailyCandle(candle) {
    return candle
        && Number.isFinite(candle.time)
        && Number.isFinite(candle.open)
        && Number.isFinite(candle.high)
        && Number.isFinite(candle.low)
        && Number.isFinite(candle.close)
        && Number.isFinite(candle.volume);
}

async function fetchCoinbaseDailyCandleChunk(start, end) {
    const params = new URLSearchParams({
        granularity: String(dayInSeconds),
        start: start.toISOString(),
        end: end.toISOString()
    });
    const url = `https://api.exchange.coinbase.com/products/BTC-EUR/candles?${params}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Chart candles request failed. Status Code: ${response.status}`);
    }

    const candles = await response.json();
    if (!Array.isArray(candles)) {
        throw new Error('Chart candles not found in response');
    }

    return candles;
}

function aggregateDailyCandlesToWeeks(dailyCandles) {
    const weeks = [];
    let currentWeek;

    dailyCandles.forEach((dailyCandle) => {
        const weekStart = getUtcWeekStartSeconds(dailyCandle.time);
        if (!currentWeek || currentWeek.time !== weekStart) {
            currentWeek = {
                time: weekStart,
                open: dailyCandle.open,
                high: dailyCandle.high,
                low: dailyCandle.low,
                close: dailyCandle.close,
                volume: dailyCandle.volume
            };
            weeks.push(currentWeek);
            return;
        }

        currentWeek.high = Math.max(currentWeek.high, dailyCandle.high);
        currentWeek.low = Math.min(currentWeek.low, dailyCandle.low);
        currentWeek.close = dailyCandle.close;
        currentWeek.volume += dailyCandle.volume;
    });

    if (weeks.length < 2) {
        throw new Error('Not enough weekly candles to render chart');
    }

    return weeks;
}

function getUtcWeekStartSeconds(unixSeconds) {
    const date = new Date(unixSeconds * 1000);
    const day = date.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
    return Math.floor(date.getTime() / 1000);
}

function getUtcDayStartSeconds(unixSeconds) {
    const date = new Date(unixSeconds * 1000);
    date.setUTCHours(0, 0, 0, 0);
    return Math.floor(date.getTime() / 1000);
}

function initializePriceChart(dailyCandles, weeklyCandles) {
    const chartElement = document.getElementById('lightweightChart');
    if (!chartElement) {
        return;
    }

    if (priceChartState.resizeObserver) {
        priceChartState.resizeObserver.disconnect();
    }
    if (priceChartState.chart) {
        priceChartState.chart.remove();
    }

    chartElement.textContent = '';
    priceChartState.dailyCandles = dailyCandles;
    priceChartState.weeklyCandles = weeklyCandles;

    const chart = createDarkChart(chartElement, {
        autoScale: true,
        backgroundColor: '#0f0f10',
        bottomMargin: 0.18,
        priceFormatter: formatChartPrice
    });

    const candlestickSeries = addChartSeries(chart, 'candlestick', {
        upColor: chartUpColor,
        downColor: chartDownColor,
        borderUpColor: chartUpColor,
        borderDownColor: chartDownColor,
        wickUpColor: chartUpColor,
        wickDownColor: chartDownColor,
        priceLineColor: chartUpColor,
        lastValueVisible: true
    });

    const volumeSeries = addChartSeries(chart, 'histogram', {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        lastValueVisible: false,
        priceLineVisible: false
    });

    priceChartState.chart = chart;
    priceChartState.candlestickSeries = candlestickSeries;
    priceChartState.volumeSeries = volumeSeries;

    volumeSeries.priceScale().applyOptions({
        scaleMargins: {
            top: 0.82,
            bottom: 0
        }
    });

    setChartTimeframe('weekly', true);

    priceChartState.resizeObserver = new ResizeObserver(() => {
        chart.resize(chartElement.clientWidth, chartElement.clientHeight);
    });
    priceChartState.resizeObserver.observe(chartElement);
}

function setChartTimeframe(timeframe, force = false) {
    if (!['daily', 'weekly'].includes(timeframe)) {
        return;
    }

    if (!force && priceChartState.timeframe === timeframe) {
        return;
    }

    priceChartState.timeframe = timeframe;
    syncChartTimeframeControls();

    if (!priceChartState.candlestickSeries || !priceChartState.volumeSeries) {
        return;
    }

    renderActiveChartData({ resetRange: true });
}

function syncChartTimeframeControls() {
    document.querySelectorAll('[data-chart-period]').forEach((button) => {
        const isActive = button.dataset.chartPeriod === priceChartState.timeframe;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    });

    const timeframeLabel = document.getElementById('chartTimeframeLabel');
    if (timeframeLabel) {
        timeframeLabel.textContent = priceChartState.timeframe === 'daily' ? '1D' : '1W';
    }
}

function renderActiveChartData({ resetRange = false } = {}) {
    const candles = getActiveChartCandles();
    priceChartState.activeCandles = candles;

    priceChartState.candlestickSeries.setData(candles.map(toCandlestickData));
    priceChartState.volumeSeries.setData(candles.map(toVolumeData));
    updateCurrentPriceLineColor();
    if (resetRange) {
        setVisibleChartRange();
    }
    updateChartOhlc();
}

function getActiveChartCandles() {
    return priceChartState.timeframe === 'daily'
        ? priceChartState.dailyCandles
        : priceChartState.weeklyCandles;
}

function addChartSeries(chart, type, options) {
    const LightweightCharts = window.LightweightCharts;
    const seriesConstructors = {
        candlestick: LightweightCharts.CandlestickSeries,
        histogram: LightweightCharts.HistogramSeries,
        line: LightweightCharts.LineSeries
    };
    if (chart.addSeries && seriesConstructors[type]) {
        return chart.addSeries(seriesConstructors[type], options);
    }

    if (type === 'candlestick') {
        return chart.addCandlestickSeries(options);
    }
    if (type === 'histogram') {
        return chart.addHistogramSeries(options);
    }
    return chart.addLineSeries(options);
}

window.loadLightweightCharts = loadLightweightCharts;
window.addChartSeries = addChartSeries;
window.createDarkChart = createDarkChart;

function toCandlestickData(candle) {
    return {
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
    };
}

function toVolumeData(candle) {
    return {
        time: candle.time,
        value: candle.volume,
        color: candle.close >= candle.open
            ? 'rgba(74, 163, 140, 0.48)'
            : 'rgba(239, 83, 80, 0.48)'
    };
}

function updateCurrentPriceLineColor() {
    const { candlestickSeries, activeCandles } = priceChartState;
    if (!candlestickSeries || activeCandles.length === 0) {
        return;
    }

    candlestickSeries.applyOptions({
        priceLineColor: getCurrentPriceMoveColor(activeCandles)
    });
}

function getCurrentPriceMoveColor(candles) {
    const move = getCandleMove(candles);
    return !move || move.change >= 0 ? chartUpColor : chartDownColor;
}

function getCandleMove(candles) {
    if (!candles.length) {
        return null;
    }

    const latest = candles[candles.length - 1];
    const previous = candles[candles.length - 2] ?? latest;
    const change = latest.close - previous.close;
    const percentChange = previous.close ? (change / previous.close) * 100 : 0;
    return {
        latest,
        previous,
        change,
        percentChange
    };
}

function updateLiveChartPrice(price) {
    const livePrice = Number(price);
    const { candlestickSeries, volumeSeries, dailyCandles, weeklyCandles } = priceChartState;
    if (!candlestickSeries || !volumeSeries || !dailyCandles.length || !weeklyCandles.length || !Number.isFinite(livePrice)) {
        return;
    }

    updateCandleCollectionWithLivePrice(dailyCandles, getUtcDayStartSeconds(Date.now() / 1000), livePrice);
    updateCandleCollectionWithLivePrice(weeklyCandles, getUtcWeekStartSeconds(Date.now() / 1000), livePrice);
    const activeCandles = getActiveChartCandles();
    const latestCandle = activeCandles[activeCandles.length - 1];
    priceChartState.activeCandles = activeCandles;
    candlestickSeries.update(toCandlestickData(latestCandle));
    volumeSeries.update(toVolumeData(latestCandle));
    updateCurrentPriceLineColor();
    updateChartOhlc();
}

function updateCandleCollectionWithLivePrice(candles, periodStart, livePrice) {
    let latestCandle = candles[candles.length - 1];
    if (!latestCandle) {
        return;
    }

    if (periodStart > latestCandle.time) {
        latestCandle = {
            time: periodStart,
            open: latestCandle.close,
            high: Math.max(latestCandle.close, livePrice),
            low: Math.min(latestCandle.close, livePrice),
            close: livePrice,
            volume: 0
        };
        candles.push(latestCandle);
        return;
    }

    latestCandle.high = Math.max(latestCandle.high, livePrice);
    latestCandle.low = Math.min(latestCandle.low, livePrice);
    latestCandle.close = livePrice;
}

function setVisibleChartRange() {
    const chart = priceChartState.chart;
    const activeCandles = priceChartState.activeCandles;
    if (!chart || activeCandles.length === 0) {
        return;
    }

    const lastIndex = activeCandles.length - 1;
    const visibleBars = priceChartState.timeframe === 'daily' ? dailyChartBars : weeklyChartBars;
    chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, lastIndex - visibleBars + 1),
        to: lastIndex + 1
    });
}

function updateChartOhlc() {
    const ohlcElement = document.getElementById('chartOhlc');
    const activeCandles = priceChartState.activeCandles;
    const move = getCandleMove(activeCandles);
    updateChartMoveIndicator(move);
    if (!ohlcElement || !move) {
        return;
    }

    const { latest, change, percentChange } = move;
    const color = change >= 0 ? chartUpColor : chartDownColor;
    const sign = change >= 0 ? '+' : '';

    ohlcElement.style.color = color;
    ohlcElement.textContent = [
        `O${formatChartPrice(latest.open)}`,
        `H${formatChartPrice(latest.high)}`,
        `L${formatChartPrice(latest.low)}`,
        `C${formatChartPrice(latest.close)}`,
        `${sign}${formatChartPrice(change)} (${sign}${percentChange.toFixed(2)}%)`
    ].join(' ');
}

function updateChartMoveIndicator(move) {
    const indicator = document.getElementById('chartMoveIndicator');
    if (!indicator) {
        return;
    }

    if (!move) {
        indicator.textContent = '--';
        indicator.classList.remove('is-up', 'is-down');
        indicator.removeAttribute('aria-label');
        return;
    }

    const isUp = move.change >= 0;
    const sign = isUp ? '+' : '';
    const percentText = `${sign}${move.percentChange.toFixed(2)}%`;
    indicator.textContent = percentText;
    indicator.setAttribute('aria-label', `Active chart move ${percentText}`);
    indicator.classList.toggle('is-up', isUp);
    indicator.classList.toggle('is-down', !isUp);
}

function formatChartPrice(price) {
    return Number(price).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatEur(value, digits = 2) {
    return `€ ${formatNumber(value, digits)}`;
}

function formatSignedEur(value, digits = 2) {
    const sign = value >= 0 ? '+' : '-';
    return `${sign}${formatEur(Math.abs(value), digits)}`;
}

function formatBtc(value, digits = 4) {
    return `₿ ${formatNumber(value, digits)}`;
}

function formatSats(btcValue) {
    return formatNumber(btcValue * 100000000, 0);
}

function formatNumber(value, digits = 0) {
    return Number(value).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });
}

function setChartStatus(message) {
    const status = document.getElementById('chartStatus');
    if (!status) {
        return;
    }

    status.textContent = message;
    status.hidden = !message;
}
