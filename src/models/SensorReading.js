const mongoose = require("mongoose");

const SensorReadingSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    device_id: { type: String, required: true },

    captured_at_epoch: { type: Number, default: 0 },
    captured_at: { type: Date, required: true, index: true },

    timestamp_ms: { type: Number, default: 0 },

    time_valid: { type: Boolean, default: false },
    hour: { type: Number, default: -1 },
    minute: { type: Number, default: -1 },
    second: { type: Number, default: -1 },

    motion_count: { type: Number, default: 0 },
    last_motion_ms_ago: { type: Number, default: 0 },

    door_status: {
      type: String,
      enum: ["Open", "Closed"],
      default: "Closed"
    },
    door_stable_ms: { type: Number, default: 0 },

    current_amp: { type: Number, default: 0 },
    sound_peak: { type: Number, default: 0 },

    wifi_rssi: { type: Number, default: 0 },
    buffered: { type: Boolean, default: false },
    buffer_queue_size: { type: Number, default: 0 },
    dropped_messages: { type: Number, default: 0 },

    sensor_health: {
      pir: { type: Boolean, default: true },
      door: { type: Boolean, default: true },
      sound: { type: Boolean, default: true },
      current: { type: Boolean, default: true }
    },

    occupancy_stat: { type: String, default: "Unknown" },
    noise_stat: { type: String, default: "Unknown" },
    waste_stat: { type: String, default: "Unknown" },

    sensor_faults: {
      pir: { type: Boolean, default: false },
      door: { type: Boolean, default: false },
      sound: { type: Boolean, default: false },
      current: { type: Boolean, default: false }
    },

    interval_energy_kwh: { type: Number, default: 0 },
    interval_wasted_energy_kwh: { type: Number, default: 0 },

    source: { type: String, default: "node-red" }
  },
  { timestamps: true }
);

SensorReadingSchema.index({ room_id: 1, captured_at: 1 });

module.exports = mongoose.model(
  "SensorReading",
  SensorReadingSchema,
  "sensorreadings"
);