const SensorReading = require("../models/SensorReading");
const {
  NotFoundError,
  assertValidRoomId,
  buildDateMatch,
  formatDateWindow,
  resolveDateWindow,
  resolveGroupBy,
  resolveLimit,
  resolveSeverityFilter,
  resolveTypeFilter
} = require("../utils/dateRange");

const TIMEZONE = "Asia/Colombo";
const QUIET_HOUR_START = 22;
const QUIET_HOUR_END = 6;
const QUIET_HOUR_NOISE_THRESHOLD = 70;
const LONG_DOOR_OPEN_WARNING_MS = 5 * 60 * 1000;
const LONG_DOOR_OPEN_CRITICAL_MS = 15 * 60 * 1000;

function toFixedNumber(value, digits = 4) {
  const numeric = Number(value || 0);
  return Number(numeric.toFixed(digits));
}

function toAverage(values = []) {
  if (!values.length) return 0;
  const total = values.reduce((sum, value) => sum + Number(value || 0), 0);
  return total / values.length;
}

function getSriLankaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((item) => item.type === "year").value;
  const month = parts.find((item) => item.type === "month").value;
  const day = parts.find((item) => item.type === "day").value;

  return { year, month, day };
}

function getSriLankaDateString(date = new Date()) {
  const { year, month, day } = getSriLankaDateParts(date);
  return `${year}-${month}-${day}`;
}

function getGroupByFormat(groupBy) {
  if (groupBy === "hour") return "%Y-%m-%dT%H:00:00";
  if (groupBy === "week") return "%G-W%V";
  return "%Y-%m-%d";
}

function getBucketExpression(groupBy) {
  return {
    $dateToString: {
      format: getGroupByFormat(groupBy),
      date: "$captured_at",
      timezone: TIMEZONE
    }
  };
}

function buildRoomDateMatch(roomId, window) {
  return {
    room_id: roomId,
    ...buildDateMatch("captured_at", window.from, window.to)
  };
}

function buildHistoryMeta(window, groupBy) {
  return {
    range: formatDateWindow(window),
    groupBy
  };
}

function getPeakPoint(points = [], key) {
  if (!points.length) {
    return { value: 0, timestamp: null };
  }

  const peak = points.reduce((best, point) => {
    return point[key] > best[key] ? point : best;
  }, points[0]);

  return {
    value: toFixedNumber(peak[key]),
    timestamp: peak.timestamp
  };
}

function normalizeNoiseStatusFromCounts(warningCount, violationCount) {
  if (violationCount > 0) return "Violation";
  if (warningCount > 0) return "Warning";
  return "Normal";
}

function isQuietHour(hourValue) {
  return hourValue >= QUIET_HOUR_START || hourValue <= QUIET_HOUR_END;
}

function buildAlertItem(reading, kind, values) {
  return {
    id: `${reading._id.toString()}-${kind}`,
    type: values.type,
    severity: values.severity,
    message: values.message,
    timestamp: reading.captured_at,
    status: "active",
    sourceReadingId: reading._id.toString()
  };
}

// Derive student-facing alerts directly from sensor readings when no dedicated alert collection exists.
function mapReadingToDerivedAlerts(reading) {
  const alerts = [];
  const seen = new Set();

  const pushAlert = (kind, payload) => {
    if (seen.has(kind)) return;
    seen.add(kind);
    alerts.push(buildAlertItem(reading, kind, payload));
  };

  if (reading.waste_stat === "Critical" || reading.waste_stat === "Warning") {
    pushAlert("waste-status", {
      type: "energy",
      severity: reading.waste_stat === "Critical" ? "Critical" : "Warning",
      message:
        reading.waste_stat === "Critical"
          ? `High wasted energy detected (${toFixedNumber(reading.interval_wasted_energy_kwh, 3)} kWh).`
          : `Wasted energy warning detected (${toFixedNumber(reading.interval_wasted_energy_kwh, 3)} kWh).`
    });
  }

  if (reading.noise_stat === "Warning" || reading.noise_stat === "Violation") {
    pushAlert("noise-status", {
      type: "noise",
      severity: reading.noise_stat === "Violation" ? "Critical" : "Warning",
      message:
        reading.noise_stat === "Violation"
          ? `Noise violation detected with peak ${toFixedNumber(reading.sound_peak, 2)}.`
          : `Noise warning detected with peak ${toFixedNumber(reading.sound_peak, 2)}.`
    });
  }

  if (isQuietHour(reading.hour) && Number(reading.sound_peak || 0) >= QUIET_HOUR_NOISE_THRESHOLD) {
    pushAlert("quiet-hours-noise", {
      type: "noise",
      severity: "Critical",
      message: `High sound peak (${toFixedNumber(reading.sound_peak, 2)}) detected during quiet hours.`
    });
  }

  if (reading.door_status === "Open" && Number(reading.door_stable_ms || 0) >= LONG_DOOR_OPEN_WARNING_MS) {
    pushAlert("door-open-long", {
      type: "security",
      severity:
        Number(reading.door_stable_ms || 0) >= LONG_DOOR_OPEN_CRITICAL_MS ? "Critical" : "Warning",
      message: `Door remained open for ${Math.round(Number(reading.door_stable_ms || 0) / 1000)} seconds.`
    });
  }

  if (reading.motion_count > 0 && isQuietHour(reading.hour)) {
    pushAlert("late-motion", {
      type: "occupancy",
      severity: "Info",
      message: `Late-hour motion detected (${reading.motion_count} movements).`
    });
  }

  return alerts;
}

function applyAlertFilters(alerts, severityFilter, typeFilter) {
  return alerts.filter((item) => {
    const severityOk = !severityFilter || severityFilter.has(item.severity.toLowerCase());
    const typeOk = !typeFilter || typeFilter.has(item.type.toLowerCase());
    return severityOk && typeOk;
  });
}

function computeInterpretation(roomAverage, hostelAverage) {
  if (!hostelAverage) {
    return "Not enough hostel-wide data for interpretation in this window.";
  }

  const ratio = roomAverage / hostelAverage;
  if (ratio >= 1.15) {
    return "Your room average is above the hostel average. Consider reducing idle appliance usage.";
  }
  if (ratio <= 0.85) {
    return "Your room average is below the hostel average. Good energy efficiency trend.";
  }
  return "Your room average is close to the hostel average in this comparison window.";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function calculateStdDev(values = []) {
  if (values.length <= 1) return 0;
  const avg = toAverage(values);
  const variance =
    values.reduce((sum, item) => sum + (item - avg) * (item - avg), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function getIsoWeekLabel(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function incrementDateByGroup(date, groupBy, step = 1) {
  const next = new Date(date);
  if (groupBy === "hour") {
    next.setUTCHours(next.getUTCHours() + step);
    return next;
  }
  if (groupBy === "week") {
    next.setUTCDate(next.getUTCDate() + 7 * step);
    return next;
  }
  next.setUTCDate(next.getUTCDate() + step);
  return next;
}

function formatForecastTimestamp(date, groupBy) {
  if (groupBy === "hour") {
    return date.toISOString().slice(0, 13) + ":00:00Z";
  }
  if (groupBy === "week") {
    return getIsoWeekLabel(date);
  }
  return date.toISOString().slice(0, 10);
}

async function aggregateEnergyHistory(roomId, window, groupBy) {
  const rows = await SensorReading.aggregate([
    { $match: buildRoomDateMatch(roomId, window) },
    {
      $group: {
        _id: getBucketExpression(groupBy),
        bucketStart: { $min: "$captured_at" },
        energyKwh: { $sum: "$interval_energy_kwh" },
        wastedEnergyKwh: { $sum: "$interval_wasted_energy_kwh" }
      }
    },
    { $sort: { bucketStart: 1 } }
  ]);

  const internalPoints = rows.map((row) => ({
    timestamp: row._id,
    bucketStart: row.bucketStart ? new Date(row.bucketStart) : null,
    energyKwh: toFixedNumber(row.energyKwh),
    wastedEnergyKwh: toFixedNumber(row.wastedEnergyKwh)
  }));

  const points = internalPoints.map(({ timestamp, energyKwh, wastedEnergyKwh }) => ({
    timestamp,
    energyKwh,
    wastedEnergyKwh
  }));

  const totalEnergy = toFixedNumber(points.reduce((sum, point) => sum + point.energyKwh, 0));
  const totalWastedEnergy = toFixedNumber(points.reduce((sum, point) => sum + point.wastedEnergyKwh, 0));
  const peak = getPeakPoint(points, "energyKwh");

  return {
    points,
    internalPoints,
    summary: {
      totalEnergy,
      totalWastedEnergy,
      averageDailyEnergy: points.length ? toFixedNumber(totalEnergy / points.length) : 0,
      peakUsageValue: peak.value,
      peakUsageAt: peak.timestamp
    }
  };
}

async function aggregateNoiseHistory(roomId, window, groupBy) {
  const rows = await SensorReading.aggregate([
    { $match: buildRoomDateMatch(roomId, window) },
    {
      $group: {
        _id: getBucketExpression(groupBy),
        bucketStart: { $min: "$captured_at" },
        soundPeak: { $max: "$sound_peak" },
        warningCount: {
          $sum: {
            $cond: [{ $eq: ["$noise_stat", "Warning"] }, 1, 0]
          }
        },
        violationCount: {
          $sum: {
            $cond: [{ $eq: ["$noise_stat", "Violation"] }, 1, 0]
          }
        },
        quietViolationCount: {
          $sum: {
            $cond: [
              {
                $and: [
                  {
                    $or: [
                      { $gte: ["$hour", QUIET_HOUR_START] },
                      { $lte: ["$hour", QUIET_HOUR_END] }
                    ]
                  },
                  { $gte: ["$sound_peak", QUIET_HOUR_NOISE_THRESHOLD] }
                ]
              },
              1,
              0
            ]
          }
        }
      }
    },
    { $sort: { bucketStart: 1 } }
  ]);

  const points = rows.map((row) => ({
    timestamp: row._id,
    soundPeak: toFixedNumber(row.soundPeak, 2),
    noiseStatus: normalizeNoiseStatusFromCounts(row.warningCount, row.violationCount),
    _quietViolationCount: row.quietViolationCount || 0
  }));

  const peak = getPeakPoint(points, "soundPeak");
  const summary = {
    averageNoisePeak: points.length ? toFixedNumber(toAverage(points.map((item) => item.soundPeak)), 2) : 0,
    noisyIntervals: points.filter((item) => item.noiseStatus !== "Normal").length,
    quietViolations: points.reduce((sum, item) => sum + (item._quietViolationCount || 0), 0),
    peakNoiseValue: peak.value,
    peakNoiseAt: peak.timestamp
  };

  return {
    points: points.map(({ timestamp, soundPeak, noiseStatus }) => ({
      timestamp,
      soundPeak,
      noiseStatus
    })),
    summary
  };
}

async function collectDerivedAlerts(roomId, window, options = {}) {
  const {
    limit = 20,
    severityFilter = null,
    typeFilter = null,
    scanLimit = 1500
  } = options;

  const readings = await SensorReading.find(buildRoomDateMatch(roomId, window))
    .sort({ captured_at: -1 })
    .limit(scanLimit)
    .select(
      "_id captured_at interval_wasted_energy_kwh waste_stat noise_stat sound_peak door_status door_stable_ms motion_count hour"
    );

  const derivedAlerts = readings
    .flatMap((reading) => mapReadingToDerivedAlerts(reading))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const filteredAlerts = applyAlertFilters(derivedAlerts, severityFilter, typeFilter);

  return {
    total: filteredAlerts.length,
    items: filteredAlerts.slice(0, limit)
  };
}

async function getTodayEnergyTotals(roomId) {
  const today = getSriLankaDateString();
  const daily = await SensorReading.aggregate([
    { $match: { room_id: roomId } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$captured_at",
            timezone: TIMEZONE
          }
        },
        totalEnergy: { $sum: "$interval_energy_kwh" },
        totalWastedEnergy: { $sum: "$interval_wasted_energy_kwh" }
      }
    },
    { $match: { _id: today } }
  ]);

  const dayTotals = daily[0];
  return {
    totalEnergyToday: toFixedNumber(dayTotals?.totalEnergy),
    wastedEnergyToday: toFixedNumber(dayTotals?.totalWastedEnergy)
  };
}

async function getLatestStudentReading(roomId) {
  return SensorReading.findOne({ room_id: roomId }).sort({ captured_at: -1 });
}

async function ensureRoomExists(roomId) {
  const latest = await getLatestStudentReading(roomId);
  if (!latest) {
    throw new NotFoundError(`No sensor data found for room '${roomId}'`);
  }
  return latest;
}

async function buildRecommendations(roomId, window) {
  const [energyData, noiseData, alertsSummary, longDoorOpenCount] = await Promise.all([
    aggregateEnergyHistory(roomId, window, "day"),
    aggregateNoiseHistory(roomId, window, "day"),
    getStudentAlertsSummary(roomId, {
      from: window.from.toISOString(),
      to: window.to.toISOString()
    }),
    SensorReading.countDocuments({
      room_id: roomId,
      ...buildDateMatch("captured_at", window.from, window.to),
      door_status: "Open",
      door_stable_ms: { $gte: LONG_DOOR_OPEN_WARNING_MS }
    })
  ]);

  const recommendations = [];
  const energySummary = energyData.summary;
  const wastedRatio =
    energySummary.totalEnergy > 0
      ? energySummary.totalWastedEnergy / energySummary.totalEnergy
      : 0;

  if (wastedRatio >= 0.3) {
    recommendations.push({
      id: "rec-waste-high",
      title: "Reduce avoidable energy waste",
      message:
        "A high share of your recent energy use was flagged as wasted. Turn off idle devices and unplug chargers when not needed.",
      priority: "high",
      category: "energy"
    });
  }

  if (noiseData.summary.quietViolations > 0) {
    recommendations.push({
      id: "rec-quiet-hours",
      title: "Respect quiet hours",
      message:
        "High noise peaks were detected during quiet hours. Keep speaker volume low at night to avoid repeated violations.",
      priority: "high",
      category: "noise"
    });
  } else if (noiseData.summary.noisyIntervals >= 5) {
    recommendations.push({
      id: "rec-noise-pattern",
      title: "Reduce repeated noise spikes",
      message:
        "Frequent noisy intervals were detected in this window. Consider lowering media and conversation volume.",
      priority: "medium",
      category: "noise"
    });
  }

  if (alertsSummary.critical > 0) {
    recommendations.push({
      id: "rec-critical-alerts",
      title: "Review critical alerts first",
      message:
        "Critical alerts are active. Resolve them first to prevent repeated waste or compliance issues.",
      priority: "high",
      category: "alerts"
    });
  }

  if (longDoorOpenCount >= 2) {
    recommendations.push({
      id: "rec-door-open",
      title: "Check door-open behavior",
      message:
        "The door remained open for long periods multiple times. Closing the door promptly improves safety and privacy.",
      priority: "medium",
      category: "security"
    });
  }

  if (!recommendations.length) {
    recommendations.push({
      id: "rec-maintain",
      title: "Maintain current usage habits",
      message:
        "No major warning pattern was detected in the selected period. Keep monitoring your energy and noise trends regularly.",
      priority: "low",
      category: "general"
    });
  }

  return recommendations;
}

async function getStudentOverview(roomId, query = {}) {
  const validatedRoomId = assertValidRoomId(roomId);
  const latest = await ensureRoomExists(validatedRoomId);
  const overviewWindow = resolveDateWindow(query, { defaultRange: "24h" });
  const recentAlertsLimit = resolveLimit(query.limit, { defaultValue: 5, max: 50 });
  const severityFilter = resolveSeverityFilter(query.severity);
  const typeFilter = resolveTypeFilter(query.type);

  const [todayTotals, recentAlerts, recommendations] = await Promise.all([
    getTodayEnergyTotals(validatedRoomId),
    collectDerivedAlerts(validatedRoomId, overviewWindow, {
      limit: recentAlertsLimit,
      severityFilter,
      typeFilter,
      scanLimit: Math.max(recentAlertsLimit * 30, 400)
    }),
    buildRecommendations(validatedRoomId, resolveDateWindow(query, { defaultRange: "7d" }))
  ]);

  const latestReading = {
    occupancy: latest.occupancy_stat || "Unknown",
    noiseStatus: latest.noise_stat || "Unknown",
    wasteStatus: latest.waste_stat || "Unknown",
    doorStatus: latest.door_status || "Unknown",
    currentAmp: toFixedNumber(latest.current_amp, 3),
    updatedAt: latest.captured_at,
    soundPeak: toFixedNumber(latest.sound_peak, 2),
    intervalEnergyKwh: toFixedNumber(latest.interval_energy_kwh),
    intervalWastedEnergyKwh: toFixedNumber(latest.interval_wasted_energy_kwh)
  };

  const kpis = {
    totalEnergyToday: todayTotals.totalEnergyToday,
    wastedEnergyToday: todayTotals.wastedEnergyToday,
    currentNoiseStatus: latestReading.noiseStatus,
    activeAlertsCount: recentAlerts.total
  };

  return {
    roomId: validatedRoomId,
    latestReading,
    kpis,
    recentAlerts: recentAlerts.items,
    recommendations,

    // Backward-compatible fields for existing student frontend adapters.
    room_id: validatedRoomId,
    current_status: {
      occupancy_stat: latestReading.occupancy,
      noise_stat: latestReading.noiseStatus,
      waste_stat: latestReading.wasteStatus,
      door_status: latestReading.doorStatus,
      current_amp: latestReading.currentAmp,
      captured_at: latestReading.updatedAt
    },
    today_energy_kwh: kpis.totalEnergyToday,
    today_wasted_energy_kwh: kpis.wastedEnergyToday
  };
}

async function getStudentEnergyHistory(roomId, query = {}) {
  const validatedRoomId = assertValidRoomId(roomId);
  await ensureRoomExists(validatedRoomId);

  const window = resolveDateWindow(query, { defaultRange: "7d" });
  const groupBy = resolveGroupBy(query.groupBy, "day");
  const { points, summary } = await aggregateEnergyHistory(validatedRoomId, window, groupBy);

  return {
    roomId: validatedRoomId,
    ...buildHistoryMeta(window, groupBy),
    summary,
    points,

    // Backward-compatible fields for existing student frontend adapters.
    room_id: validatedRoomId,
    history: points.map((point) => ({
      date: point.timestamp,
      total_energy_kwh: point.energyKwh,
      wasted_energy_kwh: point.wastedEnergyKwh
    }))
  };
}

async function getStudentNoiseHistory(roomId, query = {}) {
  const validatedRoomId = assertValidRoomId(roomId);
  await ensureRoomExists(validatedRoomId);

  const window = resolveDateWindow(query, { defaultRange: "7d" });
  const groupBy = resolveGroupBy(query.groupBy, "day");
  const { points, summary } = await aggregateNoiseHistory(validatedRoomId, window, groupBy);

  return {
    roomId: validatedRoomId,
    ...buildHistoryMeta(window, groupBy),
    summary,
    points
  };
}

async function getStudentAlerts(roomId, query = {}) {
  const validatedRoomId = assertValidRoomId(roomId);
  await ensureRoomExists(validatedRoomId);

  const window = resolveDateWindow(query, { defaultRange: "7d" });
  const limit = resolveLimit(query.limit, { defaultValue: 20, max: 200 });
  const severityFilter = resolveSeverityFilter(query.severity);
  const typeFilter = resolveTypeFilter(query.type);

  const alerts = await collectDerivedAlerts(validatedRoomId, window, {
    limit,
    severityFilter,
    typeFilter,
    scanLimit: Math.max(limit * 40, 800)
  });

  return {
    roomId: validatedRoomId,
    filters: {
      ...formatDateWindow(window),
      severity: query.severity || null,
      type: query.type || null,
      limit
    },
    total: alerts.total,
    items: alerts.items,

    // Backward-compatible fields for existing student frontend adapters.
    room_id: validatedRoomId,
    alerts: alerts.items
  };
}

async function getStudentAlertsSummary(roomId, query = {}) {
  const validatedRoomId = assertValidRoomId(roomId);
  await ensureRoomExists(validatedRoomId);

  const window = resolveDateWindow(query, { defaultRange: "7d" });
  const severityFilter = resolveSeverityFilter(query.severity);
  const typeFilter = resolveTypeFilter(query.type);

  const alerts = await collectDerivedAlerts(validatedRoomId, window, {
    limit: 10000,
    severityFilter,
    typeFilter,
    scanLimit: 10000
  });

  const byType = alerts.items.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});

  const critical = alerts.items.filter((item) => item.severity === "Critical").length;
  const warning = alerts.items.filter((item) => item.severity === "Warning").length;
  const info = alerts.items.filter((item) => item.severity === "Info").length;

  return {
    roomId: validatedRoomId,
    total: alerts.total,
    active: alerts.total,
    critical,
    warning,
    info,
    byType
  };
}

async function getStudentEnergyComparison(roomId, query = {}) {
  const validatedRoomId = assertValidRoomId(roomId);
  await ensureRoomExists(validatedRoomId);

  const window = resolveDateWindow(query, { defaultRange: "30d" });

  const averageRows = await SensorReading.aggregate([
    { $match: buildDateMatch("captured_at", window.from, window.to) },
    {
      $group: {
        _id: {
          room_id: "$room_id",
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$captured_at",
              timezone: TIMEZONE
            }
          }
        },
        dailyEnergy: { $sum: "$interval_energy_kwh" }
      }
    },
    {
      $group: {
        _id: "$_id.room_id",
        averageDailyEnergy: { $avg: "$dailyEnergy" }
      }
    },
    {
      $project: {
        _id: 0,
        roomId: "$_id",
        averageDailyEnergy: { $round: ["$averageDailyEnergy", 4] }
      }
    }
  ]);

  const currentRoomRow = averageRows.find((row) => row.roomId === validatedRoomId);
  const roomAverage = Number(currentRoomRow?.averageDailyEnergy || 0);

  const otherRooms = averageRows.filter((row) => row.roomId !== validatedRoomId);
  const peerAverage = otherRooms.length
    ? toFixedNumber(toAverage(otherRooms.map((row) => row.averageDailyEnergy)))
    : null;
  const hostelAverage = averageRows.length
    ? toFixedNumber(toAverage(averageRows.map((row) => row.averageDailyEnergy)))
    : 0;

  return {
    roomId: validatedRoomId,
    roomAverage: toFixedNumber(roomAverage),
    peerAverage,
    hostelAverage: toFixedNumber(hostelAverage),
    comparisonWindow: formatDateWindow(window),
    interpretation: computeInterpretation(roomAverage, hostelAverage)
  };
}

async function getStudentEnergyForecastPreview(roomId, query = {}) {
  const validatedRoomId = assertValidRoomId(roomId);
  await ensureRoomExists(validatedRoomId);

  const window = resolveDateWindow(query, { defaultRange: "30d" });
  const groupBy = resolveGroupBy(query.groupBy, "day");
  const forecastHorizon = resolveLimit(query.limit, { defaultValue: 5, min: 1, max: 14 });
  const { points, internalPoints } = await aggregateEnergyHistory(validatedRoomId, window, groupBy);

  const seriesEnergy = internalPoints.map((point) => point.energyKwh);
  const seriesWaste = internalPoints.map((point) => point.wastedEnergyKwh);
  const windowSize = Math.max(1, Math.min(3, seriesEnergy.length));

  const fallbackAnchor = internalPoints[internalPoints.length - 1]?.bucketStart || window.to;
  const forecastPoints = [];

  for (let index = 1; index <= forecastHorizon; index += 1) {
    const recentEnergy = seriesEnergy.slice(-windowSize);
    const recentWaste = seriesWaste.slice(-windowSize);

    const forecastEnergy = toFixedNumber(toAverage(recentEnergy));
    const forecastWaste = toFixedNumber(toAverage(recentWaste));
    const targetDate = incrementDateByGroup(fallbackAnchor, groupBy, index);

    forecastPoints.push({
      timestamp: formatForecastTimestamp(targetDate, groupBy),
      energyKwh: forecastEnergy,
      wastedEnergyKwh: forecastWaste
    });

    seriesEnergy.push(forecastEnergy);
    seriesWaste.push(forecastWaste);
  }

  const historicalEnergy = points.map((item) => item.energyKwh);
  const avg = toAverage(historicalEnergy);
  const stdDev = calculateStdDev(historicalEnergy);
  const variabilityPenalty = avg > 0 ? clamp(stdDev / avg, 0, 0.4) : 0.3;
  const baseConfidence = clamp(0.45 + points.length * 0.015, 0.45, 0.9);
  const score = clamp(baseConfidence - variabilityPenalty, 0.25, 0.9);

  return {
    roomId: validatedRoomId,
    basedOnRange: formatDateWindow(window),
    historicalPoints: points,
    forecastPoints,
    confidence: {
      score: toFixedNumber(score, 3),
      method: "rolling-average-preview",
      note: "This is a lightweight forecast preview, not a trained ML forecast."
    }
  };
}

async function getStudentRecommendations(roomId, query = {}) {
  const validatedRoomId = assertValidRoomId(roomId);
  await ensureRoomExists(validatedRoomId);

  const window = resolveDateWindow(query, { defaultRange: "7d" });
  const items = await buildRecommendations(validatedRoomId, window);

  return {
    roomId: validatedRoomId,
    generatedAt: new Date().toISOString(),
    items
  };
}

module.exports = {
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentNoiseHistory,
  getStudentAlerts,
  getStudentAlertsSummary,
  getStudentEnergyComparison,
  getStudentEnergyForecastPreview,
  getStudentRecommendations
};
