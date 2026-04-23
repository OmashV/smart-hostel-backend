const mongoose = require("mongoose");

const DailyRoomSummarySchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },

    total_energy_kwh: { type: Number, default: 0 },
    wasted_energy_kwh: { type: Number, default: 0 },
    waste_ratio_percent: { type: Number, default: 0 },

    avg_current: { type: Number, default: 0 },
    total_motion_count: { type: Number, default: 0 },
    avg_sound_peak: { type: Number, default: 0 },
    door_open_count: { type: Number, default: 0 },

    critical_count: { type: Number, default: 0 },
    warning_count: { type: Number, default: 0 }
  },
  { timestamps: true }
);

DailyRoomSummarySchema.index({ room_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model(
  "DailyRoomSummary",
  DailyRoomSummarySchema,
  "daily_room_summary"
);