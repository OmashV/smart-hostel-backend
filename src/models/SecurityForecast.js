// models/SecurityForecast.js
const mongoose = require("mongoose");

const SecurityForecastSchema = new mongoose.Schema({
  room_id: String,
  hour: Number,
  hour_label: String,
  date: String,
  expected_door_stable_ms: Number,
  expected_door_stable_min: Number,
  lower_bound_ms: Number,
  upper_bound_ms: Number,
  model_name: String
});

module.exports = mongoose.model("SecurityForecast", SecurityForecastSchema, "security_forecasts");