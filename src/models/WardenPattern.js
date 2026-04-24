const mongoose = require("mongoose");

const WardenPatternSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    day: { type: String, required: true, index: true },
    day_type: { type: String, enum: ["Weekday", "Weekend"], default: "Weekday" },
    cluster_id: { type: Number, default: -1 },
    usual_pattern: { type: String, default: "No Data" },
    avg_occupancy: { type: Number, default: 0 },
    avg_noise_level: { type: Number, default: 0 },
    avg_warnings: { type: Number, default: 0 },
    avg_critical_ratio: { type: Number, default: 0 },
    record_count: { type: Number, default: 0 },
    model_name: { type: String, default: "KMeans" }
  },
  { timestamps: true }
);

WardenPatternSchema.index({ room_id: 1, day: 1 }, { unique: true });

module.exports = mongoose.model(
  "WardenPattern",
  WardenPatternSchema,
  "warden_patterns"
);
