const mongoose = require("mongoose");

const OwnerForecastSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    predicted_total_energy_kwh: { type: Number, default: 0 },
    predicted_wasted_energy_kwh: { type: Number, default: 0 },
    model_name: { type: String, default: "random_forest" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("OwnerForecast", OwnerForecastSchema, "owner_forecasts");
