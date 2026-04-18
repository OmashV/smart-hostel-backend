const mongoose = require("mongoose");

const OwnerWeekdayPatternSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    weekday_name: { type: String, required: true, index: true },
    day_type: { type: String, required: true }, // Weekday / Weekend
    usual_pattern: { type: String, required: true },
    days_count: { type: Number, default: 0 },
    avg_total_energy_kwh: { type: Number, default: 0 },
    avg_wasted_energy_kwh: { type: Number, default: 0 },
    avg_waste_ratio_percent: { type: Number, default: 0 }
  },
  { timestamps: true }
);

OwnerWeekdayPatternSchema.index(
  { room_id: 1, weekday_name: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "OwnerWeekdayPattern",
  OwnerWeekdayPatternSchema,
  "owner_weekday_patterns"
);