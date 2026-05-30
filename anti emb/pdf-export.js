/** Payroll PDF export using jsPDF */
const PdfExport = (function () {
    const MARGIN = 14;
    const PAGE_W = 210;
    const PAGE_H = 297;

    function getCompanyName() {
        if (typeof teams !== 'undefined' && typeof currentTeamId !== 'undefined' && teams[currentTeamId]) {
            return teams[currentTeamId].name || 'Embroidery Facility';
        }
        return 'Embroidery Facility';
    }

    function pdfAmount(amount) {
        const n = Math.round(Number(amount) || 0);
        return 'Rs. ' + n.toLocaleString('en-IN');
    }

    function newDoc() {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
        doc.setProperties({ title: 'Payroll Report', subject: 'Payroll Export' });
        return doc;
    }

    function addPageNumbers(doc) {
        const total = doc.internal.getNumberOfPages();
        for (let i = 1; i <= total; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setTextColor(120, 120, 120);
            doc.text(`Page ${i} of ${total}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
            doc.setTextColor(0, 0, 0);
        }
    }

    function drawHeader(doc, fromDate, toDate) {
        doc.setFillColor(37, 99, 235);
        doc.rect(0, 0, PAGE_W, 28, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(16);
        doc.setFont('helvetica', 'bold');
        doc.text(getCompanyName(), MARGIN, 12);
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.text('Payroll Report', MARGIN, 20);
        doc.text(`${fromDate}  to  ${toDate}`, PAGE_W - MARGIN, 20, { align: 'right' });
        doc.setTextColor(17, 24, 39);
        return 36;
    }

    function generate(reportData) {
        if (!window.jspdf) throw new Error('PDF library not loaded');

        if (!reportData.workerReports || reportData.workerReports.length === 0) {
            return { error: 'No payroll data for this period. Mark attendance in Daily Tracker first.' };
        }

        const s = reportData.summary;
        if ((s.overallExpense || 0) === 0 && (s.totalStitches || 0) === 0) {
            return { error: 'All amounts are zero. Mark workers as Full/Half Day and enter stitch counts in Daily Tracker.' };
        }

        const doc = newDoc();
        let y = drawHeader(doc, reportData.fromDate, reportData.toDate);

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text(`Generated: ${new Date().toLocaleString('en-IN')}`, MARGIN, y);
        y += 10;

        const rows = reportData.workerReports.map(wr => [
            wr.name,
            (wr.totalStitches || 0).toLocaleString('en-IN'),
            pdfAmount(wr.salaryPart),
            pdfAmount(wr.bonusPart),
            pdfAmount(wr.totalSalary)
        ]);

        if (doc.autoTable) {
            doc.autoTable({
                startY: y,
                head: [['Worker', 'Stitches', 'Salary', 'Bonus', 'Total Payout']],
                body: rows,
                margin: { left: MARGIN, right: MARGIN },
                styles: { fontSize: 9, cellPadding: 3 },
                headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
                alternateRowStyles: { fillColor: [249, 250, 251] }
            });
            y = doc.lastAutoTable.finalY + 10;
        }

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Summary', MARGIN, y);
        y += 7;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        [
            ['Total Salary', pdfAmount(s.totalSalaryPaid)],
            ['Total Bonus', pdfAmount(s.totalBonusPaid)],
            ['Total Payout', pdfAmount(s.overallExpense)],
            ['Total Stitches', (s.totalStitches || 0).toLocaleString('en-IN')]
        ].forEach(([label, val]) => {
            doc.text(`${label}: ${val}`, MARGIN, y);
            y += 6;
        });

        addPageNumbers(doc);

        const filename = `payroll_${reportData.fromDate}_${reportData.toDate}.pdf`;
        doc.save(filename);
        return { success: true, filename };
    }

    return { generate };
})();
