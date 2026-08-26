const closedTrades = [
    {
        kind: 'usdStock',
        name: 'STRC trade',
        symbol: 'STRC',
        purchaseDate: '2026-06-17',
        saleDate: '2026-08-21',
        saleEurUsdRate: 1.1699,
        entry: {
            shares: 4360,
            priceUsd: 90.99,
            eurUsdRate: 1.1594
        },
        saleLots: [
            { shares: 3419, priceUsd: 95.69 },
            { shares: 941, priceUsd: 95.62 }
        ],
        commissionUsd: 34.86,
        dividends: [
            { exDate: '2026-06-30', paymentDate: '2026-07-15', amountPerShareUsd: 0.47916667 },
            { exDate: '2026-07-15', paymentDate: '2026-07-31', amountPerShareUsd: 0.5 },
            { exDate: '2026-07-31', paymentDate: '2026-08-15', amountPerShareUsd: 0.5 },
            { exDate: '2026-08-14', paymentDate: '2026-08-31', amountPerShareUsd: 0.5 }
        ]
    },
    {
        kind: 'eurLending',
        name: 'Nexo EURx 2025-2026',
        startDateLabel: 'Jun 12-13, 2025',
        endDateLabel: 'Jun 12-13, 2026',
        entryAmountEur: 313865.45,
        exitAmountEur: 345385.04,
        durationLabel: '365 days',
        typeLabel: 'Lending'
    }
];

function updateTradeHistory() {
    renderTradeHistory();
}

function renderTradeHistory() {
    const tradeHistoryElement = document.getElementById('tradeHistoryList');
    if (!tradeHistoryElement) {
        return;
    }

    tradeHistoryElement.innerHTML = closedTrades
        .map((trade) => renderTradeCard(trade, evaluateClosedTrade(trade)))
        .join('');
}

function evaluateClosedTrade(trade) {
    if (trade.kind === 'eurLending') {
        return evaluateEurLending(trade);
    }

    return evaluateUsdStockTrade(trade);
}

function evaluateUsdStockTrade(trade) {
    const entryShares = trade.entry.shares;
    const entryCostUsd = entryShares * trade.entry.priceUsd;
    const entryCostEur = entryCostUsd / trade.entry.eurUsdRate;
    const grossSaleProceedsUsd = trade.saleLots.reduce((total, lot) => (
        total + lot.shares * lot.priceUsd
    ), 0);
    const netSaleProceedsUsd = grossSaleProceedsUsd - trade.commissionUsd;
    const grossAverageSalePriceUsd = grossSaleProceedsUsd / entryShares;
    const netAverageSalePriceUsd = netSaleProceedsUsd / entryShares;
    const dividendsUsd = trade.dividends.reduce((total, dividend) => (
        total + (dividend.amountPerShareUsd * entryShares)
    ), 0);
    const stockProfitUsd = netSaleProceedsUsd - entryCostUsd;
    const totalProfitUsd = stockProfitUsd + dividendsUsd;
    const currentUsdValue = netSaleProceedsUsd + dividendsUsd;
    const profitLossEur = (currentUsdValue / trade.saleEurUsdRate) - entryCostEur;

    return {
        entryCostUsd,
        entryCostEur,
        grossSaleProceedsUsd,
        netSaleProceedsUsd,
        grossAverageSalePriceUsd,
        netAverageSalePriceUsd,
        dividendsUsd,
        stockProfitUsd,
        totalProfitUsd,
        profitLossEur,
        profitPercentUsd: (totalProfitUsd / entryCostUsd) * 100,
        profitPercentEur: profitLossEur === null ? null : (profitLossEur / entryCostEur) * 100,
        saleEurUsdRate: trade.saleEurUsdRate
    };
}

function evaluateEurLending(trade) {
    const profitEur = trade.exitAmountEur - trade.entryAmountEur;
    const profitPercent = (profitEur / trade.entryAmountEur) * 100;

    return {
        profitEur,
        profitPercent
    };
}

function renderTradeCard(trade, result) {
    if (trade.kind === 'eurLending') {
        return renderEurLendingCard(trade, result);
    }

    return renderUsdStockTradeCard(trade, result);
}

function renderUsdStockTradeCard(trade, result) {
    const usdProfitClass = result.totalProfitUsd >= 0 ? 'is-profit' : 'is-loss';
    const eurProfitClass = result.profitLossEur === null
        ? ''
        : result.profitLossEur >= 0 ? 'is-profit' : 'is-loss';

    return `
        <article class="trade-card">
            <div class="trade-card-header">
                <div>
                    <p class="holdings-label">${trade.name}</p>
                    <p class="trade-card-subtitle">
                        Entry FX ${trade.entry.eurUsdRate.toFixed(4)} EUR/USD
                        · Sale FX ${result.saleEurUsdRate.toFixed(4)} EUR/USD (ECB)
                    </p>
                </div>
            </div>
            <div class="trade-metric-grid">
                <div class="trade-metric">
                    <p>Entry</p>
                    <h2>${formatUsd(trade.entry.priceUsd)}</h2>
                    <div class="trade-detail-list">
                        ${renderDetail('Date', formatDate(trade.purchaseDate))}
                        ${renderDetail('Shares', formatNumber(trade.entry.shares, 0))}
                        ${renderDetail('Cost', formatUsd(result.entryCostUsd))}
                    </div>
                </div>
                <div class="trade-metric">
                    <p>Exit</p>
                    <h2>${formatUsd(result.netAverageSalePriceUsd)}</h2>
                    <div class="trade-detail-list">
                        ${renderDetail('Date', formatDate(trade.saleDate))}
                        ${renderDetail('Proceeds', formatUsd(result.netSaleProceedsUsd))}
                        ${renderDetail('Commission', formatUsd(trade.commissionUsd), 'is-loss')}
                    </div>
                </div>
                <div class="trade-metric">
                    <p>Profit / loss</p>
                    <h2 class="${usdProfitClass}">${formatSignedUsd(result.totalProfitUsd)}</h2>
                    <div class="trade-detail-list">
                        ${renderDetail('EUR at sale', formatSignedEur(result.profitLossEur), eurProfitClass)}
                        ${renderDetail('Return', formatSignedPercent(result.profitPercentUsd), usdProfitClass)}
                        ${renderDetail('Dividends', formatUsd(result.dividendsUsd), 'is-profit')}
                    </div>
                </div>
            </div>
        </article>
    `;
}

function renderEurLendingCard(trade, result) {
    const profitClass = result.profitEur >= 0 ? 'is-profit' : 'is-loss';

    return `
        <article class="trade-card">
            <div class="trade-card-header">
                <div>
                    <p class="holdings-label">${trade.name}</p>
                    <p class="trade-card-subtitle">
                        ${trade.startDateLabel} to ${trade.endDateLabel}
                    </p>
                </div>
            </div>
            <div class="trade-metric-grid">
                <div class="trade-metric">
                    <p>Entry</p>
                    <h2>${formatEur(trade.entryAmountEur)}</h2>
                    <div class="trade-detail-list">
                        ${renderDetail('Date', trade.startDateLabel)}
                        ${renderDetail('Type', trade.typeLabel)}
                    </div>
                </div>
                <div class="trade-metric">
                    <p>Exit</p>
                    <h2>${formatEur(trade.exitAmountEur)}</h2>
                    <div class="trade-detail-list">
                        ${renderDetail('Unlock', trade.endDateLabel)}
                        ${renderDetail('Duration', trade.durationLabel)}
                    </div>
                </div>
                <div class="trade-metric">
                    <p>Profit</p>
                    <h2 class="${profitClass}">${formatSignedEurCode(result.profitEur)}</h2>
                    <div class="trade-detail-list trade-detail-list-top">
                        ${renderDetail('Return', formatSignedPercent(result.profitPercent), profitClass)}
                    </div>
                </div>
            </div>
        </article>
    `;
}

function renderDetail(label, value, valueClass = '') {
    return `
        <div class="trade-detail">
            <span>${label}</span>
            <strong class="${valueClass}">${value}</strong>
        </div>
    `;
}

function formatDate(isoDate) {
    return new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

function formatUsd(amount, decimals = 2) {
    if (!Number.isFinite(amount)) {
        return 'unavailable';
    }

    return `USD ${formatNumber(amount, decimals)}`;
}

function formatSignedUsd(amount) {
    if (!Number.isFinite(amount)) {
        return 'unavailable';
    }

    return `${amount >= 0 ? '+' : '-'}${formatUsd(Math.abs(amount))}`;
}

function formatSignedEur(amount) {
    if (!Number.isFinite(amount)) {
        return 'unavailable';
    }

    return `${amount >= 0 ? '+' : '-'}€ ${formatNumber(Math.abs(amount), 2)}`;
}

function formatSignedEurCode(amount) {
    if (!Number.isFinite(amount)) {
        return 'unavailable';
    }

    return `${amount >= 0 ? '+' : '-'}EUR ${formatNumber(Math.abs(amount), 2)}`;
}

function formatEur(amount) {
    if (!Number.isFinite(amount)) {
        return 'unavailable';
    }

    return `€ ${formatNumber(amount, 2)}`;
}

function formatSignedPercent(amount) {
    if (!Number.isFinite(amount)) {
        return 'unavailable';
    }

    return `${amount >= 0 ? '+' : '-'}${formatNumber(Math.abs(amount), 2)}%`;
}

function formatNumber(amount, decimals = 2) {
    return Number(amount).toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}
