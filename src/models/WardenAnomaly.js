const mongoose = require("mongoose");

const WardenAnomalySchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    status: { type: String, default: "Abnormal" },
    reason: { type: String, default: "" },
    avg_sound_peak: { type: Number, default: 0 },
    avg_current: { type: Number, default: 0 },
    violation_count: { type: Number, default: 0 },
    anomaly_score: { type: Number, default: 0 }
  },
  { timestamps: true }
);

WardenAnomalySchema.index({ room_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model(
  "WardenAnomaly",
  WardenAnomalySchema,
  "warden_anomalies"
);
