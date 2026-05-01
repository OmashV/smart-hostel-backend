const SensorReading = require("../models/SensorReading");
const OwnerForecast = require("../models/OwnerForecast");
const OwnerAnomaly = require("../models/OwnerAnomaly");
const OwnerPattern = require("../models/OwnerPattern");
const DailyRoomSummary = require("../models/DailyRoomSummary");
const DailyFloorSummary = require("../models/DailyFloorSummary");
const OwnerAlert = require("../models/OwnerAlert");
const OwnerWeekdayPattern = require("../models/OwnerWeekdayPattern");
const WardenForecast = require("../models/WardenForecast");
const WardenFeatureImportance = require("../models/WardenFeatureImportance");
const WardenAnomaly = require("../models/WardenAnomaly");
const WardenPattern = require("../models/WardenPattern");
const WardenMlAlert = require("../models/WardenMlAlert");
const WardenHourlySummary = require("../models/WardenHourlySummary");
const SecurityForecast = require("../models/SecurityForecast");
const SecurityAnomaly = require("../models/SecurityAnomaly");
const { getFloorIdFromRoomId } = require("../utils/floor");
const { getSecuritySource } = require("../utils/securityReadingSource");


const TIMEZONE = "Asia/Colombo";

function deriveFloorIdFromRoom(roomId = "") {
  const clean = String(roomId).trim().toUpperCase();

  if (/^[A-Z]1\d{2}$/.test(clean)) {
    return `${clean[0]}-Floor-1`;
  }

  if (/^[A-Z]2\d{2}$/.test(clean)) {
    return `${clean[0]}-Floor-2`;
  }

  return "Unknown Floor";
}

function getSriLankaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;

  return { year, month, day };
}

function getSriLankaDateString(date = new Date()) {
  const { year, month, day } = getSriLankaDateParts(date);
  return `${year}-${month}-${day}`;
}

function buildDailyGroupStage() {
  return {
    $group: {
      _id: {
        $dateToString: {
          format: "%Y-%m-%d",
          date: "$captured_at",
          timezone: TIMEZONE
        }
      },
      total_energy_kwh: { $sum: "$interval_energy_kwh" },
      wasted_energy_kwh: { $sum: "$interval_wasted_energy_kwh" },
      critical_waste_events: {
        $sum: {
          $cond: [{ $eq: ["$waste_stat", "Critical"] }, 1, 0]
        }
      }
    }
  };
}

function inferFloorId(roomId = "") {
  const derived = getFloorIdFromRoomId(roomId);
  if (derived && derived !== "Unknown") {
    return derived.replace(/^[A-Z]-/, "");
  }

  const text = String(roomId || "").trim().toUpperCase();
  const digitMatch = text.match(/(\d)/);
  return digitMatch ? `Floor ${digitMatch[1]}` : "Other";
}

function buildInspectionReasons(room = {}) {
  const reasons = [];
  const waste = String(room.waste_stat || "").toLowerCase();
  const noise = String(room.noise_stat || "").toLowerCase();

  if (waste.includes("critical")) reasons.push("Critical waste");
  else if (waste.includes("warning")) reasons.push("Waste warning");

  if (noise.includes("violation")) reasons.push("Noise violation");
  else if (noise.includes("complaint")) reasons.push("Noise complaint");
  else if (noise.includes("warning")) reasons.push("Noise warning");

  const faults = room.sensor_faults || {};
  if (faults.pir) reasons.push("PIR sensor fault");
  if (faults.door) reasons.push("Door sensor fault");
  if (faults.sound) reasons.push("Sound sensor fault");
  if (faults.current) reasons.push("Current sensor fault");

  if (String(room.door_status || "").toLowerCase() === "open") {
    reasons.push("Door left open");
  }

  return reasons;
}

function normalizeWardenRoom(latest = {}) {
  const inspection_reasons = buildInspectionReasons(latest);
  return {
    room_id: latest.room_id,
    floor_id: inferFloorId(latest.room_id),
    occupancy_stat: latest.occupancy_stat || "Unknown",
    noise_stat: latest.noise_stat || "Unknown",
    waste_stat: latest.waste_stat || "Unknown",
    door_status: latest.door_status || "Unknown",
    current_amp: Number(latest.current_amp || 0),
    sound_peak: Number(latest.sound_peak || 0),
    motion_count: Number(latest.motion_count || 0),
    door_stable_ms: Number(latest.door_stable_ms || 0),
    sensor_faults: latest.sensor_faults || {},
    needs_inspection: inspection_reasons.length > 0,
    inspection_reasons,
    captured_at: latest.captured_at || null
  };
}


async function getLatestWardenRoomsFromRawOrSummary(roomId = "All") {
  const normalizedRoomId = String(roomId || "All").trim();
  const roomFilter =
    normalizedRoomId && normalizedRoomId !== "All" && normalizedRoomId !== "all"
      ? { room_id: normalizedRoomId }
      : {};

  const latestRawRows = await SensorReading.aggregate([
    { $match: roomFilter },
    { $sort: { room_id: 1, captured_at: -1 } },
    { $group: { _id: "$room_id", latest: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$latest" } },
    { $sort: { room_id: 1 } }
  ]);

  const latestSummaryRows = await DailyRoomSummary.aggregate([
    { $match: roomFilter },
    { $sort: { room_id: 1, date: -1 } },
    { $group: { _id: "$room_id", latest: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$latest" } },
    { $sort: { room_id: 1 } }
  ]);

  const roomMap = new Map();

  latestSummaryRows.forEach((summary) => {
    const criticalCount = Number(summary.critical_count || 0);
    const warningCount = Number(summary.warning_count || 0);
    const avgSoundPeak = Number(summary.avg_sound_peak || 0);
    const totalMotionCount = Number(summary.total_motion_count || 0);
    const doorOpenCount = Number(summary.door_open_count || 0);
    const wasteRatio = Number(summary.waste_ratio_percent || 0);

    roomMap.set(summary.room_id, {
      room_id: summary.room_id,
      device_id: summary.device_id || summary.sensor_id || `SIM-${summary.room_id}`,
      floor_id: summary.floor_id || inferFloorId(summary.room_id),
      captured_at: summary.date ? new Date(`${summary.date}T23:59:59.000+05:30`) : summary.updatedAt || null,
      occupancy_stat: totalMotionCount > 0 ? "Occupied" : "Empty",
      noise_stat:
        criticalCount > 0 ? "Violation" : warningCount > 0 ? "Warning" : avgSoundPeak > 0 ? "Normal" : "No Data",
      waste_stat: wasteRatio >= 30 ? "Critical" : wasteRatio >= 15 ? "Warning" : wasteRatio > 0 ? "Normal" : "No Data",
      door_status: doorOpenCount > 0 ? "Open" : "Closed",
      current_amp: Number(summary.avg_current || 0),
      sound_peak: avgSoundPeak,
      motion_count: totalMotionCount,
      door_stable_ms: 0,
      sensor_faults: {},
      source: "daily_room_summary"
    });
  });

  latestRawRows.forEach((raw) => {
    const existing = roomMap.get(raw.room_id) || {};

    roomMap.set(raw.room_id, {
      ...existing,
      ...raw,
      room_id: raw.room_id,
      device_id: raw.device_id || raw.sensor_id || existing.device_id || `SENSOR-${raw.room_id}`,
      floor_id: raw.floor_id || existing.floor_id || inferFloorId(raw.room_id),
      captured_at: raw.captured_at || existing.captured_at || null,
      occupancy_stat: raw.occupancy_stat && raw.occupancy_stat !== "Unknown" ? raw.occupancy_stat : existing.occupancy_stat || "Unknown",
      noise_stat: raw.noise_stat && raw.noise_stat !== "Unknown" ? raw.noise_stat : existing.noise_stat || "Unknown",
      waste_stat: raw.waste_stat && raw.waste_stat !== "Unknown" ? raw.waste_stat : existing.waste_stat || "Unknown",
      door_status: raw.door_status || existing.door_status || "Unknown",
      current_amp: Number(raw.current_amp ?? existing.current_amp ?? 0),
      sound_peak: Number(raw.sound_peak ?? existing.sound_peak ?? 0),
      motion_count: Number(raw.motion_count ?? existing.motion_count ?? 0),
      door_stable_ms: Number(raw.door_stable_ms ?? existing.door_stable_ms ?? 0),
      sensor_faults: raw.sensor_faults || existing.sensor_faults || {},
      source: existing.source ? "sensorreadings + daily_room_summary" : "sensorreadings"
    });
  });

  return Array.from(roomMap.values()).sort((a, b) =>
    String(a.room_id || "").localeCompare(String(b.room_id || ""))
  );
}

async function getLatestWardenEndDate(roomId = "All") {
  const query = roomId && roomId !== "All" ? { room_id: roomId } : {};
  const latestRaw = await SensorReading.findOne(query).sort({ captured_at: -1 }).lean();
  const latestHourly = await WardenHourlySummary.findOne(query).sort({ date: -1, hour: -1 }).lean();
  const candidates = [];
  if (latestRaw?.captured_at) candidates.push(getSriLankaDateString(new Date(latestRaw.captured_at)));
  if (latestHourly?.date) candidates.push(latestHourly.date);
  return candidates.sort().pop() || getSriLankaDateString(new Date());
}

async function getLatestReading(req, res) {
  try {
    const { roomId } = req.params;

    const reading = await SensorReading.findOne({ room_id: roomId }).sort({
      captured_at: -1
    });

    if (!reading) {
      return res.status(404).json({ message: "No reading found" });
    }

    res.json(reading);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getAvailableFloors(req, res) {
  try {
    let floors = [];

    try {
      floors = await DailyFloorSummary.distinct("floor_id");
    } catch (error) {
      floors = [];
    }

    if (!floors.length) {
      const roomIds = await SensorReading.distinct("room_id");
      floors = Array.from(new Set(roomIds.filter(Boolean).map(inferFloorId)));
    }

    res.json({ floors: floors.filter(Boolean).sort() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getAvailableRooms(req, res) {
  try {
    const { floorId } = req.query;

    let rooms = [];

    try {
      const query = {};
      if (floorId && floorId !== "all") {
        query.floor_id = floorId;
      }
      rooms = await DailyRoomSummary.distinct("room_id", query);
    } catch (error) {
      rooms = [];
    }

    if (!rooms.length) {
      rooms = (await SensorReading.distinct("room_id")).filter(Boolean).sort();
      if (floorId && floorId !== "all") {
        rooms = rooms.filter((roomId) => inferFloorId(roomId) === floorId);
      }
    }

    res.json({
      rooms: rooms.filter(Boolean).sort()
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getFloorOverview(req, res) {
  try {
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;

    const floors = await DailyFloorSummary.find({ date: todayKey })
      .sort({ floor_id: 1 })
      .lean();

    res.json({ floors });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ================= OWNER =================

async function getOwnerWeekdayPatterns(req, res) {
  try {
    const { roomId } = req.query;

    const query = {};
    if (roomId) {
      query.room_id = roomId;
    }

    const weekdayOrder = {
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
      Sunday: 7
    };

    const items = await OwnerWeekdayPattern.find(query).lean();

    items.sort((a, b) => {
      const dayA = weekdayOrder[a.weekday_name] || 99;
      const dayB = weekdayOrder[b.weekday_name] || 99;
      return dayA - dayB;
    });

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerKpis(req, res) {
  try {
    const { roomId } = req.params;

    if (roomId === "A101") {
      const now = new Date();

      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);

      const todayAgg = await SensorReading.aggregate([
        {
          $match: {
            room_id: roomId,
            captured_at: {
              $gte: startOfDay,
              $lte: endOfDay
            }
          }
        },
        {
          $group: {
            _id: null,
            total_energy_kwh: { $sum: "$interval_energy_kwh" },
            wasted_energy_kwh: { $sum: "$interval_wasted_energy_kwh" }
          }
        }
      ]);

      const totalEnergy =
        todayAgg.length > 0 ? Number(todayAgg[0].total_energy_kwh || 0) : 0;

      const wastedEnergy =
        todayAgg.length > 0 ? Number(todayAgg[0].wasted_energy_kwh || 0) : 0;

      const wasteRatio =
        totalEnergy > 0
          ? Number(((wastedEnergy / totalEnergy) * 100).toFixed(2))
          : 0;

      const latest = await SensorReading.findOne({ room_id: roomId })
        .sort({ captured_at: -1 })
        .lean();

      const currentWasteStatus =
        latest?.waste_stat && latest.waste_stat !== "Normal"
          ? latest.waste_stat
          : wasteRatio >= 30
          ? "Critical"
          : wasteRatio >= 15
          ? "Warning"
          : "Normal";

      return res.json({
        room_id: roomId,
        total_energy_today_kwh: Number(totalEnergy.toFixed(4)),
        wasted_energy_today_kwh: Number(wastedEnergy.toFixed(4)),
        waste_ratio_today_percent: Number(wasteRatio.toFixed(2)),
        current_waste_status: currentWasteStatus
      });
    }

    const latestSummary = await DailyRoomSummary.findOne({ room_id: roomId })
      .sort({ date: -1 })
      .lean();

    if (!latestSummary) {
      return res.json({
        room_id: roomId,
        total_energy_today_kwh: 0,
        wasted_energy_today_kwh: 0,
        waste_ratio_today_percent: 0,
        current_waste_status: "Normal"
      });
    }

    const wasteRatio = Number(latestSummary.waste_ratio_percent || 0);
    const currentWasteStatus =
      wasteRatio >= 30 ? "Critical" : wasteRatio >= 15 ? "Warning" : "Normal";

    res.json({
      room_id: roomId,
      total_energy_today_kwh: Number(latestSummary.total_energy_kwh || 0),
      wasted_energy_today_kwh: Number(latestSummary.wasted_energy_kwh || 0),
      waste_ratio_today_percent: wasteRatio,
      current_waste_status: currentWasteStatus
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerRoomsOverview(req, res) {
  try {
    const { floorId } = req.query;

    const latestRow = await DailyRoomSummary.findOne({})
      .sort({ date: -1 })
      .lean();

    if (!latestRow) {
      return res.json({ rooms: [] });
    }

    const query = { date: latestRow.date };

    if (floorId && floorId !== "all") {
      query.floor_id = floorId;
    }

    const rows = await DailyRoomSummary.find(query)
      .sort({ room_id: 1 })
      .lean();

    const rooms = rows.map((row) => {
      const wasteRatio = Number(row.waste_ratio_percent || 0);

      return {
        room_id: row.room_id,
        floor_id: row.floor_id || deriveFloorIdFromRoom(row.room_id),
        occupancy_stat: "Unknown",
        noise_stat: "Compliant",
        waste_stat:
          wasteRatio >= 30 ? "Critical" : wasteRatio >= 15 ? "Warning" : "Normal",
        total_energy_kwh: Number(row.total_energy_kwh || 0),
        wasted_energy_kwh: Number(row.wasted_energy_kwh || 0),
        waste_ratio_percent: wasteRatio,
        last_activity: row.updatedAt || row.createdAt || row.date,
        alert_count: row.critical_count > 0 ? 1 : row.warning_count > 0 ? 1 : 0
      };
    });

    res.json({
      rooms,
      summary_date: latestRow.date
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerOverviewSnapshot(req, res) {
  try {
    const { floorId = "all" } = req.query;

    const matchStage = {};
    if (floorId !== "all") {
      matchStage.floor_id = floorId;
    }

    // Pick the latest date with the highest room coverage
    const coverageRows = await DailyRoomSummary.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$date",
          rooms_count: { $sum: 1 },
          total_energy_kwh: { $sum: "$total_energy_kwh" },
          wasted_energy_kwh: { $sum: "$wasted_energy_kwh" }
        }
      },
      { $sort: { rooms_count: -1, _id: -1 } },
      { $limit: 1 }
    ]);

    if (!coverageRows.length) {
      return res.json({
        summary_date: null,
        kpis: {
          total_energy_today_kwh: 0,
          wasted_energy_today_kwh: 0,
          waste_ratio_today_percent: 0,
          current_waste_status: "No Data"
        },
        rooms: [],
        alerts: []
      });
    }

    const summaryDate = coverageRows[0]._id;

    const query = { date: summaryDate };
    if (floorId !== "all") {
      query.floor_id = floorId;
    }

    const rows = await DailyRoomSummary.find(query)
      .sort({ room_id: 1 })
      .lean();

    const totalEnergy = rows.reduce(
      (sum, row) => sum + Number(row.total_energy_kwh || 0),
      0
    );

    const wastedEnergy = rows.reduce(
      (sum, row) => sum + Number(row.wasted_energy_kwh || 0),
      0
    );

    const wasteRatio =
      totalEnergy > 0
        ? Number(((wastedEnergy / totalEnergy) * 100).toFixed(2))
        : 0;

    const highWasteRooms = rows.filter(
      (row) => Number(row.waste_ratio_percent || 0) >= 30
    ).length;

    let alerts = await OwnerAlert.find({
      is_deleted: false,
      status: "active"
    })
      .sort({ createdAt: -1, updatedAt: -1 })
      .lean();

    if (floorId !== "all") {
      const allowedRoomIds = rows.map((r) => r.room_id);
      alerts = alerts.filter((a) => allowedRoomIds.includes(a.room_id));
    }

    return res.json({
      summary_date: summaryDate,
      kpis: {
        total_energy_today_kwh: Number(totalEnergy.toFixed(4)),
        wasted_energy_today_kwh: Number(wastedEnergy.toFixed(4)),
        waste_ratio_today_percent: wasteRatio,
        current_waste_status: `${highWasteRooms} High Waste Rooms`
      },
      rooms: rows.map((row) => {
        const ratio = Number(row.waste_ratio_percent || 0);

        return {
          room_id: row.room_id,
          floor_id: row.floor_id,
          occupancy_stat: "Unknown",
          noise_stat: "Compliant",
          waste_stat:
            ratio >= 30 ? "Critical" : ratio >= 15 ? "Warning" : "Normal",
          total_energy_kwh: Number(row.total_energy_kwh || 0),
          wasted_energy_kwh: Number(row.wasted_energy_kwh || 0),
          waste_ratio_percent: ratio,
          last_activity: row.updatedAt || row.createdAt || row.date,
          alert_count:
            row.critical_count > 0 ? 1 : row.warning_count > 0 ? 1 : 0
        };
      }),
      alerts: alerts.map((a) => ({
        _id: a._id,
        room_id: a.room_id,
        severity: a.severity,
        title: a.title,
        message: a.message,
        captured_at: a.createdAt || a.updatedAt || a.date
      }))
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getDailyEnergyHistory(req, res) {
  try {
    const { roomId } = req.params;

    // A101 stays live
    if (roomId === "A101") {
      const results = await SensorReading.aggregate([
        { $match: { room_id: roomId } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$captured_at"
              }
            },
            total_energy_kwh: { $sum: "$interval_energy_kwh" },
            wasted_energy_kwh: { $sum: "$interval_wasted_energy_kwh" }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      const history = results.map((row) => {
        const total = Number(row.total_energy_kwh || 0);
        const wasted = Number(row.wasted_energy_kwh || 0);
        const ratio = total > 0 ? Number(((wasted / total) * 100).toFixed(2)) : 0;

        return {
          date: row._id,
          total_energy_kwh: Number(total.toFixed(4)),
          wasted_energy_kwh: Number(wasted.toFixed(4)),
          waste_ratio_percent: ratio
        };
      });

      return res.json({
        room_id: roomId,
        total_days: history.length,
        history
      });
    }

    // Daily summarized room history
    const rows = await DailyRoomSummary.find({ room_id: roomId })
      .sort({ date: 1 })
      .lean();

    const history = rows.map((row) => ({
      date: row.date,
      total_energy_kwh: Number(row.total_energy_kwh || 0),
      wasted_energy_kwh: Number(row.wasted_energy_kwh || 0),
      waste_ratio_percent: Number(row.waste_ratio_percent || 0)
    }));

    res.json({
      room_id: roomId,
      total_days: history.length,
      history
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}


async function getEnergyForecast(req, res) {
  try {
    const { roomId } = req.params;
    const forecastDays = Number(req.query.days || 5);

    let historyRows = [];

    if (roomId === "A101") {
      const results = await SensorReading.aggregate([
        { $match: { room_id: roomId } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$captured_at"
              }
            },
            total_energy_kwh: { $sum: "$interval_energy_kwh" },
            wasted_energy_kwh: { $sum: "$interval_wasted_energy_kwh" }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      historyRows = results.map((row) => {
        const total = Number(row.total_energy_kwh || 0);
        const wasted = Number(row.wasted_energy_kwh || 0);
        const ratio = total > 0 ? Number(((wasted / total) * 100).toFixed(2)) : 0;

        return {
          date: row._id,
          total_energy_kwh: Number(total.toFixed(4)),
          wasted_energy_kwh: Number(wasted.toFixed(4)),
          waste_ratio_percent: ratio
        };
      });
    } else {
      const rows = await DailyRoomSummary.find({ room_id: roomId })
        .sort({ date: 1 })
        .lean();

      historyRows = rows.map((row) => ({
        date: row.date,
        total_energy_kwh: Number(row.total_energy_kwh || 0),
        wasted_energy_kwh: Number(row.wasted_energy_kwh || 0),
        waste_ratio_percent: Number(row.waste_ratio_percent || 0)
      }));
    }

    const latestActualDate =
      historyRows.length > 0 ? historyRows[historyRows.length - 1].date : null;

    let forecastRows = await OwnerForecast.find({ room_id: roomId })
      .sort({ date: 1 })
      .lean();

    if (latestActualDate) {
      forecastRows = forecastRows.filter((row) => row.date > latestActualDate);
    }

    forecastRows = forecastRows.slice(0, forecastDays);

    const forecast = forecastRows.map((row) => ({
      date: row.date,
      predicted_total_energy_kwh: Number(row.predicted_total_energy_kwh || 0),
      predicted_wasted_energy_kwh: Number(row.predicted_wasted_energy_kwh || 0)
    }));

    res.json({
      room_id: roomId,
      based_on_days: historyRows.length,
      forecast_days: forecast.length,
      history: historyRows,
      forecast
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerAlerts(req, res) {
  try {
    const { roomId } = req.query;

    const query = {
      is_deleted: false,
      status: "active"
    };

    if (roomId) {
      query.room_id = roomId;
    }

    const alerts = await OwnerAlert.find(query)
      .sort({ date: -1, createdAt: -1 })
      .lean();

    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function deleteOwnerAlert(req, res) {
  try {
    const { alertId } = req.params;

    const updated = await OwnerAlert.findByIdAndUpdate(
      alertId,
      { $set: { is_deleted: true } },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Alert not found" });
    }

    res.json({ message: "Alert deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function resolveOwnerAlert(req, res) {
  try {
    const { alertId } = req.params;

    const updated = await OwnerAlert.findByIdAndUpdate(
      alertId,
      { $set: { status: "resolved" } },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Alert not found" });
    }

    res.json({ message: "Alert resolved successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}


async function getOwnerAnomalies(req, res) {
  try {
    const { roomId } = req.query;

    const query = {};
    if (roomId) {
      query.room_id = roomId;
    }

    const items = await OwnerAnomaly.find(query)
      .sort({ date: -1 })
      .lean();

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerPatterns(req, res) {
  try {
    const items = await OwnerPattern.find()
      .sort({ date: -1 })
      .lean();

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerForecasts(req, res) {
  try {
    const items = await OwnerForecast.find()
      .sort({ date: 1 })
      .lean();

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}
// ================= WARDEN =================

async function getWardenSummary(req, res) {
  try {
    const { roomId = "All" } = req.query;
    const latestPerRoom = await getLatestWardenRoomsFromRawOrSummary(roomId);
    const summary = { room_id: roomId, occupied_rooms: 0, empty_rooms: 0, sleeping_rooms: 0, noise_issue_rooms: 0, rooms_needing_inspection: 0, open_door_rooms: 0, cleaning_priority_rooms: 0 };
    for (const room of latestPerRoom) {
      const normalized = normalizeWardenRoom(room);
      if (normalized.occupancy_stat === "Occupied") summary.occupied_rooms++;
      else if (normalized.occupancy_stat === "Empty") summary.empty_rooms++;
      else if (normalized.occupancy_stat === "Sleeping") summary.sleeping_rooms++;
      if (["Warning", "Violation", "Complaint"].includes(normalized.noise_stat)) summary.noise_issue_rooms++;
      if (normalized.needs_inspection) summary.rooms_needing_inspection++;
      if (normalized.door_status === "Open") summary.open_door_rooms++;
      if (normalized.occupancy_stat === "Empty" || normalized.needs_inspection) summary.cleaning_priority_rooms++;
    }
    summary.total_rooms = latestPerRoom.length;
    res.json(summary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenRoomsStatus(req, res) {
  try {
    const { roomId = "All" } = req.query;
    const latestPerRoom = await getLatestWardenRoomsFromRawOrSummary(roomId);
    const rooms = latestPerRoom.map(normalizeWardenRoom);
    res.json({ room_id: roomId, rooms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenNoiseIssues(req, res) {
  try {
    const rooms = await SensorReading.aggregate([
      {
        $match: {
          noise_stat: { $in: ["Warning", "Violation"] }
        }
      },
      { $sort: { room_id: 1, captured_at: -1 } },
      {
        $group: {
          _id: "$room_id",
          latest: { $first: "$$ROOT" },
          issue_count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          room_id: "$_id",
          issue_count: 1,
          latest_noise_stat: "$latest.noise_stat",
          latest_sound_peak: "$latest.sound_peak",
          latest_captured_at: "$latest.captured_at"
        }
      },
      { $sort: { issue_count: -1 } }
    ]);

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenFeatureImportance(req, res) {
  try {
    const items = await WardenFeatureImportance.find().sort({ importance: -1 }).lean();
    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenAnomalies(req, res) {
  try {
    const { roomId = "All" } = req.query;
    const query = roomId && roomId !== "All" ? { room_id: roomId } : {};
    const items = await WardenAnomaly.find(query).sort({ date: -1 }).lean();
    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}


async function getWardenDataRange(req, res) {
  try {
    const { roomId = "All" } = req.query;
    const query = roomId && roomId !== "All" ? { room_id: roomId } : {};

    const sensorCount = await SensorReading.countDocuments(query);
    const hourlyCount = await WardenHourlySummary.countDocuments(query);

    const firstRaw = await SensorReading.findOne(query).sort({ captured_at: 1 }).lean();
    const lastRaw = await SensorReading.findOne(query).sort({ captured_at: -1 }).lean();
    const firstHourly = await WardenHourlySummary.findOne(query).sort({ date: 1, hour: 1 }).lean();
    const lastHourly = await WardenHourlySummary.findOne(query).sort({ date: -1, hour: -1 }).lean();

    const firstCandidates = [];
    const lastCandidates = [];
    if (firstRaw?.captured_at) firstCandidates.push(new Date(firstRaw.captured_at));
    if (firstHourly?.date) firstCandidates.push(new Date(`${firstHourly.date}T${String(firstHourly.hour || 0).padStart(2, "0")}:00:00+05:30`));
    if (lastRaw?.captured_at) lastCandidates.push(new Date(lastRaw.captured_at));
    if (lastHourly?.date) lastCandidates.push(new Date(`${lastHourly.date}T${String(lastHourly.hour || 23).padStart(2, "0")}:59:59+05:30`));

    if (!firstCandidates.length || !lastCandidates.length) {
      return res.json({ room_id: roomId, total_records: 0, sensor_records: 0, hourly_summary_records: 0, first_timestamp: null, last_timestamp: null, total_days_covered: 0, is_valid_5_to_7_days_or_more: false, data_sources: [] });
    }

    const firstDate = new Date(Math.min(...firstCandidates.map((d) => d.getTime())));
    const lastDate = new Date(Math.max(...lastCandidates.map((d) => d.getTime())));
    const totalDaysCovered = Math.max(1, Math.floor((lastDate - firstDate) / (1000 * 60 * 60 * 24)) + 1);

    res.json({
      room_id: roomId,
      total_records: sensorCount + hourlyCount,
      sensor_records: sensorCount,
      hourly_summary_records: hourlyCount,
      first_timestamp: firstDate,
      last_timestamp: lastDate,
      total_days_covered: totalDaysCovered,
      is_valid_5_to_7_days_or_more: totalDaysCovered >= 5,
      data_sources: [
        sensorCount ? "sensorreadings" : null,
        hourlyCount ? "warden_hourly_summary" : null
      ].filter(Boolean)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}


async function getWardenMlAlerts(req, res) {
  try {
    const { roomId = "All", limit = 20 } = req.query;
    const query = roomId && roomId !== "All" ? { room_id: roomId } : {};
    const items = await WardenMlAlert.find(query)
      .sort({ createdAt: -1, updatedAt: -1, captured_at: -1 })
      .limit(Number(limit) || 20)
      .lean();

    const normalizedItems = items.map((item) => ({
      ...item,
      display_at: item.display_at || item.generated_at || item.updatedAt || item.createdAt || item.captured_at,
      evidence_at: item.evidence_at || item.captured_at
    }));

    res.json({ items: normalizedItems });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenPatterns(req, res) {
  try {
    const { roomId = "All" } = req.query;
    const orderedDays = [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday"
    ];

    const query = roomId && roomId !== "All" ? { room_id: roomId } : { room_id: "All" };
    let docs = await WardenPattern.find(query).lean();

    if ((!docs || !docs.length) && (!roomId || roomId === "All")) {
      docs = await WardenPattern.aggregate([
        { $match: { room_id: { $ne: "All" } } },
        {
          $group: {
            _id: "$day",
            avg_occupancy: { $avg: "$avg_occupancy" },
            avg_noise_level: { $avg: "$avg_noise_level" },
            avg_warnings: { $avg: "$avg_warnings" },
            avg_critical_ratio: { $avg: "$avg_critical_ratio" },
            record_count: { $sum: "$record_count" },
            usual_pattern: { $first: "$usual_pattern" },
            cluster_id: { $first: "$cluster_id" },
            model_name: { $first: "$model_name" }
          }
        },
        {
          $project: {
            _id: 0,
            room_id: "All",
            day: "$_id",
            day_type: { $cond: [{ $in: ["$_id", ["Saturday", "Sunday"]] }, "Weekend", "Weekday"] },
            avg_occupancy: { $round: ["$avg_occupancy", 2] },
            avg_noise_level: { $round: ["$avg_noise_level", 2] },
            avg_warnings: { $round: ["$avg_warnings", 2] },
            avg_critical_ratio: { $round: ["$avg_critical_ratio", 2] },
            record_count: 1,
            usual_pattern: 1,
            cluster_id: 1,
            model_name: 1
          }
        }
      ]);
    }

    const byDay = new Map((docs || []).map((item) => [item.day, item]));
    const items = orderedDays.map((day) => {
      const found = byDay.get(day);
      return found || {
        room_id: roomId || "All",
        day,
        day_type: ["Saturday", "Sunday"].includes(day) ? "Weekend" : "Weekday",
        cluster_id: -1,
        usual_pattern: "No Data",
        avg_occupancy: 0,
        avg_noise_level: 0,
        avg_warnings: 0,
        avg_critical_ratio: 0,
        record_count: 0,
        model_name: "KMeans"
      };
    });

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenForecasts(req, res) {
  try {
    const { roomId = "All" } = req.query;
    const query = roomId && roomId !== "All" ? { room_id: roomId } : {};
    const items = await WardenForecast.find(query).sort({ date: 1 }).lean();
    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenInspectionQueue(req, res) {
  try {
    const { roomId = "All" } = req.query;
    const latestPerRoom = await getLatestWardenRoomsFromRawOrSummary(roomId);

    const rooms = latestPerRoom
      .map(normalizeWardenRoom)
      .filter((room) => room.needs_inspection)
      .sort((a, b) => {
        const aScore = (a.noise_stat === "Violation" ? 3 : a.noise_stat === "Warning" ? 2 : 0) +
          (a.waste_stat === "Critical" ? 2 : a.waste_stat === "Warning" ? 1 : 0) +
          (a.door_status === "Open" ? 1 : 0);
        const bScore = (b.noise_stat === "Violation" ? 3 : b.noise_stat === "Warning" ? 2 : 0) +
          (b.waste_stat === "Critical" ? 2 : b.waste_stat === "Warning" ? 1 : 0) +
          (b.door_status === "Open" ? 1 : 0);
        return bScore - aScore || String(a.room_id).localeCompare(String(b.room_id));
      });

    res.json({ room_id: roomId, rooms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}


async function getWardenNoiseTrend(req, res) {
  try {
    const days = Math.max(Number(req.query.days || 7), 1);
    const roomId = req.query.roomId || "All";

    const endDate = await getLatestWardenEndDate(roomId);
    const startDateObj = new Date(`${endDate}T00:00:00+05:30`);
    startDateObj.setDate(startDateObj.getDate() - (days - 1));
    const startDate = getSriLankaDateString(startDateObj);
    const roomFilter = roomId && roomId !== "All" ? { room_id: roomId } : {};

    const hourlyRoomIds = await WardenHourlySummary.distinct("room_id", {
      ...roomFilter,
      date: { $gte: startDate, $lte: endDate }
    });

    const hourlyTrend = await WardenHourlySummary.aggregate([
      { $match: { ...roomFilter, date: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: "$date", warning_count: { $sum: { $ifNull: ["$warning_count", 0] } }, violation_count: { $sum: { $ifNull: ["$violation_count", 0] } } } },
      { $project: { _id: 0, date: "$_id", warning_count: 1, violation_count: 1 } }
    ]);

    const byDate = new Map();
    for (const row of hourlyTrend) {
      const current = byDate.get(row.date) || { date: row.date, warning_count: 0, violation_count: 0 };
      current.warning_count += Number(row.warning_count || 0);
      current.violation_count += Number(row.violation_count || 0);
      byDate.set(row.date, current);
    }

    const trend = Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    res.json({ days, trend, source_priority: ["warden_hourly_summary", "sensorreadings"] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}


async function getWardenHistory(req, res) {
  try {
    const days = Math.max(parseInt(req.query.days || "7", 10), 1);
    const roomId = req.query.roomId || "All";
    const endDate = await getLatestWardenEndDate(roomId);
    const startDateObj = new Date(`${endDate}T00:00:00+05:30`);
    startDateObj.setDate(startDateObj.getDate() - (days - 1));
    const startDate = getSriLankaDateString(startDateObj);
    const roomFilter = roomId && roomId !== "All" ? { room_id: roomId } : {};

    const hourlyRoomIds = await WardenHourlySummary.distinct("room_id", {
      ...roomFilter,
      date: { $gte: startDate, $lte: endDate }
    });

    const detailedHourlyRows = await WardenHourlySummary.find({
      ...roomFilter,
      date: { $gte: startDate, $lte: endDate }
    })
      .select({
        _id: 0,
        room_id: 1,
        date: 1,
        hour: 1,
        occupied_count: 1,
        empty_count: 1,
        sleeping_count: 1,
        warning_count: 1,
        violation_count: 1,
        door_open_count: 1,
        inspection_count: 1,
        avg_sound_peak: 1,
        avg_current: 1
      })
      .sort({ date: -1, hour: -1, room_id: 1 })
      .lean();

    const hourlyRows = await WardenHourlySummary.aggregate([
      { $match: { ...roomFilter, date: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: { date: "$date", room_id: "$room_id" }, occupied_count: { $sum: { $ifNull: ["$occupied_count", 0] } }, empty_count: { $sum: { $ifNull: ["$empty_count", 0] } }, sleeping_count: { $sum: { $ifNull: ["$sleeping_count", 0] } }, warning_count: { $sum: { $ifNull: ["$warning_count", 0] } }, violation_count: { $sum: { $ifNull: ["$violation_count", 0] } }, door_open_count: { $sum: { $ifNull: ["$door_open_count", 0] } }, inspection_count: { $sum: { $ifNull: ["$inspection_count", 0] } }, avg_sound_peak: { $avg: { $ifNull: ["$avg_sound_peak", 0] } }, avg_current: { $avg: { $ifNull: ["$avg_current", 0] } } } },
      { $project: { _id: 0, date: "$_id.date", room_id: "$_id.room_id", occupied_count: 1, empty_count: 1, sleeping_count: 1, warning_count: 1, violation_count: 1, door_open_count: 1, inspection_count: 1, avg_sound_peak: { $round: ["$avg_sound_peak", 2] }, avg_current: { $round: ["$avg_current", 4] }, source: "warden_hourly_summary" } }
    ]);

    let combinedRoomRows = [...hourlyRows];

    if (!combinedRoomRows.length) {
      combinedRoomRows = await SensorReading.aggregate([
        { $match: { ...roomFilter, captured_at: { $gte: new Date(`${startDate}T00:00:00+05:30`), $lte: new Date(`${endDate}T23:59:59+05:30`) } } },
        { $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$captured_at", timezone: TIMEZONE } }, room_id: "$room_id" }, occupied_count: { $sum: { $cond: [{ $eq: ["$occupancy_stat", "Occupied"] }, 1, 0] } }, empty_count: { $sum: { $cond: [{ $eq: ["$occupancy_stat", "Empty"] }, 1, 0] } }, sleeping_count: { $sum: { $cond: [{ $eq: ["$occupancy_stat", "Sleeping"] }, 1, 0] } }, warning_count: { $sum: { $cond: [{ $eq: ["$noise_stat", "Warning"] }, 1, 0] } }, violation_count: { $sum: { $cond: [{ $eq: ["$noise_stat", "Violation"] }, 1, 0] } }, door_open_count: { $sum: { $cond: [{ $eq: ["$door_status", "Open"] }, 1, 0] } }, avg_sound_peak: { $avg: "$sound_peak" }, avg_current: { $avg: "$current_amp" }, inspection_count: { $sum: { $cond: ["$needs_inspection", 1, 0] } } } },
        { $project: { _id: 0, date: "$_id.date", room_id: "$_id.room_id", occupied_count: 1, empty_count: 1, sleeping_count: 1, warning_count: 1, violation_count: 1, door_open_count: 1, inspection_count: 1, avg_sound_peak: { $round: ["$avg_sound_peak", 2] }, avg_current: { $round: ["$avg_current", 4] }, source: "sensorreadings" } }
      ]);
    }

    const byDate = new Map();
    for (const row of combinedRoomRows) {
      const key = row.date;
      const current = byDate.get(key) || { date: key, occupied_count: 0, empty_count: 0, sleeping_count: 0, warning_count: 0, violation_count: 0, door_open_count: 0, inspection_count: 0, avg_sound_peak_sum: 0, avg_current_sum: 0, room_count: 0, sources: new Set() };
      current.occupied_count += Number(row.occupied_count || 0);
      current.empty_count += Number(row.empty_count || 0);
      current.sleeping_count += Number(row.sleeping_count || 0);
      current.warning_count += Number(row.warning_count || 0);
      current.violation_count += Number(row.violation_count || 0);
      current.door_open_count += Number(row.door_open_count || 0);
      current.inspection_count += Number(row.inspection_count || 0);
      current.avg_sound_peak_sum += Number(row.avg_sound_peak || 0);
      current.avg_current_sum += Number(row.avg_current || 0);
      current.room_count += 1;
      if (row.source) current.sources.add(row.source);
      byDate.set(key, current);
    }

    const results = Array.from(byDate.values())
      .map((row) => ({
        date: row.date, occupied_count: row.occupied_count, empty_count: row.empty_count, sleeping_count: row.sleeping_count,
        warning_count: row.warning_count, violation_count: row.violation_count, door_open_count: row.door_open_count, inspection_count: row.inspection_count,
        avg_sound_peak: row.room_count ? Number((row.avg_sound_peak_sum / row.room_count).toFixed(2)) : 0,
        avg_current: row.room_count ? Number((row.avg_current_sum / row.room_count).toFixed(4)) : 0,
        room_count: row.room_count, source: Array.from(row.sources).join(" + ")
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const realRoomLevelItems = detailedHourlyRows.length
      ? detailedHourlyRows.map((row) => ({
          ...row,
          avg_sound_peak: Number(Number(row.avg_sound_peak || 0).toFixed(2)),
          avg_current: Number(Number(row.avg_current || 0).toFixed(4)),
          source: "warden_hourly_summary"
        }))
      : combinedRoomRows;

    res.json({ items: results, room_level_items: realRoomLevelItems, source_priority: ["warden_hourly_summary", "sensorreadings"] });
  } catch (error) {
    console.error("getWardenHistory error:", error);
    res.status(500).json({ message: "Failed to load warden history" });
  }
}


async function getOwnerFeatureImportance(req, res) {
  try {
    const items = await OwnerFeatureImportance.find().sort({ importance: -1 }).lean();
    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerAnomalies(req, res) {
  try {
    const { roomId } = req.query;

    const query = {};
    if (roomId) {
      query.room_id = roomId;
    }

    const items = await OwnerAnomaly.find(query)
      .sort({ date: -1 })
      .lean();

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}


// ================= SECURITY =================


// ── Helpers to query both collections ────────────────────────────────────────
async function aggregateBothSources(pipeline) {
  return SensorReading.aggregate(pipeline);
}

async function findBothSources(query, options = {}) {
  return SensorReading.find(query)
    .sort(options.sort || {})
    .limit(options.limit || 0)
    .select(options.select || "")
    .lean();
}

function pickSource() {
  return SensorReading;
}

// ── getSecuritySummary ────────────────────────────────────────────────────────
async function getSecuritySummary(req, res) {
  try {
    const { roomId } = req.query;

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
      const isAfterHours = room.hour >= 23 || room.hour <= 5;

      const suspicious =
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

    res.json(summary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ── getSecuritySuspiciousRooms ────────────────────────────────────────────────
async function getSecuritySuspiciousRooms(req, res) {
  try {
    const { roomId } = req.query;

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
          _id: 0,
          room_id:       1,
          door_status:   1,
          door_stable_ms: 1,
          motion_count:  1,
          hour:          1,
          captured_at:   1
        }
      }
    );

    const rooms = roomId
      ? await pickSource(roomId).aggregate(pipeline)
      : await aggregateBothSources(pipeline);

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ── getSecurityDoorEvents ─────────────────────────────────────────────────────
async function getSecurityDoorEvents(req, res) {
  try {
    const { roomId } = req.query;
    const limit = Number(req.query.limit || 50);

    const query  = { door_status: "Open" };
    if (roomId) query.room_id = roomId;

    const selectFields = "room_id captured_at door_status door_stable_ms motion_count hour minute second -_id";

    let events;
    if (roomId) {
      events = await pickSource(roomId)
        .find(query)
        .sort({ captured_at: -1 })
        .limit(limit)
        .select(selectFields)
        .lean();
    } else {
      const all = await findBothSources(query, {
        sort:   { captured_at: -1 },
        limit,
        select: selectFields
      });
      events = all
        .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))
        .slice(0, limit);
    }

    res.json({ events });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ── getSecurityTrend ──────────────────────────────────────────────────────────
async function getSecurityTrend(req, res) {
  try {
    const { roomId } = req.query;

    // ── Step 1: Today's date range in Colombo timezone ─────────────────────
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Colombo"
    });

    const todayStart = new Date(`${today}T00:00:00+05:30`);
    const todayEnd   = new Date(`${today}T23:59:59+05:30`);

    // ── Step 2a: Today's actual readings ───────────────────────────────────
    const actualMatch = {
      door_stable_ms: { $gt: 0 },
      captured_at: { $gte: todayStart, $lte: todayEnd }
    };
    if (roomId) actualMatch.room_id = roomId;

    const actualGroupPipeline = [
      { $match: actualMatch },
      {
        $group: {
          _id: {
            $hour: { date: "$captured_at", timezone: "Asia/Colombo" }
          },
          actual_door_stable_ms: { $avg: "$door_stable_ms" },
          sample_count:          { $sum: 1 },
          latest_captured_at:    { $max: "$captured_at" }
        }
      }
    ];

    const actualReadingsRaw = roomId
      ? await pickSource(roomId).aggregate(actualGroupPipeline)
      : await aggregateBothSources(actualGroupPipeline);

    // If merged, re-group by hour across both sources
    const actualByHour = {};
    for (const item of actualReadingsRaw) {
      const h = item._id;
      if (!actualByHour[h]) {
        actualByHour[h] = { sum: 0, count: 0, latest: null };
      }
      actualByHour[h].sum   += (item.actual_door_stable_ms || 0) * (item.sample_count || 1);
      actualByHour[h].count += item.sample_count || 1;
      if (!actualByHour[h].latest || item.latest_captured_at > actualByHour[h].latest) {
        actualByHour[h].latest = item.latest_captured_at;
      }
    }

    const actualMap = {};
    for (const [h, val] of Object.entries(actualByHour)) {
      actualMap[Number(h)] = {
        actual_door_stable_ms: val.sum / val.count,
        sample_count:          val.count,
        latest_captured_at:    val.latest
      };
    }

    // ── Step 2b: Historical fallback ───────────────────────────────────────
    const historicalMatch = { door_stable_ms: { $gt: 0 } };
    if (roomId) historicalMatch.room_id = roomId;

    const historicalGroupPipeline = [
      { $match: historicalMatch },
      {
        $group: {
          _id: {
            $hour: { date: "$captured_at", timezone: "Asia/Colombo" }
          },
          historical_avg_ms: { $avg: "$door_stable_ms" },
          count:             { $sum: 1 }
        }
      }
    ];

    const historicalReadingsRaw = roomId
      ? await pickSource(roomId).aggregate(historicalGroupPipeline)
      : await aggregateBothSources(historicalGroupPipeline);

    // Re-group historical across both sources
    const historicalByHour = {};
    for (const item of historicalReadingsRaw) {
      const h = item._id;
      if (!historicalByHour[h]) {
        historicalByHour[h] = { sum: 0, count: 0 };
      }
      historicalByHour[h].sum   += (item.historical_avg_ms || 0) * (item.count || 1);
      historicalByHour[h].count += item.count || 1;
    }

    const historicalMap = {};
    for (const [h, val] of Object.entries(historicalByHour)) {
      historicalMap[Number(h)] = val.sum / val.count;
    }

    // ── Step 3: Pull Prophet forecasts ─────────────────────────────────────
    const forecastQuery = { model_name: "prophet" };
    if (roomId) forecastQuery.room_id = roomId;

    const forecasts = await SecurityForecast.find(forecastQuery)
      .sort({ hour: 1 })
      .lean();

    // ── Step 4: Current hour in Colombo ────────────────────────────────────
    const currentHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Colombo",
        hour:     "numeric",
        hour12:   false
      }).format(new Date())
    );

    // ── Step 5: Build hour base — full 24 hours for expected line ──────────
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

    // ── Step 6: Merge into trend array ─────────────────────────────────────
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
      }

      return {
        hour,
        hour_label:  forecast.hour_label || `${hour}:00`,
        date:        today,

        actual_door_stable_ms:  actualMs,
        actual_door_stable_min: actualMs != null
          ? Number((actualMs / 60000).toFixed(2))
          : null,
        is_live_data:       isLiveData,
        sample_count:       actual?.sample_count || 0,
        latest_captured_at: actual?.latest_captured_at || null,

        expected_door_stable_ms:  expectedMs,
        expected_door_stable_min: expectedMs != null
          ? Number((expectedMs / 60000).toFixed(2))
          : null,
        lower_bound_ms: forecast.lower_bound_ms
          ? Math.round(forecast.lower_bound_ms)
          : null,
        upper_bound_ms: forecast.upper_bound_ms
          ? Math.round(forecast.upper_bound_ms)
          : null,

        deviation_ms:  deviationMs,
        deviation_min: deviationMs != null
          ? Number((deviationMs / 60000).toFixed(2))
          : null,

        trend_status,
        model_name: "prophet"
      };
    });

    res.json({
      summary: {
        room_id:       roomId || "ALL",
        date:          today,
        hours_covered: trend.length,
        model_name:    "prophet"
      },
      trend
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ── getSecurityAnomalies ──────────────────────────────────────────────────────
async function getSecurityAnomalies(req, res) {
  try {
    const { roomId } = req.query;
    const limit = Number(req.query.limit || 50);

    const anomalyQuery = { model_name: "isolation_forest" };
    if (roomId) anomalyQuery.room_id = roomId;

    const mlAnomalies = await SecurityAnomaly.find(anomalyQuery)
      .sort({ anomaly_score: 1 })
      .limit(limit)
      .select("-_id -__v")
      .lean();

    if (!mlAnomalies.length) {
      return res.json({ anomalies: [] });
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
        room_id:      anomaly.room_id,
        captured_at:  anomaly.captured_at,
        hour:         anomaly.hour,

        status:        anomaly.status,
        reason:        anomaly.reason,
        severity:      anomaly.severity,
        anomaly_score: anomaly.anomaly_score,

        door_stable_ms:  anomaly.door_stable_ms,
        door_stable_min: anomaly.door_stable_min,
        motion_count:    anomaly.motion_count,
        is_after_hours:  anomaly.is_after_hours,
        is_empty:        anomaly.is_empty,

        expected_door_stable_ms:  forecast?.expected_door_stable_ms  ?? null,
        expected_door_stable_min: forecast?.expected_door_stable_min ?? null,
        lower_bound_ms:           forecast?.lower_bound_ms           ?? null,
        upper_bound_ms:           forecast?.upper_bound_ms           ?? null,
        is_outside_prophet_band:  isOutsideBand,

        model_name: "isolation_forest"
      };
    });

    res.json({ anomalies });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ================= STUDENT =================

async function getStudentOverview(req, res) {
  try {
    const { roomId } = req.params;

    const latest = await SensorReading.findOne({ room_id: roomId }).sort({ captured_at: -1 });

    if (!latest) {
      return res.status(404).json({ message: "No data found for this room" });
    }

    const todaySriLanka = getSriLankaDateString();

    const daily = await SensorReading.aggregate([
      { $match: { room_id: roomId } },
      buildDailyGroupStage(),
      { $match: { _id: todaySriLanka } }
    ]);

    const today = daily[0];

    res.json({
      room_id: roomId,
      current_status: {
        occupancy_stat: latest.occupancy_stat,
        noise_stat: latest.noise_stat,
        waste_stat: latest.waste_stat,
        door_status: latest.door_status,
        current_amp: latest.current_amp,
        captured_at: latest.captured_at
      },
      today_energy_kwh: Number(((today?.total_energy_kwh) || 0).toFixed(4)),
      today_wasted_energy_kwh: Number(((today?.wasted_energy_kwh) || 0).toFixed(4))
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getStudentEnergyHistory(req, res) {
  try {
    return getDailyEnergyHistory(req, res);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getStudentRecentAlerts(req, res) {
  try {
    const { roomId } = req.params;
    const limit = Number(req.query.limit || 20);

    const alerts = await SensorReading.find({
      room_id: roomId,
      $or: [
        { waste_stat: { $in: ["Warning", "Critical"] } },
        { noise_stat: { $in: ["Warning", "Violation"] } }
      ]
    })
      .sort({ captured_at: -1 })
      .limit(limit)
      .select("captured_at waste_stat noise_stat current_amp sound_peak door_status occupancy_stat");

    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports = {
  getLatestReading,
  getAvailableFloors,
  getAvailableRooms,
  getFloorOverview,
  getOwnerKpis,
  getOwnerWeekdayPatterns,
  getOwnerAnomalies,
  getOwnerPatterns,
  getOwnerForecasts,
  getOwnerRoomsOverview,
  getOwnerOverviewSnapshot,
  getOwnerAlerts,
  deleteOwnerAlert,
  resolveOwnerAlert,
  getDailyEnergyHistory,
  getEnergyForecast,
  getWardenSummary,
  getWardenRoomsStatus,
  getWardenNoiseIssues,
  getWardenInspectionQueue,
  getWardenNoiseTrend,
  getWardenHistory,
  getWardenFeatureImportance,
  getWardenAnomalies,
  getWardenPatterns,
  getWardenForecasts,
  getWardenMlAlerts,
  getWardenDataRange,
  getSecuritySummary,
  getSecuritySuspiciousRooms,
  getSecurityDoorEvents,
  getSecurityTrend,
  getSecurityAnomalies,
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentRecentAlerts
};
