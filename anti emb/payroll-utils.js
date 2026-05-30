/** Production bonus & payroll calculations (final factory rules) */
const PRODUCTION_BONUS_ABOVE = 300000;
const PRODUCTION_BONUS_UNIT = 500;

function formatINR(amount, decimals) {
    const opts = { style: 'currency', currency: 'INR' };
    if (decimals !== undefined) {
        opts.minimumFractionDigits = decimals;
        opts.maximumFractionDigits = decimals;
    }
    return new Intl.NumberFormat('en-IN', opts).format(amount || 0);
}

function formatINRPlain(amount) {
    return '₹' + Math.round(amount || 0).toLocaleString('en-IN');
}

function formatINRDecimal(amount) {
    const n = Number(amount) || 0;
    return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isAutoProductionBonusEnabled(mySettings) {
    if (!mySettings) return true;
    return mySettings.autoProductionBonus !== false;
}

/** Final production bonus from total daily stitch count */
function calculateStitchBonus(stitches) {
    const count = Math.max(0, parseInt(stitches, 10) || 0);
    let bonus = 0;
    let slab = 'Below 2,50,000';
    let extraStitches = 0;
    let additionalBonus = 0;
    let baseBonus = 0;

    if (count < 250000) {
        bonus = 0;
        slab = 'Below 2,50,000 — ₹0';
    } else if (count <= 274999) {
        bonus = 50;
        baseBonus = 50;
        slab = '2,50,000 – 2,74,999 — ₹50 fixed';
    } else if (count <= 299999) {
        bonus = 75;
        baseBonus = 75;
        slab = '2,75,000 – 2,99,999 — ₹75 fixed';
    } else if (count === 300000) {
        bonus = 100;
        baseBonus = 100;
        slab = '3,00,000 — ₹100 fixed';
    } else {
        baseBonus = 100;
        extraStitches = count - PRODUCTION_BONUS_ABOVE;
        additionalBonus = extraStitches / PRODUCTION_BONUS_UNIT;
        bonus = baseBonus + additionalBonus;
        slab = `Above 3,00,000 — ₹100 + ${extraStitches.toLocaleString('en-IN')}÷500`;
    }

    return {
        stitches: count,
        slab,
        extraStitches,
        additionalBonus,
        baseBonus,
        bonus
    };
}

function getWorkerDayStitchTotal(data) {
    if (!data || !data.prod) return 0;
    return Object.values(data.prod).reduce((sum, v) => sum + (parseInt(v, 10) || 0), 0);
}

function isDateInRange(dateStr, fromDate, toDate) {
    return dateStr >= fromDate && dateStr <= toDate;
}

function eachDateInRange(fromDate, toDate, callback) {
    const [y0, m0, d0] = fromDate.split('-').map(Number);
    const [y1, m1, d1] = toDate.split('-').map(Number);
    const end = new Date(y1, m1 - 1, d1);
    let cur = new Date(y0, m0 - 1, d0);
    while (cur <= end) {
        const dateStr =
            cur.getFullYear() + '-' +
            String(cur.getMonth() + 1).padStart(2, '0') + '-' +
            String(cur.getDate()).padStart(2, '0');
        callback(dateStr);
        cur.setDate(cur.getDate() + 1);
    }
}

/** Saved attendance or implied festival day (matches Daily Tracker defaults) */
function getEffectiveDayData(worker, date, attendanceData, mySettings) {
    const saved = attendanceData[date] && attendanceData[date][worker.id];
    if (saved) {
        if (saved.teamId && saved.teamId !== worker.teamId) return null;
        return saved;
    }
    if (mySettings.festivals && mySettings.festivals.includes(date)) {
        return { status: 'festival', prod: {}, customBonus: 0, teamId: worker.teamId };
    }
    return null;
}

/** Single-day earnings (production bonus on combined daily stitches) */
function calculateDayEarnings(worker, date, attendanceRecord, mySettings) {
    const data = attendanceRecord || { status: 'absent', prod: {}, customBonus: 0 };
    const s = data.status;
    const isFestivalDate = mySettings.festivals.includes(date);
    const autoBonus = isAutoProductionBonusEnabled(mySettings);

    if (s === 'absent') {
        return {
            date,
            status: s,
            baseSalary: 0,
            festivalPay: 0,
            perfBonus: 0,
            customBonus: 0,
            total: 0,
            totalStitches: 0,
            bonusSlab: '—',
            production: {},
            attendanceLabel: 'Absent'
        };
    }

    let baseSalary = 0;
    let festivalPay = 0;
    const production = {};

    worker.machines.forEach((m, index) => {
        const mt = mySettings.machineTypes.find(x => x.id === m.mtId);
        if (!mt) return;

        const dailySlot = m.salary / 30;
        if (s === 'festival' || s === 'full' || isFestivalDate) {
            if (s === 'festival' || isFestivalDate) festivalPay += dailySlot;
            else baseSalary += dailySlot;
        } else if (s === 'half') {
            baseSalary += dailySlot / 2;
        }

        const stitches = data.prod ? (data.prod[index] || 0) : 0;
        production[mt.name] = stitches;
    });

    const totalStitches = getWorkerDayStitchTotal(data);
    let perfBonus = 0;
    let bonusSlab = '—';
    let bonusDetail = null;

    if (s === 'full' || s === 'half') {
        bonusDetail = calculateStitchBonus(totalStitches);
        perfBonus = bonusDetail.bonus;
        bonusSlab = bonusDetail.slab;
    }

    const customBonus = autoBonus ? 0 : (data.customBonus || 0);
    const total = baseSalary + festivalPay + perfBonus + customBonus;

    let attendanceLabel = 'Present';
    if (s === 'festival' || isFestivalDate) attendanceLabel = 'Festival';
    else if (s === 'full') attendanceLabel = 'Full Day';
    else if (s === 'half') attendanceLabel = 'Half Day';

    return {
        date,
        status: s,
        baseSalary,
        festivalPay,
        perfBonus,
        customBonus,
        total,
        totalStitches,
        bonusSlab,
        bonusDetail,
        production,
        attendanceLabel
    };
}

/** Aggregate payroll for date range */
function getPayrollReportData(workers, attendanceData, mySettings, fromDate, toDate, workerIdFilter) {
    const targetWorkers = workerIdFilter
        ? workers.filter(w => w.id === workerIdFilter)
        : workers;

    const workerReports = [];
    let grandBase = 0;
    let grandPerf = 0;
    let grandCustom = 0;
    let grandFestival = 0;
    let grandTotal = 0;
    let grandStitches = 0;

    const attendanceSummary = { full: 0, half: 0, absent: 0, festival: 0 };

    targetWorkers.forEach(worker => {
        let baseSalary = 0;
        let perfBonus = 0;
        let customBonus = 0;
        let festivalPay = 0;
        let totalStitches = 0;
        const dailyRows = [];
        const workerAttSummary = { full: 0, half: 0, absent: 0, festival: 0 };

        eachDateInRange(fromDate, toDate, date => {
            const dayData = getEffectiveDayData(worker, date, attendanceData, mySettings);
            if (!dayData) return;

            const day = calculateDayEarnings(worker, date, dayData, mySettings);

            if (day.status === 'absent') {
                attendanceSummary.absent++;
                workerAttSummary.absent++;
                return;
            }

            baseSalary += day.baseSalary;
            festivalPay += day.festivalPay;
            perfBonus += day.perfBonus;
            customBonus += day.customBonus;
            totalStitches += day.totalStitches;

            if (day.attendanceLabel === 'Full Day') { attendanceSummary.full++; workerAttSummary.full++; }
            else if (day.attendanceLabel === 'Half Day') { attendanceSummary.half++; workerAttSummary.half++; }
            else if (day.attendanceLabel === 'Festival') { attendanceSummary.festival++; workerAttSummary.festival++; }

            dailyRows.push(day);
        });

        dailyRows.sort((a, b) => a.date.localeCompare(b.date));

        const salaryPart = baseSalary + festivalPay;
        const bonusPart = perfBonus + customBonus;
        const totalSalary = salaryPart + bonusPart;

        const machineNames = worker.machines.map(m => {
            const mt = mySettings.machineTypes.find(x => x.id === m.mtId);
            return mt ? mt.name : 'Unknown';
        }).join(', ');

        const monthlyBase = worker.machines.reduce((s, m) => s + m.salary, 0);

        if (dailyRows.length === 0 && totalSalary === 0) return;

        workerReports.push({
            worker,
            workerId: worker.id,
            name: worker.name,
            phone: worker.phone,
            machineType: machineNames,
            monthlyBaseSalary: monthlyBase,
            baseSalary,
            festivalPay,
            salaryPart,
            perfBonus,
            customBonus,
            bonusPart,
            totalStitches,
            totalSalary,
            attendanceSummary: workerAttSummary,
            dailyRows
        });

        grandBase += baseSalary;
        grandPerf += perfBonus;
        grandCustom += customBonus;
        grandFestival += festivalPay;
        grandTotal += totalSalary;
        grandStitches += totalStitches;
    });

    return {
        workerReports,
        summary: {
            totalBase: grandBase,
            totalPerfBonus: grandPerf,
            totalCustomBonus: grandCustom,
            totalFestivalPay: grandFestival,
            totalSalaryPaid: grandBase + grandFestival,
            totalBonusPaid: grandPerf + grandCustom,
            overallExpense: grandTotal,
            totalStitches: grandStitches
        },
        fromDate,
        toDate
    };
}

/** Calculator / quick estimate */
function estimateProductionPayroll(opts) {
    const stitches = opts.stitches || 0;
    const stitchResult = calculateStitchBonus(stitches);
    let dailyBase = parseFloat(opts.baseSalary) || 0;

    if (!dailyBase && opts.worker) {
        opts.worker.machines.forEach(m => {
            dailyBase += m.salary / 30;
        });
    }

    return {
        ...stitchResult,
        dailyBase,
        finalSalary: dailyBase,
        totalPayout: dailyBase + stitchResult.bonus,
        workerName: opts.workerName || (opts.worker ? opts.worker.name : '')
    };
}
