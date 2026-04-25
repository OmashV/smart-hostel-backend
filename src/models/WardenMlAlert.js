const mongoose = require("mongoose");

const WardenMlAlertSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    captured_at: { type: String, required: true, index: true },
    evidence_at: { type: String, default: "" },
    display_at: { type: Date },
    generated_at: { type: Date },
    alert_type: { type: String, required: true },
    severity: { type: String, enum: ["Critical", "Warning", "Info"], default: "Warning" },
    confidence: { type: Number, default: 0 },
    model_name: { type: String, default: "RandomForestClassifier + IsolationForest" },
    reason: { type: String, default: "" },
    source_anomaly_score: { type: Number, default: 0 },
    source_alert_probability: { type: Number, default: 0 }
  },
  { timestamps: true }
);

WardenMlAlertSchema.index({ room_id: 1, captured_at: -1 });

module.exports = mongoose.model(
  "WardenMlAlert",
  WardenMlAlertSchema,
  "warden_ml_alerts"
);
