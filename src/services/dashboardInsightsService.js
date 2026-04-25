const SensorReading = require("../models/SensorReading");
const WardenAnomaly = require("../models/WardenAnomaly");
const WardenForecast = require("../models/WardenForecast");
const WardenPattern = require("../models/WardenPattern");
const WardenFeatureImportance = require("../models/WardenFeatureImportance");
const WardenMlAlert = require("../models/WardenMlAlert");

async function buildDashboardContext(role = "warden") {
  const latestRooms = await SensorReading.aggregate([
    { $sort: { room_id: 1, captured_at: -1 } },
    { $group: { _id: "$room_id", latest: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$latest" } },
    { $sort: { room_id: 1 } }
  ]);

  const occupancySummary = latestRooms.reduce(
    (acc, room) => {
      if (room.occupancy_stat === "Occupied") acc.occupied += 1;
      else if (room.occupancy_stat === "Empty") acc.empty += 1;
      else if (room.occupancy_stat === "Sleeping") acc.sleeping += 1;
      if (["Warning", "Violation"].includes(room.noise_stat)) acc.noiseIssues += 1;
      if (["Warning", "Critical"].includes(room.waste_stat)) acc.wasteIssues += 1;
      if (room.needs_inspection) acc.inspectionRooms += 1;
      return acc;
    },
    { occupied: 0, empty: 0, sleeping: 0, noiseIssues: 0, wasteIssues: 0, inspectionRooms: 0 }
  );

  const alerts = await WardenMlAlert.find().sort({ captured_at: -1 }).limit(8).lean();
  const anomalies = await WardenAnomaly.find().sort({ date: -1 }).limit(5).lean();
  const forecasts = await WardenForecast.find().sort({ date: 1 }).limit(10).lean();
  const patterns = await WardenPattern.find({ room_id: "All" }).sort({ day: 1 }).limit(7).lean();
  const features = await WardenFeatureImportance.find().sort({ importance: -1 }).limit(8).lean();

  return {
    role,
    generated_at: new Date().toISOString(),
    room_count: latestRooms.length,
    occupancy_summary: occupancySummary,
    latest_rooms: latestRooms.slice(0, 12).map((room) => ({
      room_id: room.room_id,
      occupancy_stat: room.occupancy_stat,
      noise_stat: room.noise_stat,
      waste_stat: room.waste_stat,
      door_status: room.door_status,
      current_amp: room.current_amp,
      sound_peak: room.sound_peak,
      needs_inspection: room.needs_inspection,
      captured_at: room.captured_at
    })),
    ml_alerts: alerts,
    anomalies,
    forecasts,
    patterns,
    features
  };
}

module.exports = { buildDashboardContext };
