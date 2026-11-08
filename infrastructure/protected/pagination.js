'use strict';
function invalidCursor() {
  const error = new Error('invalid_cursor'); error.status = 400; throw error;
}
function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return undefined;
  if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalidCursor();
  let key;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) invalidCursor();
    key = JSON.parse(bytes.toString('utf8'));
  } catch { invalidCursor(); }
  if (!key || Array.isArray(key) || Object.keys(key).sort().join(',') !== 'kind,pk' || key.kind !== 'archive' || !/^archive:0x[\da-f]{64}$/.test(key.pk)) invalidCursor();
  return key;
}
function createArchivePager({ query, get }) {
  return async cursor => {
    const result = await query({ limit: 50, exclusiveStartKey: decodeCursor(cursor) });
    const items = (await Promise.all((result.Items || []).map(item => get(item.pk)))).filter(item => item?.kind === 'archive' && item.ready === true);
    const nextCursor = result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null;
    return { items, nextCursor };
  };
}
module.exports = { decodeCursor, createArchivePager };
