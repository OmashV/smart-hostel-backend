const RANGE_PRESETS = Object.freeze({
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000
});

const VALID_GROUP_BY = new Set(["hour", "day", "week"]);
const VALID_ALERT_SEVERITIES = new Set(["critical", "warning", "info"]);
const VALID_ALERT_TYPES = new Set(["energy", "noise", "security", "occupancy", "general"]);

class HttpError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

class RequestValidationError extends HttpError {
  constructor(message, details = null) {
    super(400, "BAD_REQUEST", message, details);
    this.name = "RequestValidationError";
  }
}

class NotFoundError extends HttpError {
  constructor(message, details = null) {
    super(404, "NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

function parseDateInput(value, fieldName) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RequestValidationError(`Invalid ${fieldName} date format`, {
      field: fieldName,
      value
    });
  }
  return parsed;
}

function assertValidRoomId(roomId) {
  if (!roomId || typeof roomId !== "string" || !roomId.trim()) {
    throw new RequestValidationError("roomId path parameter is required");
  }

  const cleaned = roomId.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cleaned)) {
    throw new RequestValidationError("Invalid roomId format", { roomId: cleaned });
  }

  return cleaned;
}

function resolveRangeDurationMs(range, defaultRange) {
  const fallback = defaultRange || "7d";
  const selected = range || fallback;
  const duration = RANGE_PRESETS[selected];

  if (!duration) {
    throw new RequestValidationError("Invalid range value", {
      range,
      supported: Object.keys(RANGE_PRESETS)
    });
  }

  return { range: selected, duration };
}

function resolveDateWindow(query = {}, options = {}) {
  const { defaultRange = "7d" } = options;
  const now = new Date();

  const from = parseDateInput(query.from, "from");
  const to = parseDateInput(query.to, "to");

  let resolvedFrom;
  let resolvedTo;
  let preset = query.range || null;

  if (from && to) {
    resolvedFrom = from;
    resolvedTo = to;
  } else if (from && !to) {
    resolvedFrom = from;
    resolvedTo = now;
    preset = null;
  } else if (!from && to) {
    const { duration } = resolveRangeDurationMs(query.range, defaultRange);
    resolvedTo = to;
    resolvedFrom = new Date(to.getTime() - duration);
    preset = query.range || defaultRange;
  } else {
    const { range, duration } = resolveRangeDurationMs(query.range, defaultRange);
    resolvedTo = now;
    resolvedFrom = new Date(now.getTime() - duration);
    preset = range;
  }

  if (resolvedFrom > resolvedTo) {
    throw new RequestValidationError("'from' must be earlier than or equal to 'to'");
  }

  return {
    from: resolvedFrom,
    to: resolvedTo,
    range: preset
  };
}

function resolveGroupBy(groupBy, fallback = "day") {
  if (!groupBy) return fallback;
  if (!VALID_GROUP_BY.has(groupBy)) {
    throw new RequestValidationError("Invalid groupBy value", {
      groupBy,
      supported: [...VALID_GROUP_BY]
    });
  }
  return groupBy;
}

function resolveLimit(limit, options = {}) {
  const { defaultValue = 20, min = 1, max = 200 } = options;
  if (limit === undefined || limit === null || limit === "") {
    return defaultValue;
  }

  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RequestValidationError("Invalid limit value", {
      limit,
      min,
      max
    });
  }

  return parsed;
}

function normalizeCsvFilterValue(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function resolveSeverityFilter(value) {
  const values = normalizeCsvFilterValue(value);
  if (!values.length) return null;

  const invalid = values.find((item) => !VALID_ALERT_SEVERITIES.has(item));
  if (invalid) {
    throw new RequestValidationError("Invalid severity filter", {
      severity: value,
      supported: [...VALID_ALERT_SEVERITIES]
    });
  }

  return new Set(values);
}

function resolveTypeFilter(value) {
  const values = normalizeCsvFilterValue(value);
  if (!values.length) return null;

  const invalid = values.find((item) => !VALID_ALERT_TYPES.has(item));
  if (invalid) {
    throw new RequestValidationError("Invalid type filter", {
      type: value,
      supported: [...VALID_ALERT_TYPES]
    });
  }

  return new Set(values);
}

function buildDateMatch(field, from, to) {
  return {
    [field]: {
      $gte: from,
      $lte: to
    }
  };
}

function formatDateWindow(window) {
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    range: window.range || null
  };
}

module.exports = {
  HttpError,
  NotFoundError,
  RequestValidationError,
  assertValidRoomId,
  buildDateMatch,
  formatDateWindow,
  resolveDateWindow,
  resolveGroupBy,
  resolveLimit,
  resolveSeverityFilter,
  resolveTypeFilter
};

