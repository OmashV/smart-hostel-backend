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
    const floors = await DailyFloorSummary.distinct("floor_id");
    res.json({ floors: floors.filter(Boolean).sort() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getAvailableRooms(req, res) {
  try {
    const { floorId } = req.query;

    const query = {};
    if (floorId && floorId !== "all") {
      query.floor_id = floorId;
    }

    const rooms = await DailyRoomSummary.distinct("room_id", query);

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
        floor_id: row.floor_id,
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

    // Synthetic / static rooms
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
    const latestPerRoom = await SensorReading.aggregate([
      { $sort: { room_id: 1, captured_at: -1 } },
      {
        $group: {
          _id: "$room_id",
          latest: { $first: "$$ROOT" }
        }
      },
      { $replaceRoot: { newRoot: "$latest" } }
    ]);

    const summary = {
      occupied_rooms: 0,
      empty_rooms: 0,
      sleeping_rooms: 0,
      noise_issue_rooms: 0,
      rooms_needing_inspection: 0
    };

    for (const room of latestPerRoom) {
      if (room.occupancy_stat === "Occupied") summary.occupied_rooms++;
      else if (room.occupancy_stat === "Empty") summary.empty_rooms++;
      else if (room.occupancy_stat === "Sleeping") summary.sleeping_rooms++;

      if (room.noise_stat === "Warning" || room.noise_stat === "Violation") {
        summary.noise_issue_rooms++;
      }

      if (
        room.waste_stat === "Critical" ||
        room.noise_stat === "Violation" ||
        room.sensor_faults?.pir ||
        room.sensor_faults?.door ||
        room.sensor_faults?.sound ||
        room.sensor_faults?.current
      ) {
        summary.rooms_needing_inspection++;
      }
    }

    res.json(summary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenRoomsStatus(req, res) {
  try {
    const rooms = await SensorReading.aggregate([
      { $sort: { room_id: 1, captured_at: -1 } },
      {
        $group: {
          _id: "$room_id",
          latest: { $first: "$$ROOT" }
        }
      },
      {
        $project: {
          _id: 0,
          room_id: "$latest.room_id",
          occupancy_stat: "$latest.occupancy_stat",
          noise_stat: "$latest.noise_stat",
          waste_stat: "$latest.waste_stat",
          door_status: "$latest.door_status",
          current_amp: "$latest.current_amp",
          captured_at: "$latest.captured_at"
        }
      },
      { $sort: { room_id: 1 } }
    ]);

    res.json({ rooms });
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
    const items = await WardenAnomaly.find()
      .sort({ date: -1 })
      .lean();

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenPatterns(req, res) {
  try {
    const items = await WardenPattern.find()
      .sort({ date: -1 })
      .lean();

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getWardenForecasts(req, res) {
  try {
    const items = await WardenForecast.find()
      .sort({ date: 1 })
      .lean();

    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: error.message });
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
async function getSecuritySummary(req, res) {
  try {
    const latestPerRoom = await SensorReading.aggregate([
      { $sort: { room_id: 1, captured_at: -1 } },
      {
        $group: {
          _id: "$room_id",
          latest: { $first: "$$ROOT" }
        }
      },
      { $replaceRoot: { newRoot: "$latest" } }
    ]);

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
      { $sort: { room_id: 1, captured_at: -1 } },
      {
        $group: {
          _id: "$room_id",
          latest: { $first: "$$ROOT" }
        }
      },
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
  getOwnerAlerts,
  deleteOwnerAlert,
  resolveOwnerAlert,
  getDailyEnergyHistory,
  getEnergyForecast,
  getWardenSummary,
  getWardenRoomsStatus,
  getWardenNoiseIssues,
  getWardenFeatureImportance,
  getWardenAnomalies,
  getWardenPatterns,
  getWardenForecasts,
  getSecuritySummary,
  getSecuritySuspiciousRooms,
  getSecurityDoorEvents,
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentRecentAlerts
};
