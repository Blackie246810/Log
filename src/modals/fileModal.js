import { AttachmentBuilder } from 'discord.js';
import ExcelJS from 'exceljs';
import { getLogsBetween } from '../db.js';
import { parseDateStartOfDay, parseDateEndOfDay, defaultFileFromDate, FILE_EXPORT_EPOCH, todayDDMMYYYY, formatDateTimeDDMMYYYY } from '../constants.js';
import { logError } from '../errorReporter.js';

export const customId = 'file-modal';

const CURRENCY_KEYS = new Set(['amount', 'cashBalance', 'cardBalance', 'total']);

// Excel has no reliable way to auto-map an arbitrary ISO currency code to a
// native currency-symbol number format (that mapping is locale-based, not
// code-based, and isn't 1:1 across ~180 codes) — so amounts stay a real
// numeric column (sums/sorts still work) with the code as a literal text
// prefix, e.g. "USD 450.00", set per-cell since rows can span a currency
// change.
function formatCurrencyCell(value, currency) {
  return `${currency} ${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function handle(interaction) {
  const rawFrom = interaction.fields.getTextInputValue('from').trim();
  const rawTo = interaction.fields.getTextInputValue('to').trim();

  const errorBlocks = [];
  let fromDate;
  let toDate;

  if (!rawFrom) {
    fromDate = defaultFileFromDate();
  } else if (rawFrom.toLowerCase() === 'all') {
    fromDate = FILE_EXPORT_EPOCH;
  } else {
    fromDate = parseDateStartOfDay(rawFrom);
    if (!fromDate) {
      errorBlocks.push(`Unexpected value for [from]\nexpected values: DD-MM-YYYY format, or "all"\ngiven value: ${rawFrom}`);
    }
  }

  if (!rawTo) {
    toDate = parseDateEndOfDay(todayDDMMYYYY());
  } else {
    toDate = parseDateEndOfDay(rawTo);
    if (!toDate) {
      errorBlocks.push(`Unexpected value for [to]\nexpected values: DD-MM-YYYY format\ngiven value: ${rawTo}`);
    }
  }

  if (errorBlocks.length > 0) {
    const errorText = errorBlocks.join('\n\n');
    logError('file-modal validation', errorText);
    await interaction.reply({ content: errorText });
    return;
  }

  if (fromDate.getTime() > toDate.getTime()) {
    const errorText = `Unexpected value for [from]\nexpected values: a date on or before [to]\ngiven value: from is after to`;
    logError('file-modal validation', errorText);
    await interaction.reply({ content: errorText });
    return;
  }

  await interaction.deferReply();

  let rows;
  try {
    rows = await getLogsBetween(fromDate, toDate);
  } catch (err) {
    logError('file-modal DB read', err);
    await interaction.editReply({ content: 'Database error while building the export. Check the console for details.' });
    return;
  }

  if (rows.length === 0) {
    await interaction.editReply({ content: 'No entries found in that date range.' });
    return;
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Transactions');

  sheet.columns = [
    { header: 'Date', key: 'date' },
    { header: 'Timezone', key: 'timezone' },
    { header: 'Type', key: 'type' },
    { header: 'Category', key: 'category' },
    { header: 'Payment mode', key: 'paymentMode' },
    { header: 'Currency', key: 'currency' },
    { header: 'Amount', key: 'amount' },
    { header: 'Note', key: 'note' },
    { header: 'Cash balance', key: 'cashBalance' },
    { header: 'Card balance', key: 'cardBalance' },
    { header: 'Total', key: 'total' },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const r of rows) {
    sheet.addRow({
      date: formatDateTimeDDMMYYYY(new Date(r.createdAt), r.timezone),
      timezone: r.timezone,
      type: r.type,
      category: r.category,
      paymentMode: r.paymentMode,
      currency: r.currency,
      amount: Number(r.amount),
      note: r.note ?? '',
      cashBalance: Number(r.cashBalance),
      cardBalance: Number(r.cardBalance),
      total: Number(r.total),
    });
  }

  const NOTE_MAX_WIDTH = 45;
  sheet.columns.forEach((column) => {
    let maxLength = column.header.length;
    column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
      if (rowNumber === 1) return;
      const rowData = rows[rowNumber - 2];
      const text = CURRENCY_KEYS.has(column.key)
        ? formatCurrencyCell(cell.value, rowData.currency)
        : String(cell.value ?? '');
      if (CURRENCY_KEYS.has(column.key)) cell.numFmt = `"${rowData.currency} "#,##0.00`;
      maxLength = Math.max(maxLength, text.length);
    });

    if (column.key === 'note') {
      column.width = Math.min(maxLength, NOTE_MAX_WIDTH) + 2;
      column.alignment = { wrapText: true, vertical: 'top' };
    } else {
      column.width = maxLength + 2;
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const fromLabel = fromDate.getTime() === FILE_EXPORT_EPOCH.getTime() ? 'all' : fromDate.toISOString().slice(0, 10);
  const toLabel = toDate.toISOString().slice(0, 10);
  const attachment = new AttachmentBuilder(Buffer.from(buffer), { name: `transactions_${fromLabel}_to_${toLabel}.xlsx` });

  await interaction.editReply({
    content: `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} exported.`,
    files: [attachment],
  });
}
