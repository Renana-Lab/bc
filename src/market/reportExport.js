export const escapeReportText = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]);

// SpreadsheetML matches the existing market's multi-sheet Excel export without
// importing unrelated runtime dependencies into the account-based application.
export function buildMarketWorkbook(tables) {
  const sheets = tables.map(({
    name,
    rows
  }) => {
    const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const cell = value => `<Cell><Data ss:Type="${typeof value === 'number' ? 'Number' : 'String'}">${escapeReportText(value)}</Data></Cell>`;
    return `<Worksheet ss:Name="${escapeReportText(name)}"><Table><Row>${headers.map(cell).join('')}</Row>${rows.map(row => `<Row>${headers.map(header => cell(row[header])).join('')}</Row>`).join('')}</Table></Worksheet>`;
  });
  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${sheets.join('')}</Workbook>`;
}
