const SensorReading = require("../models/SensorReading");
const { buildForecast } = require("../services/forecastService");
const OwnerForecast = require("../models/OwnerForecast");
const OwnerFeatureImportance = require("../models/OwnerFeatureImportance");
const OwnerAnomaly = require("../models/OwnerAnomaly");
const OwnerPattern = require("../models/OwnerPattern");
const DailyRoomSummary = require("../models/DailyRoomSummary");


const TIMEZONE = "Asia/Colombo";

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

function mapDailyRows(results) {
  return results.map((item) => ({
    date: item._id,
    total_energy_kwh: Number((item.total_energy_kwh || 0).toFixed(4)),
    wasted_energy_kwh: Number((item.wasted_energy_kwh || 0).toFixed(4)),
    critical_waste_events: item.critical_waste_events || 0
  }));
}

function buildDailyMatchByDate(dateString) {
  return {
    $match: {
      $expr: {
        $eq: [
          {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$captured_at",
              timezone: TIMEZONE
            }
          },
          dateString
        ]
      }
    }
  };
}

function getLatestPerRoomPipeline() {
  return [
    { $sort: { room_id: 1, captured_at: -1 } },
    {
      $group: {
        _id: "$room_id",
        latest: { $first: "$$ROOT" }
      }
    },
    { $replaceRoot: { newRoot: "$latest" } }
  ];
}

function getSensorFaultFlags(room) {
  return {
    pir: Boolean(room?.sensor_faults?.pir),
    door: Boolean(room?.sensor_faults?.door),
    sound: Boolean(room?.sensor_faults?.sound),
    current: Boolean(room?.sensor_faults?.current)
  };
}

function hasAnySensorFault(room) {
  const faults = getSensorFaultFlags(room);
  return faults.pir || faults.door || faults.sound || faults.current;
}

function isStaleReading(capturedAt, staleMinutes = 10) {
  if (!capturedAt) return true;
  const diffMs = Date.now() - new Date(capturedAt).getTime();
  return diffMs > staleMinutes * 60 * 1000;
}

function getInspectionReasons(room) {
  const reasons = [];

  if (room.waste_stat === "Critical") reasons.push("Critical waste");
  if (room.noise_stat === "Violation") reasons.push("Noise violation");
  if (room.noise_stat === "Warning") reasons.push("Noise warning");

  const faults = getSensorFaultFlags(room);
  if (faults.pir) reasons.push("PIR sensor fault");
  if (faults.door) reasons.push("Door sensor fault");
  if (faults.sound) reasons.push("Sound sensor fault");
  if (faults.current) reasons.push("Current sensor fault");

  if (isStaleReading(room.captured_at)) reasons.push("Stale data");

  return reasons;
}

function toWardenRoomStatus(room) {
  const sensor_faults = getSensorFaultFlags(room);
  const stale_data = isStaleReading(room.captured_at);
  const inspection_reasons = getInspectionReasons(room);

  return {
    room_id: room.room_id,
    occupancy_stat: room.occupancy_stat || "Unknown",
    noise_stat: room.noise_stat || "Unknown",
    waste_stat: room.waste_stat || "Unknown",
    door_status: room.door_status || "Unknown",
    current_amp: Number((room.current_amp || 0).toFixed(2)),
    sound_peak: Number((room.sound_peak || 0).toFixed(2)),
    sensor_health: room.sensor_health || {},
    sensor_faults,
    stale_data,
    needs_inspection: inspection_reasons.length > 0,
    inspection_reasons,
    captured_at: room.captured_at
  };
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

// ================= OWNER =================

async function getOwnerRoomsOverview(req, res) {
  try {
    const latestPerRoom = await SensorReading.aggregate([
      { $sort: { captured_at: -1 } },
      {
        $group: {
          _id: "$room_id",
          latest: { $first: "$$ROOT" }
        }
      }
    ]);

    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;

    const summaries = await DailyRoomSummary.find({ date: todayKey }).lean();
    const summaryMap = summaries.reduce((acc, item) => {
      acc[item.room_id] = item;
      return acc;
    }, {});

    const rooms = latestPerRoom.map(({ latest }) => {
      const summary = summaryMap[latest.room_id] || {};

      const totalEnergy = Number(summary.total_energy_kwh || 0);
      const wastedEnergy = Number(summary.wasted_energy_kwh || 0);
      const wasteRatio =
        summary.waste_ratio_percent !== undefined && summary.waste_ratio_percent !== null
          ? Number(summary.waste_ratio_percent)
          : totalEnergy > 0
          ? Number(((wastedEnergy / totalEnergy) * 100).toFixed(2))
          : 0;

      const alertCount =
        (latest.waste_stat === "Critical" ? 1 : 0) +
        (latest.noise_stat === "Warning" || latest.noise_stat === "Violation" ? 1 : 0);

      return {
        room_id: latest.room_id,
        occupancy_stat: latest.occupancy_stat || "Unknown",
        noise_stat: latest.noise_stat || "Compliant",
        waste_stat: latest.waste_stat || "Normal",
        total_energy_kwh: totalEnergy,
        wasted_energy_kwh: wastedEnergy,
        waste_ratio_percent: wasteRatio,
        last_activity: latest.captured_at,
        alert_count: alertCount
      };
    });

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerKpis(req, res) {
  try {
    const { roomId } = req.params;

    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;

    const summary = await DailyRoomSummary.findOne({
      room_id: roomId,
      date: todayKey
    }).lean();

    const latest = await SensorReading.findOne({ room_id: roomId })
      .sort({ captured_at: -1 })
      .lean();

    const totalEnergy = Number(summary?.total_energy_kwh || 0);
    const wastedEnergy = Number(summary?.wasted_energy_kwh || 0);
    const wasteRatio =
      summary?.waste_ratio_percent !== undefined && summary?.waste_ratio_percent !== null
        ? Number(summary.waste_ratio_percent)
        : totalEnergy > 0
        ? Number(((wastedEnergy / totalEnergy) * 100).toFixed(2))
        : 0;

    const currentWasteStatus =
      latest?.waste_stat ||
      (wasteRatio >= 30 ? "Critical" : wasteRatio >= 15 ? "Warning" : "Normal");

    const totalEnergy = Number((today?.total_energy_kwh || 0).toFixed(4));
    const wastedEnergy = Number((today?.wasted_energy_kwh || 0).toFixed(4));
    const wasteRatio =
      totalEnergy > 0 ? Number(((wastedEnergy / totalEnergy) * 100).toFixed(2)) : 0;

    const latestReading = await SensorReading.findOne({ room_id: roomId }).sort({
      captured_at: -1
    });

    res.json({
      room_id: roomId,
      date: todaySriLanka,
      total_energy_today_kwh: totalEnergy,
      wasted_energy_today_kwh: wastedEnergy,
      waste_ratio_today_percent: wasteRatio,
      current_waste_status: latestReading?.waste_stat || "Unknown"
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerRoomComparison(req, res) {
  try {
    const todaySriLanka = getSriLankaDateString();

    const results = await SensorReading.aggregate([
      buildDailyMatchByDate(todaySriLanka),
      {
        $group: {
          _id: "$room_id",
          total_energy_kwh: { $sum: "$interval_energy_kwh" },
          wasted_energy_kwh: { $sum: "$interval_wasted_energy_kwh" }
        }
      },
      {
        $project: {
          _id: 0,
          room_id: "$_id",
          total_energy_kwh: { $round: ["$total_energy_kwh", 4] },
          wasted_energy_kwh: { $round: ["$wasted_energy_kwh", 4] },
          waste_ratio_percent: {
            $round: [
              {
                $cond: [
                  { $gt: ["$total_energy_kwh", 0] },
                  {
                    $multiply: [
                      { $divide: ["$wasted_energy_kwh", "$total_energy_kwh"] },
                      100
                    ]
                  },
                  0
                ]
              },
              2
            ]
          }
        }
      },
      {
        $sort: { wasted_energy_kwh: -1 }
      }
    ]);

    res.json({
      date: todaySriLanka,
      rooms: results
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerAlerts(req, res) {
  try {
    const todaySriLanka = getSriLankaDateString();

    const latestPerRoom = await SensorReading.aggregate(getLatestPerRoomPipeline());

    const todayRoomAgg = await SensorReading.aggregate([
      buildDailyMatchByDate(todaySriLanka),
      {
        $group: {
          _id: "$room_id",
          total_energy_kwh: { $sum: "$interval_energy_kwh" },
          wasted_energy_kwh: { $sum: "$interval_wasted_energy_kwh" }
        }
      }
    ]);

    const roomMap = new Map(
      todayRoomAgg.map((r) => [
        r._id,
        {
          total_energy_kwh: r.total_energy_kwh || 0,
          wasted_energy_kwh: r.wasted_energy_kwh || 0
        }
      ])
    );

    const alerts = [];

    for (const room of latestPerRoom) {
      const agg = roomMap.get(room.room_id) || {
        total_energy_kwh: 0,
        wasted_energy_kwh: 0
      };

      const wasteRatio =
        agg.total_energy_kwh > 0
          ? (agg.wasted_energy_kwh / agg.total_energy_kwh) * 100
          : 0;

      if (room.waste_stat === "Critical") {
        alerts.push({
          type: "critical",
          title: "Critical Energy Waste",
          message: `Room ${room.room_id} is currently wasting energy at a critical level.`,
          room_id: room.room_id,
          severity: "Critical",
          captured_at: room.captured_at
        });
      }

      if (wasteRatio >= 40) {
        alerts.push({
          type: "warning",
          title: "High Waste Ratio",
          message: `Room ${room.room_id} has a waste ratio of ${wasteRatio.toFixed(2)}% today.`,
          room_id: room.room_id,
          severity: "Warning",
          captured_at: room.captured_at
        });
      }

      if (agg.total_energy_kwh >= 3 && agg.wasted_energy_kwh === 0) {
        alerts.push({
          type: "info",
          title: "High Energy Usage",
          message: `Room ${room.room_id} has high energy usage today.`,
          room_id: room.room_id,
          severity: "Info",
          captured_at: room.captured_at
        });
      }
    }

    const uniqueAlerts = alerts
      .sort((a, b) => {
        const priority = { Critical: 3, Warning: 2, Info: 1 };
        return priority[b.severity] - priority[a.severity];
      })
      .slice(0, 6);

    res.json({
      date: todaySriLanka,
      alerts: uniqueAlerts
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerRoomsOverview(req, res) {
  try {
    const todaySriLanka = getSriLankaDateString();

    const latestPerRoom = await SensorReading.aggregate(getLatestPerRoomPipeline());

    const todayAgg = await SensorReading.aggregate([
      buildDailyMatchByDate(todaySriLanka),
      {
        $group: {
          _id: "$room_id",
          total_energy_kwh: { $sum: "$interval_energy_kwh" },
          wasted_energy_kwh: { $sum: "$interval_wasted_energy_kwh" }
        }
      }
    ]);

    const aggMap = new Map(
      todayAgg.map((item) => [
        item._id,
        {
          total_energy_kwh: Number((item.total_energy_kwh || 0).toFixed(4)),
          wasted_energy_kwh: Number((item.wasted_energy_kwh || 0).toFixed(4))
        }
      ])
    );

    const rooms = latestPerRoom.map((room) => {
      const agg = aggMap.get(room.room_id) || {
        total_energy_kwh: 0,
        wasted_energy_kwh: 0
      };

      const wasteRatio =
        agg.total_energy_kwh > 0
          ? Number(((agg.wasted_energy_kwh / agg.total_energy_kwh) * 100).toFixed(2))
          : 0;

      const alertCount =
        (room.waste_stat === "Critical" ? 1 : 0) +
        (room.noise_stat === "Warning" || room.noise_stat === "Violation" ? 1 : 0);

      return {
        room_id: room.room_id,
        occupancy_stat: room.occupancy_stat,
        noise_stat: room.noise_stat,
        waste_stat: room.waste_stat,
        door_status: room.door_status,
        current_amp: room.current_amp,
        total_energy_kwh: agg.total_energy_kwh,
        wasted_energy_kwh: agg.wasted_energy_kwh,
        waste_ratio_percent: wasteRatio,
        last_activity: room.captured_at,
        alert_count: alertCount
      };
    });

    res.json({
      date: todaySriLanka,
      rooms: rooms.sort((a, b) => a.room_id.localeCompare(b.room_id))
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getDailyEnergyHistory(req, res) {
  try {
    const { roomId } = req.params;

    const results = await SensorReading.aggregate([
      { $match: { room_id: roomId } },
      buildDailyGroupStage(),
      { $sort: { _id: 1 } }
    ]);

    const history = mapDailyRows(results).map(({ critical_waste_events, ...rest }) => rest);

    res.json({
      room_id: roomId,
      total_days: history.length,
      history
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getTopWasteDays(req, res) {
  try {
    const { roomId } = req.params;
    const limit = Number(req.query.limit || 5);

    const results = await SensorReading.aggregate([
      { $match: { room_id: roomId } },
      buildDailyGroupStage(),
      { $sort: { wasted_energy_kwh: -1 } },
      { $limit: limit }
    ]);

    const days = results.map((item) => {
      const totalEnergy = Number((item.total_energy_kwh || 0).toFixed(4));
      const wastedEnergy = Number((item.wasted_energy_kwh || 0).toFixed(4));
      const wasteRatio =
        totalEnergy > 0 ? Number(((wastedEnergy / totalEnergy) * 100).toFixed(2)) : 0;

      return {
        date: item._id,
        total_energy_kwh: totalEnergy,
        wasted_energy_kwh: wastedEnergy,
        waste_ratio_percent: wasteRatio
      };
    });

    res.json({
      room_id: roomId,
      days
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getEnergyForecast(req, res) {
  try {
    const { roomId } = req.params;
    const forecastDays = Number(req.query.days || 5);

    const results = await SensorReading.aggregate([
      { $match: { room_id: roomId } },
      buildDailyGroupStage(),
      { $sort: { _id: 1 } }
    ]);

    const history = mapDailyRows(results).map(({ critical_waste_events, ...rest }) => rest);

    if (history.length < 3) {
      return res.status(400).json({
        message: "Not enough historical daily data for forecasting. Collect at least 3 days."
      });
    }

    const forecast = buildForecast(history, forecastDays);

    res.json({
      room_id: roomId,
      based_on_days: history.length,
      forecast_days: forecastDays,
      history,
      forecast
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getOwnerAlerts(req, res) {
  try {
    const latestPerRoom = await SensorReading.aggregate([
      { $sort: { captured_at: -1 } },
      {
        $group: {
          _id: "$room_id",
          latest: { $first: "$$ROOT" }
        }
      }
    ]);

    const alerts = [];

    latestPerRoom.forEach(({ latest }) => {
      if (latest.waste_stat === "Critical") {
        alerts.push({
          room_id: latest.room_id,
          severity: "Critical",
          title: "High Energy Waste",
          message: "Room is showing critical waste behavior.",
          captured_at: latest.captured_at
        });
      }

      if (latest.noise_stat === "Warning" || latest.noise_stat === "Violation") {
        alerts.push({
          room_id: latest.room_id,
          severity: "Warning",
          title: "Noise Issue",
          message: "Room has abnormal or non-compliant noise behavior.",
          captured_at: latest.captured_at
        });
      }
    });

    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ================= WARDEN =================

async function getWardenSummary(req, res) {
  try {
    const latestPerRoom = await SensorReading.aggregate(getLatestPerRoomPipeline());

    const summary = {
      occupied_rooms: 0,
      empty_rooms: 0,
      sleeping_rooms: 0,
      noise_issue_rooms: 0,
      rooms_needing_inspection: 0,
      stale_rooms: 0,
      rooms_with_sensor_faults: 0
    };

    for (const room of latestPerRoom) {
      if (room.occupancy_stat === "Occupied") summary.occupied_rooms++;
      else if (room.occupancy_stat === "Empty") summary.empty_rooms++;
      else if (room.occupancy_stat === "Sleeping") summary.sleeping_rooms++;

      if (room.noise_stat === "Warning" || room.noise_stat === "Violation") {
        summary.noise_issue_rooms++;
      }

      if (isStaleReading(room.captured_at)) {
        summary.stale_rooms++;
      }

      if (hasAnySensorFault(room)) {
        summary.rooms_with_sensor_faults++;
      }

      if (getInspectionReasons(room).length > 0) {
        summary.rooms_needing_inspection++;
      }
    }

    res.json(summary);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch warden summary",
      error: error.message
    });
  }
}

async function getWardenRoomsStatus(req, res) {
  try {
    const latestPerRoom = await SensorReading.aggregate([
      ...getLatestPerRoomPipeline(),
      { $sort: { room_id: 1 } }
    ]);

    const rooms = latestPerRoom.map(toWardenRoomStatus);

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch room status",
      error: error.message
    });
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
          issue_count: { $sum: 1 },
          warning_count: {
            $sum: { $cond: [{ $eq: ["$noise_stat", "Warning"] }, 1, 0] }
          },
          violation_count: {
            $sum: { $cond: [{ $eq: ["$noise_stat", "Violation"] }, 1, 0] }
          }
        }
      },
      {
        $project: {
          _id: 0,
          room_id: "$_id",
          issue_count: 1,
          warning_count: 1,
          violation_count: 1,
          latest_noise_stat: "$latest.noise_stat",
          latest_sound_peak: { $round: ["$latest.sound_peak", 2] },
          latest_captured_at: "$latest.captured_at"
        }
      },
      { $sort: { issue_count: -1, room_id: 1 } }
    ]);

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch noise issues",
      error: error.message
    });
  }
}

async function getWardenInspectionQueue(req, res) {
  try {
    const latestPerRoom = await SensorReading.aggregate([
      ...getLatestPerRoomPipeline(),
      { $sort: { room_id: 1 } }
    ]);

    const rooms = latestPerRoom
      .map(toWardenRoomStatus)
      .filter((room) => room.needs_inspection)
      .map((room) => ({
        room_id: room.room_id,
        occupancy_stat: room.occupancy_stat,
        noise_stat: room.noise_stat,
        waste_stat: room.waste_stat,
        door_status: room.door_status,
        current_amp: room.current_amp,
        sound_peak: room.sound_peak,
        sensor_health: room.sensor_health,
        sensor_faults: room.sensor_faults,
        stale_data: room.stale_data,
        inspection_reasons: room.inspection_reasons,
        issue_count: room.inspection_reasons.length,
        captured_at: room.captured_at
      }))
      .sort((a, b) => b.issue_count - a.issue_count || a.room_id.localeCompare(b.room_id));

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch inspection queue",
      error: error.message
    });
  }
}

async function getWardenNoiseTrend(req, res) {
  try {
    const days = Number(req.query.days || 7);

    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);

    const trend = await SensorReading.aggregate([
      {
        $match: {
          captured_at: { $gte: start },
          noise_stat: { $in: ["Warning", "Violation"] }
        }
      },
      {
        $group: {
          _id: {
            date: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$captured_at",
                timezone: TIMEZONE
              }
            },
            noise_stat: "$noise_stat"
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id.date": 1 } }
    ]);

    const dateMap = new Map();

    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = getSriLankaDateString(d);
      dateMap.set(key, { date: key, warnings: 0, violations: 0, total: 0 });
    }

    for (const row of trend) {
      const date = row._id.date;
      const stat = row._id.noise_stat;
      const item = dateMap.get(date) || { date, warnings: 0, violations: 0, total: 0 };

      if (stat === "Warning") item.warnings += row.count;
      if (stat === "Violation") item.violations += row.count;
      item.total = item.warnings + item.violations;

      dateMap.set(date, item);
    }

    res.json({
      days,
      trend: Array.from(dateMap.values())
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch noise trend",
      error: error.message
    });
  }
}

// ================= SECURITY =================

async function getSecuritySummary(req, res) {
  try {
    const latestPerRoom = await SensorReading.aggregate(getLatestPerRoomPipeline());

    const summary = {
      active_security_alerts: 0,
      suspicious_rooms: 0,
      door_open_rooms: 0
    };

    for (const room of latestPerRoom) {
      const suspicious =
        (room.door_status === "Open" && room.door_stable_ms > 300000) ||
        (room.motion_count > 0 && (room.hour >= 23 || room.hour <= 5));

      if (room.door_status === "Open") summary.door_open_rooms++;
      if (suspicious) {
        summary.suspicious_rooms++;
        summary.active_security_alerts++;
      }
    }

    res.json(summary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getSecuritySuspiciousRooms(req, res) {
  try {
    const rooms = await SensorReading.aggregate([
      ...getLatestPerRoomPipeline(),
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
                    $or: [{ $gte: ["$hour", 23] }, { $lte: ["$hour", 5] }]
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
          room_id: 1,
          door_status: 1,
          door_stable_ms: 1,
          motion_count: 1,
          hour: 1,
          captured_at: 1
        }
      },
      { $sort: { room_id: 1 } }
    ]);

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getSecurityDoorEvents(req, res) {
  try {
    const limit = Number(req.query.limit || 50);

    const events = await SensorReading.find({
      door_status: "Open"
    })
      .sort({ captured_at: -1 })
      .limit(limit)
      .select("room_id captured_at door_status door_stable_ms motion_count hour minute second -_id");

    res.json({ events });
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
      today_energy_kwh: Number((today?.total_energy_kwh || 0).toFixed(4)),
      today_wasted_energy_kwh: Number((today?.wasted_energy_kwh || 0).toFixed(4))
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
  getOwnerKpis,
  getOwnerFeatureImportance,
  getOwnerAnomalies,
  getOwnerPatterns,
  getOwnerForecasts,
  getOwnerRoomsOverview,
  getOwnerAlerts,
  getDailyEnergyHistory,
  getTopWasteDays,
  getEnergyForecast,
  getOwnerRoomComparison,
  getOwnerRoomsOverview,
  getOwnerAlerts,
  getWardenSummary,
  getWardenRoomsStatus,
  getWardenNoiseIssues,
  getWardenInspectionQueue,
  getWardenNoiseTrend,
  getSecuritySummary,
  getSecuritySuspiciousRooms,
  getSecurityDoorEvents,
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentRecentAlerts
};
