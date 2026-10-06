import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { parseStrategyFiling, applyFilingUpdate, fetchAtomFilings, fetchText } from './update-strategy-inputs.mjs';

const baseline = {
    btcHoldings: 845050, usdAssets: 6710000000, debt: 6754000000,
    preferred: 14810282300, dilutedShares: 424431421,
    source: { filingDate: '2026-08-31', accessionNumber: '0001193125-26-375463' },
    appliedFilings: ['0001193125-26-375463']
};
// Values independently transcribed from the linked SEC filings. Repurchases are shares * $100 face value.
const cases = [
    ['2026-08-31', '375463', 845050, 6710000000, 155717700, 4531421],
    ['2026-09-08', '384402', 845050, 6540000000, 181088500, 0],
    ['2026-09-14', '389858', 845050, 6400000000, 142046700, 0],
    ['2026-09-21', '396093', 846000, 6090000000, 177123800, 0],
    ['2026-09-28', '403417', 847666, 6020000000, 153453000, 1469165],
    ['2026-10-05', '413164', 848000, 5713400000, 177380200, 92894]
];
const fixture = (date) => readFile(new URL(`fixtures/${date}.html`, import.meta.url), 'utf8');
const filing = ([date, id]) => ({
    filingDate: date,
    accessionNumber: `0001193125-26-${id}`,
    url: `https://www.sec.gov/Archives/edgar/data/1050446/000119312526${id}/0001193125-26-${id}.txt`
});

for (const [date, , btcHoldings, usdAssets, preferredRepurchasedUsd, mstrSharesSold] of cases) {
    test(`parses the real ${date} filing`, async () => {
        assert.deepEqual(parseStrategyFiling(await fixture(date)), {
            reportDate: date, btcHoldings, usdAssets, preferredRepurchasedUsd, mstrSharesSold,
            preferredIssuedUsd: 0, mstrSharesRepurchased: 0
        });
    });
}

test('ignores unrelated 8-Ks and duplicate exhibits in full SEC submissions', async () => {
    const html = await fixture('2026-10-05');
    assert.equal(parseStrategyFiling(await fixture('2026-09-01')), null);
    assert.deepEqual(parseStrategyFiling(
        `<DOCUMENT>\n<TYPE>8-K\n<TEXT>${html}</TEXT></DOCUMENT>`
        + `<DOCUMENT>\n<TYPE>EX-99.1\n<TEXT>${html}</TEXT></DOCUMENT>`
    ), parseStrategyFiling(html));
    assert.throws(() => parseStrategyFiling('<DOCUMENT><TYPE>EX-99.1\n<TEXT>wrong</TEXT>'), /Primary 8-K/);
});

test('accepts footnote changes, numeric entities, dash variants and currency whitespace', async () => {
    const html = await fixture('2026-08-31');
    const variant = html.replaceAll('(2)', '(12)').replaceAll('&#160;', '&#xA0;')
        .replaceAll('>-<', '>&mdash;<').replaceAll('$5.10', '$ 5.10');
    assert.deepEqual(parseStrategyFiling(variant), parseStrategyFiling(html));
});

test('uses the latest BTC snapshot even if the table order changes', async () => {
    const html = await fixture('2026-10-05');
    const tables = [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)]
        .map(([table]) => table).filter((table) => table.includes('Aggregate BTC Holdings'));
    assert.equal(tables.length, 2);
    assert.equal(parseStrategyFiling(html.replace(tables[0], '__FIRST__')
        .replace(tables[1], tables[0]).replace('__FIRST__', tables[1])).btcHoldings, 848000);
});

test('does not silently treat missing or malformed financial fields as zero', async () => {
    const html = await fixture('2026-10-05');
    for (const [from, to, message] of [
        ['848,000', 'not available', /numeric cell/],
        ['833.4 million', 'not available', /USD Reserve/],
        ['92,894', 'not available', /numeric cell/],
        ['740,634', '', /Unrecognized STRC/],
        ['STRC Stock', 'NEW Stock', /missing|Unknown preferred/],
        ['Shares Sold', 'Units Sold', /ATM activity/],
        ['Shares Repurchased', 'Units Repurchased', /repurchase activity/]
    ]) {
        assert.throws(() => parseStrategyFiling(html.replaceAll(from, to)), message);
    }
});

test('sums preferred issues and common repurchases at face value, independently of proceeds', () => {
    const table = (activity, rows) => `<table><tr><th>Security</th><th>Shares ${activity}</th>`
        + '<th>Notional Value (in millions)</th><th>Net Proceeds (in millions)</th></tr>'
        + ['STRF', 'STRC', 'STRK', 'STRD', 'MSTR'].map((symbol) =>
            `<tr><td>${symbol} Stock</td><td>${rows[symbol] || '-'}</td><td>$1</td><td>$0.9</td></tr>`
        ).join('') + '</table>';
    const update = parseStrategyFiling('BTC Update '
        + 'As of October 4, 2026, Strategy holds approximately 848,000 bitcoin. '
        + 'USD Reserve and USD Cash were $4.88 billion and $833.4 million. '
        + table('Sold', { STRC: 10000, STRK: 2000, MSTR: 500 })
        + table('Repurchased', { STRC: 300, MSTR: 20 }));
    assert.equal(update.preferredIssuedUsd, 1200000);
    assert.equal(update.preferredRepurchasedUsd, 30000);
    assert.equal(update.mstrSharesRepurchased, 20);
    assert.equal(update.mstrSharesSold, 500);
});

test('catches up missed weeks once and preserves manual debt edits', async () => {
    let current = { ...baseline, debt: 6000000000 };
    for (const row of cases.slice(1)) {
        const update = parseStrategyFiling(await fixture(row[0]));
        current = applyFilingUpdate(current, filing(row), update);
        assert.equal(applyFilingUpdate(current, filing(row), update), current);
    }
    assert.equal(current.btcHoldings, 848000);
    assert.equal(current.usdAssets, 5713400000);
    assert.equal(current.preferred, 13979190100);
    assert.equal(current.dilutedShares, 425993480);
    assert.equal(current.debt, 6000000000);
    assert.throws(() => applyFilingUpdate(current, { filingDate: '2026-08-01' }, {}), /older/);
    assert.throws(() => applyFilingUpdate(current, { filingDate: '2026-10-06' }, {
        btcHoldings: 848000, usdAssets: 1, preferredIssuedUsd: 0,
        preferredRepurchasedUsd: 1e12, mstrSharesSold: 0, mstrSharesRepurchased: 0
    }), /Invalid preferred/);
});

function atom(rows) {
    return '<feed>' + rows.map((row) => {
        const f = filing(row);
        return `<entry><accession-number>${f.accessionNumber}</accession-number>`
            + `<filing-date>${f.filingDate}</filing-date><filing-type>8-K</filing-type>`
            + `<filing-href>${f.url.replace('.txt', '-index.htm')}</filing-href></entry>`;
    }).join('') + '</feed>';
}

test('paginates filing history until the saved date is covered', async () => {
    const urls = [];
    const result = await fetchAtomFilings('2026-09-08', async (url) => {
        urls.push(url);
        return urls.length === 1 ? atom(cases.slice(2).reverse()) : atom(cases.slice(0, 2).reverse());
    });
    assert.equal(result.length, 6);
    assert.match(urls[1], /start=100/);
    await assert.rejects(fetchAtomFilings('2026-08-01', async () => atom(cases)), /did not advance/);
    await assert.rejects(fetchAtomFilings('2026-08-01', async () => '<feed></feed>'), /history ended/);
    await assert.rejects(fetchAtomFilings('2026-08-01', async () => '<html>Blocked</html>'), /invalid filing feed/);
});

test('retries transient SEC failures and respects bounded Retry-After', async () => {
    let attempts = 0;
    const waits = [];
    const result = await fetchText('https://example.test', 'text/html', async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('connection reset');
        if (attempts === 2) return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
        if (attempts === 3) return new Response('', { status: 503 });
        return new Response('ok');
    }, async (ms) => waits.push(ms));
    assert.equal(result, 'ok');
    assert.deepEqual(waits, [1000, 30000, 4000]);
    attempts = 0;
    await assert.rejects(fetchText('https://example.test', 'text/html', async () => {
        attempts += 1;
        return new Response('', { status: 403 });
    }, async () => {}), /403/);
    assert.equal(attempts, 4);
    await assert.rejects(fetchText('https://example.test', 'text/html', async () =>
        new Response('', { status: 404 }), async () => assert.fail('404 must not retry')), /404/);
});

test('CLI dry run, catch-up, rerun and failed batch preserve correct state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strategy-updater-'));
    try {
        await mkdir(join(dir, 'scripts'));
        await copyFile(new URL('update-strategy-inputs.mjs', import.meta.url), join(dir, 'scripts/update-strategy-inputs.mjs'));
        const inputs = join(dir, 'strategy-inputs.json');
        const initial = JSON.stringify(baseline);
        await writeFile(inputs, initial);
        const responses = Object.fromEntries(await Promise.all(cases.map(async (row) => [filing(row).url, await fixture(row[0])])));
        const feed = atom([...cases].reverse().concat([['2026-08-24', '361845']]));
        const mock = join(dir, 'mock.mjs');
        await writeFile(mock, `const responses = ${JSON.stringify(responses)};
            globalThis.fetch = async (url) => {
                if (url.includes('browse-edgar')) return new Response(${JSON.stringify(feed)});
                let html = responses[url];
                if (!html) throw new Error('Unexpected URL: ' + url);
                if (process.env.BREAK_FILING) html = html.replace('848,000', 'invalid');
                return new Response(html);
            };`);
        const run = (...args) => promisify(execFile)(process.execPath,
            ['--import', mock, join(dir, 'scripts/update-strategy-inputs.mjs'), ...args],
            { env: { ...process.env, SEC_USER_AGENT: 'trade-dash tests test@example.com' } });
        await run('--dry-run');
        assert.equal(await readFile(inputs, 'utf8'), initial);
        await run();
        const saved = await readFile(inputs, 'utf8');
        assert.equal(JSON.parse(saved).preferred, 13979190100);
        assert.equal(JSON.parse(saved).source.filingDate, '2026-10-05');
        await run();
        assert.equal(await readFile(inputs, 'utf8'), saved);
        await writeFile(inputs, initial);
        await assert.rejects(promisify(execFile)(process.execPath,
            ['--import', mock, join(dir, 'scripts/update-strategy-inputs.mjs')],
            { env: { ...process.env, BREAK_FILING: '1', SEC_USER_AGENT: 'trade-dash tests test@example.com' } }),
        /2026-10-05.*413164/);
        assert.equal(await readFile(inputs, 'utf8'), initial);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('browser keeps last good inputs on outages and never falls back to August', async () => {
    const context = vm.createContext({ window: {}, console: { warn() {} }, Date, fetch: async () => { throw new Error('offline'); } });
    vm.runInContext(await readFile(new URL('../btc.js', import.meta.url), 'utf8'), context);
    assert.equal(await vm.runInContext('getStrategyMnavInputs()', context), null);
    context.fetch = async (_, options) => {
        assert.equal(options.cache, 'no-store');
        return new Response(JSON.stringify(baseline));
    };
    const good = await vm.runInContext('getStrategyMnavInputs()', context);
    vm.runInContext('strategyInputsCache.fetchedAt = 0', context);
    context.fetch = async () => { throw new Error('offline'); };
    assert.equal(await vm.runInContext('getStrategyMnavInputs()', context), good);
    vm.runInContext(`getBTCPriceUSD = async () => 85000; getUsdEurRate = async () => 0.85;
        getMstrPriceUsd = async () => 170; strategyInputsCache = undefined;`, context);
    const result = await vm.runInContext('evaluateMstrPosition(3333, 123.70)', context);
    assert.equal(result.positionValueEur, 481618.5);
    assert.equal(result.mnav, null);
    assert.equal(result.netBtcPerShare, null);
    context.inputs = baseline;
    const metrics = vm.runInContext('calculateStrategyMnav(inputs, 170, 85000)', context);
    const netReserve = 845050 * 85000 + 6710000000 - 6754000000 - 14810282300;
    assert.equal(metrics.netBtcPerShare, netReserve / 424431421 / 85000);
    assert.equal(metrics.mnav, 170 / (netReserve / 424431421));
    const nodes = Object.fromEntries(['delta', 'deltaDetail', 'total', 'currentPrice', 'percent', 'percentDetail']
        .map((id) => [id, { style: {}, textContent: '' }]));
    context.document = { getElementById: (id) => nodes[id] };
    await vm.runInContext('updateTradeInfo()', context);
    assert.equal(nodes.delta.textContent, 'N/A');
    assert.equal(nodes.deltaDetail.textContent, '');
    assert.equal(nodes.currentPrice.textContent, '$170.00');
    assert.equal(nodes.percent.textContent, '+37.43%');
});
