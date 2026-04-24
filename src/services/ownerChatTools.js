const DailyRoomSummary = require("../models/DailyRoomSummary");
const DailyFloorSummary = require("../models/DailyFloorSummary");
const OwnerAlert = require("../models/OwnerAlert");
const OwnerAnomaly = require("../models/OwnerAnomaly");
const OwnerForecast = require("../models/OwnerForecast");
const OwnerWeekdayPattern = require("../models/OwnerWeekdayPattern");

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

async function getHighestWastedRoom({ floorId = "all", date }) {
  const scopeQuery = {};
  if (floorId && floorId !== "all") {
    scopeQuery.floor_id = floorId;
  }

  let targetDate = date;

  // If model passes "today", blank, or something unusable, ignore it
  if (!targetDate || String(targetDate).trim().toLowerCase() === "today") {
    targetDate = null;
  }

  // Try requested date first if it exists
  if (targetDate) {
    const requestedQuery = { ...scopeQuery, date: targetDate };

    const requestedRow = await DailyRoomSummary.findOne(requestedQuery)
      .sort({ wasted_energy_kwh: -1, waste_ratio_percent: -1 })
      .lean();

    if (requestedRow) {
      return {
        date: targetDate,
        room: {
          room_id: requestedRow.room_id,
          floor_id: requestedRow.floor_id,
          total_energy_kwh: Number(requestedRow.total_energy_kwh || 0),
          wasted_energy_kwh: Number(requestedRow.wasted_energy_kwh || 0),
          waste_ratio_percent: Number(requestedRow.waste_ratio_percent || 0)
        }
      };
    }
  }

  // Fallback: use latest available date within selected scope
  const latestRow = await DailyRoomSummary.findOne(scopeQuery)
    .sort({ date: -1 })
    .lean();

  const latestDate = latestRow?.date || null;

  if (!latestDate) {
    return { date: null, room: null };
  }

  const latestQuery = { ...scopeQuery, date: latestDate };

  const row = await DailyRoomSummary.findOne(latestQuery)
    .sort({ wasted_energy_kwh: -1, waste_ratio_percent: -1 })
    .lean();

  if (!row) {
    return { date: latestDate, room: null };
  }

  return {
    date: latestDate,
    room: {
      room_id: row.room_id,
      floor_id: row.floor_id,
      total_energy_kwh: Number(row.total_energy_kwh || 0),
      wasted_energy_kwh: Number(row.wasted_energy_kwh || 0),
      waste_ratio_percent: Number(row.waste_ratio_percent || 0)
    }
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

async function getWastePatternByWeekday({ roomId }) {
  if (!roomId || roomId === "all") {
    return { error: "roomId is required for weekday pattern lookup" };
  }

  const items = await OwnerWeekdayPattern.find({ room_id: roomId }).lean();

  const weekdayOrder = {
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
    Sunday: 7
  };

  items.sort((a, b) => {
    const dayA = weekdayOrder[a.weekday_name] || 99;
    const dayB = weekdayOrder[b.weekday_name] || 99;
    return dayA - dayB;
  });

  return {
    room_id: roomId,
    weekday_patterns: items.map((item) => ({
      weekday_name: item.weekday_name,
      day_type: item.day_type,
      usual_pattern: item.usual_pattern,
      avg_total_energy_kwh: Number(item.avg_total_energy_kwh || 0),
      avg_wasted_energy_kwh: Number(item.avg_wasted_energy_kwh || 0),
      avg_waste_ratio_percent: Number(item.avg_waste_ratio_percent || 0),
      days_count: Number(item.days_count || 0)
    }))
  };
}

async function getActiveAlerts({ floorId = "all", roomId = "all", limit = 10 }) {
  const query = {
    is_deleted: false,
    status: "active"
  };

  if (roomId && roomId !== "all") {
    query.room_id = roomId;
  }

  let alerts = await OwnerAlert.find(query)
    .sort({ date: -1, createdAt: -1 })
    .limit(Number(limit) || 10)
    .lean();

  if (floorId && floorId !== "all" && roomId === "all") {
    const allowedRooms = await DailyRoomSummary.distinct("room_id", { floor_id: floorId });
    alerts = alerts.filter((a) => allowedRooms.includes(a.room_id));
  }

  return {
    alerts: alerts.map((a) => ({
      room_id: a.room_id,
      date: a.date,
      severity: a.severity,
      title: a.title,
      message: a.message
    }))
  };
}

async function getOverviewSnapshot({ floorId = "all" }) {
  const latestQuery = {};
  if (floorId !== "all") {
    latestQuery.floor_id = floorId;
  }

  const latestRow = await DailyRoomSummary.findOne(latestQuery)
    .sort({ date: -1 })
    .lean();

  if (!latestRow) {
    return { summary_date: null, rooms: [] };
  }

  const query = { date: latestRow.date };
  if (floorId !== "all") {
    query.floor_id = floorId;
  }

  const rows = await DailyRoomSummary.find(query).sort({ room_id: 1 }).lean();

  return {
    summary_date: latestRow.date,
    rooms: rows.map((r) => ({
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

async function getPrioritySummary({ floorId = "all" }) {
  const latestQuery = {};
  if (floorId !== "all") {
    latestQuery.floor_id = floorId;
  }

  const latestRow = await DailyRoomSummary.findOne(latestQuery)
    .sort({ date: -1 })
    .lean();

  if (!latestRow) {
    return { summary_date: null, priorities: [] };
  }

  const query = { date: latestRow.date };
  if (floorId !== "all") {
    query.floor_id = floorId;
  }

  const rows = await DailyRoomSummary.find(query).lean();

  const priorities = rows
    .map((r) => {
      const wasteRatio = Number(r.waste_ratio_percent || 0);
      const wastedEnergy = Number(r.wasted_energy_kwh || 0);
      const priorityScore = wasteRatio * 0.6 + wastedEnergy * 100 * 0.4;

      return {
        room_id: r.room_id,
        floor_id: r.floor_id,
        waste_ratio_percent: wasteRatio,
        wasted_energy_kwh: wastedEnergy,
        priority_score: Number(priorityScore.toFixed(2))
      };
    })
    .sort((a, b) => b.priority_score - a.priority_score);

  return {
    summary_date: latestRow.date,
    priorities
  };
}

async function getVisualExplanationContext({ visualId, visualTitle, dashboardState }) {
  const visual = dashboardState?.selectedVisual || null;

  if (!visual) {
    return {
      error: "No selected visual is available in the current dashboard context."
    };
  }

  return {
    visual_id: visual.id || visualId || null,
    title: visual.title || visualTitle || null,
    shortLabel: visual.shortLabel || null,
    type: visual.type || null,
    description: visual.description || null,
    dataSummary: visual.dataSummary || null,
    selectedItem: visual.selectedItem || null
  };
}

module.exports = {
  getLatestSummaryDate,
  getFloorOverview,
  getRoomsOverview,
  getTopWasteRoomsToday,
  getHighestWastedRoom,
  getRoomDetail,
  getWastePatternByWeekday,
  getActiveAlerts,
  getOverviewSnapshot,
  getPrioritySummary,
  getVisualExplanationContext
};
