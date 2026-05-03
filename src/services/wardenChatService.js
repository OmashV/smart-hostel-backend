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
  if (
    text.includes("all rooms") ||
    text.includes("which rooms") ||
    text.includes("what rooms") ||
    text.includes("occupied rooms") ||
    text.includes("empty rooms") ||
    text.includes("noisy rooms") ||
    text.includes("inspection rooms")
  ) {
    return "All";
  }

  return dashboardState?.roomId || dashboardState?.selectedFilters?.roomId || "All";
}

function listRoomIds(rooms = []) {
  return rooms.map((r) => r.room_id).filter(Boolean).join(", ") || "none";
}

function n(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function statusMatches(value, status) {
  return normalizeText(value) === normalizeText(status);
}

function describeRoom(room) {
  return `${room.room_id}: ${room.occupancy_stat || "No Data"}, noise ${room.noise_stat || "No Data"} (${n(room.sound_peak)} dB), door ${room.door_status || "No Data"}, power ${n(room.current_amp)} A`;
}

function strongestRiskRoom(rooms = []) {
  return [...rooms].sort((a, b) => {
    const score = (r) =>
      Number(r.needs_inspection ? 5 : 0) +
      Number(String(r.noise_stat || "").toLowerCase().includes("violation") ? 4 : 0) +
      Number(String(r.door_status || "").toLowerCase().includes("open") ? 2 : 0) +
      Number(r.sound_peak || 0) / 25 +
      Number(r.current_amp || 0);
    return score(b) - score(a);
  })[0];
}

async function deterministicWardenAnswer(message = "", dashboardState = {}) {
  const text = normalizeText(message);
  const roomId = getRoomScope(message, dashboardState);
  const explicitRoom = extractRoomId(message);

  if (text.includes("occupied")) {
    const { rooms } = await getLatestRoomReadings({ roomId: "All" });
    const occupied = rooms.filter((r) => statusMatches(r.occupancy_stat, "Occupied"));
    return `There are ${occupied.length} occupied room${occupied.length === 1 ? "" : "s"}: ${listRoomIds(occupied)}.`;
  }

  if (text.includes("empty") || text.includes("vacant")) {
    const { rooms } = await getLatestRoomReadings({ roomId: "All" });
    const empty = rooms.filter((r) => statusMatches(r.occupancy_stat, "Empty"));
    return `There are ${empty.length} empty room${empty.length === 1 ? "" : "s"}: ${listRoomIds(empty)}.`;
  }

  if (text.includes("sleeping")) {
    const { rooms } = await getLatestRoomReadings({ roomId: "All" });
    const sleeping = rooms.filter((r) => statusMatches(r.occupancy_stat, "Sleeping"));
    return `There are ${sleeping.length} sleeping room${sleeping.length === 1 ? "" : "s"}: ${listRoomIds(sleeping)}.`;
  }

  if (explicitRoom && (text.includes("why") || text.includes("explain") || text.includes("critical") || text.includes("problem"))) {
    const { rooms } = await getLatestRoomReadings({ roomId: explicitRoom });
    const room = rooms[0];
    const { alerts } = await getActiveWardenAlerts({ roomId: explicitRoom, limit: 5 });
    const { anomalies } = await getWardenAnomalySummary({ roomId: explicitRoom, limit: 3 });

    if (!room) return `Room ${explicitRoom} was not found.`;

    const evidence = [];
    if (String(room.noise_stat || "").toLowerCase().includes("violation")) evidence.push(`very loud noise (${n(room.sound_peak)} dB)`);
    if (String(room.door_status || "").toLowerCase().includes("open")) evidence.push("door is open");
    if (Number(room.current_amp || 0) > 0) evidence.push(`power use is ${n(room.current_amp)} A`);
    if (room.needs_inspection) evidence.push("room is marked for inspection");
    if (alerts.length) evidence.push(`${alerts.length} active alert record(s)`);
    if (anomalies.length) evidence.push(`${anomalies.length} anomaly record(s)`);

    return `Room ${explicitRoom} needs attention because ${evidence.join(", ") || "unusual room activity was detected"}.`;
  }

  if (explicitRoom && (text.includes("noise level") || text.includes("sound level") || text.includes("noise"))) {
    const result = await getRoomNoiseLevel({ roomId: explicitRoom });
    if (!result.found) return `Room ${explicitRoom} was not found.`;
    return `Room ${explicitRoom} noise level is ${n(result.sound_peak)} dB and status is ${result.noise_stat || "No Data"}.`;
  }

  if (text.includes("noise") || text.includes("noisy") || text.includes("violation") || text.includes("complaint") || text.includes("warning")) {
    const wantsViolation = text.includes("violation") || text.includes("critical");
    const wantsWarning = !wantsViolation && (text.includes("complaint") || text.includes("warning"));

    const { rooms } = await getNoisyRooms({
      roomId: "All",
      mode: wantsViolation ? "violation" : wantsWarning ? "complaint" : "all"
    });

    if (!rooms.length) return "No rooms currently have matching noise issues.";

    const label = wantsViolation
      ? "Rooms with noise violations"
      : wantsWarning
      ? "Rooms with noise complaints or warnings"
      : "Rooms with noise issues";

    return `${label}: ${rooms.map((r) => `${r.room_id} (${r.noise_stat}, ${n(r.sound_peak)} dB)`).join(", ")}.`;
  }

  if (text.includes("door") || text.includes("open")) {
    const { rooms } = await getOpenDoorRooms({ roomId: "All" });
    return rooms.length ? `Open-door rooms: ${listRoomIds(rooms)}.` : "No rooms currently have an open-door status.";
  }

  if (text.includes("inspection") || text.includes("cleaning") || text.includes("priority") || text.includes("action first")) {
    const { rooms } = await getInspectionRooms({ roomId: "All" });
    if (!rooms.length) return "No rooms currently need inspection or cleaning priority action.";
    return `Rooms needing warden action: ${listRoomIds(rooms)}. Check these first because they have sensor or alert evidence.`;
  }

  if (text.includes("most risky") || text.includes("highest risk") || text.includes("worst room") || text.includes("check first")) {
    const { rooms } = await getLatestRoomReadings({ roomId: "All" });
    const room = strongestRiskRoom(rooms);
    if (!room) return "No room data available.";
    return `The room to check first is ${room.room_id}. Evidence: noise ${room.noise_stat} (${n(room.sound_peak)} dB), door ${room.door_status}, power ${n(room.current_amp)} A, inspection ${room.needs_inspection ? "needed" : "not marked"}.`;
  }

  if (text.includes("room status") || text.includes("current status") || text.includes("status of")) {
    const { rooms } = await getLatestRoomReadings({ roomId });
    if (!rooms.length) return `No current status records are available for ${roomId}.`;
    return rooms.map(describeRoom).join("; ");
  }

  if (text.includes("alert") || text.includes("critical")) {
    const { alerts } = await getActiveWardenAlerts({ roomId, limit: 100 });
    if (!alerts.length) return `There are no active critical alerts for ${roomId}.`;
    const affected = [...new Set(alerts.map((a) => a.room_id).filter(Boolean))];
    return `There are ${alerts.length} critical alert${alerts.length === 1 ? "" : "s"} for ${roomId}. Affected rooms: ${affected.join(", ")}.`;
  }

  if (text.includes("pattern") || text.includes("weekly")) {
    const { patterns } = await getWeeklyPattern({ roomId });
    if (!patterns.length) return `No weekly pattern records are available for ${roomId}.`;
    return `Weekly room behavior for ${roomId}: ${patterns.map((p) => `${p.day}: ${p.usual_pattern}, average noise ${n(p.avg_noise_level)} dB, attention ${n(p.avg_critical_ratio)}%`).join("; ")}.`;
  }

  if (text.includes("anomal") || text.includes("abnormal") || text.includes("unusual")) {
    const { anomalies } = await getWardenAnomalySummary({ roomId, limit: 10 });
    if (!anomalies.length) return `No unusual activity records are available for ${roomId}.`;
    return `Unusual activity for ${roomId}: ${anomalies.map((a) => `${a.room_id || roomId} on ${a.date}: ${a.reason || "unusual behavior"}, noise ${n(a.avg_sound_peak)} dB, power ${n(a.avg_current)} A`).join("; ")}.`;
  }

  if (text.includes("forecast") || text.includes("predict") || text.includes("future")) {
    const { forecasts } = await getWardenForecastSummary({ roomId });
    if (!forecasts.length) return `No forecast records are available for ${roomId}.`;
    return `Forecast for ${roomId}: ${forecasts.slice(0, 5).map((f) => `${f.date}: predicted occupancy ${n(f.predicted_occupied_count)}, warnings ${n(f.predicted_warning_count)}, violations ${n(f.predicted_violation_count)}`).join("; ")}.`;
  }

  if (text.includes("compare")) {
    const { rooms } = await getLatestRoomReadings({ roomId: "All" });
    if (!rooms.length) return "No rooms available to compare.";
    return `Room comparison: ${rooms.map((r) => `${r.room_id}: ${r.noise_stat}, ${n(r.sound_peak)} dB, door ${r.door_status}, power ${n(r.current_amp)} A`).join("; ")}.`;
  }

  if (text.includes("data range") || text.includes("coverage") || text.includes("valid")) {
    const range = await getWardenDataRangeTool({ roomId });
    return `Data coverage for ${roomId}: ${range.total_records || 0} records, ${range.total_days_covered || 0} day(s), from ${range.first_timestamp || "not available"} to ${range.last_timestamp || "not available"}. Valid 5+ days: ${range.valid ? "yes" : "no"}.`;
  }

  if (text.includes("summary") || text.includes("overview")) {
    const summary = await getWardenSummaryTool({ roomId });
    return `Warden summary for ${roomId}: total rooms ${summary.total_rooms}, occupied ${summary.occupied_rooms}, empty ${summary.empty_rooms}, sleeping ${summary.sleeping_rooms}, inspection rooms ${summary.rooms_needing_inspection}, open-door rooms ${summary.open_door_rooms}, noisy rooms ${summary.noisy_rooms}, active alerts ${summary.active_ml_alerts}.`;
  }

  return null;
}

function systemPrompt() {
  return `
You are a Smart Hostel Warden visual analytics assistant.
Use only the provided MongoDB and ML context.
Never invent counts, room IDs, dates, or model results.
Answer in simple warden-friendly language.
Support decision questions by giving evidence and action.
Avoid technical jargon unless the user asks for it.
`;
}

async function generateWardenReply({ message, dashboardState }) {
  const directReply = await deterministicWardenAnswer(message, dashboardState);

  if (directReply) {
    return {
      reply: directReply,
      context_used: { source: "deterministic_warden_real_data_tools" }
    };
  }

  const roomId = getRoomScope(message, dashboardState);

  const [summary, rooms, alerts, patterns, anomalies, forecasts, dataRange, visual] =
    await Promise.all([
      getWardenSummaryTool({ roomId }),
      getLatestRoomReadings({ roomId }),
      getActiveWardenAlerts({ roomId, limit: 100 }),
      getWeeklyPattern({ roomId }),
      getWardenAnomalySummary({ roomId, limit: 10 }),
      getWardenForecastSummary({ roomId }),
      getWardenDataRangeTool({ roomId }),
      getVisualExplanationContext({ dashboardState })
    ]);

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
          content: `Question: ${message}\n\nReal dashboard context:\n${JSON.stringify(context)}`
        }
      ]
    });

    return {
      reply:
        response.choices?.[0]?.message?.content ||
        "No answer was generated from the Warden dashboard context.",
      context_used: context
    };
  } catch (error) {
    return {
      reply:
        "I can answer questions about occupied rooms, empty rooms, noise, doors, inspections, alerts, unusual activity, forecasts, weekly patterns, and which room to check first.",
      context_used: context
    };
  }
}

module.exports = {
  generateWardenReply
};