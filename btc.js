const lightweightChartsScriptUrl = 'vendor/lightweight-charts.standalone.production.js?v=5.2.0';
const chartHistoryMonths = 24;
const weeklyChartBars = Math.ceil((chartHistoryMonths * 365.25) / 12 / 7);
const dailyChartBars = Math.ceil(chartHistoryMonths * 365.25 / 12);
const coinbaseDailyCandleLimit = 290;
const dayInSeconds = 86400;
const candleCacheTtlMs = 3 * 60 * 60 * 1000;
const candleCacheKey = `shorty:BTC-EUR:daily-candles:${chartHistoryMonths}m:v1`;
let sellPrice = 92000; // sell price in EUR
let currentEurHoldings = 342000; // current EUR holdings
let holdingsInputDebounceId;
let shortEntryInputDebounceId;
let hasLoadedPriceChart = false;
let hasPreloadedPriceChart = false;
let lightweightChartsLoadPromise;
let priceChartState = {
    chart: null,
    candlestickSeries: null,
    volumeSeries: null,
    entryPriceLine: null,
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

async function evaluateShortTrade(sellPrice, currentEurHoldings) {
    const btcPrice = await getBTCPriceEUR();
    // BTC bought back = current EUR holdings / current BTC price
    const btcBoughtBack = currentEurHoldings / btcPrice;
    // BTC originally sold = current EUR holdings / sell price
    const btcSold = currentEurHoldings / sellPrice;
    // If btcBoughtBack > btcSold, the short was successful
    const wasSuccessful = btcBoughtBack > btcSold;
    // BTC gained or lost
    const btcDelta = btcBoughtBack - btcSold;
    
    // Calculate profit or loss percentage
    // Profit/Loss % = (btcDelta / btcSold) * 100
    const profitLossPercent = parseFloat(((btcDelta / btcSold) * 100).toFixed(2));

    return {
        btcBoughtBack,
        wasSuccessful,
        btcDelta,
        btcPrice,
        profitLossPercent
    };
}

async function updateTradeInfo() {
    try {
        syncCurrentEurHoldingsFromInput();
        syncSellPriceFromInput();
        // 348390.65 is the EUR holdings with interest exluding tax the above is including tax
        const result = await evaluateShortTrade(sellPrice, currentEurHoldings);
        const color = result.wasSuccessful ? '#22c55e' : '#ef4444';
        const plusminus = result.wasSuccessful ? '+' : '';

        // Update the text content of the elements with the results
        document.getElementById('delta').textContent = plusminus + result.btcDelta.toFixed(4);
        document.getElementById('total').textContent = '₿ ' + result.btcBoughtBack.toFixed(4);
        document.getElementById('currentPrice').textContent = '€ ' + result.btcPrice;
        document.getElementById('percent').textContent = plusminus + result.profitLossPercent + '%';
        updateLiveChartPrice(result.btcPrice);
        
        // Change the color of the text based on success or failure of the trade
        document.getElementById('delta').style.color = color;
        document.getElementById('total').style.color = color;
        document.getElementById('currentPrice').style.color = color;
        document.getElementById('percent').style.color = color;

        console.log('Trade info updated');
        return result;
    } catch (err) {
        document.getElementById('delta').textContent = 'Error';
        document.getElementById('total').textContent = 'Error';
        document.getElementById('currentPrice').textContent = 'Error';
        document.getElementById('percent').textContent = 'Error';
        console.error(err);
        return null;
    }
}

function syncCurrentEurHoldingsFromInput() {
    const input = document.getElementById('currentEurHoldings');
    if (!input) {
        return currentEurHoldings;
    }

    if (input.value.trim() === '') {
        return currentEurHoldings;
    }

    const nextValue = Number(input.value);
    if (Number.isFinite(nextValue) && nextValue > 0) {
        currentEurHoldings = nextValue;
    }

    return currentEurHoldings;
}

function syncSellPriceFromInput() {
    const input = document.getElementById('shortEntryPrice');
    if (!input) {
        return sellPrice;
    }

    if (input.value.trim() === '') {
        return sellPrice;
    }

    const nextValue = Number(input.value);
    if (Number.isFinite(nextValue) && nextValue > 0) {
        sellPrice = nextValue;
    }

    return sellPrice;
}

function setupHoldingsInput(onChange) {
    const input = document.getElementById('currentEurHoldings');
    if (!input) {
        return;
    }

    input.value = String(Math.round(currentEurHoldings));
    input.addEventListener('input', () => {
        syncCurrentEurHoldingsFromInput();
        window.clearTimeout(holdingsInputDebounceId);
        holdingsInputDebounceId = window.setTimeout(onChange, 350);
    });
}

function setupShortEntryInput(onChange) {
    const input = document.getElementById('shortEntryPrice');
    if (!input) {
        return;
    }

    input.value = String(Math.round(sellPrice));
    input.addEventListener('input', () => {
        syncSellPriceFromInput();
        updateEntryPriceLine();
        window.clearTimeout(shortEntryInputDebounceId);
        shortEntryInputDebounceId = window.setTimeout(onChange, 350);
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
    chartHost.classList.add('is-loading');
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
        chartHost.classList.remove('is-loading');
    } catch (err) {
        hasLoadedPriceChart = false;
        chartHost.classList.remove('is-loading');
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
    return candles
        .map(([time, low, high, open, close, volume]) => ({
            time: Number(time),
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume)
        }))
        .filter((candle) => (
            Number.isFinite(candle.time)
            && Number.isFinite(candle.open)
            && Number.isFinite(candle.high)
            && Number.isFinite(candle.low)
            && Number.isFinite(candle.close)
            && Number.isFinite(candle.volume)
        ))
        .filter((candle, index, allCandles) => (
            allCandles.findIndex((candidate) => candidate.time === candle.time) === index
        ))
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

    const LightweightCharts = window.LightweightCharts;
    const chart = LightweightCharts.createChart(chartElement, {
        autoSize: true,
        layout: {
            background: { type: 'solid', color: '#0f0f10' },
            textColor: '#b8b8bd',
            fontFamily: 'Arial, sans-serif'
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.06)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.06)' }
        },
        rightPriceScale: {
            autoScale: true,
            borderColor: 'rgba(255, 255, 255, 0.08)',
            scaleMargins: {
                top: 0.08,
                bottom: 0.18
            }
        },
        timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.08)',
            timeVisible: false,
            secondsVisible: false
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode?.Normal ?? 0
        },
        localization: {
            priceFormatter: (price) => formatChartPrice(price)
        }
    });

    const candlestickSeries = addChartSeries(chart, 'candlestick', {
        upColor: '#4aa38c',
        downColor: '#ef5350',
        borderUpColor: '#4aa38c',
        borderDownColor: '#ef5350',
        wickUpColor: '#4aa38c',
        wickDownColor: '#ef5350',
        priceLineColor: '#ef5350',
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
    updateEntryPriceLine();
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

function updateEntryPriceLine() {
    const { candlestickSeries } = priceChartState;
    if (!candlestickSeries) {
        return;
    }

    if (priceChartState.entryPriceLine) {
        candlestickSeries.removePriceLine(priceChartState.entryPriceLine);
    }

    const dottedLineStyle = window.LightweightCharts?.LineStyle?.Dotted ?? 1;
    priceChartState.entryPriceLine = candlestickSeries.createPriceLine({
        price: sellPrice,
        color: '#ef5350',
        lineWidth: 1,
        lineStyle: dottedLineStyle,
        axisLabelVisible: true,
        title: 'Short entry'
    });
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
    if (!ohlcElement || activeCandles.length === 0) {
        return;
    }

    const latest = activeCandles[activeCandles.length - 1];
    const previous = activeCandles[activeCandles.length - 2] ?? latest;
    const change = latest.close - previous.close;
    const percentChange = previous.close ? (change / previous.close) * 100 : 0;
    const color = change >= 0 ? '#4aa38c' : '#ef5350';
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

function formatChartPrice(price) {
    return Number(price).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
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
