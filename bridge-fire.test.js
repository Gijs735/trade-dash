const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const fixedNow = new Date(2026, 6, 19);

class FixedDate extends Date {
    constructor(...args) {
        if (args.length === 0) {
            super(fixedNow.getTime());
            return;
        }
        super(...args);
    }

    static now() {
        return fixedNow.getTime();
    }
}

function loadCalculator(initialStorage = null) {
    const storage = new Map(initialStorage ? [['bridgeFire:settings:v1', JSON.stringify(initialStorage)]] : []);
    const context = {
        console,
        Intl,
        Date: FixedDate,
        Math,
        Number,
        String,
        Boolean,
        RegExp,
        JSON,
        Array,
        Object,
        Set,
        Map,
        document: {
            querySelectorAll: () => [],
            getElementById: () => null
        },
        localStorage: {
            getItem: (key) => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value)
        }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('bridge-fire.js', 'utf8'), context);
    return {
        calc: context.bridgeFireCalculator,
        storage
    };
}

function month(date) {
    return date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : null;
}

function approx(actual, expected, tolerance = 0.01) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`);
}

function recordFor(result, yearMonth) {
    return result.records.find((record) => month(record.date) === yearMonth);
}

const { calc } = loadCalculator();
const today = new FixedDate(2026, 6, 19);

assert.equal(calc.completedLoanPayments(today), 31);
approx(calc.loanBalanceOnDate(today), 196931.55);
assert.equal(calc.completedLoanPayments(new FixedDate(2026, 6, 23)), 32);
approx(calc.loanBalanceAfterPayments(299), 0);

const defaults = calc.defaultSettings;
assert.equal(defaults.prePayoffRent, defaults.mortgagePayment);
assert.equal(defaults.cashReserveYears, 3);
assert.equal(defaults.cashReturnPercent, 2);
assert.equal(defaults.inflationPercent, 3);
assert.equal(defaults.lifeExpectancyAge, 100);

const defaultResult = calc.evaluateBridgeFire(defaults, { today });
assert.equal(month(defaultResult.earliestFireMonth), '2032-12');
assert.equal(month(defaultResult.fireMonth), '2032-12');
assert.equal(defaultResult.success, true);
assert.equal(defaultResult.inheritanceTrigger.parent, 'mom');
assert.equal(defaultResult.inheritanceTrigger.label, 'Mom');
assert.equal(month(defaultResult.inheritanceMonth), '2060-03');
approx(defaultResult.currentLoanBalance, 196931.55);
approx(defaultResult.currentApartmentEquity, 100068.45);
approx(defaultResult.currentNetWorth, 442068.45);
assert.ok(defaultResult.requiredLiquidAtFireFuture > defaultResult.requiredLiquidAtFire);
assert.ok(defaultResult.requiredLiquidAtFireFuture > recordFor(defaultResult, month(defaultResult.fireMonth)).liquid);
assert.ok(defaultResult.requiredLiquidAtFireFuture < defaultResult.projectedLiquidAtFireFuture);
assert.match(recordFor(defaultResult, month(defaultResult.fireMonth)).event, /FIRE starts/);
assert.equal(Math.round(recordFor(defaultResult, month(defaultResult.fireMonth)).cash), 90000);

const manualLater = calc.evaluateBridgeFire({
    ...defaults,
    fireMode: 'manual',
    manualFireAge: 40.3
}, { today });
assert.equal(month(manualLater.earliestFireMonth), '2032-12');
assert.equal(month(manualLater.fireMonth), '2036-01');
assert.equal(manualLater.success, true);
assert.ok(manualLater.projectedLiquidAtFire > defaultResult.projectedLiquidAtFire);

const manualTooEarly = calc.evaluateBridgeFire({
    ...defaults,
    fireMode: 'manual',
    manualFireAge: 34.3
}, { today });
assert.equal(month(manualTooEarly.fireMonth), '2030-01');
assert.equal(manualTooEarly.success, false);
assert.equal(month(manualTooEarly.retirement.failMonth), '2047-09');

const webnLow = calc.evaluateBridgeFire({
    ...defaults,
    webnReturnPercent: 3
}, { today });
assert.notEqual(Math.round(webnLow.requiredLiquidAtFireFuture), Math.round(defaultResult.requiredLiquidAtFireFuture));

const preFireHigh = calc.evaluateBridgeFire({
    ...defaults,
    preFireReturnPercent: 9
}, { today });
assert.notEqual(month(preFireHigh.earliestFireMonth), month(defaultResult.earliestFireMonth));

const inheritedAt90 = calc.evaluateBridgeFire({
    ...defaults,
    inheritanceTriggerAge: 90
}, { today });
assert.equal(month(inheritedAt90.inheritanceMonth), '2055-03');

const lowerSpending = calc.evaluateBridgeFire({
    ...defaults,
    retirementSpending: 35000
}, { today });
assert.notEqual(Math.round(lowerSpending.requiredLiquidAtFireFuture), Math.round(defaultResult.requiredLiquidAtFireFuture));

const investedPreFireCashflow = calc.evaluateBridgeFire({
    ...defaults,
    fireMode: 'manual',
    manualFireAge: 31,
    liquidPortfolio: 1000,
    preFireReturnPercent: 0,
    includePreFireApartmentCashflow: true,
    prePayoffRent: 1200,
    mortgagePayment: 1000
}, { today });
assert.equal(month(investedPreFireCashflow.fireMonth), '2026-09');
assert.equal(Math.round(investedPreFireCashflow.projectedLiquidAtFire), 1400);

const rentForever = calc.evaluateBridgeFire({
    ...defaults,
    fireMode: 'manual',
    manualFireAge: 40.3,
    apartmentStrategy: 'rentForever'
}, { today });
assert.equal(recordFor(rentForever, '2049-01').rentalIncome, 775);
assert.ok(recordFor(rentForever, '2049-01').apartmentEquity > 296000);

const sellSpecified = calc.evaluateBridgeFire({
    ...defaults,
    fireMode: 'manual',
    manualFireAge: 40.3,
    apartmentStrategy: 'sellAtDate',
    apartmentSaleMonth: '2055-01'
}, { today });
assert.match(recordFor(sellSpecified, '2055-01').event, /Apartment sold/);
assert.equal(recordFor(sellSpecified, '2055-01').apartmentEquity, 0);
assert.equal(recordFor(sellSpecified, '2055-02').rentalIncome, 0);

const sellAtPayoff = calc.evaluateBridgeFire({
    ...defaults,
    fireMode: 'manual',
    manualFireAge: 40.3,
    apartmentStrategy: 'sellAtPayoff'
}, { today });
assert.match(recordFor(sellAtPayoff, '2048-10').event, /Apartment sold/);
assert.equal(recordFor(sellAtPayoff, '2048-10').apartmentEquity, 0);

const pastSaleDate = calc.evaluateBridgeFire({
    ...defaults,
    fireMode: 'manual',
    manualFireAge: 40.3,
    apartmentStrategy: 'sellAtDate',
    apartmentSaleMonth: '2020-01'
}, { today });
assert.match(recordFor(pastSaleDate, '2026-07').event, /Apartment sold/);
assert.equal(recordFor(pastSaleDate, '2026-07').apartmentEquity, 0);

const guardrailOn = calc.evaluateBridgeFire({
    ...defaults,
    fireMode: 'manual',
    manualFireAge: 30.9,
    liquidPortfolio: 500000,
    webnReturnPercent: 0,
    cashReturnPercent: 0,
    cashReserveYears: 0,
    apartmentValue: 0,
    prePayoffRent: 0,
    postPayoffRent: 0,
    mortgagePayment: 0,
    inheritanceHouseValue: 0,
    earlyRetirementSpending: 100000,
    earlyRetirementYears: 99,
    retirementSpending: 100000,
    guardrailCutAmount: 50000
}, { today });
const firstGuardrail = guardrailOn.records.find((record) => record.guardrailActive);
assert.ok(firstGuardrail);
assert.equal(firstGuardrail.annualSpending, 50000);

const guardrailOff = calc.evaluateBridgeFire({
    ...defaults,
    fireMode: 'manual',
    manualFireAge: 30.9,
    liquidPortfolio: 500000,
    webnReturnPercent: 0,
    cashReturnPercent: 0,
    cashReserveYears: 0,
    apartmentValue: 0,
    prePayoffRent: 0,
    postPayoffRent: 0,
    mortgagePayment: 0,
    inheritanceHouseValue: 0,
    earlyRetirementSpending: 100000,
    earlyRetirementYears: 99,
    retirementSpending: 100000,
    guardrailEnabled: false
}, { today });
assert.equal(guardrailOff.records.some((record) => record.guardrailActive), false);

assert.equal(month(defaultResult.endMonth), '2095-09');

const saved = loadCalculator();
saved.calc.saveSettings({
    ...saved.calc.defaultSettings,
    webnReturnPercent: 3,
    fireMode: 'manual',
    manualFireAge: 41
});
const savedPayload = JSON.parse(saved.storage.get('bridgeFire:settings:v1'));
assert.equal(savedPayload.expiresAt - savedPayload.savedAt, 30 * 24 * 60 * 60 * 1000);
assert.equal(savedPayload.settings.webnReturnPercent, 3);
assert.equal(savedPayload.settings.manualFireAge, 41);

const expired = loadCalculator({
    savedAt: 1,
    expiresAt: 1,
    settings: {
        webnReturnPercent: 3
    }
});
assert.equal(expired.calc.loadSettings().webnReturnPercent, defaults.webnReturnPercent);

const legacy = loadCalculator({
    savedAt: FixedDate.now(),
    expiresAt: FixedDate.now() + 30 * 24 * 60 * 60 * 1000,
    settings: {
        fireMode: 'manual',
        manualFireMonth: '2036-01'
    }
});
approx(legacy.calc.loadSettings().manualFireAge, 40.3, 0.1);

console.log('Bridge-FIRE calculation tests passed');
