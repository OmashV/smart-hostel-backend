const mongoose = require("mongoose");

const OwnerAnomalySchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    status: { type: String, default: "Abnormal" },
    reason: { type: String, default: "" },
    total_energy_kwh: { type: Number, default: 0 },
    wasted_energy_kwh: { type: Number, default: 0 },
    waste_ratio_percent: { type: Number, default: 0 },
    avg_current: { type: Number, default: 0 },
    anomaly_score: { type: Number, default: 0 }
  },
  { timestamps: true }
);

OwnerAnomalySchema.index({ room_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("OwnerAnomaly", OwnerAnomalySchema, "owner_anomalies");
