const SensorReading = require("../models/SensorReading");
const WardenMlAlert = require("../models/WardenMlAlert");
const WardenAnomaly = require("../models/WardenAnomaly");
const WardenForecast = require("../models/WardenForecast");
const WardenPattern = require("../models/WardenPattern");
const WardenHourlySummary = require("../models/WardenHourlySummary");
const DailyRoomSummary = require("../models/DailyRoomSummary");

const ORDERED_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday"
];

function roomQuery(roomId = "All") {
  return roomId && roomId !== "All" && roomId !== "all" ? { room_id: roomId } : {};
}

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function getLatestRoomReadings({ roomId = "All" } = {}) {
  const query = roomQuery(roomId);
  const latest = await SensorReading.aggregate([
    { $match: query },
    { $sort: { room_id: 1, captured_at: -1 } },
    { $group: { _id: "$room_id", latest: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$latest" } },
    { $sort: { room_id: 1 } }
  ]);

  return {
    room_id: roomId,
    rooms: latest.map((room) => ({
      room_id: room.room_id,
      device_id: room.device_id,
      captured_at: room.captured_at,
      occupancy_stat: room.occupancy_stat,
      noise_stat: room.noise_stat,
      door_status: room.door_status,
      sound_peak: toNumber(room.sound_peak),
      current_amp: toNumber(room.current_amp),
      motion_count: toNumber(room.motion_count),
      needs_inspection: Boolean(room.needs_inspection),
      sensor_faults: room.sensor_faults || {}
    }))
  };
}

async function getWardenSummaryTool({ roomId = "All" } = {}) {
  const { rooms } = await getLatestRoomReadings({ roomId });
  const alerts = await WardenMlAlert.countDocuments(roomQuery(roomId));

  return {
    room_id: roomId,
    total_rooms: rooms.length,
    occupied_rooms: rooms.filter((room) => room.occupancy_stat === "Occupied").length,
    empty_rooms: rooms.filter((room) => room.occupancy_stat === "Empty").length,
    sleeping_rooms: rooms.filter((room) => room.occupancy_stat === "Sleeping").length,
    rooms_needing_inspection: rooms.filter((room) => room.needs_inspection).length,
    open_door_rooms: rooms.filter((room) => room.door_status === "Open").length,
    active_ml_alerts: alerts
  };
}

async function getActiveWardenAlerts({ roomId = "All", limit = 10 } = {}) {
  const alerts = await WardenMlAlert.find(roomQuery(roomId))
    .sort({ captured_at: -1, createdAt: -1 })
    .limit(Number(limit) || 10)
    .lean();

  return {
    room_id: roomId,
    alerts: alerts.map((alert) => ({
      room_id: alert.room_id,
      captured_at: alert.captured_at,
      severity: alert.severity,
      confidence: toNumber(alert.confidence),
      model_name: alert.model_name,
      alert_type: alert.alert_type,
      reason: alert.reason
    }))
  };
}

async function getInspectionRooms({ roomId = "All" } = {}) {
  const { rooms } = await getLatestRoomReadings({ roomId });
  const alertCounts = await WardenMlAlert.aggregate([
    { $match: roomQuery(roomId) },
    { $group: { _id: "$room_id", alert_count: { $sum: 1 } } }
  ]);
  const countByRoom = new Map(alertCounts.map((item) => [item._id, item.alert_count]));

  return {
    room_id: roomId,
    rooms: rooms
      .filter((room) => room.needs_inspection || toNumber(countByRoom.get(room.room_id)) > 0)
      .map((room) => ({
        ...room,
        alert_count: toNumber(countByRoom.get(room.room_id)),
        reason: room.needs_inspection
          ? "Latest sensor reading marks this room for inspection."
          : "Room has ML alert evidence."
      }))
  };
}

async function getWeeklyPattern({ roomId = "All" } = {}) {
  const query = roomId && roomId !== "All" && roomId !== "all" ? { room_id: roomId } : { room_id: "All" };
  let items = await WardenPattern.find(query).lean();

  if (!items.length && query.room_id === "All") {
    items = await WardenPattern.find({ room_id: { $ne: "All" } }).lean();
  }

  const byDay = new Map();
  for (const day of ORDERED_DAYS) {
    const rows = items.filter((item) => item.day === day);
    if (!rows.length) {
      byDay.set(day, {
        day,
        day_type: ["Saturday", "Sunday"].includes(day) ? "Weekend" : "Weekday",
        usual_pattern: "No Data",
        avg_occupancy: 0,
        avg_noise_level: 0,
        avg_warnings: 0,
        avg_critical_ratio: 0,
        cluster_id: -1,
        model_name: "KMeans"
      });
    } else {
      const first = rows[0];
      byDay.set(day, {
        day,
        day_type: first.day_type,
        usual_pattern: first.usual_pattern,
        avg_occupancy: rows.reduce((sum, row) => sum + toNumber(row.avg_occupancy), 0) / rows.length,
        avg_noise_level: rows.reduce((sum, row) => sum + toNumber(row.avg_noise_level), 0) / rows.length,
        avg_warnings: rows.reduce((sum, row) => sum + toNumber(row.avg_warnings), 0) / rows.length,
        avg_critical_ratio: rows.reduce((sum, row) => sum + toNumber(row.avg_critical_ratio), 0) / rows.length,
        cluster_id: first.cluster_id,
        model_name: first.model_name || "KMeans"
      });
    }
  }

  return { room_id: roomId, patterns: ORDERED_DAYS.map((day) => byDay.get(day)) };
}

async function getWardenAnomalySummary({ roomId = "All", limit = 10 } = {}) {
  const anomalies = await WardenAnomaly.find(roomQuery(roomId))
    .sort({ date: -1, createdAt: -1 })
    .limit(Number(limit) || 10)
    .lean();

  return {
    room_id: roomId,
    anomalies: anomalies.map((item) => ({
      room_id: item.room_id,
      date: item.date,
      status: item.status,
      anomaly_score: toNumber(item.anomaly_score),
      model_name: item.model_name,
      reason: item.reason,
      avg_sound_peak: toNumber(item.avg_sound_peak),
      avg_current: toNumber(item.avg_current)
    }))
  };
}

async function getWardenForecastSummary({ roomId = "All" } = {}) {
  const forecasts = await WardenForecast.find(roomQuery(roomId))
    .sort({ date: 1 })
    .limit(14)
    .lean();

  return {
    room_id: roomId,
    forecasts: forecasts.map((item) => ({
      room_id: item.room_id,
      date: item.date,
      predicted_occupied_count: toNumber(item.predicted_occupied_count),
      predicted_warning_count: toNumber(item.predicted_warning_count),
      predicted_violation_count: toNumber(item.predicted_violation_count),
      model_name: item.model_name
    }))
  };
}

async function getWardenDataRangeTool({ roomId = "All" } = {}) {
  const query = roomQuery(roomId);
  const sensorCount = await SensorReading.countDocuments(query);
  const hourlyCount = await WardenHourlySummary.countDocuments(query);
  const dailyCount = await DailyRoomSummary.countDocuments(query);

  const firstRaw = await SensorReading.findOne(query).sort({ captured_at: 1 }).lean();
  const lastRaw = await SensorReading.findOne(query).sort({ captured_at: -1 }).lean();
  const firstHourly = await WardenHourlySummary.findOne(query).sort({ date: 1, hour: 1 }).lean();
  const lastHourly = await WardenHourlySummary.findOne(query).sort({ date: -1, hour: -1 }).lean();
  const firstDaily = await DailyRoomSummary.findOne(query).sort({ date: 1 }).lean();
  const lastDaily = await DailyRoomSummary.findOne(query).sort({ date: -1 }).lean();

  const firstCandidates = [firstRaw?.captured_at, firstHourly?.date, firstDaily?.date]
    .filter(Boolean)
    .map((value) => new Date(value));
  const lastCandidates = [lastRaw?.captured_at, lastHourly?.date, lastDaily?.date]
    .filter(Boolean)
    .map((value) => new Date(value));

  if (!firstCandidates.length || !lastCandidates.length) {
    return { room_id: roomId, total_records: 0, total_days_covered: 0, valid: false };
  }

  const first = new Date(Math.min(...firstCandidates.map((date) => date.getTime())));
  const last = new Date(Math.max(...lastCandidates.map((date) => date.getTime())));
  const totalDays = Math.max(1, Math.floor((last - first) / 86400000) + 1);

  return {
    room_id: roomId,
    total_records: sensorCount + hourlyCount + dailyCount,
    first_timestamp: first,
    last_timestamp: last,
    total_days_covered: totalDays,
    valid: totalDays >= 5
  };
}

async function getVisualExplanationContext({ visualId, visualTitle, dashboardState }) {
  const visual = dashboardState?.selectedVisual || null;
  return {
    visual_id: visual?.id || visualId || null,
    title: visual?.title || visualTitle || null,
    shortLabel: visual?.shortLabel || null,
    type: visual?.type || null,
    description: visual?.description || null,
    dataSummary: visual?.dataSummary || null,
    selectedItem: visual?.selectedItem || null,
    dashboardState: visual ? undefined : dashboardState || {}
  };
}

module.exports = {
  getWardenSummaryTool,
  getLatestRoomReadings,
  getActiveWardenAlerts,
  getInspectionRooms,
  getWeeklyPattern,
  getWardenAnomalySummary,
  getWardenForecastSummary,
  getWardenDataRangeTool,
  getVisualExplanationContext
};
