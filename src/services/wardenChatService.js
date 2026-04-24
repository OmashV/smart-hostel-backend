function listRooms(items = []) {
  return items.map((x) => x.room_id).filter(Boolean).join(', ') || 'No rooms found';
}

function generateWardenReply({ message, dashboardState = {} }) {
  const text = String(message || '').toLowerCase();
  const alerts = dashboardState.alerts || [];
  const rooms = dashboardState.rooms || [];
  const anomalies = dashboardState.anomalies || [];
  const patterns = dashboardState.patterns || [];
  const forecasts = dashboardState.forecasts || [];

  if (text.includes('active alert')) {
    return { reply: alerts.length ? `Active alerts are currently shown for: ${listRooms(alerts)}. Highest priority: ${alerts[0]?.room_id} (${alerts[0]?.severity}) - ${alerts[0]?.title}.` : 'There are no active Warden ML alerts for the selected room filter.', actions: [] };
  }
  if (text.includes('inspection')) {
    const need = rooms.filter((r) => r.needs_inspection || r.active_alert_count > 0);
    return { reply: need.length ? `Rooms needing inspection: ${listRooms(need)}. Prioritize rooms with Critical/Warning ML alerts first.` : 'No rooms currently need inspection based on active ML alerts.', actions: [] };
  }
  if (text.includes('weekly') || text.includes('pattern')) {
    const high = patterns.filter((p) => p.cluster_id === 2 || String(p.usual_pattern).toLowerCase().includes('high'));
    return { reply: patterns.length ? `Weekly pattern discovery has ${patterns.length} rows. Higher monitoring days: ${high.map((p) => `${p.day} (${p.usual_pattern})`).join(', ') || 'none'}.` : 'No weekly pattern rows are available yet. Run npm run ml:warden after MongoDB is connected.', actions: [] };
  }
  if (text.includes('anomal')) {
    return { reply: anomalies.length ? `Recent anomalies: ${anomalies.slice(0, 5).map((a) => `${a.room_id} on ${String(a.date).slice(0,10)} score ${a.anomaly_score}`).join('; ')}.` : 'No anomaly rows found for the selected filter.', actions: [] };
  }
  if (text.includes('forecast')) {
    return { reply: forecasts.length ? `Forecast is available for ${forecasts.length} future room/day rows. Next prediction: ${forecasts[0]?.room_id} on ${forecasts[0]?.date}, occupancy ${forecasts[0]?.predicted_occupied_count}, warnings ${forecasts[0]?.predicted_warning_count}.` : 'No forecast rows found. Run the Warden analytics builder to populate warden_forecasts.', actions: [] };
  }
  return { reply: 'I can answer Warden questions about active alerts, inspection rooms, weekly patterns, anomalies, and forecast using the live dashboard API data.', actions: [] };
}

module.exports = { generateWardenReply };
