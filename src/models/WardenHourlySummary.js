const mongoose = require("mongoose");

const WardenHourlySummarySchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    hour: { type: Number, required: true, index: true },

    occupied_count: { type: Number, default: 0 },
    empty_count: { type: Number, default: 0 },
    sleeping_count: { type: Number, default: 0 },

    warning_count: { type: Number, default: 0 },
    violation_count: { type: Number, default: 0 },
    complaint_count: { type: Number, default: 0 },

    avg_sound_peak: { type: Number, default: 0 },
    avg_current: { type: Number, default: 0 },
    door_open_count: { type: Number, default: 0 },

    inspection_count: { type: Number, default: 0 }
  },
  { timestamps: true }
);

WardenHourlySummarySchema.index(
  { room_id: 1, date: 1, hour: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "WardenHourlySummary",
  WardenHourlySummarySchema,
  "warden_hourly_summary"
);
