const mongoose = require("mongoose");

const WardenMlAlertSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    device_id: { type: String, default: "" },
    captured_at: { type: Date, required: true, index: true },
    alert_type: { type: String, default: "Operational Anomaly" },
    severity: { type: String, enum: ["Info", "Warning", "Critical"], default: "Warning" },
    title: { type: String, default: "Warden Alert" },
    message: { type: String, default: "" },
    confidence: { type: Number, default: 0 },
    model_name: { type: String, default: "IsolationForest" },
    reason: { type: String, default: "" },
    occupancy_stat: { type: String, default: "Unknown" },
    door_status: { type: String, default: "Unknown" },
    sound_peak: { type: Number, default: 0 },
    current_amp: { type: Number, default: 0 },
    anomaly_score: { type: Number, default: 0 },
    evidence: { type: [String], default: [] },
    status: { type: String, enum: ["Active", "Resolved"], default: "Active" }
  },
  { timestamps: true }
);

WardenMlAlertSchema.index({ room_id: 1, captured_at: 1, alert_type: 1 }, { unique: true });

module.exports = mongoose.model("WardenMlAlert", WardenMlAlertSchema, "warden_ml_alerts");
