const { buildDashboardContext } = require("../services/dashboardInsightsService");

function buildFallbackReply(question, context) {
  const q = String(question || "").toLowerCase();
  const summary = context.occupancy_summary || {};
  const latestAlert = context.ml_alerts?.[0];
  const latestAnomaly = context.anomalies?.[0];
  const nextForecast = context.forecasts?.[0];
  const highPattern = context.patterns?.find((p) => String(p.usual_pattern || "").toLowerCase().includes("high"));

  if (q.includes("alert") || q.includes("critical") || q.includes("risk")) {
    if (!latestAlert) return "No ML-generated Warden alerts are available right now. Run the Warden ML script after collecting sensor data.";
    return `The latest ML alert is ${latestAlert.alert_type} for room ${latestAlert.room_id} with ${latestAlert.severity} severity and ${Math.round((latestAlert.confidence || 0) * 100)}% confidence. Reason: ${latestAlert.reason}`;
  }

  if (q.includes("anomaly") || q.includes("abnormal")) {
    if (!latestAnomaly) return "No Warden anomaly records are available right now.";
    return `The latest anomaly is for room ${latestAnomaly.room_id} on ${latestAnomaly.date}. IsolationForest marked it as ${latestAnomaly.status || "Abnormal"}. Reason: ${latestAnomaly.reason || "unusual room behavior"}.`;
  }

  if (q.includes("pattern") || q.includes("weekly") || q.includes("kmeans")) {
    if (!context.patterns?.length) return "No KMeans weekly pattern records are available right now.";
    if (highPattern) return `${highPattern.day} has the strongest Warden weekly pattern: ${highPattern.usual_pattern}, with average noise ${highPattern.avg_noise_level} and average warnings ${highPattern.avg_warnings}.`;
    return `Weekly Pattern Discovery uses KMeans. The current table contains ${context.patterns.length} weekday/weekend pattern rows.`;
  }

  if (q.includes("forecast") || q.includes("predict")) {
    if (!nextForecast) return "No Warden forecast records are available right now.";
    return `The nearest forecast is for room ${nextForecast.room_id} on ${nextForecast.date}: predicted occupancy ${nextForecast.predicted_occupied_count || 0}, predicted warnings ${nextForecast.predicted_warning_count || 0}.`;
  }

  if (q.includes("inspection") || q.includes("cleaning")) {
    return `${summary.inspectionRooms || 0} rooms currently need inspection from the latest sensor snapshot. Empty rooms can be prioritized for cleaning allocation.`;
  }

  if (q.includes("occupied") || q.includes("empty") || q.includes("room status")) {
    return `Current hostel status shows ${summary.occupied || 0} occupied rooms, ${summary.empty || 0} empty rooms, and ${summary.sleeping || 0} sleeping rooms. ML alerts currently available: ${context.ml_alerts?.length || 0}.`;
  }

  return `The Warden assistant is connected to live dashboard data. Ask about active ML alerts, anomalies, weekly patterns, forecasts, inspection rooms, or occupancy.`;
}

async function askDashboardAssistant(req, res) {
  try {
    const { question, role = "warden" } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ message: "Question is required." });

    const context = await buildDashboardContext(role);
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!apiKey || typeof fetch !== "function") {
      return res.json({ answer: buildFallbackReply(question, context), used_fallback: true, context });
    }

    const prompt = `You are a visual analytics assistant for a Smart Hostel Warden dashboard. Answer only from the JSON context. Explain ML alerts, anomalies, KMeans weekly patterns, forecasts, and inspection decisions clearly. Do not invent facts.\n\nCONTEXT:\n${JSON.stringify(context)}`;
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: "system", content: prompt }, { role: "user", content: String(question) }] })
    });

    if (!response.ok) {
      const text = await response.text();
      return res.json({ answer: buildFallbackReply(question, context), used_fallback: true, model_error: text, context });
    }
    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content || buildFallbackReply(question, context);
    return res.json({ answer, used_fallback: false, context });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Assistant request failed." });
  }
}

module.exports = { askDashboardAssistant };
