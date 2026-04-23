const DailyRoomSummary = require("../models/DailyRoomSummary");
const DailyFloorSummary = require("../models/DailyFloorSummary");
const OwnerAlert = require("../models/OwnerAlert");
const OwnerAnomaly = require("../models/OwnerAnomaly");
const OwnerForecast = require("../models/OwnerForecast");

async function getLatestSummaryDate() {
  const latest = await DailyRoomSummary.findOne({}).sort({ date: -1 }).lean();
  return latest?.date || null;
}

async function getFloorOverview({ date }) {
  const latestDate = date || (await getLatestSummaryDate());
  if (!latestDate) return { date: null, floors: [] };

  const floors = await DailyFloorSummary.find({
    date: latestDate,
    floor_id: { $ne: null }
  })
    .sort({ floor_id: 1 })
    .lean();

  return {
    date: latestDate,
    floors: floors.map((f) => ({
      floor_id: f.floor_id,
      total_energy_kwh: Number(f.total_energy_kwh || 0),
      wasted_energy_kwh: Number(f.wasted_energy_kwh || 0),
      waste_ratio_percent: Number(f.waste_ratio_percent || 0),
      critical_rooms_count: Number(f.critical_rooms_count || 0),
      warning_rooms_count: Number(f.warning_rooms_count || 0),
      rooms_count: Number(f.rooms_count || 0)
    }))
  };
}

async function getRoomsOverview({ floorId = "all", date }) {
  const latestDate = date || (await getLatestSummaryDate());
  if (!latestDate) return { date: null, rooms: [] };

  const query = { date: latestDate };
  if (floorId && floorId !== "all") {
    query.floor_id = floorId;
  }

  const rooms = await DailyRoomSummary.find(query).sort({ room_id: 1 }).lean();

  return {
    date: latestDate,
    rooms: rooms.map((r) => ({
      room_id: r.room_id,
      floor_id: r.floor_id,
      total_energy_kwh: Number(r.total_energy_kwh || 0),
      wasted_energy_kwh: Number(r.wasted_energy_kwh || 0),
      waste_ratio_percent: Number(r.waste_ratio_percent || 0),
      critical_count: Number(r.critical_count || 0),
      warning_count: Number(r.warning_count || 0)
    }))
  };
}

async function getTopWasteRoomsToday({ floorId = "all", limit = 5, date }) {
  const latestDate = date || (await getLatestSummaryDate());
  if (!latestDate) return { date: null, rooms: [] };

  const query = { date: latestDate };
  if (floorId && floorId !== "all") {
    query.floor_id = floorId;
  }

  const rooms = await DailyRoomSummary.find(query)
    .sort({ wasted_energy_kwh: -1, waste_ratio_percent: -1 })
    .limit(Number(limit) || 5)
    .lean();

  return {
    date: latestDate,
    rooms: rooms.map((r) => ({
      room_id: r.room_id,
      floor_id: r.floor_id,
      total_energy_kwh: Number(r.total_energy_kwh || 0),
      wasted_energy_kwh: Number(r.wasted_energy_kwh || 0),
      waste_ratio_percent: Number(r.waste_ratio_percent || 0)
    }))
  };
}

async function getRoomDetail({ roomId }) {
  if (!roomId || roomId === "all") {
    return { error: "roomId is required" };
  }

  const history = await DailyRoomSummary.find({ room_id: roomId })
    .sort({ date: 1 })
    .lean();

  const latest = history[history.length - 1] || null;

  const alerts = await OwnerAlert.find({
    room_id: roomId,
    is_deleted: false,
    status: "active"
  })
    .sort({ date: -1 })
    .limit(5)
    .lean();

  const anomalies = await OwnerAnomaly.find({ room_id: roomId })
    .sort({ date: -1 })
    .limit(5)
    .lean();

  const forecast = await OwnerForecast.find({ room_id: roomId })
    .sort({ date: 1 })
    .limit(5)
    .lean();

  return {
    latest: latest
      ? {
          room_id: latest.room_id,
          floor_id: latest.floor_id,
          date: latest.date,
          total_energy_kwh: Number(latest.total_energy_kwh || 0),
          wasted_energy_kwh: Number(latest.wasted_energy_kwh || 0),
          waste_ratio_percent: Number(latest.waste_ratio_percent || 0)
        }
      : null,
    alerts: alerts.map((a) => ({
      date: a.date,
      severity: a.severity,
      title: a.title,
      message: a.message
    })),
    anomalies: anomalies.map((a) => ({
      date: a.date,
      reason: a.reason,
      anomaly_score: a.anomaly_score
    })),
    forecast: forecast.map((f) => ({
      date: f.date,
      predicted_total_energy_kwh: Number(f.predicted_total_energy_kwh || 0),
      predicted_wasted_energy_kwh: Number(f.predicted_wasted_energy_kwh || 0)
    }))
  };
}

module.exports = {
  getLatestSummaryDate,
  getFloorOverview,
  getRoomsOverview,
  getTopWasteRoomsToday,
  getRoomDetail
};
