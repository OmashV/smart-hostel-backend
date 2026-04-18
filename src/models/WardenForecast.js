const mongoose = require("mongoose");

const WardenForecastSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    predicted_warning_count: { type: Number, default: 0 },
    predicted_violation_count: { type: Number, default: 0 },
    predicted_occupied_count: { type: Number, default: 0 },
    model_name: { type: String, default: "prophet" }
  },
  { timestamps: true }
);

WardenForecastSchema.index({ room_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model(
  "WardenForecast",
  WardenForecastSchema,
  "warden_forecasts"
);
