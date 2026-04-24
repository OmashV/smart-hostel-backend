// models/DemoSecurityReading.js
const mongoose = require("mongoose");
const SensorReading = require("./SensorReading");

const DemoSecurityReading = mongoose.model(
  "DemoSecurityReading",
  SensorReading.schema,
  "demo_security_readings"
);

module.exports = DemoSecurityReading;