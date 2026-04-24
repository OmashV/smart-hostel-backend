const mongoose = require("mongoose");

const WardenPatternSchema = new mongoose.Schema(
  {
    room_id: { type: String, default: "All", index: true },
    day: { type: String, required: true, index: true },
    day_type: { type: String, default: "Weekday" },
    usual_pattern: { type: String, default: "Normal Operations" },
    avg_occupancy: { type: Number, default: 0 },
    avg_noise_level: { type: Number, default: 0 },
    avg_warnings: { type: Number, default: 0 },
    avg_critical_ratio: { type: Number, default: 0 },
    cluster_id: { type: Number, default: 0 },
    model_name: { type: String, default: "kmeans" }
  },
  { timestamps: true }
);

WardenPatternSchema.index({ room_id: 1, day: 1 }, { unique: true });

module.exports = mongoose.model("WardenPattern", WardenPatternSchema, "warden_patterns");
