const {
  BatchWriteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
} = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({});
const presenceTable = process.env.PRESENCE_TABLE;
const activityTable = process.env.ACTIVITY_TABLE;
const presenceTtlSeconds = Math.max(30, Number(process.env.PRESENCE_TTL_SECONDS || 60));
const historyTtlDays = Math.max(30, Number(process.env.HISTORY_TTL_DAYS || 400));
const maxHistoryRows = 20000;

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
  body: body === undefined ? "" : JSON.stringify(body),
});

const numberValue = (item, key, fallback = 0) => {
  const value = Number(item?.[key]?.N);
  return Number.isFinite(value) ? value : fallback;
};

const stringValue = (item, key, fallback = "") => item?.[key]?.S || fallback;

const dateKeysBetween = (fromMs, toMs) => {
  const keys = [];
  const cursor = new Date(fromMs);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(toMs);
  end.setUTCHours(0, 0, 0, 0);

  while (cursor <= end && keys.length <= historyTtlDays + 1) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
};

const scanFreshPresence = async (nowSeconds) => {
  const items = [];
  let exclusiveStartKey;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: presenceTable,
        FilterExpression: "expiresAt > :now",
        ExpressionAttributeValues: { ":now": { N: String(nowSeconds) } },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
};

const aggregatePresence = (items, nowMs) => {
  const humanRoles = new Map();
  const bots = new Set();
  let activeAuctions = 0;
  let activeAuctionUpdatedAt = 0;
  let sessions = 0;

  items.forEach((item) => {
    const entityType = stringValue(item, "entityType");
    const actorId = stringValue(item, "actorId");

    if (entityType === "session" && actorId) {
      sessions += 1;
      const role = stringValue(item, "role") === "admin" ? "admin" : "user";
      if (role === "admin" || !humanRoles.has(actorId)) humanRoles.set(actorId, role);
    } else if (entityType === "bot" && actorId) {
      bots.add(actorId);
    } else if (entityType === "system") {
      const updatedAt = numberValue(item, "lastSeen");
      if (updatedAt >= activeAuctionUpdatedAt) {
        activeAuctionUpdatedAt = updatedAt;
        activeAuctions = numberValue(item, "activeAuctions");
      }
    }
  });

  let users = 0;
  let admins = 0;
  humanRoles.forEach((role) => {
    if (role === "admin") admins += 1;
    else users += 1;
  });

  return {
    timestamp: nowMs,
    timestampIso: new Date(nowMs).toISOString(),
    users,
    admins,
    bots: bots.size,
    activeAuctions,
    sessions,
  };
};

const writePresenceEntities = async ({ sessionId, entities, route, activeAuctions }, nowMs) => {
  const nowSeconds = Math.floor(nowMs / 1000);
  const expiresAt = nowSeconds + presenceTtlSeconds;
  const requests = entities.map((entity) => ({
    PutRequest: {
      Item: {
        id: { S: `${sessionId}:${entity.type}:${entity.actorId.slice(0, 24)}` },
        entityType: { S: entity.type },
        actorId: { S: entity.actorId },
        role: { S: entity.role || "user" },
        route: { S: route },
        sessionId: { S: sessionId },
        lastSeen: { N: String(nowMs) },
        expiresAt: { N: String(expiresAt) },
      },
    },
  }));

  if (Number.isFinite(activeAuctions)) {
    requests.push({
      PutRequest: {
        Item: {
          id: { S: "system:active-auctions" },
          entityType: { S: "system" },
          actorId: { S: "active-auctions" },
          role: { S: "system" },
          route: { S: route },
          sessionId: { S: sessionId },
          activeAuctions: { N: String(Math.max(0, Math.floor(activeAuctions))) },
          lastSeen: { N: String(nowMs) },
          expiresAt: { N: String(nowSeconds + presenceTtlSeconds * 2) },
        },
      },
    });
  }

  for (let offset = 0; offset < requests.length; offset += 25) {
    let pending = requests.slice(offset, offset + 25);
    for (let attempt = 0; pending.length && attempt < 4; attempt += 1) {
      const result = await client.send(
        new BatchWriteItemCommand({ RequestItems: { [presenceTable]: pending } }),
      );
      pending = result.UnprocessedItems?.[presenceTable] || [];
      if (pending.length) {
        await new Promise((resolve) => setTimeout(resolve, 40 * 2 ** attempt));
      }
    }
    if (pending.length) throw new Error("Presence heartbeat was only partially stored.");
  }
};

const writeActivitySnapshot = async (counts, nowMs) => {
  const bucketMs = Math.floor(nowMs / 60000) * 60000;
  const expiresAt = Math.floor(bucketMs / 1000) + historyTtlDays * 24 * 60 * 60;
  await client.send(
    new PutItemCommand({
      TableName: activityTable,
      Item: {
        day: { S: new Date(bucketMs).toISOString().slice(0, 10) },
        timestamp: { N: String(bucketMs) },
        timestampIso: { S: new Date(bucketMs).toISOString() },
        users: { N: String(counts.users) },
        admins: { N: String(counts.admins) },
        bots: { N: String(counts.bots) },
        activeAuctions: { N: String(counts.activeAuctions) },
        sessions: { N: String(counts.sessions) },
        expiresAt: { N: String(expiresAt) },
      },
    }),
  );
};

const queryDay = async (day, fromMs = 0, toMs = Number.MAX_SAFE_INTEGER) => {
  const rows = [];
  let exclusiveStartKey;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: activityTable,
        KeyConditionExpression: "#day = :day AND #timestamp BETWEEN :from AND :to",
        ExpressionAttributeNames: { "#day": "day", "#timestamp": "timestamp" },
        ExpressionAttributeValues: {
          ":day": { S: day },
          ":from": { N: String(fromMs) },
          ":to": { N: String(toMs) },
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    rows.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey && rows.length < maxHistoryRows);
  return rows;
};

const mapActivityItem = (item) => ({
  timestamp: numberValue(item, "timestamp"),
  timestampIso: stringValue(item, "timestampIso"),
  users: numberValue(item, "users"),
  admins: numberValue(item, "admins"),
  bots: numberValue(item, "bots"),
  activeAuctions: numberValue(item, "activeAuctions"),
  sessions: numberValue(item, "sessions"),
});

const getPeakToday = async (nowMs) => {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const rows = (await queryDay(day)).map(mapActivityItem);
  return rows.reduce(
    (peak, row) => ({
      users: Math.max(peak.users, row.users),
      admins: Math.max(peak.admins, row.admins),
      bots: Math.max(peak.bots, row.bots),
      activeAuctions: Math.max(peak.activeAuctions, row.activeAuctions),
    }),
    { users: 0, admins: 0, bots: 0, activeAuctions: 0 },
  );
};

const parseHeartbeat = (event) => {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    throw Object.assign(new Error("Heartbeat body must be valid JSON."), { statusCode: 400 });
  }

  const sessionId = String(body.sessionId || "").trim();
  const route = String(body.route || "/").slice(0, 160);
  const rawEntities = Array.isArray(body.entities) ? body.entities.slice(0, 50) : [];
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(sessionId)) {
    throw Object.assign(new Error("Invalid presence session."), { statusCode: 400 });
  }

  const entities = rawEntities
    .map((entity) => ({
      type: entity?.type === "bot" ? "bot" : "session",
      role: entity?.role === "admin" ? "admin" : "user",
      actorId: String(entity?.actorId || "").toLowerCase(),
    }))
    .filter((entity) => /^[a-f0-9]{64}$/.test(entity.actorId));
  if (!entities.length) {
    throw Object.assign(new Error("Heartbeat must contain a wallet session or bot."), {
      statusCode: 400,
    });
  }

  const hasActiveAuctionCount =
    body.activeAuctions !== null &&
    body.activeAuctions !== undefined &&
    body.activeAuctions !== "";
  const activeAuctions = hasActiveAuctionCount ? Number(body.activeAuctions) : null;
  return {
    sessionId,
    route,
    entities,
    activeAuctions: Number.isFinite(activeAuctions) ? activeAuctions : null,
  };
};

const getLiveCounts = async (nowMs) => {
  const items = await scanFreshPresence(Math.floor(nowMs / 1000));
  return aggregatePresence(items, nowMs);
};

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path = String(event.rawPath || event.path || "/").replace(/\/$/, "") || "/";

  try {
    if (method === "OPTIONS") return response(204);

    if (method === "POST" && path.endsWith("/heartbeat")) {
      const heartbeat = parseHeartbeat(event);
      const nowMs = Date.now();
      await writePresenceEntities(heartbeat, nowMs);
      const counts = await getLiveCounts(nowMs);
      await writeActivitySnapshot(counts, nowMs);
      return response(200, { ok: true, counts });
    }

    if (method === "GET" && path.endsWith("/live")) {
      const nowMs = Date.now();
      return response(200, {
        ok: true,
        counts: await getLiveCounts(nowMs),
        peakToday: await getPeakToday(nowMs),
      });
    }

    if (method === "GET" && path.endsWith("/history")) {
      const query = event.queryStringParameters || {};
      const fromMs = Date.parse(query.from || "");
      const toMs = Date.parse(query.to || "");
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
        return response(400, { ok: false, error: "Use a valid from/to ISO date range." });
      }
      if (toMs - fromMs > historyTtlDays * 24 * 60 * 60 * 1000) {
        return response(400, { ok: false, error: `History is limited to ${historyTtlDays} days.` });
      }

      const rows = [];
      for (const day of dateKeysBetween(fromMs, toMs)) {
        rows.push(...(await queryDay(day, fromMs, toMs)).map(mapActivityItem));
        if (rows.length >= maxHistoryRows) break;
      }
      rows.sort((left, right) => left.timestamp - right.timestamp);
      return response(200, { ok: true, rows: rows.slice(0, maxHistoryRows) });
    }

    if (method === "GET" && (path === "/" || path.endsWith("/health"))) {
      return response(200, { ok: true, service: "bc-live-presence", time: new Date().toISOString() });
    }

    return response(404, { ok: false, error: "Presence endpoint not found." });
  } catch (error) {
    console.error("Presence request failed", error);
    return response(error.statusCode || 500, {
      ok: false,
      error: error.statusCode ? error.message : "Live presence is temporarily unavailable.",
    });
  }
};
