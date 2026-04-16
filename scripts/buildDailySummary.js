const mongoose = require("mongoose");
require("dotenv").config();

const SensorReading = require("../src/models/SensorReading");
const DailyRoomSummary = require("../src/models/DailyRoomSummary");

const TIMEZONE = "Asia/Colombo";

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

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
          }
        },
        total_energy_kwh: { $sum: "$interval_energy_kwh" },
        wasted_energy_kwh: { $sum: "$interval_wasted_energy_kwh" },
        avg_current: { $avg: "$current_amp" },
        total_motion_count: { $sum: "$motion_count" },
        avg_sound_peak: { $avg: "$sound_peak" },
        door_open_count: {
          $sum: {
            $cond: [{ $eq: ["$door_status", "Open"] }, 1, 0]
          }
        },
        critical_count: {
          $sum: {
            $cond: [{ $eq: ["$waste_stat", "Critical"] }, 1, 0]
          }
        },
        warning_count: {
          $sum: {
            $cond: [{ $eq: ["$waste_stat", "Warning"] }, 1, 0]
          }
        }
      }
    }
  ]);

  for (const item of results) {
    const total = item.total_energy_kwh || 0;
    const wasted = item.wasted_energy_kwh || 0;
    const wasteRatio = total > 0 ? (wasted / total) * 100 : 0;

    await DailyRoomSummary.updateOne(
      {
        room_id: item._id.room_id,
        date: item._id.date
      },
      {
        $set: {
          room_id: item._id.room_id,
          date: item._id.date,
          total_energy_kwh: Number(total.toFixed(4)),
          wasted_energy_kwh: Number(wasted.toFixed(4)),
          waste_ratio_percent: Number(wasteRatio.toFixed(2)),
          avg_current: Number((item.avg_current || 0).toFixed(4)),
          total_motion_count: item.total_motion_count || 0,
          avg_sound_peak: Number((item.avg_sound_peak || 0).toFixed(2)),
          door_open_count: item.door_open_count || 0,
          critical_count: item.critical_count || 0,
          warning_count: item.warning_count || 0
        }
      },
      { upsert: true }
    );
  }

  console.log("Daily summary build complete");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});