const strcEntryPriceUsd = 90.99;
const strcOwnedShares = 4360;
const strcEntryEurUsdRate = 1.1594;
const strcPurchaseDate = '2026-06-17';
const strcDividendJsonUrl = '/strc-dividends.json';
const strcDividendCacheTtlMs = 5 * 60 * 1000;
let strcDividendScheduleCache;
let strcDividendScheduleFetchedAt = 0;
let strcDividendSchedulePromise;

async function updateStrcPositionWidget() {
    try {
        const [strcPriceUsd, currentEurUsdRate, dividendSchedule] = await Promise.all([
            getTradingViewStrcPriceUsd(),
            getCurrentEurUsdRate(),
            getStrcDividendSchedule()
        ]);
        const position = evaluateStrcPosition(strcPriceUsd, currentEurUsdRate, dividendSchedule);
        renderStrcPosition(position);
        return position;
    } catch (err) {
        renderStrcPositionError();
        console.error(err);
        return null;
    }
}

async function getTradingViewStrcPriceUsd() {
    const response = await fetch('https://scanner.tradingview.com/america/scan', {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
            symbols: {
                tickers: ['NASDAQ:STRC'],
                query: { types: [] }
            },
            columns: ['close', 'currency']
        })
    });
    if (!response.ok) {
        throw new Error(`STRC quote request failed. Status Code: ${response.status}`);
    }

    const json = await response.json();
    const row = json?.data?.[0]?.d;
    const price = Number(row?.[0]);
    const currency = row?.[1];
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error('STRC price not found in response');
    }
    if (currency !== 'USD') {
        throw new Error(`Unexpected STRC quote currency: ${currency}`);
    }

    return price;
}

async function getCurrentEurUsdRate() {
    try {
        return await getCoinbaseEurUsdRate();
    } catch (err) {
        console.warn('Coinbase EUR/USD unavailable, trying Kraken', err);
        return getKrakenEurUsdRate();
    }
}

async function getCoinbaseEurUsdRate() {
    const response = await fetch('https://api.coinbase.com/v2/prices/EUR-USD/spot');
    if (!response.ok) {
        throw new Error(`Coinbase EUR/USD request failed. Status Code: ${response.status}`);
    }

    const json = await response.json();
    const rate = Number(json?.data?.amount);
    if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error('Coinbase EUR/USD rate not found in response');
    }

    return rate;
}

async function getKrakenEurUsdRate() {
    const response = await fetch('https://api.kraken.com/0/public/Ticker?pair=EURUSD');
    if (!response.ok) {
        throw new Error(`Kraken EUR/USD request failed. Status Code: ${response.status}`);
    }

    const json = await response.json();
    const ticker = json?.result?.ZEURZUSD;
    const bid = Number(ticker?.b?.[0]);
    const ask = Number(ticker?.a?.[0]);
    const last = Number(ticker?.c?.[0]);
    const rate = Number.isFinite(bid) && Number.isFinite(ask)
        ? (bid + ask) / 2
        : last;
    if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error('Kraken EUR/USD rate not found in response');
    }

    return rate;
}

async function getStrcDividendSchedule() {
    if (
        strcDividendScheduleCache
        && Date.now() - strcDividendScheduleFetchedAt < strcDividendCacheTtlMs
    ) {
        return strcDividendScheduleCache;
    }

    if (!strcDividendSchedulePromise) {
        strcDividendSchedulePromise = fetchStrcDividendSchedule()
            .finally(() => {
                strcDividendSchedulePromise = null;
            });
    }

    return strcDividendSchedulePromise;
}

async function fetchStrcDividendSchedule() {
    const response = await fetch(strcDividendJsonUrl, { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`STRC dividends request failed. Status Code: ${response.status}`);
    }

    const json = await response.json();
    if (json?.symbol !== 'STRC' || !Array.isArray(json?.dividends)) {
        throw new Error('STRC dividends response is invalid');
    }

    const dividendSchedule = json.dividends
        .map(normalizeStrcDividend)
        .filter(Boolean);
    strcDividendScheduleCache = dividendSchedule;
    strcDividendScheduleFetchedAt = Date.now();
    return dividendSchedule;
}

function normalizeStrcDividend(dividend) {
    const amountUsd = Number(dividend?.amountUsd);
    if (
        !isIsoDate(dividend?.exDividendDate)
        || !isIsoDate(dividend?.paymentDate)
        || !Number.isFinite(amountUsd)
        || amountUsd <= 0
    ) {
        return null;
    }

    return {
        exDividendDate: dividend.exDividendDate,
        paymentDate: dividend.paymentDate,
        amountUsd
    };
}

function isIsoDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function evaluateStrcPosition(currentPriceUsd, currentEurUsdRate, dividendSchedule) {
    const costBasisEur = (strcEntryPriceUsd * strcOwnedShares) / strcEntryEurUsdRate;
    const currentValueEur = (currentPriceUsd * strcOwnedShares) / currentEurUsdRate;
    const dividendsReceived = getStrcDividendsReceived(currentEurUsdRate, dividendSchedule);
    const adjustedCostBasisEur = costBasisEur - dividendsReceived.totalEur;
    const profitLossEur = currentValueEur - adjustedCostBasisEur;
    const profitLossPercent = adjustedCostBasisEur === 0 ? 0 : (profitLossEur / adjustedCostBasisEur) * 100;

    return {
        currentPriceUsd,
        currentEurUsdRate,
        profitLossEur,
        profitLossPercent,
        dividendsReceived
    };
}

function getStrcDividendsReceived(currentEurUsdRate, dividendSchedule) {
    const today = getLocalDateString();
    const receivedDividends = dividendSchedule.filter((dividend) => (
        dividend.exDividendDate >= strcPurchaseDate
        && dividend.paymentDate <= today
    ));
    const totalUsd = receivedDividends.reduce((total, dividend) => (
        total + (dividend.amountUsd * strcOwnedShares)
    ), 0);

    return {
        count: receivedDividends.length,
        totalUsd,
        totalEur: totalUsd / currentEurUsdRate
    };
}

function getLocalDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function renderStrcPosition(position) {
    const currentPriceElement = document.getElementById('strcCurrentPrice');
    const profitLossElement = document.getElementById('strcProfitLoss');
    const profitLossPercentElement = document.getElementById('strcProfitLossPercent');
    const dividendsReceivedElement = document.getElementById('strcDividendsReceived');
    const fxRateElement = document.getElementById('strcFxRate');

    if (!currentPriceElement || !profitLossElement || !profitLossPercentElement || !dividendsReceivedElement || !fxRateElement) {
        return;
    }

    const isProfit = position.profitLossEur >= 0;
    currentPriceElement.textContent = formatUsd(position.currentPriceUsd);
    profitLossElement.textContent = formatSignedEur(position.profitLossEur);
    profitLossPercentElement.textContent = `${isProfit ? '+' : ''}${position.profitLossPercent.toFixed(2)}%`;
    dividendsReceivedElement.textContent = `(Div: ${formatEur(position.dividendsReceived.totalEur)})`;
    dividendsReceivedElement.classList.toggle('has-dividends', position.dividendsReceived.totalEur > 0);
    fxRateElement.textContent = `${position.currentEurUsdRate.toFixed(4)} EUR/USD`;
    fxRateElement.classList.toggle('is-favorable', position.currentEurUsdRate <= strcEntryEurUsdRate);
    fxRateElement.classList.toggle('is-unfavorable', position.currentEurUsdRate > strcEntryEurUsdRate);
    profitLossElement.classList.toggle('is-profit', isProfit);
    profitLossElement.classList.toggle('is-loss', !isProfit);
}

function renderStrcPositionError() {
    const currentPriceElement = document.getElementById('strcCurrentPrice');
    const profitLossElement = document.getElementById('strcProfitLoss');
    const profitLossPercentElement = document.getElementById('strcProfitLossPercent');
    const dividendsReceivedElement = document.getElementById('strcDividendsReceived');
    const fxRateElement = document.getElementById('strcFxRate');

    if (currentPriceElement) {
        currentPriceElement.textContent = 'Error';
    }
    if (profitLossElement) {
        profitLossElement.textContent = 'Error';
        profitLossElement.classList.remove('is-profit', 'is-loss');
    }
    if (profitLossPercentElement) {
        profitLossPercentElement.textContent = '';
    }
    if (dividendsReceivedElement) {
        dividendsReceivedElement.textContent = '';
        dividendsReceivedElement.classList.remove('has-dividends');
    }
    if (fxRateElement) {
        fxRateElement.textContent = 'unavailable';
        fxRateElement.classList.remove('is-favorable', 'is-unfavorable');
    }
}

function formatUsd(amount) {
    return `USD ${Number(amount).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

function formatSignedEur(amount) {
    const sign = amount >= 0 ? '+' : '-';
    return `${sign}${formatEur(Math.abs(amount))}`;
}

function formatEur(amount) {
    return `€ ${Number(amount).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}
