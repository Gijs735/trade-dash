(function () {
    const storageKey = 'bridgeFire:settings:v1';
    const storageTtlMs = 30 * 24 * 60 * 60 * 1000;
    const lightweightChartsScriptUrl = 'vendor/lightweight-charts.standalone.production.js?v=5.2.0';
    const chartLiquidColor = '#f2c46d';
    const chartCashColor = '#7ed1bb';
    const chartApartmentColor = '#8ab4f8';
    let bridgeLightweightChartsLoadPromise;

    const defaultSettings = {
        birthdate: '1995-09-15',
        liquidPortfolio: 342000,
        preFireReturnPercent: 8,
        webnReturnPercent: 4,
        cashReturnPercent: 2,
        cashReserveYears: 3,
        inflationPercent: 3,
        lifeExpectancyAge: 100,
        fireMode: 'earliest',
        manualFireAge: 40,
        earlyRetirementSpending: 30000,
        earlyRetirementYears: 5,
        retirementSpending: 40000,
        guardrailEnabled: true,
        guardrailDropPercent: 20,
        guardrailCutAmount: 5000,
        apartmentStrategy: 'rentForever',
        apartmentValue: 297000,
        apartmentRealAppreciationPercent: 0,
        prePayoffRent: 934.25,
        mortgagePayment: 934.25,
        postPayoffRent: 775,
        apartmentSaleMonth: '2055-01',
        apartmentSaleCostPercent: 0,
        includePreFireApartmentCashflow: false,
        dadBirthdate: '1964-05-12',
        momBirthdate: '1965-03-24',
        inheritanceTriggerAge: 95,
        inheritanceHouseValue: 650000
    };

    const loan = {
        originalAmount: 214000,
        monthlyRate: 0.001864,
        payment: 934.25,
        totalPayments: 299,
        paymentDay: 23,
        firstPaymentDate: parseDate('2023-12-23'),
        payoffDate: parseDate('2048-10-23')
    };

    const settingTypes = Object.fromEntries(Object.entries(defaultSettings).map(([key, value]) => [
        key,
        typeof value
    ]));

    let bridgeFireState = {
        settings: { ...defaultSettings },
        lastResult: null,
        hasRendered: false,
        chart: null,
        liquidSeries: null,
        cashSeries: null,
        apartmentSeries: null,
        markerOverlay: null,
        eventLineFrame: null,
        resizeObserver: null
    };

    function setupBridgeFireCalculator() {
        const app = document.getElementById('bridgeFireApp');
        if (!app) {
            return;
        }

        bridgeFireState.settings = loadSettings();
        writeSettingsToControls(bridgeFireState.settings);
        bindBridgeFireControls();
        document.getElementById('bridgeFireTabButton')?.addEventListener('click', () => {
            renderBridgeFire();
        });

        if (!document.getElementById('bridgeFireTabPanel')?.hidden) {
            renderBridgeFire();
        }
    }

    function bindBridgeFireControls() {
        document.querySelectorAll('[data-fire-setting]').forEach((control) => {
            const eventName = control.type === 'checkbox' || control.type === 'radio' || control.tagName === 'SELECT'
                ? 'change'
                : 'input';
            control.addEventListener(eventName, () => {
                bridgeFireState.settings = readSettingsFromControls();
                saveSettings(bridgeFireState.settings);
                renderBridgeFire();
            });
        });

        document.getElementById('bridgeFireResetButton')?.addEventListener('click', () => {
            bridgeFireState.settings = { ...defaultSettings };
            saveSettings(bridgeFireState.settings);
            writeSettingsToControls(bridgeFireState.settings);
            renderBridgeFire();
        });
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) {
                return saveSettings({ ...defaultSettings });
            }

            const payload = JSON.parse(raw);
            if (!payload || Date.now() > Number(payload.expiresAt) || typeof payload.settings !== 'object') {
                return saveSettings({ ...defaultSettings });
            }

            const mergedSettings = {
                ...defaultSettings,
                ...payload.settings
            };
            if (payload.settings.manualFireAge == null && isValidMonthString(payload.settings.manualFireMonth)) {
                mergedSettings.manualFireAge = ageOnDate(parseDate(mergedSettings.birthdate), parseMonth(payload.settings.manualFireMonth));
            }

            return saveSettings(normalizeSettings(mergedSettings));
        } catch (err) {
            return saveSettings({ ...defaultSettings });
        }
    }

    function saveSettings(settings) {
        const normalized = normalizeSettings(settings);
        try {
            const savedAt = Date.now();
            localStorage.setItem(storageKey, JSON.stringify({
                savedAt,
                expiresAt: savedAt + storageTtlMs,
                settings: normalized
            }));
        } catch (err) {
            // Persistence should not block the calculator.
        }
        return normalized;
    }

    function normalizeSettings(settings) {
        const normalized = { ...defaultSettings };
        Object.entries(defaultSettings).forEach(([key, defaultValue]) => {
            const value = settings[key];
            if (typeof defaultValue === 'boolean') {
                normalized[key] = Boolean(value);
                return;
            }
            if (typeof defaultValue === 'number') {
                const number = Number(value);
                normalized[key] = Number.isFinite(number) ? number : defaultValue;
                return;
            }
            normalized[key] = typeof value === 'string' && value.trim() ? value : defaultValue;
        });
        if (settings.manualFireAge == null && isValidMonthString(settings.manualFireMonth)) {
            normalized.manualFireAge = ageOnDate(parseDate(normalized.birthdate), parseMonth(settings.manualFireMonth));
        }
        if (!['earliest', 'manual'].includes(normalized.fireMode)) {
            normalized.fireMode = defaultSettings.fireMode;
        }
        normalized.liquidPortfolio = Math.max(0, normalized.liquidPortfolio);
        normalized.preFireReturnPercent = clampReturnPercent(normalized.preFireReturnPercent);
        normalized.webnReturnPercent = clampReturnPercent(normalized.webnReturnPercent);
        normalized.cashReturnPercent = clampReturnPercent(normalized.cashReturnPercent);
        normalized.inflationPercent = clampReturnPercent(normalized.inflationPercent);
        normalized.lifeExpectancyAge = clamp(normalized.lifeExpectancyAge, 60, 120);
        if (!isValidDateString(normalized.birthdate)) {
            normalized.birthdate = defaultSettings.birthdate;
        }
        if (!isValidDateString(normalized.dadBirthdate)) {
            normalized.dadBirthdate = defaultSettings.dadBirthdate;
        }
        if (!isValidDateString(normalized.momBirthdate)) {
            normalized.momBirthdate = defaultSettings.momBirthdate;
        }
        normalized.manualFireAge = clamp(
            normalized.manualFireAge,
            getMinimumFireAge(normalized),
            Math.max(getMinimumFireAge(normalized), normalized.lifeExpectancyAge)
        );
        normalized.earlyRetirementSpending = Math.max(0, normalized.earlyRetirementSpending);
        normalized.earlyRetirementYears = Math.max(0, normalized.earlyRetirementYears);
        normalized.retirementSpending = Math.max(0, normalized.retirementSpending);
        normalized.guardrailDropPercent = clamp(normalized.guardrailDropPercent, 0, 95);
        normalized.guardrailCutAmount = Math.max(0, normalized.guardrailCutAmount);
        normalized.cashReserveYears = Math.max(0, normalized.cashReserveYears);
        if (!['rentForever', 'sellAtFire', 'sellAtPayoff', 'sellAtDate'].includes(normalized.apartmentStrategy)) {
            normalized.apartmentStrategy = defaultSettings.apartmentStrategy;
        }
        normalized.apartmentValue = Math.max(0, normalized.apartmentValue);
        normalized.apartmentRealAppreciationPercent = clampReturnPercent(normalized.apartmentRealAppreciationPercent);
        normalized.prePayoffRent = Math.max(0, normalized.prePayoffRent);
        normalized.mortgagePayment = Math.max(0, normalized.mortgagePayment);
        normalized.postPayoffRent = Math.max(0, normalized.postPayoffRent);
        normalized.apartmentSaleCostPercent = clamp(normalized.apartmentSaleCostPercent, 0, 25);
        normalized.inheritanceTriggerAge = clamp(normalized.inheritanceTriggerAge, 50, 120);
        normalized.inheritanceHouseValue = Math.max(0, normalized.inheritanceHouseValue);
        if (!isValidMonthString(normalized.apartmentSaleMonth)) {
            normalized.apartmentSaleMonth = defaultSettings.apartmentSaleMonth;
        }
        return normalized;
    }

    function writeSettingsToControls(settings) {
        document.querySelectorAll('[data-fire-setting]').forEach((control) => {
            const key = control.dataset.fireSetting;
            const value = settings[key];
            if (control.type === 'checkbox') {
                control.checked = Boolean(value);
                return;
            }
            if (control.type === 'radio') {
                control.checked = control.value === value;
                return;
            }
            if (control.type === 'range') {
                syncManualFireAgeControl(control, settings);
                return;
            }
            control.value = String(value);
        });
    }

    function readSettingsFromControls() {
        const nextSettings = { ...bridgeFireState.settings };
        document.querySelectorAll('[data-fire-setting]').forEach((control) => {
            const key = control.dataset.fireSetting;
            if (control.type === 'radio') {
                if (control.checked) {
                    nextSettings[key] = control.value;
                }
                return;
            }
            if (control.type === 'checkbox') {
                nextSettings[key] = control.checked;
                return;
            }
            nextSettings[key] = settingTypes[key] === 'number'
                ? Number(control.value)
                : control.value;
        });
        return normalizeSettings(nextSettings);
    }

    function renderBridgeFire() {
        syncManualFireAgeControls(bridgeFireState.settings);
        const result = evaluateBridgeFire(bridgeFireState.settings);
        bridgeFireState.lastResult = result;
        bridgeFireState.hasRendered = true;
        renderKpis(result);
        renderChart(result);
        renderYearlyRows(result);
    }

    function evaluateBridgeFire(settings, options = {}) {
        const today = options.today ? startOfDay(options.today) : getToday();
        const todayMonth = firstOfMonth(today);
        const endMonth = firstOfMonth(addYears(parseDate(settings.birthdate), settings.lifeExpectancyAge));
        const currentLoanBalance = loanBalanceOnDate(today);
        const currentApartmentValue = apartmentValueOnDate(settings, todayMonth, todayMonth);
        const currentApartmentEquity = Math.max(0, currentApartmentValue - currentLoanBalance);
        const currentNetWorth = Math.max(0, settings.liquidPortfolio) + currentApartmentEquity;
        const inheritanceTrigger = getInheritanceTrigger(settings);
        const inheritanceDate = inheritanceTrigger.date;
        const inheritanceMonth = firstOfMonth(inheritanceDate);
        const common = {
            inheritanceDate,
            inheritanceMonth,
            inheritanceTrigger,
            currentLoanBalance,
            currentApartmentEquity,
            currentApartmentValue,
            currentNetWorth,
            todayMonth,
            endMonth
        };

        const earliest = findEarliestFire(settings, todayMonth, endMonth);
        const selectedFireMonth = getSelectedFireMonth(settings, earliest?.fireMonth, todayMonth, endMonth);
        const selectedProjection = selectedFireMonth
            ? buildFireProjection(settings, selectedFireMonth, todayMonth, endMonth)
            : buildNoSafeProjection(settings, todayMonth, endMonth);

        return {
            ...selectedProjection,
            ...common,
            earliestSuccess: Boolean(earliest),
            earliestFireMonth: earliest?.fireMonth ?? null,
            earliestRequiredLiquidAtFire: earliest?.requiredLiquidAtFire ?? null,
            earliestRequiredLiquidAtFireFuture: earliest?.requiredLiquidAtFireFuture ?? null,
            fireMode: settings.fireMode
        };
    }

    function findEarliestFire(settings, todayMonth, endMonth) {
        for (let fireMonth = todayMonth; fireMonth <= endMonth; fireMonth = addMonths(fireMonth, 1)) {
            const projectedLiquidAtFire = projectLiquidToFire(settings, todayMonth, fireMonth);
            const retirement = simulateRetirement(settings, fireMonth, projectedLiquidAtFire, todayMonth, endMonth, {
                collectRecords: false
            });
            if (retirement.success) {
                const requiredLiquidAtFire = getRequiredLiquidAtFire(settings, fireMonth, todayMonth, endMonth);
                const requiredLiquidAtFireFuture = toFutureEuros(settings, requiredLiquidAtFire, todayMonth, fireMonth);
                return {
                    fireMonth,
                    projectedLiquidAtFire,
                    requiredLiquidAtFire,
                    requiredLiquidAtFireFuture
                };
            }
        }
        return null;
    }

    function getSelectedFireMonth(settings, earliestFireMonth, todayMonth, endMonth) {
        if (settings.fireMode === 'manual') {
            return clampMonth(fireMonthFromAge(settings, settings.manualFireAge), todayMonth, endMonth);
        }
        return earliestFireMonth;
    }

    function buildFireProjection(settings, fireMonth, todayMonth, endMonth) {
        const projectedLiquidAtFire = projectLiquidToFire(settings, todayMonth, fireMonth);
        const projectedLiquidAtFireFuture = toFutureEuros(settings, projectedLiquidAtFire, todayMonth, fireMonth);
        const requiredLiquidAtFire = getRequiredLiquidAtFire(settings, fireMonth, todayMonth, endMonth);
        const requiredLiquidAtFireFuture = Number.isFinite(requiredLiquidAtFire)
            ? toFutureEuros(settings, requiredLiquidAtFire, todayMonth, fireMonth)
            : requiredLiquidAtFire;
        const retirement = simulateRetirement(settings, fireMonth, projectedLiquidAtFire, todayMonth, endMonth);
        const preFireRecords = buildPreFireRecords(settings, todayMonth, fireMonth, projectedLiquidAtFire);
        return {
            success: retirement.success,
            fireMonth,
            projectedLiquidAtFire,
            projectedLiquidAtFireFuture,
            requiredLiquidAtFire,
            requiredLiquidAtFireFuture,
            retirement,
            records: [...preFireRecords, ...retirement.records]
        };
    }

    function buildNoSafeProjection(settings, todayMonth, endMonth) {
        const projectedLiquidAtEnd = projectLiquidToFire(settings, todayMonth, endMonth);
        return {
            success: false,
            fireMonth: null,
            projectedLiquidAtFire: projectedLiquidAtEnd,
            projectedLiquidAtFireFuture: null,
            requiredLiquidAtFire: null,
            requiredLiquidAtFireFuture: null,
            retirement: {
                success: false,
                records: [],
                failMonth: null
            },
            records: buildPreFireRecords(settings, todayMonth, endMonth, projectedLiquidAtEnd)
        };
    }

    function projectLiquidToFire(settings, startMonth, fireMonth) {
        const monthlyReturn = monthlyRate(settings.preFireReturnPercent);
        let liquid = Math.max(0, settings.liquidPortfolio);
        let apartmentSold = false;
        const saleMonth = getApartmentSaleMonth(settings, fireMonth, startMonth);
        for (let month = startMonth; month < fireMonth; month = addMonths(month, 1)) {
            if (!apartmentSold && saleMonth && month >= saleMonth) {
                liquid += getApartmentSaleProceeds(settings, month, startMonth);
                apartmentSold = true;
            }
            if (!apartmentSold && settings.includePreFireApartmentCashflow) {
                liquid += getApartmentMonthlyCashflow(settings, month, false);
            }
            liquid *= 1 + monthlyReturn;
            liquid = Math.max(0, liquid);
        }
        return liquid;
    }

    function getRequiredLiquidAtFire(settings, fireMonth, todayMonth, endMonth) {
        const survives = (amount) => simulateRetirement(settings, fireMonth, amount, todayMonth, endMonth, {
            collectRecords: false
        }).success;
        if (survives(0)) {
            return 0;
        }

        let low = 0;
        let high = Math.max(100000, settings.retirementSpending * 20);
        let attempts = 0;
        while (!survives(high) && attempts < 30) {
            high *= 1.5;
            attempts += 1;
        }
        if (attempts >= 30) {
            return Number.POSITIVE_INFINITY;
        }

        for (let i = 0; i < 44; i += 1) {
            const mid = (low + high) / 2;
            if (survives(mid)) {
                high = mid;
            } else {
                low = mid;
            }
        }
        return high;
    }

    function simulateRetirement(settings, fireMonth, initialLiquid, todayMonth, endMonth, options = {}) {
        const collectRecords = options.collectRecords !== false;
        const webnMonthlyReturn = monthlyRate(settings.webnReturnPercent);
        const cashMonthlyReturn = monthlyRate(settings.cashReturnPercent);
        const saleMonth = getApartmentSaleMonth(settings, fireMonth, todayMonth);
        const inheritanceMonth = firstOfMonth(getInheritanceDate(settings));
        let apartmentSold = Boolean(saleMonth && saleMonth < fireMonth);
        let inherited = false;
        let guardrailActive = false;
        let cash = Math.min(Math.max(0, initialLiquid), getCashReserveTarget(settings, 0, false));
        let webn = Math.max(0, initialLiquid - cash);
        let highWater = cash + webn;
        const records = [];

        for (let month = fireMonth, monthIndex = 0; month <= endMonth; month = addMonths(month, 1), monthIndex += 1) {
            const events = [];
            if (monthIndex === 0) {
                events.push('FIRE starts');
            }
            cash *= 1 + cashMonthlyReturn;
            webn *= 1 + webnMonthlyReturn;

            if (!apartmentSold && saleMonth && month >= saleMonth) {
                webn += getApartmentSaleProceeds(settings, month, todayMonth);
                apartmentSold = true;
                events.push('Apartment sold');
            }

            if (!inherited && month >= inheritanceMonth) {
                webn += Math.max(0, settings.inheritanceHouseValue);
                inherited = true;
                events.push('Inheritance invested');
            }

            let liquid = cash + webn;
            if (liquid > highWater) {
                highWater = liquid;
            }

            if (settings.guardrailEnabled) {
                if (guardrailActive && liquid >= highWater) {
                    guardrailActive = false;
                } else if (liquid < highWater * (1 - settings.guardrailDropPercent / 100)) {
                    guardrailActive = true;
                }
            } else {
                guardrailActive = false;
            }

            const annualSpending = getAnnualSpending(settings, monthIndex, guardrailActive);
            const monthlySpending = annualSpending / 12;
            const rentalIncome = apartmentSold ? 0 : getApartmentMonthlyCashflow(settings, month, true);
            const netWithdrawal = monthlySpending - rentalIncome;
            let failed = false;

            if (netWithdrawal >= 0) {
                const withdrawal = withdrawFromLiquid(cash, webn, netWithdrawal);
                cash = withdrawal.cash;
                webn = withdrawal.webn;
                failed = withdrawal.failed;
            } else {
                cash += Math.abs(netWithdrawal);
            }

            const reserveTarget = getCashReserveTarget(settings, monthIndex, guardrailActive);
            if (!failed && cash < reserveTarget && webn > 0) {
                const transfer = Math.min(reserveTarget - cash, webn);
                cash += transfer;
                webn -= transfer;
            }
            if (!failed && cash > reserveTarget) {
                webn += cash - reserveTarget;
                cash = reserveTarget;
            }

            liquid = cash + webn;
            if (liquid > highWater) {
                highWater = liquid;
            }

            if (collectRecords) {
                const apartmentValue = apartmentSold ? 0 : apartmentValueOnDate(settings, month, todayMonth);
                const apartmentEquity = apartmentSold ? 0 : Math.max(0, apartmentValue - loanBalanceOnDate(month));
                records.push({
                    date: month,
                    monthIndex,
                    age: ageOnDate(parseDate(settings.birthdate), month),
                    liquid,
                    cash,
                    webn,
                    apartmentValue,
                    apartmentEquity,
                    annualSpending,
                    rentalIncome,
                    event: events.join(', '),
                    guardrailActive,
                    failed
                });
            }

            if (failed || liquid <= -0.5) {
                return {
                    success: false,
                    records,
                    failMonth: month
                };
            }
        }

        return {
            success: true,
            records,
            failMonth: null
        };
    }

    function buildPreFireRecords(settings, todayMonth, fireMonth, projectedLiquidAtFire) {
        const records = [];
        const monthlyReturn = monthlyRate(settings.preFireReturnPercent);
        let liquid = Math.max(0, settings.liquidPortfolio);
        let apartmentSold = false;
        const saleMonth = getApartmentSaleMonth(settings, fireMonth, todayMonth);

        for (let month = todayMonth, monthIndex = 0; month < fireMonth; month = addMonths(month, 1), monthIndex += 1) {
            const events = [];
            if (!apartmentSold && saleMonth && month >= saleMonth) {
                liquid += getApartmentSaleProceeds(settings, month, todayMonth);
                apartmentSold = true;
                events.push('Apartment sold');
            }

            const apartmentValue = apartmentSold ? 0 : apartmentValueOnDate(settings, month, todayMonth);
            const monthlyCashflow = !apartmentSold && settings.includePreFireApartmentCashflow
                ? getApartmentMonthlyCashflow(settings, month, false)
                : 0;
            records.push({
                date: month,
                monthIndex: -monthsBetween(month, fireMonth),
                age: ageOnDate(parseDate(settings.birthdate), month),
                liquid,
                cash: 0,
                webn: liquid,
                apartmentValue,
                apartmentEquity: apartmentSold ? 0 : Math.max(0, apartmentValue - loanBalanceOnDate(month)),
                annualSpending: 0,
                rentalIncome: monthlyCashflow,
                event: events.join(', '),
                guardrailActive: false,
                failed: false
            });
            liquid += monthlyCashflow;
            liquid *= 1 + monthlyReturn;
        }
        return records;
    }

    function withdrawFromLiquid(cash, webn, amount) {
        if (cash >= amount) {
            return { cash: cash - amount, webn, failed: false };
        }

        const remaining = amount - cash;
        cash = 0;
        webn -= remaining;
        return {
            cash,
            webn: Math.max(0, webn),
            failed: webn < -0.5
        };
    }

    function getAnnualSpending(settings, monthIndex, guardrailActive) {
        const yearsSinceFire = monthIndex / 12;
        const baseSpending = yearsSinceFire < settings.earlyRetirementYears
            ? settings.earlyRetirementSpending
            : settings.retirementSpending;
        return Math.max(0, baseSpending - (guardrailActive ? settings.guardrailCutAmount : 0));
    }

    function getCashReserveTarget(settings, monthIndex, guardrailActive) {
        return getAnnualSpending(settings, monthIndex, guardrailActive) * Math.max(0, settings.cashReserveYears);
    }

    function getApartmentMonthlyCashflow(settings, month, afterFire) {
        const paymentDue = loanPaymentDueInMonth(month);
        const rent = paymentDue ? settings.prePayoffRent : settings.postPayoffRent;
        const mortgage = paymentDue ? settings.mortgagePayment : 0;
        const net = rent - mortgage;
        if (!afterFire && !settings.includePreFireApartmentCashflow) {
            return 0;
        }
        return net;
    }

    function getApartmentSaleMonth(settings, fireMonth, todayMonth = null) {
        let saleMonth = null;
        if (settings.apartmentStrategy === 'rentForever') {
            return null;
        }
        if (settings.apartmentStrategy === 'sellAtFire') {
            saleMonth = fireMonth;
        } else if (settings.apartmentStrategy === 'sellAtPayoff') {
            saleMonth = firstOfMonth(loan.payoffDate);
        } else {
            saleMonth = parseMonth(settings.apartmentSaleMonth);
        }
        if (todayMonth && saleMonth < todayMonth) {
            return firstOfMonth(todayMonth);
        }
        return saleMonth;
    }

    function getApartmentSaleProceeds(settings, saleMonth, todayMonth) {
        const value = apartmentValueOnDate(settings, saleMonth, todayMonth);
        const loanBalance = loanBalanceForSaleMonth(saleMonth);
        const saleCosts = value * Math.max(0, settings.apartmentSaleCostPercent) / 100;
        return Math.max(0, value - loanBalance - saleCosts);
    }

    function loanBalanceForSaleMonth(saleMonth) {
        if (firstOfMonth(saleMonth) >= firstOfMonth(loan.payoffDate)) {
            return 0;
        }
        return loanBalanceOnDate(saleMonth);
    }

    function apartmentValueOnDate(settings, date, todayMonth = firstOfMonth(getToday())) {
        const monthDelta = monthsBetween(todayMonth, firstOfMonth(date));
        return Math.max(0, settings.apartmentValue) * Math.pow(1 + monthlyRate(settings.apartmentRealAppreciationPercent), monthDelta);
    }

    function loanPaymentDueInMonth(month) {
        const paymentDate = new Date(month.getFullYear(), month.getMonth(), loan.paymentDay);
        return paymentDate >= loan.firstPaymentDate && paymentDate <= loan.payoffDate;
    }

    function loanBalanceOnDate(date) {
        return loanBalanceAfterPayments(completedLoanPayments(date));
    }

    function completedLoanPayments(date) {
        if (date < loan.firstPaymentDate) {
            return 0;
        }

        const firstPaymentMonth = firstOfMonth(loan.firstPaymentDate);
        const currentMonth = firstOfMonth(date);
        const wholeMonths = monthsBetween(firstPaymentMonth, currentMonth);
        const completedThisMonth = date.getDate() >= loan.paymentDay ? 1 : 0;
        return clamp(wholeMonths + completedThisMonth, 0, loan.totalPayments);
    }

    function loanBalanceAfterPayments(paymentCount) {
        let balance = loan.originalAmount;
        for (let i = 0; i < paymentCount; i += 1) {
            const interest = roundCents(balance * loan.monthlyRate);
            const principal = Math.min(roundCents(loan.payment - interest), balance);
            balance = roundCents(balance - principal);
        }
        return balance;
    }

    function getInheritanceDate(settings) {
        return getInheritanceTrigger(settings).date;
    }

    function getInheritanceTrigger(settings) {
        const dadDate = addYears(parseDate(settings.dadBirthdate), settings.inheritanceTriggerAge);
        const momDate = addYears(parseDate(settings.momBirthdate), settings.inheritanceTriggerAge);
        if (dadDate > momDate) {
            return {
                parent: 'dad',
                label: 'Dad',
                date: dadDate
            };
        }
        if (momDate > dadDate) {
            return {
                parent: 'mom',
                label: 'Mom',
                date: momDate
            };
        }
        return {
            parent: 'both',
            label: 'Both parents',
            date: dadDate
        };
    }

    function toFutureEuros(settings, realAmount, fromMonth, toMonth) {
        const monthDelta = Math.max(0, monthsBetween(firstOfMonth(fromMonth), firstOfMonth(toMonth)));
        return realAmount * Math.pow(1 + monthlyRate(settings.inflationPercent), monthDelta);
    }

    function renderKpis(result) {
        setText('bridgeApartmentEquity', formatEur(result.currentApartmentEquity));
        setText('bridgeCurrentNetWorth', formatEur(result.currentNetWorth));
        setText('bridgeFireDate', result.earliestSuccess ? formatMonth(result.earliestFireMonth) : 'No safe date');
        setText(
            'bridgeInheritanceSummary',
            `Youngest parent: ${result.inheritanceTrigger.label} reaches age ${bridgeFireState.settings.inheritanceTriggerAge} in ${formatMonth(result.inheritanceDate)}, ${formatYearsAway(result.todayMonth, result.inheritanceMonth)} away.`
        );

        if (!result.fireMonth) {
            setText('bridgeFireDate', 'No safe date');
            setText('bridgeFireAge', '--');
            setText('bridgeRequiredLiquid', '--');
            setText('bridgeRequiredLiquidNote', 'Future euros');
            setText('bridgePlanStatus', 'Needs more assets');
            setText('bridgeProjectionSummary', `Projection runs through ${formatMonth(result.endMonth)} without a safe FIRE date.`);
            return;
        }

        setText('bridgeFireAge', ageOnDate(parseDate(bridgeFireState.settings.birthdate), result.fireMonth).toFixed(1));
        setText(
            'bridgeRequiredLiquid',
            Number.isFinite(result.requiredLiquidAtFireFuture)
                ? `${formatEur(result.requiredLiquidAtFireFuture)} future`
                : '--'
        );
        setText(
            'bridgeRequiredLiquidNote',
            Number.isFinite(result.requiredLiquidAtFire)
                ? `${formatEur(result.requiredLiquidAtFire)} in today's euros`
                : 'Future euros'
        );
        setText(
            'bridgePlanStatus',
            result.success
                ? `Survives to ${bridgeFireState.settings.lifeExpectancyAge}`
                : `Depletes ${formatMonth(result.retirement.failMonth)}`
        );

        const earliestText = result.earliestSuccess
            ? `Earliest safe FIRE is ${formatMonth(result.earliestFireMonth)}.`
            : `No safe FIRE date found before age ${bridgeFireState.settings.lifeExpectancyAge}.`;
        setText(
            'bridgeProjectionSummary',
            `Selected FIRE starts ${formatMonth(result.fireMonth)} with ${formatEur(result.projectedLiquidAtFire)} liquid in today's euros. ${earliestText} Inheritance uses the youngest parent, ${result.inheritanceTrigger.label.toLowerCase()}, reaching age ${bridgeFireState.settings.inheritanceTriggerAge} in ${formatMonth(result.inheritanceDate)}.`
        );
    }

    async function renderChart(result) {
        const chartElement = document.getElementById('bridgeFireChart');
        if (!chartElement) {
            return;
        }

        const records = result.records;
        if (!records.length) {
            return;
        }

        chartElement.classList.remove('has-chart-error');
        if (!bridgeFireState.chart) {
            chartElement.textContent = '';
        }
        try {
            await loadBridgeLightweightCharts();
            ensureBridgeChart(chartElement);
            const liquidData = records.map((record) => ({
                time: toChartTime(record.date),
                value: roundCents(record.liquid)
            }));
            const cashData = records.map((record) => ({
                time: toChartTime(record.date),
                value: roundCents(record.cash)
            }));
            const apartmentData = records.map((record) => ({
                time: toChartTime(record.date),
                value: roundCents(record.apartmentEquity)
            }));

            bridgeFireState.liquidSeries.setData(liquidData);
            bridgeFireState.cashSeries.setData(cashData);
            bridgeFireState.apartmentSeries.setData(apartmentData);
            bridgeFireState.chart.timeScale().fitContent();
            addBridgeChartMarkers(result);
            scheduleBridgeEventLineRender(result);
        } catch (err) {
            chartElement.textContent = 'Projection chart unavailable';
            chartElement.classList.add('has-chart-error');
            console.error(err);
        }
    }

    function loadBridgeLightweightCharts() {
        if (window.LightweightCharts) {
            return Promise.resolve();
        }
        if (bridgeLightweightChartsLoadPromise) {
            return bridgeLightweightChartsLoadPromise;
        }

        bridgeLightweightChartsLoadPromise = new Promise((resolve, reject) => {
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
        return bridgeLightweightChartsLoadPromise;
    }

    function ensureBridgeChart(chartElement) {
        if (bridgeFireState.chart) {
            return;
        }

        const LightweightCharts = window.LightweightCharts;
        const chart = LightweightCharts.createChart(chartElement, {
            autoSize: true,
            layout: {
                background: { type: 'solid', color: '#111213' },
                textColor: '#b8b8bd',
                fontFamily: 'Arial, sans-serif'
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.06)' },
                horzLines: { color: 'rgba(255, 255, 255, 0.06)' }
            },
            rightPriceScale: {
                borderColor: 'rgba(255, 255, 255, 0.08)',
                scaleMargins: {
                    top: 0.08,
                    bottom: 0.12
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
                priceFormatter: (price) => formatChartEur(price)
            }
        });

        bridgeFireState.chart = chart;
        bridgeFireState.liquidSeries = addBridgeSeries(chart, 'line', {
            color: chartLiquidColor,
            lineWidth: 3,
            priceLineVisible: false,
            lastValueVisible: true,
            title: 'Liquid'
        });
        bridgeFireState.cashSeries = addBridgeSeries(chart, 'line', {
            color: chartCashColor,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            title: 'Cash'
        });
        bridgeFireState.apartmentSeries = addBridgeSeries(chart, 'line', {
            color: chartApartmentColor,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            title: 'Apartment equity'
        });

        if (window.ResizeObserver) {
            bridgeFireState.resizeObserver = new ResizeObserver(() => {
                chart.resize(chartElement.clientWidth, chartElement.clientHeight);
                if (bridgeFireState.lastResult) {
                    scheduleBridgeEventLineRender(bridgeFireState.lastResult);
                }
            });
            bridgeFireState.resizeObserver.observe(chartElement);
        }

        const timeScale = chart.timeScale();
        if (timeScale.subscribeVisibleTimeRangeChange) {
            timeScale.subscribeVisibleTimeRangeChange(() => {
                if (bridgeFireState.lastResult) {
                    scheduleBridgeEventLineRender(bridgeFireState.lastResult);
                }
            });
        }
        if (timeScale.subscribeVisibleLogicalRangeChange) {
            timeScale.subscribeVisibleLogicalRangeChange(() => {
                if (bridgeFireState.lastResult) {
                    scheduleBridgeEventLineRender(bridgeFireState.lastResult);
                }
            });
        }
    }

    function addBridgeSeries(chart, type, options) {
        const LightweightCharts = window.LightweightCharts;
        const constructors = {
            line: LightweightCharts.LineSeries
        };
        if (chart.addSeries && constructors[type]) {
            return chart.addSeries(constructors[type], options);
        }
        if (type === 'line' && chart.addLineSeries) {
            return chart.addLineSeries(options);
        }
        throw new Error('Line series unavailable');
    }

    function addBridgeChartMarkers(result) {
        const markers = [];
        if (result.fireMonth) {
            markers.push({
                time: toChartTime(result.fireMonth),
                position: 'aboveBar',
                color: chartLiquidColor,
                shape: 'arrowDown',
                text: 'FIRE'
            });
        }
        if (result.inheritanceMonth >= result.records[0].date && result.inheritanceMonth <= result.records[result.records.length - 1].date) {
            markers.push({
                time: toChartTime(result.inheritanceMonth),
                position: 'belowBar',
                color: '#7ed1bb',
                shape: 'arrowUp',
                text: 'House'
            });
        }
        if (result.retirement.failMonth) {
            markers.push({
                time: toChartTime(result.retirement.failMonth),
                position: 'belowBar',
                color: '#ff8a87',
                shape: 'circle',
                text: 'Depletion'
            });
        }

        if (bridgeFireState.liquidSeries.setMarkers) {
            bridgeFireState.liquidSeries.setMarkers(markers);
        }
    }

    function scheduleBridgeEventLineRender(result) {
        if (bridgeFireState.eventLineFrame) {
            cancelAnimationFrame(bridgeFireState.eventLineFrame);
        }
        bridgeFireState.eventLineFrame = requestAnimationFrame(() => {
            bridgeFireState.eventLineFrame = null;
            renderBridgeEventLines(result);
        });
    }

    function renderBridgeEventLines(result) {
        const chartElement = document.getElementById('bridgeFireChart');
        if (!chartElement || !bridgeFireState.chart || !result.records.length) {
            return;
        }

        const overlay = ensureBridgeMarkerOverlay(chartElement);
        overlay.textContent = '';
        const events = getBridgeEventLineItems(result);
        const startDate = result.records[0].date;
        const endDate = result.records[result.records.length - 1].date;

        events.forEach((event, index) => {
            if (!event.date || event.date < startDate || event.date > endDate) {
                return;
            }
            const x = bridgeFireState.chart.timeScale().timeToCoordinate(toChartTime(event.date));
            if (!Number.isFinite(x)) {
                return;
            }
            const marker = document.createElement('div');
            marker.className = `bridge-event-line ${event.className}`;
            marker.title = event.label;
            marker.style.left = `${Math.round(x)}px`;

            const label = document.createElement('span');
            label.textContent = event.label;
            label.style.top = `${8 + (index % 4) * 24}px`;
            if (x > chartElement.clientWidth - 120) {
                label.classList.add('align-left');
            }
            marker.appendChild(label);
            overlay.appendChild(marker);
        });
    }

    function getBridgeEventLineItems(result) {
        const events = [
            {
                date: result.fireMonth,
                label: 'FIRE',
                className: 'is-fire'
            },
            {
                date: result.inheritanceMonth,
                label: 'Inheritance',
                className: 'is-inheritance'
            }
        ];
        const saleMonth = result.fireMonth
            ? getApartmentSaleMonth(bridgeFireState.settings, result.fireMonth, result.todayMonth)
            : null;
        if (saleMonth) {
            events.push({
                date: saleMonth,
                label: 'Apartment sold',
                className: 'is-apartment-sale'
            });
        }
        const payoffMonth = firstOfMonth(loan.payoffDate);
        if ((!saleMonth || saleMonth > payoffMonth) && payoffMonth >= result.todayMonth) {
            events.push({
                date: payoffMonth,
                label: 'Rent starts',
                className: 'is-rent-start'
            });
        }
        return dedupeBridgeEvents(events);
    }

    function dedupeBridgeEvents(events) {
        const seen = new Set();
        return events.filter((event) => {
            const key = `${event.label}:${event.date ? event.date.getTime() : 'none'}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    function ensureBridgeMarkerOverlay(chartElement) {
        if (bridgeFireState.markerOverlay && chartElement.contains(bridgeFireState.markerOverlay)) {
            return bridgeFireState.markerOverlay;
        }

        const overlay = document.createElement('div');
        overlay.className = 'bridge-event-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        chartElement.appendChild(overlay);
        bridgeFireState.markerOverlay = overlay;
        return overlay;
    }

    function renderYearlyRows(result) {
        const body = document.getElementById('bridgeYearlyRows');
        if (!body) {
            return;
        }

        body.textContent = '';
        const rows = result.records.filter((record, index) => (
            index === 0
            || index === result.records.length - 1
            || record.date.getMonth() === 0
            || record.event
        ));

        rows.forEach((record) => {
            const row = document.createElement('tr');
            [
                formatMonth(record.date),
                record.age.toFixed(1),
                formatEur(record.liquid),
                formatEur(record.cash),
                formatEur(record.apartmentEquity),
                record.annualSpending ? formatEur(record.annualSpending) : '--',
                record.event || (record.guardrailActive ? 'Guardrail' : '')
            ].forEach((value) => {
                const cell = document.createElement('td');
                cell.textContent = value;
                row.appendChild(cell);
            });
            body.appendChild(row);
        });
    }

    function setText(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    }

    function parseDate(value) {
        const [year, month, day] = String(value).split('-').map(Number);
        return new Date(year, month - 1, day);
    }

    function parseMonth(value) {
        const [year, month] = String(value).split('-').map(Number);
        return new Date(year, month - 1, 1);
    }

    function fireMonthFromAge(settings, age) {
        const birthMonth = firstOfMonth(parseDate(settings.birthdate));
        return addMonths(birthMonth, Math.round(age * 12));
    }

    function getMinimumFireAge(settings) {
        return Math.ceil(ageOnDate(parseDate(settings.birthdate), getToday()) * 10) / 10;
    }

    function syncManualFireAgeControls(settings) {
        document.querySelectorAll('[data-fire-setting="manualFireAge"]').forEach((control) => {
            syncManualFireAgeControl(control, settings);
        });
    }

    function syncManualFireAgeControl(control, settings) {
        const minAge = getMinimumFireAge(settings);
        const maxAge = Math.max(minAge, settings.lifeExpectancyAge);
        control.min = minAge.toFixed(1);
        control.max = maxAge.toFixed(1);
        control.value = clamp(settings.manualFireAge, minAge, maxAge).toFixed(1);
        setText('bridgeManualFireAgeValue', Number(control.value).toFixed(1));
    }

    function isValidDate(date) {
        return date instanceof Date && !Number.isNaN(date.getTime());
    }

    function isValidMonthString(value) {
        const match = /^(\d{4})-(\d{2})$/.exec(String(value));
        if (!match) {
            return false;
        }
        const year = Number(match[1]);
        const month = Number(match[2]);
        const parsed = parseMonth(value);
        return month >= 1
            && month <= 12
            && isValidDate(parsed)
            && parsed.getFullYear() === year
            && parsed.getMonth() === month - 1;
    }

    function isValidDateString(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
        if (!match) {
            return false;
        }
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const parsed = parseDate(value);
        return month >= 1
            && month <= 12
            && day >= 1
            && day <= 31
            && isValidDate(parsed)
            && parsed.getFullYear() === year
            && parsed.getMonth() === month - 1
            && parsed.getDate() === day;
    }

    function clampReturnPercent(value) {
        return clamp(value, -99.9, 100);
    }

    function clampMonth(date, minDate, maxDate) {
        if (!isValidDate(date)) {
            return firstOfMonth(minDate);
        }
        if (date < minDate) {
            return firstOfMonth(minDate);
        }
        if (date > maxDate) {
            return firstOfMonth(maxDate);
        }
        return firstOfMonth(date);
    }

    function getToday() {
        return startOfDay(new Date());
    }

    function startOfDay(date) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    function firstOfMonth(date) {
        return new Date(date.getFullYear(), date.getMonth(), 1);
    }

    function addMonths(date, months) {
        return new Date(date.getFullYear(), date.getMonth() + months, 1);
    }

    function addYears(date, years) {
        return new Date(date.getFullYear() + years, date.getMonth(), date.getDate());
    }

    function monthsBetween(start, end) {
        return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    }

    function ageOnDate(birthdate, date) {
        const years = date.getFullYear() - birthdate.getFullYear();
        const birthdayThisYear = new Date(date.getFullYear(), birthdate.getMonth(), birthdate.getDate());
        const birthdayAdjustment = date < birthdayThisYear ? -1 : 0;
        const lastBirthday = new Date(date.getFullYear() + birthdayAdjustment, birthdate.getMonth(), birthdate.getDate());
        const nextBirthday = new Date(lastBirthday.getFullYear() + 1, birthdate.getMonth(), birthdate.getDate());
        const fullYears = years + birthdayAdjustment;
        return fullYears + ((date - lastBirthday) / (nextBirthday - lastBirthday));
    }

    function monthlyRate(annualPercent) {
        return Math.pow(1 + annualPercent / 100, 1 / 12) - 1;
    }

    function roundCents(value) {
        return Math.round((value + Number.EPSILON) * 100) / 100;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function formatEur(value) {
        if (!Number.isFinite(value)) {
            return '--';
        }
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'EUR',
            maximumFractionDigits: 0
        }).format(value);
    }

    function formatChartEur(value) {
        if (Math.abs(value) >= 1000000) {
            return `€${(value / 1000000).toFixed(2)}M`;
        }
        if (Math.abs(value) >= 1000) {
            return `€${Math.round(value / 1000)}k`;
        }
        return `€${Math.round(value)}`;
    }

    function formatMonth(date) {
        return new Intl.DateTimeFormat('en-US', {
            month: 'short',
            year: 'numeric'
        }).format(date);
    }

    function formatYearsAway(fromMonth, toMonth) {
        const years = Math.max(0, monthsBetween(firstOfMonth(fromMonth), firstOfMonth(toMonth)) / 12);
        const rounded = Math.round(years * 10) / 10;
        return `${rounded.toFixed(1)} years`;
    }

    function toChartTime(date) {
        return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), 1) / 1000);
    }

    window.setupBridgeFireCalculator = setupBridgeFireCalculator;
    window.bridgeFireCalculator = {
        defaultSettings,
        evaluateBridgeFire,
        loanBalanceAfterPayments,
        loanBalanceOnDate,
        completedLoanPayments,
        saveSettings,
        loadSettings
    };
}());
