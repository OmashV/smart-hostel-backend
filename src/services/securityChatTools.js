const SecurityAnomaly    = require("../models/SecurityAnomaly");
const SecurityForecast   = require("../models/SecurityForecast");
const SecurityPattern    = require("../models/SecurityPattern");
const SensorReading      = require("../models/SensorReading");
const DemoSecurityReading = require("../models/DemoSecurityReading");

// ── REAL_ROOM constant — A101 uses real sensorreadings, all others use demo ──
const REAL_ROOM = "A101";

// ── Valid room IDs — used for input sanitization ─────────────────────────────
const VALID_ROOM = /^[A-C]\d{3}$/;
function sanitizeRoomId(roomId) {
  return roomId && VALID_ROOM.test(roomId) ? roomId : null;
}

// ── Source picker — returns the right model for a given roomId ───────────────
function pickSource(roomId) {
  return roomId === REAL_ROOM ? SensorReading : DemoSecurityReading;
}

// ── Query both collections and merge results ─────────────────────────────────
async function aggregateBothSources(pipeline) {
  const [real, demo] = await Promise.all([
    SensorReading.aggregate(pipeline),
    DemoSecurityReading.aggregate(pipeline)
  ]);
  return [...real, ...demo];
}

async function findBothSources(query, options = {}) {
  // Oversample each source so merging and re-sorting doesn't drop records
  // from one source when the other dominates the top N by timestamp.
  const oversample = options.limit ? options.limit * 2 : 0;
  const [real, demo] = await Promise.all([
    SensorReading.find(query)
      .sort(options.sort || {})
      .limit(oversample)
      .select(options.select || "")
      .lean(),
    DemoSecurityReading.find(query)
      .sort(options.sort || {})
      .limit(oversample)
      .select(options.select || "")
      .lean()
  ]);
  return [...real, ...demo];
}

// ── Shared helper — merges hourly aggregates from both sources ───────────────
// Used for both actual and historical aggregations to avoid duplicated logic
function mergeHourlyAggregates(items, valueField, countField = "sample_count") {
  const merged = {};
  for (const item of items) {
    const hour = item._id;
    if (!merged[hour]) {
      merged[hour] = { valueSum: 0, count: 0, latest: null };
    }
    merged[hour].valueSum += (item[valueField] || 0) * (item[countField] || 1);
    merged[hour].count    += item[countField] || 1;
    if (!merged[hour].latest || item.latest_captured_at > merged[hour].latest) {
      merged[hour].latest = item.latest_captured_at;
    }
  }
  return merged;
}

// ── getSecuritySummary ────────────────────────────────────────────────────────
async function getSecuritySummary({ roomId } = {}) {
  roomId = sanitizeRoomId(roomId);
  const pipeline = [];
  if (roomId) pipeline.push({ $match: { room_id: roomId } });

  pipeline.push(
    { $sort: { room_id: 1, captured_at: -1 } },
    { $group: { _id: "$room_id", latest: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$latest" } }
  );

  const latestPerRoom = roomId
    ? await pickSource(roomId).aggregate(pipeline)
    : await aggregateBothSources(pipeline);

  const summary = {
    active_security_alerts: 0,
    suspicious_rooms:       0,
    door_open_rooms:        0,
    high_risk_rooms:        0,
    after_hours_events:     0
  };

  for (const room of latestPerRoom) {
    const capturedHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Colombo", hour: "numeric", hour12: false
      }).format(new Date(room.captured_at))
    );
    const isAfterHours = capturedHour >= 23 || capturedHour <= 5;
    const suspicious   =
      (room.door_status === "Open" && room.door_stable_ms > 300000) ||
      (room.motion_count > 0 && isAfterHours);

    let riskScore = 0;
    if (room.door_status === "Open" && room.door_stable_ms > 1800000) riskScore += 3;
    else if (room.door_status === "Open" && room.door_stable_ms > 600000) riskScore += 2;
    if (room.motion_count === 0)         riskScore += 1;
    if (isAfterHours)                    riskScore += 2;
    if (room.occupancy_stat === "Empty") riskScore += 2;

    if (room.door_status === "Open") summary.door_open_rooms++;
    if (isAfterHours)                summary.after_hours_events++;
    if (suspicious) {
      summary.suspicious_rooms++;
      summary.active_security_alerts++;
    }
    if (riskScore >= 4) summary.high_risk_rooms++;
  }

  return summary;
}

// ── getSecuritySuspiciousRooms ────────────────────────────────────────────────
async function getSecuritySuspiciousRooms({ roomId } = {}) {
  roomId = sanitizeRoomId(roomId);
  const pipeline = [];
  if (roomId) pipeline.push({ $match: { room_id: roomId } });

  pipeline.push(
    { $sort: { room_id: 1, captured_at: -1 } },
    { $group: { _id: "$room_id", latest: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$latest" } },
    {
      $addFields: {
        suspicious: {
          $or: [
            {
              $and: [
                { $eq: ["$door_status", "Open"] },
                { $gt: ["$door_stable_ms", 300000] }
              ]
            },
            {
              $and: [
                { $gt: ["$motion_count", 0] },
                {
                  $or: [
                    { $gte: ["$hour", 23] },
                    { $lte: ["$hour", 5] }
                  ]
                }
              ]
            }
          ]
        }
      }
    },
    { $match: { suspicious: true } },
    {
      $project: {
        _id: 0, room_id: 1, door_status: 1,
        door_stable_ms: 1, motion_count: 1, hour: 1, captured_at: 1
      }
    }
  );

  const rooms = roomId
    ? await pickSource(roomId).aggregate(pipeline)
    : await aggregateBothSources(pipeline);

  return { rooms };
}

// ── getSecurityDoorEvents ─────────────────────────────────────────────────────
// FIX: replaced getSecuritySource(roomId).model / roomFilter pattern
//      with direct pickSource() call which returns the correct model
async function getSecurityDoorEvents({ roomId, limit = 50 } = {}) {
  roomId = sanitizeRoomId(roomId);
  const query        = { door_status: "Open" };
  if (roomId) query.room_id = roomId;

  const selectFields = "room_id captured_at door_status door_stable_ms motion_count hour minute second -_id";

  let events;
  if (roomId) {
    // FIX: use pickSource directly — no destructuring mismatch
    events = await pickSource(roomId)
      .find(query)
      .sort({ captured_at: -1 })
      .limit(Number(limit) || 50)
      .select(selectFields)
      .lean();
  } else {
    const all = await findBothSources(query, {
      sort:   { captured_at: -1 },
      limit:  Number(limit) || 50,
      select: selectFields
    });
    events = all
      .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))
      .slice(0, Number(limit) || 50);
  }

  return { events };
}

// ── getSecurityTrend ──────────────────────────────────────────────────────────
// FIX: uses mergeHourlyAggregates consistently for both actual and historical
async function getSecurityTrend({ roomId } = {}) {
  roomId = sanitizeRoomId(roomId);
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Colombo"
  });

  const todayStart = new Date(`${today}T00:00:00+05:30`);
  const todayEnd   = new Date(`${today}T23:59:59+05:30`);

  // ── Actual readings for today ─────────────────────────────────────────────
  const actualMatch = {
    door_stable_ms: { $gt: 0 },
    captured_at:    { $gte: todayStart, $lte: todayEnd }
  };
  if (roomId) actualMatch.room_id = roomId;

  const actualGroupPipeline = [
    { $match: actualMatch },
    {
      $group: {
        _id:                   { $hour: { date: "$captured_at", timezone: "Asia/Colombo" } },
        actual_door_stable_ms: { $avg: "$door_stable_ms" },
        sample_count:          { $sum: 1 },
        latest_captured_at:    { $max: "$captured_at" }
      }
    }
  ];

  const actualReadingsRaw = roomId
    ? await pickSource(roomId).aggregate(actualGroupPipeline)
    : await aggregateBothSources(actualGroupPipeline);

  const actualByHour = mergeHourlyAggregates(
    actualReadingsRaw,
    "actual_door_stable_ms",
    "sample_count"
  );

  const actualMap = Object.fromEntries(
    Object.entries(actualByHour).map(([hour, value]) => [
      Number(hour),
      {
        actual_door_stable_ms: value.count ? value.valueSum / value.count : null,
        sample_count:          value.count,
        latest_captured_at:    value.latest
      }
    ])
  );

  // ── Historical fallback — all-time average per hour ───────────────────────
  const historicalMatch = { door_stable_ms: { $gt: 0 } };
  if (roomId) historicalMatch.room_id = roomId;

  const historicalGroupPipeline = [
    { $match: historicalMatch },
    {
      $group: {
        _id:               { $hour: { date: "$captured_at", timezone: "Asia/Colombo" } },
        historical_avg_ms: { $avg: "$door_stable_ms" },
        count:             { $sum: 1 }
      }
    }
  ];

  const historicalReadingsRaw = roomId
    ? await pickSource(roomId).aggregate(historicalGroupPipeline)
    : await aggregateBothSources(historicalGroupPipeline);

  // FIX: use mergeHourlyAggregates consistently instead of a manual for-loop
  const historicalByHour = mergeHourlyAggregates(
    historicalReadingsRaw,
    "historical_avg_ms",
    "count"
  );

  const historicalMap = Object.fromEntries(
    Object.entries(historicalByHour).map(([hour, value]) => [
      Number(hour),
      value.count ? value.valueSum / value.count : null
    ])
  );

  // ── Prophet forecasts ─────────────────────────────────────────────────────
  const forecastQuery = { model_name: "prophet" };
  if (roomId) forecastQuery.room_id = roomId;

  const forecasts = await SecurityForecast.find(forecastQuery)
    .sort({ hour: 1 })
    .lean();

  const currentHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Colombo",
      hour:     "numeric",
      hour12:   false
    }).format(new Date())
  );

  const hours = forecasts.length
    ? forecasts
    : Array.from({ length: 24 }, (_, i) => ({
        hour:                     i,
        hour_label:               `${i}:00`,
        expected_door_stable_ms:  null,
        expected_door_stable_min: null,
        lower_bound_ms:           null,
        upper_bound_ms:           null
      }));

  const trend = hours.map((forecast) => {
    const hour         = forecast.hour;
    const isFutureHour = hour > currentHour;
    const actual       = actualMap[hour];

    const isLiveData = !isFutureHour && !!actual;
    const actualMs   = isFutureHour
      ? null
      : actual
      ? Math.round(actual.actual_door_stable_ms)
      : historicalMap[hour] != null
      ? Math.round(historicalMap[hour])
      : null;

    const expectedMs  = forecast.expected_door_stable_ms
      ? Math.round(forecast.expected_door_stable_ms)
      : null;

    const deviationMs = actualMs != null && expectedMs != null
      ? actualMs - expectedMs
      : null;

    let trend_status = "No Data";
    if (actualMs != null && expectedMs != null) {
      if (!isLiveData) {
        trend_status = "Historical Average";
      } else if (actualMs > forecast.upper_bound_ms) {
        trend_status = "Above Expected (Anomalous)";
      } else if (actualMs < forecast.lower_bound_ms) {
        trend_status = "Below Expected (Anomalous)";
      } else if (actualMs > expectedMs) {
        trend_status = "Above Expected (Normal Range)";
      } else if (actualMs < expectedMs) {
        trend_status = "Below Expected (Normal Range)";
      } else {
        trend_status = "Normal";
      }
    } else if (actualMs != null) {
      trend_status = isLiveData
        ? "Live door stability data available"
        : "Historical door stability data available";
    } else if (expectedMs != null) {
      trend_status = "Forecast available, no live data yet";
    }

    return {
      hour,
      hour_label:               forecast.hour_label || `${hour}:00`,
      date:                     today,
      actual_door_stable_ms:    actualMs,
      actual_door_stable_min:   actualMs != null ? Number((actualMs / 60000).toFixed(2)) : null,
      is_live_data:             isLiveData,
      sample_count:             actual?.sample_count || 0,
      latest_captured_at:       actual?.latest_captured_at || null,
      expected_door_stable_ms:  expectedMs,
      expected_door_stable_min: expectedMs != null ? Number((expectedMs / 60000).toFixed(2)) : null,
      lower_bound_ms:           forecast.lower_bound_ms != null ? Math.round(forecast.lower_bound_ms) : null,
      upper_bound_ms:           forecast.upper_bound_ms != null ? Math.round(forecast.upper_bound_ms) : null,
      deviation_ms:             deviationMs,
      deviation_min:            deviationMs != null ? Number((deviationMs / 60000).toFixed(2)) : null,
      trend_status,
      model_name:               forecast.model_name || "prophet"
    };
  });

  return {
    summary: {
      room_id:       roomId || "ALL",
      date:          today,
      hours_covered: trend.length,
      model_name:    "prophet"
    },
    trend
  };
}

// ── getSecurityAnomalies ──────────────────────────────────────────────────────
async function getSecurityAnomalies({ roomId, limit = 50 } = {}) {
  roomId = sanitizeRoomId(roomId);
  const anomalyQuery = { model_name: "isolation_forest" };
  if (roomId) anomalyQuery.room_id = roomId;

  const mlAnomalies = await SecurityAnomaly.find(anomalyQuery)
    .sort({ anomaly_score: 1 })
    .limit(Number(limit) || 50)
    .select("-_id -__v")
    .lean();

  if (!mlAnomalies.length) {
    return { anomalies: [] };
  }

  const forecastQuery = { model_name: "prophet" };
  if (roomId) forecastQuery.room_id = roomId;

  const forecasts = await SecurityForecast.find(forecastQuery).lean();

  const forecastMap = {};
  forecasts.forEach((f) => {
    forecastMap[`${f.room_id}_${f.hour}`] = f;
  });

  const anomalies = mlAnomalies.map((anomaly) => {
    const forecast      = forecastMap[`${anomaly.room_id}_${anomaly.hour}`];
    const isOutsideBand = forecast
      ? anomaly.door_stable_ms > forecast.upper_bound_ms ||
        anomaly.door_stable_ms < forecast.lower_bound_ms
      : null;

    return {
      room_id:                  anomaly.room_id,
      captured_at:              anomaly.captured_at,
      hour:                     anomaly.hour,
      status:                   anomaly.status,
      reason:                   anomaly.reason,
      severity:                 anomaly.severity,
      anomaly_score:            anomaly.anomaly_score,
      door_stable_ms:           anomaly.door_stable_ms,
      door_stable_min:          anomaly.door_stable_min,
      motion_count:             anomaly.motion_count,
      is_after_hours:           anomaly.is_after_hours,
      is_empty:                 anomaly.is_empty,
      expected_door_stable_ms:  forecast?.expected_door_stable_ms  ?? null,
      expected_door_stable_min: forecast?.expected_door_stable_min ?? null,
      lower_bound_ms:           forecast?.lower_bound_ms           ?? null,
      upper_bound_ms:           forecast?.upper_bound_ms           ?? null,
      is_outside_prophet_band:  isOutsideBand,
      model_name:               "isolation_forest"
    };
  });

  return { anomalies };
}

// ── getSecurityPatterns ───────────────────────────────────────────────────────
// Returns one aggregated summary per room (most recent record + profile counts)
// rather than raw rows — keeps LLM context small.
async function getSecurityPatterns({ roomId } = {}) {
  roomId = sanitizeRoomId(roomId);
  const matchStage = roomId ? { $match: { room_id: roomId } } : null;

  const pipeline = [
    ...(matchStage ? [matchStage] : []),
    { $sort: { captured_at: -1 } },
    {
      $group: {
        _id:              "$room_id",
        latest_at:        { $first: "$captured_at" },
        behavior_profile: { $first: "$behavior_profile" },
        pattern_name:     { $first: "$pattern_name" },
        cluster_label:    { $first: "$cluster_label" },
        model_name:       { $first: "$model_name" },
        avg_door_min:     { $avg: "$door_stable_min" },
        total_records:    { $sum: 1 },
        after_hours_count: { $sum: { $cond: ["$is_after_hours", 1, 0] } }
      }
    },
    { $sort: { _id: 1 } }
  ];

  const items = await SecurityPattern.aggregate(pipeline);

  return {
    patterns: items.map((item) => ({
      room_id:           item._id,
      latest_at:         item.latest_at,
      behavior_profile:  item.behavior_profile,
      pattern_name:      item.pattern_name,
      cluster_label:     item.cluster_label,
      model_name:        item.model_name,
      avg_door_min:      item.avg_door_min != null ? Number(item.avg_door_min.toFixed(2)) : null,
      total_records:     item.total_records,
      after_hours_count: item.after_hours_count
    }))
  };
}

module.exports = {
  getSecuritySummary,
  getSecuritySuspiciousRooms,
  getSecurityDoorEvents,
  getSecurityTrend,
  getSecurityAnomalies,
  getSecurityPatterns
};