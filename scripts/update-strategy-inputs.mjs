import { readFile, writeFile, rename } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const cik = '0001050446';
const atomFeedUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=8-K&owner=exclude&count=100&output=atom`;
const declaredUserAgent = process.env.SEC_USER_AGENT || 'trade-dash strategy-updater local';
const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const userAgent = declaredUserAgent.includes('Chrome/')
    ? declaredUserAgent
    : `${chromeUserAgent} ${declaredUserAgent}`;
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputsPath = resolve(rootDir, 'strategy-inputs.json');
const million = 1000000;
const billion = 1000000000;
const dryRun = process.argv.includes('--dry-run');

async function main() {
    validateUserAgent();
    const current = await readCurrentInputs();
    validateInputs(current);
    const filings = await getCandidateFilings(current);
    let next = current;
    let applied = 0;

    for (const filing of filings) {
        let update;
        try {
            await delay(200);
            update = parseStrategyFiling(await fetchText(filing.url));
        } catch (error) {
            throw new Error(`${filing.filingDate} (${filing.url}): ${error.message}`, { cause: error });
        }
        if (!update) {
            continue;
        }

        next = applyFilingUpdate(next, filing, update);
        console.log(`Parsed ${filing.filingDate}: ${next.btcHoldings} BTC, $${next.usdAssets} USD assets, $${next.preferred} preferred, ${next.dilutedShares} shares.`);
        applied += 1;
    }

    if (!applied) {
        console.log(`Strategy inputs already current at ${current.source?.filingDate || 'unknown date'}.`);
        if (Date.now() - Date.parse(current.source?.filingDate) > 10 * 86400000) {
            console.warn('::warning::No newer weekly Strategy update parsed; saved inputs are over 10 days old.');
        }
        return;
    }

    if (dryRun) {
        console.log(JSON.stringify(next, null, 2));
        return;
    }

    await writeFile(`${inputsPath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    await rename(`${inputsPath}.tmp`, inputsPath);
    console.log(`Updated Strategy inputs through ${next.source.filingDate} (${next.source.accessionNumber}).`);
}

async function readCurrentInputs() {
    return JSON.parse(await readFile(inputsPath, 'utf8'));
}

async function getCandidateFilings(current) {
    const overrideUrl = getArgValue('--filing-url');
    if (overrideUrl) {
        const accessionNumber = getArgValue('--accession') || overrideUrl.match(/\d{10}-\d{2}-\d{6}/)?.[0];
        if (!accessionNumber || !getArgValue('--filing-date')) {
            throw new Error('--filing-url requires --accession and --filing-date.');
        }
        if (current.appliedFilings?.includes(accessionNumber)) return [];
        if (getArgValue('--filing-date') < current.source.filingDate) {
            throw new Error('Cannot apply an older filing to the current inputs.');
        }
        return [{
            accessionNumber,
            filingDate: getArgValue('--filing-date'),
            reportDate: getArgValue('--report-date') || '',
            url: overrideUrl
        }];
    }

    const appliedFilings = new Set(current.appliedFilings || []);
    const currentFilingDate = current.source?.filingDate || '0000-00-00';
    return (await fetchAtomFilings(currentFilingDate))
        .filter((filing) => filing.form === '8-K')
        .filter((filing) => filing.filingDate >= currentFilingDate)
        .filter((filing) => !appliedFilings.has(filing.accessionNumber))
        .sort((a, b) => (
            a.filingDate.localeCompare(b.filingDate)
            || a.accessionNumber.localeCompare(b.accessionNumber)
        ));
}

export async function fetchAtomFilings(since, request = fetchText) {
    const filings = new Map();
    for (let start = 0; ; start += 100) {
        if (start) await delay(200);
        const atom = await request(`${atomFeedUrl}&start=${start}`, 'application/atom+xml');
        if (!/<feed\b/i.test(atom)) throw new Error('SEC returned an invalid filing feed.');
        const entries = parseAtomFilings(atom);
        if (!entries.length) {
            throw new Error(`SEC filing history ended before the saved filing date ${since}.`);
        }
        const previousSize = filings.size;
        for (const filing of entries) filings.set(filing.accessionNumber, filing);
        if (entries.some((filing) => filing.filingDate < since)) break;
        if (filings.size === previousSize) throw new Error('SEC filing pagination did not advance.');
    }
    return [...filings.values()];
}

function parseAtomFilings(atom) {
    return [...atom.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)]
        .map(([, entry]) => ({
            accessionNumber: tagText(entry, 'accession-number'),
            filingDate: tagText(entry, 'filing-date'),
            reportDate: '',
            form: tagText(entry, 'filing-type'),
            indexUrl: decodeXml(tagText(entry, 'filing-href'))
        }))
        .map((filing) => {
            if (!filing.accessionNumber || !filing.filingDate || !filing.indexUrl || !filing.form) {
                throw new Error('SEC feed entry is incomplete.');
            }
            return { ...filing, url: filingDocumentUrl(filing.indexUrl) };
        });
}

function filingDocumentUrl(indexUrl) {
    const accessionPath = indexUrl.match(/\/Archives\/edgar\/data\/\d+\/\d+\//)?.[0];
    const accessionNumber = indexUrl.match(/(\d{10}-\d{2}-\d{6})-index\.htm/)?.[1];
    if (!accessionPath || !accessionNumber) {
        throw new Error(`Could not derive filing document URL from ${indexUrl}`);
    }

    return `https://www.sec.gov${accessionPath}${accessionNumber}.txt`;
}

export async function fetchText(url, accept = 'text/html', request = fetch, wait = delay) {
    for (let attempt = 0; ; attempt += 1) {
        let response;
        try {
            response = await request(url, {
                headers: secHeaders(accept),
                signal: AbortSignal.timeout(30000)
            });
            if (response.ok) return await response.text();
            await response.body?.cancel();
        } catch (error) {
            if (attempt >= 3) throw new Error(`SEC request failed: ${url}`, { cause: error });
            response = undefined;
        }
        if ((response && ![403, 408, 429, 500, 502, 503, 504].includes(response.status)) || attempt >= 3) {
            throw new Error(`SEC filing request failed ${response?.status}: ${url}`);
        }
        const retryAfter = Number(response?.headers.get('retry-after')) * 1000;
        await wait(Math.min(30000, Math.max(1000 * 2 ** attempt, retryAfter || 0)));
    }
}

function secHeaders(accept) {
    return {
        'User-Agent': userAgent,
        'Accept-Encoding': 'gzip, deflate, br',
        Accept: accept
    };
}

function validateUserAgent() {
    const hasEmailContact = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(declaredUserAgent);
    const usesGithubNoreply = /@users\.noreply\.github\.com/i.test(declaredUserAgent);

    if (process.env.GITHUB_ACTIONS && (!hasEmailContact || usesGithubNoreply)) {
        throw new Error(
            'Set a SEC_USER_AGENT repository secret or variable with a real contact email, '
            + 'for example: trade-dash FinestBit you@example.com'
        );
    }
}

function tagText(xml, tagName) {
    return decodeXml(xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`))?.[1] || '').trim();
}

function decodeXml(value) {
    return value
        .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(
            code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
        ))
        .replace(/&nbsp;/gi, ' ')
        .replace(/&[mn]dash;/gi, '-')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'");
}

export function parseStrategyFiling(html) {
    // A complete SEC submission also contains exhibits and duplicate XBRL data.
    if (/<DOCUMENT>/i.test(html)) {
        html = html.match(/<DOCUMENT>\s*<TYPE>8-K\s[\s\S]*?<TEXT>([\s\S]*?)<\/TEXT>/i)?.[1];
        if (!html) throw new Error('Primary 8-K document missing from SEC submission.');
    }
    const text = htmlToText(html);
    if (!/BTC Updates?\b|Aggregate BTC Holdings|holds approximately [\d,]+ bitcoin/i.test(text)) {
        return null;
    }
    const tables = readTables(html);
    const sales = parseStockActivity(tables, 'Sold');
    const repurchases = parseStockActivity(tables, 'Repurchased');
    if (!sales.tables && !/did not sell any shares under its at-the-market offering program/i.test(text)) {
        throw new Error('ATM activity could not be determined.');
    }
    if (!repurchases.tables && !/did not repurchase any shares/i.test(text)) {
        throw new Error('Share repurchase activity could not be determined.');
    }
    const update = {
        reportDate: parseReportDate(text),
        btcHoldings: parseBtcHoldings(tables, text),
        usdAssets: parseUsdAssets(text),
        preferredIssuedUsd: sales.preferred,
        preferredRepurchasedUsd: repurchases.preferred,
        mstrSharesSold: sales.mstr,
        mstrSharesRepurchased: repurchases.mstr
    };

    if (!update.btcHoldings) {
        throw new Error('Strategy BTC update found, but aggregate BTC holdings could not be parsed.');
    }
    if (update.usdAssets === null) throw new Error('USD Reserve and USD Cash balances could not be parsed.');

    return update;
}

export function applyFilingUpdate(current, filing, update) {
    if (current.appliedFilings?.includes(filing.accessionNumber)) return current;
    if (filing.filingDate < current.source.filingDate) throw new Error('Cannot apply an older filing.');
    const appliedFilings = [...new Set([...(current.appliedFilings || []), filing.accessionNumber])].slice(-40);

    const next = {
        btcHoldings: update.btcHoldings,
        usdAssets: update.usdAssets,
        debt: current.debt,
        preferred: current.preferred + update.preferredIssuedUsd - update.preferredRepurchasedUsd,
        dilutedShares: current.dilutedShares + update.mstrSharesSold - update.mstrSharesRepurchased,
        source: {
            accessionNumber: filing.accessionNumber,
            filingDate: filing.filingDate,
            reportDate: update.reportDate || filing.reportDate,
            url: filing.url
        },
        appliedFilings,
        updatedAt: new Date().toISOString()
    };
    validateInputs(next);
    return next;
}

function validateInputs(inputs) {
    for (const key of ['btcHoldings', 'usdAssets', 'debt', 'preferred', 'dilutedShares']) {
        if (!Number.isFinite(inputs[key]) || inputs[key] < 0) throw new Error(`Invalid ${key} input.`);
    }
    if (!Number.isSafeInteger(inputs.btcHoldings) || !Number.isSafeInteger(inputs.dilutedShares)
        || inputs.btcHoldings === 0 || inputs.dilutedShares === 0) {
        throw new Error('BTC holdings and diluted shares must be positive integers.');
    }
}

function parseBtcHoldings(tables, text) {
    const snapshots = [];
    for (const rows of tables) {
        const headerIndex = rows.findIndex((row) => row.some((cell) => /^Aggregate BTC Holdings$/i.test(cell)));
        if (headerIndex < 0) continue;
        const column = rows[headerIndex].findIndex((cell) => /^Aggregate BTC Holdings$/i.test(cell));
        const values = rows[headerIndex + 1];
        if (!values || values.length !== rows[headerIndex].length) throw new Error('Unrecognized BTC holdings table.');
        const date = rows.flat().join(' ').match(/As of ([A-Z][a-z]+ \d{1,2}, \d{4})/i)?.[1];
        if (!date) throw new Error('BTC holdings table has no snapshot date.');
        snapshots.push({ date: toIsoDate(date), value: parseNumber(values[column]) });
    }
    for (const match of text.matchAll(/As of ([A-Z][a-z]+ \d{1,2}, \d{4}), Strategy holds approximately ([\d,]+) bitcoin/gi)) {
        snapshots.push({ date: toIsoDate(match[1]), value: parseNumber(match[2]) });
    }
    return snapshots.sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.value ?? null;
}

function parseUsdAssets(section) {
    const match = [...section.matchAll(/USD Reserve and USD Cash were\s+\$\s*([\d,.]+)\s+(million|billion)\s+and\s+\$\s*([\d,.]+)\s+(million|billion)/gi)].at(-1);
    if (!match) {
        return null;
    }
    return parseScaledNumber(match[1], match[2]) + parseScaledNumber(match[3], match[4]);
}

function parseStockActivity(tables, activity) {
    const total = { tables: 0, preferred: 0, mstr: 0 };
    for (const rows of tables) {
        const headerIndex = rows.findIndex((row) => row.includes(`Shares ${activity}`));
        if (headerIndex < 0) continue;
        total.tables += 1;
        const headers = rows[headerIndex];
        const sharesColumn = headers.indexOf(`Shares ${activity}`);
        const symbolColumn = headers.indexOf('Security');
        const symbols = new Set();
        for (const row of rows.slice(headerIndex + 1)) {
            const symbol = row[symbolColumn]?.match(/^([A-Z]+) Stock$/)?.[1];
            if (!symbol) continue;
            if (symbols.has(symbol) || row.length !== headers.length) throw new Error(`Unrecognized ${symbol} ${activity} row.`);
            symbols.add(symbol);
            const shares = parseNumber(row[sharesColumn]);
            if (!Number.isSafeInteger(shares)) throw new Error(`Invalid ${symbol} share count.`);
            if (symbol === 'MSTR') total.mstr += shares;
            else {
                // Net BTC deducts notional claims, not the cash paid to retire them.
                if (!['STRF', 'STRC', 'STRK', 'STRD'].includes(symbol) && shares) {
                    throw new Error(`Unknown preferred notional for ${symbol}.`);
                }
                total.preferred += shares * 100;
            }
        }
        for (const symbol of ['MSTR', 'STRF', 'STRC', 'STRK', 'STRD']) {
            if (!symbols.has(symbol)) throw new Error(`${symbol} missing from ${activity} table.`);
        }
    }
    return total;
}

function readTables(html) {
    // Ignore layout cells and standalone currency cells so headers align with values.
    return [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(([, table]) => (
        [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) => (
            [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
                .map(([, cell]) => htmlToText(cell).replace(/\(\d+\)/g, '').trim())
                .filter((cell) => cell && cell !== '$')
        )).filter((row) => row.length)
    ));
}

function parseReportDate(text) {
    const match = text.match(/Date of Report \(Date of earliest event reported\):\s+([A-Z][a-z]+ \d{1,2}, \d{4})/);
    return match ? toIsoDate(match[1]) : '';
}

function parseNumber(value) {
    const normalized = value?.replace(/^\$\s*/, '').replaceAll(',', '').trim();
    if (normalized === '-') return 0;
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error(`Invalid numeric cell: ${value}`);
    return Number(normalized);
}

function parseScaledNumber(value, scale) {
    return Number(value.replaceAll(',', '')) * (scale.toLowerCase() === 'billion' ? billion : million);
}

function htmlToText(html) {
    return decodeXml(html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<ix:hidden\b[\s\S]*?<\/ix:hidden>/gi, '')
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<\/p>|<\/td>|<\/tr>|<\/table>/gi, ' ')
        .replace(/<[^>]+>/g, ' '))
        .replace(/[\u2013\u2014\u2212]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function toIsoDate(dateText) {
    const parsed = new Date(`${dateText} UTC`);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function getArgValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? '' : process.argv[index + 1] || '';
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}
