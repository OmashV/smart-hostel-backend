const mongoose = require("mongoose");

const OwnerAnomalySchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    anomaly_score: { type: Number, default: 0 },
    is_anomaly: { type: Boolean, default: false },
    total_energy_kwh: { type: Number, default: 0 },
    wasted_energy_kwh: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model("OwnerAnomaly", OwnerAnomalySchema, "owner_anomalies");