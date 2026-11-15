export const escapeReportText = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]);

const isTimeColumn = key => /(?:_at|At)$/.test(key);
const reportDate = (key, value) => {
  if (!isTimeColumn(key) || value === null || value === undefined || value === '') return null;
  const timestamp = typeof value === 'number' ? value : NaN;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function formatReportValue(key, value) {
  return reportDate(key, value) ?? value ?? '';
}

// SpreadsheetML matches the existing market's multi-sheet Excel export without
// importing unrelated runtime dependencies into the account-based application.
export function buildMarketWorkbook(tables) {
  const sheets = tables.map(({
    name,
    rows
  }) => {
    const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const cell = (value, key = '') => {
      const date = reportDate(key, value);
      if (date) return `<Cell ss:StyleID="UtcDate"><Data ss:Type="DateTime">${date.replace(/Z$/, '')}</Data></Cell>`;
      return `<Cell><Data ss:Type="${typeof value === 'number' ? 'Number' : 'String'}">${escapeReportText(value)}</Data></Cell>`;
    };
    return `<Worksheet ss:Name="${escapeReportText(name)}"><Table>${headers.map(header => `<Column ss:Width="${isTimeColumn(header) ? 160 : 110}"/>`).join('')}<Row>${headers.map(header => cell(isTimeColumn(header) ? `${header} (UTC)` : header)).join('')}</Row>${rows.map(row => `<Row>${headers.map(header => cell(row[header], header)).join('')}</Row>`).join('')}</Table></Worksheet>`;
  });
  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="UtcDate"><NumberFormat ss:Format="yyyy-mm-dd hh:mm:ss"/></Style></Styles>${sheets.join('')}</Workbook>`;
}
