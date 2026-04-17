const mongoose = require("mongoose");
require("dotenv").config();

const SensorReading = require("../src/models/SensorReading");
const WardenHourlySummary = require("../src/models/WardenHourlySummary");

const TIMEZONE = "Asia/Colombo";

async function run() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected.");
    console.log("Connected DB name:", mongoose.connection.name);

    const totalSensorDocs = await SensorReading.countDocuments();
    console.log("sensorreadings count:", totalSensorDocs);

    const results = await SensorReading.aggregate([
      {
        $group: {
          _id: {
            room_id: "$room_id",
            date: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$captured_at",
                timezone: TIMEZONE
              }
            },
            hour: {
              $hour: {
                date: "$captured_at",
                timezone: TIMEZONE
              }
            }
          },
          occupied_count: {
            $sum: { $cond: [{ $eq: ["$occupancy_stat", "Occupied"] }, 1, 0] }
          },
          empty_count: {
            $sum: { $cond: [{ $eq: ["$occupancy_stat", "Empty"] }, 1, 0] }
          },
          sleeping_count: {
            $sum: { $cond: [{ $eq: ["$occupancy_stat", "Sleeping"] }, 1, 0] }
          },
          warning_count: {
            $sum: { $cond: [{ $eq: ["$noise_stat", "Warning"] }, 1, 0] }
          },
          violation_count: {
            $sum: { $cond: [{ $eq: ["$noise_stat", "Violation"] }, 1, 0] }
          },
          complaint_count: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$noise_stat", "Complaint"] },
                    { $eq: ["$noise_stat", "Compliant"] }
                  ]
                },
                1,
                0
              ]
            }
          },
          avg_sound_peak: { $avg: "$sound_peak" },
          avg_current: { $avg: "$current_amp" },
          door_open_count: {
            $sum: { $cond: [{ $eq: ["$door_status", "Open"] }, 1, 0] }
          },
          inspection_count: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$waste_stat", "Critical"] },
                    { $eq: ["$noise_stat", "Violation"] },
                    { $eq: ["$noise_stat", "Warning"] },
                    "$sensor_faults.pir",
                    "$sensor_faults.door",
                    "$sensor_faults.sound",
                    "$sensor_faults.current"
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    console.log("Aggregated warden hourly groups found:", results.length);

    for (const item of results) {
      await WardenHourlySummary.updateOne(
        {
          room_id: item._id.room_id,
          date: item._id.date,
          hour: item._id.hour
        },
        {
          $set: {
            room_id: item._id.room_id,
            date: item._id.date,
            hour: item._id.hour,
            occupied_count: item.occupied_count || 0,
            empty_count: item.empty_count || 0,
            sleeping_count: item.sleeping_count || 0,
            warning_count: item.warning_count || 0,
            violation_count: item.violation_count || 0,
            complaint_count: item.complaint_count || 0,
            avg_sound_peak: Number((item.avg_sound_peak || 0).toFixed(2)),
            avg_current: Number((item.avg_current || 0).toFixed(4)),
            door_open_count: item.door_open_count || 0,
            inspection_count: item.inspection_count || 0
          }
        },
        { upsert: true }
      );
    }

    const totalSummaryDocs = await WardenHourlySummary.countDocuments();
    console.log("warden_hourly_summary count:", totalSummaryDocs);

    console.log("Warden hourly summary build complete.");
    await mongoose.disconnect();
  } catch (err) {
    console.error("Error while building warden hourly summary:");
    console.error(err);
    process.exit(1);
  }
}

run();
