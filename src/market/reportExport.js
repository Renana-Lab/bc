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

// CSV cell: neutralise leading formula characters, double quotes, always quote (newlines stay inside the cell).
export const csvCell = v => `"${String(v ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`;

export const BIDS_CSV_HEADERS = ['id', 'auction_id', 'user_id', 'amount', 'cumulative', 'budget_before', 'budget_after', 'created_at'];
export const AUCTIONS_CSV_HEADERS = ['id', 'description', 'payload', 'seller_identifier', 'winner_identifier', 'payload_revealed', 'status', 'created_at', 'end_at', 'finalized_at', 'highest', 'minimum', 'original_minimum', 'adjusted_minimum', 'deleted_at'];

export function buildCsv(headers, rows) {
  return [headers.map(h => isTimeColumn(h) ? `${h} (UTC)` : h), ...rows.map(r => headers.map(h => formatReportValue(h, r[h])))]
    .map(row => row.map(csvCell).join(',')).join('\r\n');
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
