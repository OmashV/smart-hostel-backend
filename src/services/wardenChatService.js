const groq = require("./groqClient");
const {
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
} = require("./wardenChatTools");

function normalizeText(value = "") {
  return String(value).toLowerCase().trim();
}

function extractRoomId(message = "") {
  const match = String(message).match(/\b([A-Z]\d{3})\b/i);
  return match ? match[1].toUpperCase() : null;
}

function getRoomScope(message = "", dashboardState = {}) {
  const explicitRoom = extractRoomId(message);
  if (explicitRoom) return explicitRoom;

  const text = normalizeText(message);
  const globalWords = [
    "all",
    "rooms",
    "occupied rooms",
    "empty rooms",
    "vacant rooms",
    "which rooms",
    "what rooms"
  ];

  if (globalWords.some((word) => text.includes(word))) return "All";

  return dashboardState?.roomId || dashboardState?.selectedFilters?.roomId || "All";
}

function listRoomIds(rooms = []) {
  return rooms.map((room) => room.room_id).filter(Boolean).join(", ") || "none";
}

function statusMatches(value, status) {
  return normalizeText(value) === normalizeText(status);
}

function latestForecastText(forecasts = []) {
  if (!forecasts.length) return "No forecast records are available for the selected scope.";

  return forecasts
    .slice(0, 5)
    .map(
      (item) =>
        `${item.date}: occupied ${Number(item.predicted_occupied_count || 0).toFixed(
          2
        )}, warnings ${Number(item.predicted_warning_count || 0).toFixed(
          2
        )}, violations ${Number(item.predicted_violation_count || 0).toFixed(2)} (${
          item.model_name || "forecast model"
        })`
    )
    .join("; ");
}

async function deterministicWardenAnswer(message = "", dashboardState = {}) {
  const text = normalizeText(message);
  const roomId = getRoomScope(message, dashboardState);

  if (text.includes("occupied")) {
    const { rooms } = await getLatestRoomReadings({ roomId: "All" });
    const occupied = rooms.filter((room) => statusMatches(room.occupancy_stat, "Occupied"));
    return `There are ${occupied.length} occupied room${occupied.length === 1 ? "" : "s"}: ${listRoomIds(occupied)}.`;
  }

  if (text.includes("empty") || text.includes("vacant")) {
    const { rooms } = await getLatestRoomReadings({ roomId: "All" });
    const empty = rooms.filter((room) => statusMatches(room.occupancy_stat, "Empty"));
    return `There are ${empty.length} empty room${empty.length === 1 ? "" : "s"}: ${listRoomIds(empty)}.`;
  }

  if (text.includes("sleeping")) {
    const { rooms } = await getLatestRoomReadings({ roomId: "All" });
    const sleeping = rooms.filter((room) => statusMatches(room.occupancy_stat, "Sleeping"));
    return `There are ${sleeping.length} sleeping room${sleeping.length === 1 ? "" : "s"}: ${listRoomIds(sleeping)}.`;
  }

  if (
    text.includes("noise level") ||
    text.includes("sound level") ||
    text.includes("noise in room") ||
    text.includes("sound in room")
  ) {
    const explicitRoom = extractRoomId(message);
    if (explicitRoom) {
      const result = await getRoomNoiseLevel({ roomId: explicitRoom });

      if (!result.found) {
        return `Room ${explicitRoom} was not found in Warden room-status data.`;
      }

      return `Room ${explicitRoom} has ${result.noise_stat || "No Data"} noise status with ${Number(result.sound_peak || 0).toFixed(2)} dB.`;
    }
  }

  if (
    text.includes("noise") ||
    text.includes("noisy") ||
    text.includes("violation") ||
    text.includes("complaint") ||
    text.includes("warning")
  ) {
    const wantsViolationOnly = text.includes("violation") || text.includes("critical");
    const wantsComplaintOnly = !wantsViolationOnly && (text.includes("complaint") || text.includes("warning"));

    const { rooms } = await getNoisyRooms({
      roomId: "All",
      mode: wantsViolationOnly ? "violation" : wantsComplaintOnly ? "complaint" : "all"
    });

    if (!rooms.length && wantsViolationOnly) {
      const allNoise = await getNoisyRooms({ roomId: "All", mode: "all" });
      if (allNoise.rooms.length) {
        return `No rooms currently have noise violations. Other noise issues: ${allNoise.rooms
          .map((room) => `${room.room_id} (${room.noise_stat}, ${Number(room.sound_peak || 0).toFixed(2)} dB)`)
          .join(", ")}.`;
      }
    }

    if (!rooms.length) {
      return "No rooms currently have noise complaints, warnings, or violations.";
    }

    const label = wantsViolationOnly
      ? "Rooms with noise violations"
      : wantsComplaintOnly
      ? "Rooms with noise complaints or warnings"
      : "Rooms with noise issues";

    return `${label}: ${rooms
      .map(
        (room) =>
          `${room.room_id} (${room.noise_stat}, ${Number(room.sound_peak || 0).toFixed(2)} dB)`
      )
      .join(", ")}.`;
  }

  if (
    text.includes("room status") ||
    text.includes("status of") ||
    text.includes("current status")
  ) {
    const { rooms } = await getLatestRoomReadings({ roomId });

    if (!rooms.length) return `No current room-status records are available for ${roomId}.`;

    return rooms
      .map(
        (room) =>
          `${room.room_id}: ${room.occupancy_stat || "Unknown"}, noise ${
            room.noise_stat || "Unknown"
          }, door ${room.door_status || "Unknown"}, sound ${Number(room.sound_peak || 0).toFixed(2)} dB`
      )
      .join("; ");
  }

  if (text.includes("alert") || text.includes("critical")) {
    const { alerts } = await getActiveWardenAlerts({ roomId, limit: 20 });

    if (!alerts.length) return `There are no active ML alerts for ${roomId}.`;

    const affected = [...new Set(alerts.map((item) => item.room_id).filter(Boolean))];

    return `There are ${alerts.length} active ML alert${alerts.length === 1 ? "" : "s"} for ${roomId}. Affected rooms: ${affected.join(", ") || "none"}. Latest model: ${alerts[0].model_name || "IsolationForest"}.`;
  }

  if (
    text.includes("inspection") ||
    text.includes("cleaning") ||
    text.includes("priority") ||
    text.includes("action first")
  ) {
    const { rooms } = await getInspectionRooms({ roomId: "All" });

    if (!rooms.length) return "No rooms currently need inspection or cleaning priority action.";

    return `Rooms needing Warden action: ${listRoomIds(rooms)}. Priority is based on current sensor status plus ML alert evidence.`;
  }

  if (text.includes("door") || text.includes("open")) {
    const { rooms } = await getOpenDoorRooms({ roomId: "All" });

    return rooms.length
      ? `Open-door rooms: ${listRoomIds(rooms)}.`
      : "No rooms currently have an open-door status.";
  }

  if (text.includes("pattern") || text.includes("weekly") || text.includes("kmeans")) {
    const { patterns } = await getWeeklyPattern({ roomId });

    if (!patterns.length) return `No KMeans weekly pattern records are available for ${roomId}.`;

    return `Weekly KMeans patterns for ${roomId}: ${patterns
      .map(
        (p) =>
          `${p.day}: ${p.usual_pattern} (cluster ${p.cluster_id}, avg noise ${Number(
            p.avg_noise_level || 0
          ).toFixed(2)})`
      )
      .join("; ")}.`;
  }

  if (text.includes("anomal") || text.includes("abnormal") || text.includes("outlier")) {
    const { anomalies } = await getWardenAnomalySummary({ roomId, limit: 10 });

    if (!anomalies.length) return `No IsolationForest anomaly records are available for ${roomId}.`;

    return `IsolationForest anomalies for ${roomId}: ${anomalies
      .map(
        (a) =>
          `${a.room_id || roomId} on ${a.date} score ${Number(a.anomaly_score || 0).toFixed(3)}`
      )
      .join("; ")}.`;
  }

  if (text.includes("forecast") || text.includes("predict") || text.includes("future")) {
    const { forecasts } = await getWardenForecastSummary({ roomId });
    return latestForecastText(forecasts);
  }

  if (text.includes("data range") || text.includes("coverage") || text.includes("valid")) {
    const range = await getWardenDataRangeTool({ roomId });

    return `Data coverage for ${roomId}: ${range.total_records || 0} records, first timestamp ${
      range.first_timestamp || "not available"
    }, last timestamp ${range.last_timestamp || "not available"}, ${
      range.total_days_covered || 0
    } day(s) covered. Valid 5+ days: ${range.valid ? "yes" : "no"}.`;
  }

  if (text.includes("summary") || text.includes("overview")) {
    const summary = await getWardenSummaryTool({ roomId });

    return `Warden summary for ${roomId}: total rooms ${summary.total_rooms}, occupied ${summary.occupied_rooms}, empty ${summary.empty_rooms}, sleeping ${summary.sleeping_rooms}, inspection rooms ${summary.rooms_needing_inspection}, open-door rooms ${summary.open_door_rooms}, noisy rooms ${summary.noisy_rooms}, active ML alerts ${summary.active_ml_alerts}.`;
  }

  return null;
}

function systemPrompt() {
  return `You are a Smart Hostel Warden visual analytics assistant. Answer only using the provided MongoDB and ML context. Never invent room counts, room IDs, dates, or model results. Keep the answer operational and useful for Warden decisions.`;
}

async function generateWardenReply({ message, dashboardState }) {
  const directReply = await deterministicWardenAnswer(message, dashboardState);

  if (directReply) {
    return {
      reply: directReply,
      context_used: { source: "warden_real_data_tools" }
    };
  }

  const roomId = getRoomScope(message, dashboardState);

  const [summary, rooms, alerts, patterns, anomalies, forecasts, dataRange] =
    await Promise.all([
      getWardenSummaryTool({ roomId }),
      getLatestRoomReadings({ roomId }),
      getActiveWardenAlerts({ roomId, limit: 10 }),
      getWeeklyPattern({ roomId }),
      getWardenAnomalySummary({ roomId, limit: 10 }),
      getWardenForecastSummary({ roomId }),
      getWardenDataRangeTool({ roomId })
    ]);

  const visual = await getVisualExplanationContext({ dashboardState });

  const context = {
    summary,
    rooms,
    alerts,
    patterns,
    anomalies,
    forecasts,
    dataRange,
    visual
  };

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt() },
        {
          role: "user",
          content: `Question: ${message}\n\nWarden data context:\n${JSON.stringify(context)}`
        }
      ]
    });

    return {
      reply:
        response.choices?.[0]?.message?.content ||
        "No answer was generated from the Warden context.",
      context_used: context
    };
  } catch (error) {
    return {
      reply:
        "I can answer Warden questions about occupancy, empty rooms, alerts, inspections, noise, doors, weekly patterns, anomalies, forecasts, data range, and summary using dashboard data.",
      context_used: context
    };
  }
}

module.exports = { generateWardenReply };