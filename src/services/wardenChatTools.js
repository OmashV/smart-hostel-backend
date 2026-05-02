const SensorReading = require("../models/SensorReading");
const WardenMlAlert = require("../models/WardenMlAlert");
const WardenAnomaly = require("../models/WardenAnomaly");
const WardenForecast = require("../models/WardenForecast");
const WardenPattern = require("../models/WardenPattern");
const WardenHourlySummary = require("../models/WardenHourlySummary");
const mongoose = require("mongoose");

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

function normalizeStatus(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (text.includes("violation") || text.includes("critical")) return "Violation";
  if (text.includes("warning")) return "Warning";
  if (text.includes("complaint")) return "Complaint";
  if (text.includes("normal") || text.includes("compliant") || text.includes("stable")) return "Normal";
  return text ? String(value).trim() : "Normal";
}

function noiseSeverity(status = "") {
  const normalized = normalizeStatus(status).toLowerCase();
  if (normalized.includes("violation") || normalized.includes("critical")) return 3;
  if (normalized.includes("warning")) return 2;
  if (normalized.includes("complaint")) return 1;
  return 0;
}

function strongerNoiseStatus(a = "Normal", b = "Normal") {
  return noiseSeverity(b) > noiseSeverity(a) ? normalizeStatus(b) : normalizeStatus(a);
}

function deriveNoiseStat(row = {}) {
  const existing = row.noise_stat || row.avg_noise_stat || row.sound_status || row.noise_status;
  if (existing && normalizeStatus(existing) !== "Normal") return normalizeStatus(existing);

  if (toNumber(row.violation_count) > 0 || toNumber(row.critical_count) > 0) return "Violation";
  if (toNumber(row.warning_count) > 0) return "Warning";
  if (toNumber(row.complaint_count) > 0) return "Complaint";

  return normalizeStatus(existing || "Normal");
}

function isNoiseIssue(room = {}) {
  return noiseSeverity(room.noise_stat) > 0;
}

function isNoiseViolation(room = {}) {
  return noiseSeverity(room.noise_stat) >= 3;
}

function isNoiseComplaintOrWarning(room = {}) {
  const severity = noiseSeverity(room.noise_stat);
  return severity === 1 || severity === 2;
}

function mergeRoom(roomMap, row = {}, source = "unknown") {
  if (!row.room_id) return;
  const existing = roomMap.get(row.room_id) || {};
  const derivedNoise = deriveNoiseStat(row);
  const mergedNoise = strongerNoiseStatus(existing.noise_stat || "Normal", derivedNoise);

  roomMap.set(row.room_id, {
    ...existing,
    room_id: row.room_id,
    floor_id: row.floor_id || existing.floor_id,
    device_id: row.device_id || row.sensor_id || existing.device_id || `SIM-${row.room_id}`,
    captured_at: row.captured_at || row.date || existing.captured_at || null,
    occupancy_stat:
      row.occupancy_stat ||
      existing.occupancy_stat ||
      (toNumber(row.occupied_count || row.total_motion_count || row.motion_count || row.motion) > 0
        ? "Occupied"
        : "Empty"),
    noise_stat: mergedNoise,
    door_status:
      row.door_status ||
      existing.door_status ||
      (toNumber(row.door_open_count) > 0 ? "Open" : "Closed"),
    sound_peak:
  row.sound_peak !== undefined && row.sound_peak !== null
    ? toNumber(row.sound_peak)
    : row.noise !== undefined && row.noise !== null
    ? toNumber(row.noise)
    : row.avg_sound_peak !== undefined && row.avg_sound_peak !== null
    ? toNumber(row.avg_sound_peak)
    : toNumber(existing.sound_peak),
    current_amp: toNumber(row.current_amp || row.current || row.avg_current || existing.current_amp),
    motion_count: toNumber(row.motion_count || row.motion || row.occupied_count || row.total_motion_count || existing.motion_count),
    warning_count: toNumber(existing.warning_count) + toNumber(row.warning_count),
    violation_count: toNumber(existing.violation_count) + toNumber(row.violation_count || row.critical_count),
    complaint_count: toNumber(existing.complaint_count) + toNumber(row.complaint_count),
    needs_inspection: Boolean(existing.needs_inspection || row.needs_inspection || toNumber(row.inspection_count) > 0),
    sensor_faults: row.sensor_faults || existing.sensor_faults || {},
    source: existing.source ? `${existing.source} + ${source}` : source
  });
}

async function getLatestRoomReadings({ roomId = "All" } = {}) {
  const db = mongoose.connection.db;
  const query = roomQuery(roomId);
  const roomMap = new Map();

  const dailyRows = await db
    .collection("daily_room_summary")
    .aggregate([
      { $match: query },
      { $sort: { date: -1 } },
      { $group: { _id: "$room_id", latest: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$latest" } },
      { $sort: { room_id: 1 } }
    ])
    .toArray();

  const hourlyRows = await WardenHourlySummary.aggregate([
    { $match: query },
    { $sort: { date: -1, hour: -1 } },
    { $group: { _id: "$room_id", latest: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$latest" } },
    { $sort: { room_id: 1 } }
  ]);

  const sensorRows = await SensorReading.aggregate([
    { $match: query },
    { $sort: { room_id: 1, captured_at: -1 } },
    { $group: { _id: "$room_id", latest: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$latest" } },
    { $sort: { room_id: 1 } }
  ]);

  dailyRows.forEach((row) => mergeRoom(roomMap, row, "daily_room_summary"));
  hourlyRows.forEach((row) => mergeRoom(roomMap, row, "warden_hourly_summary"));
  sensorRows.forEach((row) => mergeRoom(roomMap, row, "sensorreadings"));

  const rooms = Array.from(roomMap.values()).map((room) => {
    let noise_stat = room.noise_stat || "Normal";
    if (noiseSeverity(noise_stat) === 0) {
      if (toNumber(room.violation_count) > 0) noise_stat = "Violation";
      else if (toNumber(room.warning_count) > 0) noise_stat = "Warning";
      else if (toNumber(room.complaint_count) > 0) noise_stat = "Complaint";
    }
    return { ...room, noise_stat };
  }).sort((a, b) => String(a.room_id).localeCompare(String(b.room_id)));

  return { room_id: roomId, rooms };
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
    open_door_rooms: rooms.filter((room) => String(room.door_status || "").toLowerCase() === "open").length,
    noisy_rooms: rooms.filter(isNoiseIssue).length,
    noise_violation_rooms: rooms.filter(isNoiseViolation).length,
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
          ? "Latest sensor or summary evidence marks this room for inspection."
          : "Room has ML alert evidence."
      }))
  };
}

async function getNoisyRooms({ roomId = "All", mode = "all" } = {}) {
  const { rooms } = await getLatestRoomReadings({ roomId });
  const filtered = rooms.filter((room) => {
    if (mode === "violation") return isNoiseViolation(room);
    if (mode === "complaint") return isNoiseComplaintOrWarning(room);
    return isNoiseIssue(room);
  });

  return {
    room_id: roomId,
    rooms: filtered.map((room) => ({
      room_id: room.room_id,
      noise_stat: room.noise_stat,
      sound_peak: toNumber(room.sound_peak),
      warning_count: toNumber(room.warning_count),
      violation_count: toNumber(room.violation_count),
      complaint_count: toNumber(room.complaint_count),
      captured_at: room.captured_at,
      source: room.source
    }))
  };
}

async function getOpenDoorRooms({ roomId = "All" } = {}) {
  const { rooms } = await getLatestRoomReadings({ roomId });

  return {
    room_id: roomId,
    rooms: rooms
      .filter((room) => String(room.door_status || "").toLowerCase() === "open")
      .map((room) => ({
        room_id: room.room_id,
        door_status: room.door_status,
        captured_at: room.captured_at
      }))
  };
}

async function getRoomNoiseLevel({ roomId }) {
  const { rooms } = await getLatestRoomReadings({ roomId });
  const room = rooms.find((item) => item.room_id === roomId);

  return {
    room_id: roomId,
    found: Boolean(room),
    noise_stat: room?.noise_stat || null,
    sound_peak: toNumber(room?.sound_peak),
    warning_count: toNumber(room?.warning_count),
    violation_count: toNumber(room?.violation_count),
    complaint_count: toNumber(room?.complaint_count),
    captured_at: room?.captured_at || null,
    source: room?.source || null
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
  const firstRaw = await SensorReading.findOne(query).sort({ captured_at: 1 }).lean();
  const lastRaw = await SensorReading.findOne(query).sort({ captured_at: -1 }).lean();
  const firstHourly = await WardenHourlySummary.findOne(query).sort({ date: 1, hour: 1 }).lean();
  const lastHourly = await WardenHourlySummary.findOne(query).sort({ date: -1, hour: -1 }).lean();

  const firstCandidates = [firstRaw?.captured_at, firstHourly?.date]
    .filter(Boolean)
    .map((value) => new Date(value));
  const lastCandidates = [lastRaw?.captured_at, lastHourly?.date]
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
    total_records: sensorCount + hourlyCount,
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
  getNoisyRooms,
  getOpenDoorRooms,
  getRoomNoiseLevel,
  getWeeklyPattern,
  getWardenAnomalySummary,
  getWardenForecastSummary,
  getWardenDataRangeTool,
  getVisualExplanationContext
};
