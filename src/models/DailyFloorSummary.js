const mongoose = require("mongoose");

const DailyFloorSummarySchema = new mongoose.Schema(
  {
    floor_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },

    total_energy_kwh: { type: Number, default: 0 },
    wasted_energy_kwh: { type: Number, default: 0 },
    waste_ratio_percent: { type: Number, default: 0 },

    avg_current: { type: Number, default: 0 },
    total_motion_count: { type: Number, default: 0 },
    avg_sound_peak: { type: Number, default: 0 },

    rooms_count: { type: Number, default: 0 },
    critical_rooms_count: { type: Number, default: 0 },
    warning_rooms_count: { type: Number, default: 0 }
  },
  { timestamps: true }
);

DailyFloorSummarySchema.index({ floor_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model(
  "DailyFloorSummary",
  DailyFloorSummarySchema,
  "daily_floor_summary"
);
