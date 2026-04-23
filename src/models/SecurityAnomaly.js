// models/SecurityAnomaly.js
const mongoose = require("mongoose");

const SecurityAnomalySchema = new mongoose.Schema({
  room_id: String,
  captured_at: String,
  hour: Number,
  status: String,
  reason: String,
  severity: String,
  door_stable_ms: Number,
  door_stable_min: Number,
  motion_count: Number,
  is_after_hours: Boolean,
  is_empty: Boolean,
  anomaly_score: Number,
  model_name: String
});

module.exports = mongoose.model("SecurityAnomaly", SecurityAnomalySchema, "security_anomalies");