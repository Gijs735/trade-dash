import { readFile, writeFile } from 'node:fs/promises';
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
    const filings = await getCandidateFilings(current);
    let next = current;
    let applied = 0;

    for (const filing of filings) {
        const html = await fetchText(filing.url);
        const update = parseStrategyFiling(html);
        if (!update) {
            continue;
        }

        next = applyFilingUpdate(next, filing, update);
        applied += 1;
    }

    if (!applied) {
        console.log(`Strategy inputs already current at ${current.source?.filingDate || 'unknown date'}.`);
        return;
    }

    if (dryRun) {
        console.log(JSON.stringify(next, null, 2));
        return;
    }

    await writeFile(inputsPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Updated Strategy inputs through ${next.source.filingDate} (${next.source.accessionNumber}).`);
}

async function readCurrentInputs() {
    return JSON.parse(await readFile(inputsPath, 'utf8'));
}

async function getCandidateFilings(current) {
    const overrideUrl = getArgValue('--filing-url');
    if (overrideUrl) {
        return [{
            accessionNumber: getArgValue('--accession') || `manual-${Date.now()}`,
            filingDate: getArgValue('--filing-date') || new Date().toISOString().slice(0, 10),
            reportDate: getArgValue('--report-date') || '',
            url: overrideUrl
        }];
    }

    const appliedFilings = new Set(current.appliedFilings || []);
    const currentFilingDate = current.source?.filingDate || '0000-00-00';
    return (await fetchAtomFilings())
        .filter((filing) => filing.form === '8-K')
        .filter((filing) => filing.filingDate >= currentFilingDate)
        .filter((filing) => !appliedFilings.has(filing.accessionNumber))
        .sort((a, b) => (
            a.filingDate.localeCompare(b.filingDate)
            || a.accessionNumber.localeCompare(b.accessionNumber)
        ));
}

async function fetchAtomFilings() {
    const atom = await fetchText(atomFeedUrl, 'application/atom+xml');
    return [...atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
        .map(([, entry]) => ({
            accessionNumber: tagText(entry, 'accession-number'),
            filingDate: tagText(entry, 'filing-date'),
            reportDate: '',
            form: tagText(entry, 'filing-type'),
            indexUrl: decodeXml(tagText(entry, 'filing-href'))
        }))
        .filter((filing) => filing.accessionNumber && filing.filingDate && filing.indexUrl)
        .map((filing) => ({
            ...filing,
            url: filingDocumentUrl(filing.indexUrl)
        }));
}

function filingDocumentUrl(indexUrl) {
    const accessionPath = indexUrl.match(/\/Archives\/edgar\/data\/\d+\/\d+\//)?.[0];
    const accessionNumber = indexUrl.match(/(\d{10}-\d{2}-\d{6})-index\.htm/)?.[1];
    if (!accessionPath || !accessionNumber) {
        throw new Error(`Could not derive filing document URL from ${indexUrl}`);
    }

    return `https://www.sec.gov${accessionPath}${accessionNumber}.txt`;
}

async function fetchText(url, accept = 'text/html') {
    const response = await fetch(url, { headers: secHeaders(accept) });
    if (!response.ok) {
        throw new Error(`SEC filing request failed ${response.status}: ${url}`);
    }
    return response.text();
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
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'");
}

function parseStrategyFiling(html) {
    const text = htmlToText(html);
    if (!text.includes('BTC Update') || !text.includes('Aggregate BTC Holdings')) {
        return null;
    }

    const btcSection = sliceBetween(text, 'BTC Update', 'Repurchase Program Updates');
    const cashSection = sliceBetween(text, 'USD Reserve and USD Cash Updates', 'Item 7.01');
    const atmSection = sliceBetween(text, 'ATM Update', 'BTC Update');
    const repurchaseSection = sliceBetween(text, 'Repurchase Program Updates', 'USD Reserve and USD Cash Updates');

    const update = {
        reportDate: parseReportDate(text),
        btcHoldings: parseBtcHoldings(btcSection),
        usdAssets: parseUsdAssets(cashSection),
        preferredIssuedUsd: parsePreferredIssued(atmSection),
        preferredRepurchasedUsd: parsePreferredRepurchased(repurchaseSection),
        mstrSharesSold: parseMstrShares(atmSection),
        mstrSharesRepurchased: parseMstrShares(repurchaseSection)
    };

    if (!update.btcHoldings) {
        throw new Error('Strategy BTC update found, but aggregate BTC holdings could not be parsed.');
    }

    return update;
}

function applyFilingUpdate(current, filing, update) {
    const appliedFilings = [...new Set([...(current.appliedFilings || []), filing.accessionNumber])].slice(-40);

    return {
        btcHoldings: update.btcHoldings ?? current.btcHoldings,
        usdAssets: update.usdAssets ?? current.usdAssets,
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
}

function parseBtcHoldings(section) {
    const match = section.match(/Average Purchase Price\s+\(2\)\s+([\d,]+)\s+\$\s+[\d,.]+\s+\$\s+[\d,.]+\s+([\d,]+)/);
    return match ? parseInteger(match[2]) : null;
}

function parseUsdAssets(section) {
    const match = section.match(/USD Reserve and USD Cash were\s+\$([\d,.]+)\s+(million|billion)\s+and\s+\$([\d,.]+)\s+(million|billion)/i);
    if (!match) {
        return null;
    }
    return parseScaledNumber(match[1], match[2]) + parseScaledNumber(match[3], match[4]);
}

function parsePreferredIssued(section) {
    return sumStockDollars(section, ['STRF', 'STRC', 'STRK', 'STRD'], 1);
}

function parsePreferredRepurchased(section) {
    return sumStockDollars(section, ['STRF', 'STRC', 'STRK', 'STRD'], 1);
}

function parseMstrShares(section) {
    const match = section.match(/MSTR Stock(?:\s+\(\d+\))?\s+([\d,]+|-)/);
    return match ? parseInteger(match[1]) : 0;
}

function sumStockDollars(section, symbols, dollarColumn) {
    return symbols.reduce((sum, symbol) => {
        const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = section.match(new RegExp(`${escapedSymbol} Stock(?:\\s+\\(\\d+\\))?\\s+[\\d,\\-]+\\s+\\$\\s+([\\d,.\\-]+)(?:\\s+\\$\\s+([\\d,.\\-]+))?`));
        const value = match ? parseMoneyCell(match[dollarColumn]) : 0;
        return sum + value;
    }, 0);
}

function parseReportDate(text) {
    const match = text.match(/Date of Report \(Date of earliest event reported\):\s+([A-Z][a-z]+ \d{1,2}, \d{4})/);
    return match ? toIsoDate(match[1]) : '';
}

function parseInteger(value) {
    return value && value !== '-' ? Number(value.replaceAll(',', '')) : 0;
}

function parseMoneyCell(value) {
    return value && value !== '-' ? Number(value.replaceAll(',', '')) * million : 0;
}

function parseScaledNumber(value, scale) {
    return Number(value.replaceAll(',', '')) * (scale.toLowerCase() === 'billion' ? billion : million);
}

function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<\/p>|<\/td>|<\/tr>|<\/table>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#160;|&nbsp;/g, ' ')
        .replace(/&#8217;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function sliceBetween(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    if (start === -1) {
        return '';
    }
    const end = text.indexOf(endMarker, start + startMarker.length);
    return end === -1 ? text.slice(start) : text.slice(start, end);
}

function toIsoDate(dateText) {
    const parsed = new Date(`${dateText} UTC`);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function getArgValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? '' : process.argv[index + 1] || '';
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
