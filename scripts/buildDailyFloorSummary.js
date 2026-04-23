const mongoose = require("mongoose");
require("dotenv").config();

const DailyRoomSummary = require("../src/models/DailyRoomSummary");
const DailyFloorSummary = require("../src/models/DailyFloorSummary");

async function run() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected.");

    const results = await DailyRoomSummary.aggregate([
      {
        $group: {
          _id: {
            floor_id: "$floor_id",
            date: "$date"
          },
          total_energy_kwh: { $sum: "$total_energy_kwh" },
          wasted_energy_kwh: { $sum: "$wasted_energy_kwh" },
          avg_current: { $avg: "$avg_current" },
          total_motion_count: { $sum: "$total_motion_count" },
          avg_sound_peak: { $avg: "$avg_sound_peak" },
          rooms_count: { $sum: 1 },
          critical_rooms_count: {
            $sum: {
              $cond: [{ $gt: ["$critical_count", 0] }, 1, 0]
            }
          },
          warning_rooms_count: {
            $sum: {
              $cond: [{ $gt: ["$warning_count", 0] }, 1, 0]
            }
          }
        }
      }
    ]);

    for (const item of results) {
      const total = item.total_energy_kwh || 0;
      const wasted = item.wasted_energy_kwh || 0;
      const wasteRatio = total > 0 ? (wasted / total) * 100 : 0;

      await DailyFloorSummary.updateOne(
        {
          floor_id: item._id.floor_id,
          date: item._id.date
        },
        {
          $set: {
            floor_id: item._id.floor_id,
            date: item._id.date,
            total_energy_kwh: Number(total.toFixed(4)),
            wasted_energy_kwh: Number(wasted.toFixed(4)),
            waste_ratio_percent: Number(wasteRatio.toFixed(2)),
            avg_current: Number((item.avg_current || 0).toFixed(4)),
            total_motion_count: item.total_motion_count || 0,
            avg_sound_peak: Number((item.avg_sound_peak || 0).toFixed(2)),
            rooms_count: item.rooms_count || 0,
            critical_rooms_count: item.critical_rooms_count || 0,
            warning_rooms_count: item.warning_rooms_count || 0
          }
        },
        { upsert: true }
      );
    }

    console.log(
      "daily_floor_summary count:",
      await DailyFloorSummary.countDocuments()
    );

    await mongoose.disconnect();
    console.log("Daily floor summary build complete.");
  } catch (error) {
    console.error("Error building daily floor summary:", error);
    process.exit(1);
  }
}

run();
