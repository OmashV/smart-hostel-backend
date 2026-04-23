const SensorReading = require("../models/SensorReading");
const { buildForecast } = require("../services/forecastService");
const OwnerForecast = require("../models/OwnerForecast");
const OwnerAnomaly = require("../models/OwnerAnomaly");
const OwnerPattern = require("../models/OwnerPattern");
const DailyRoomSummary = require("../models/DailyRoomSummary");
const OwnerAlert = require("../models/OwnerAlert");
const OwnerWeekdayPattern = require("../models/OwnerWeekdayPattern");
const WardenForecast = require("../models/WardenForecast");
const WardenFeatureImportance = require("../models/WardenFeatureImportance");
const WardenAnomaly = require("../models/WardenAnomaly");
const WardenPattern = require("../models/WardenPattern");
const SecurityForecast = require("../models/SecurityForecast");
const SecurityAnomaly = require("../models/SecurityAnomaly");


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
      latest?.waste_stat ||
      (wasteRatio >= 30 ? "Critical" : wasteRatio >= 15 ? "Warning" : "Normal");

    res.json({
      room_id: roomId,
      total_energy_today_kwh: Number(totalEnergy.toFixed(4)),
      wasted_energy_today_kwh: Number(wastedEnergy.toFixed(4)),
      waste_ratio_today_percent: Number(wasteRatio.toFixed(2)),
      current_waste_status: currentWasteStatus
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

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

    const now = new Date();

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const todayAgg = await SensorReading.aggregate([
      {
        $match: {
          captured_at: {
            $gte: startOfDay,
            $lte: endOfDay
          }
        }
      },
      {
        $group: {
          _id: "$room_id",
          total_energy_kwh: { $sum: "$interval_energy_kwh" },
          wasted_energy_kwh: { $sum: "$interval_wasted_energy_kwh" }
        }
      }
    ]);

    const aggMap = todayAgg.reduce((acc, item) => {
      acc[item._id] = item;
      return acc;
    }, {});

    const rooms = latestPerRoom.map(({ latest }) => {
      const agg = aggMap[latest.room_id] || {};

      const totalEnergy = Number(agg.total_energy_kwh || 0);
      const wastedEnergy = Number(agg.wasted_energy_kwh || 0);
      const wasteRatio =
        totalEnergy > 0
          ? Number(((wastedEnergy / totalEnergy) * 100).toFixed(2))
          : 0;

      const alertCount =
        (latest.waste_stat === "Critical" ? 1 : 0) +
        (latest.noise_stat === "Warning" || latest.noise_stat === "Violation" ? 1 : 0);

      return {
        room_id: latest.room_id,
        occupancy_stat: latest.occupancy_stat || "Unknown",
        noise_stat: latest.noise_stat || "Compliant",
        waste_stat:
          latest.waste_stat ||
          (wasteRatio >= 30 ? "Critical" : wasteRatio >= 15 ? "Warning" : "Normal"),
        total_energy_kwh: Number(totalEnergy.toFixed(4)),
        wasted_energy_kwh: Number(wastedEnergy.toFixed(4)),
        waste_ratio_percent: Number(wasteRatio.toFixed(2)),
        last_activity: latest.captured_at,
        alert_count: alertCount
      };
    });

    res.json({ rooms });
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
    const { roomId } = req.query;

    const pipeline = [];

    if (roomId) {
      pipeline.push({ $match: { room_id: roomId } });
    }

    pipeline.push(
      { $sort: { room_id: 1, captured_at: -1 } },
      {
        $group: {
          _id: "$room_id",
          latest: { $first: "$$ROOT" }
        }
      },
      { $replaceRoot: { newRoot: "$latest" } }
    );

    const latestPerRoom = await SensorReading.aggregate(pipeline);

    const summary = {
      active_security_alerts: 0,
      suspicious_rooms: 0,
      door_open_rooms: 0,
      high_risk_rooms: 0,
      after_hours_events: 0
    };

    for (const room of latestPerRoom) {
      const isAfterHours = room.hour >= 23 || room.hour <= 5;

      const suspicious =
        (room.door_status === "Open" && room.door_stable_ms > 300000) ||
        (room.motion_count > 0 && isAfterHours);

      let riskScore = 0;

      if (room.door_status === "Open" && room.door_stable_ms > 1800000) riskScore += 3;
      else if (room.door_status === "Open" && room.door_stable_ms > 600000) riskScore += 2;

      if (room.motion_count === 0) riskScore += 1;
      if (isAfterHours) riskScore += 2;
      if (room.occupancy_stat === "Empty") riskScore += 2;

      if (room.door_status === "Open") summary.door_open_rooms++;
      if (isAfterHours) summary.after_hours_events++;

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

async function getSecuritySuspiciousRooms(req, res) {
  try {
    const { roomId } = req.query;

    const pipeline = [];

    if (roomId) {
      pipeline.push({ $match: { room_id: roomId } });
    }

    pipeline.push(
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
      }
    );

    const rooms = await SensorReading.aggregate(pipeline);

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getSecurityDoorEvents(req, res) {
  try {
    const { roomId } = req.query;
    const limit = Number(req.query.limit || 50);

    const query = {
      door_status: "Open"
    };

    if (roomId) {
      query.room_id = roomId;
    }

    const events = await SensorReading.find(query)
      .sort({ captured_at: -1 })
      .limit(limit)
      .select("room_id captured_at door_status door_stable_ms motion_count hour minute second -_id");

    res.json({ events });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

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

    const actualReadings = await SensorReading.aggregate([
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
    ]);

    // ── Step 2b: Historical fallback — all-time average per hour ───────────
    const historicalMatch = { door_stable_ms: { $gt: 0 } };
    if (roomId) historicalMatch.room_id = roomId;

    const historicalReadings = await SensorReading.aggregate([
      { $match: historicalMatch },
      {
        $group: {
          _id: {
            $hour: { date: "$captured_at", timezone: "Asia/Colombo" }
          },
          historical_avg_ms: { $avg: "$door_stable_ms" }
        }
      }
    ]);

    // ── Step 2c: Build lookup maps ─────────────────────────────────────────
    const actualMap = {};
    actualReadings.forEach((item) => {
      actualMap[item._id] = item;
    });

    const historicalMap = {};
    historicalReadings.forEach((item) => {
      historicalMap[item._id] = item.historical_avg_ms;
    });

    // ── Step 3: Pull Prophet forecasts ─────────────────────────────────────
    const forecastQuery = { model_name: "prophet" };
    if (roomId) forecastQuery.room_id = roomId;

    const forecasts = await SecurityForecast.find(forecastQuery)
      .sort({ hour: 1 })
      .lean();

    // ── Step 4: Get current hour in Colombo timezone ───────────────────────
    const currentHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Colombo",
        hour: "numeric",
        hour12: false
      }).format(new Date())
    );

    // ── Step 5: Build hour base — full 24 hours for expected line ──────────
    const hours = forecasts.length
      ? forecasts
      : Array.from({ length: 24 }, (_, i) => ({
          hour: i,
          hour_label: `${i}:00`,
          expected_door_stable_ms:  null,
          expected_door_stable_min: null,
          lower_bound_ms: null,
          upper_bound_ms: null
        }));

    // ── Step 5: Merge everything into trend array ───────────────────────────
   const trend = hours.map((forecast) => {
      const hour   = forecast.hour;
      const isFutureHour = hour > currentHour;   // ← key check

      const actual = actualMap[hour];

      // Future hours — no actual data regardless of what's in the map
      const isLiveData = !isFutureHour && !!actual;
      const actualMs = isFutureHour
        ? null                                    // ← null for future hours
        : actual
        ? Math.round(actual.actual_door_stable_ms)
        : historicalMap[hour]
        ? Math.round(historicalMap[hour])
        : null;

      const expectedMs = forecast.expected_door_stable_ms
        ? Math.round(forecast.expected_door_stable_ms)
        : null;

      const deviationMs = actualMs != null && expectedMs != null
        ? actualMs - expectedMs
        : null;

      // Trend status — only when both values are present and it's live data
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

        // Actual — live today or historical fallback
        actual_door_stable_ms:  actualMs,
        actual_door_stable_min: actualMs != null
          ? Number((actualMs / 60000).toFixed(2))
          : null,
        is_live_data:       isLiveData,
        sample_count:       actual?.sample_count || 0,
        latest_captured_at: actual?.latest_captured_at || null,

        // Prophet ML values
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

        // Deviation
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

async function getSecurityAnomalies(req, res) {
  try {
    const { roomId } = req.query;
    const limit = Number(req.query.limit || 50);

    // Step 1: Pull Isolation Forest anomalies from ML collection
    const anomalyQuery = { model_name: "isolation_forest" };
    if (roomId) anomalyQuery.room_id = roomId;

    const mlAnomalies = await SecurityAnomaly.find(anomalyQuery)
      .sort({ anomaly_score: 1 })       // most anomalous first (most negative score)
      .limit(limit)
      .select("-_id -__v")
      .lean();

    if (!mlAnomalies.length) {
      return res.json({ anomalies: [] });
    }

    // Step 2: Enrich each anomaly with Prophet forecast context
    // Pull forecasts for reference (expected values + confidence bands)
    const forecastQuery = { model_name: "prophet" };
    if (roomId) forecastQuery.room_id = roomId;

    const forecasts = await SecurityForecast.find(forecastQuery).lean();

    // Map forecasts by room_id + hour for fast lookup
    const forecastMap = {};
    forecasts.forEach((f) => {
      forecastMap[`${f.room_id}_${f.hour}`] = f;
    });

    // Step 3: Build enriched response
    const anomalies = mlAnomalies.map((anomaly) => {
      const forecastKey = `${anomaly.room_id}_${anomaly.hour}`;
      const forecast = forecastMap[forecastKey];

      // Check if actual reading is outside Prophet confidence band
      const isOutsideBand = forecast
        ? anomaly.door_stable_ms > forecast.upper_bound_ms ||
          anomaly.door_stable_ms < forecast.lower_bound_ms
        : null;

      return {
        room_id: anomaly.room_id,
        captured_at: anomaly.captured_at,
        hour: anomaly.hour,

        // Isolation Forest output
        status: anomaly.status,
        reason: anomaly.reason,
        severity: anomaly.severity,
        anomaly_score: anomaly.anomaly_score,   // learned score, not hardcoded

        // Sensor readings
        door_stable_ms: anomaly.door_stable_ms,
        door_stable_min: anomaly.door_stable_min,
        motion_count: anomaly.motion_count,
        is_after_hours: anomaly.is_after_hours,
        is_empty: anomaly.is_empty,

        // Prophet context (if available)
        expected_door_stable_ms: forecast?.expected_door_stable_ms ?? null,
        expected_door_stable_min: forecast?.expected_door_stable_min ?? null,
        lower_bound_ms: forecast?.lower_bound_ms ?? null,
        upper_bound_ms: forecast?.upper_bound_ms ?? null,
        is_outside_prophet_band: isOutsideBand,

        // Makes ML origin explicit for the dashboard
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
  getSecurityTrend,
  getSecurityAnomalies,
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentRecentAlerts
};
