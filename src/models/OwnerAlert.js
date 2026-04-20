const mongoose = require("mongoose");

const OwnerAlertSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },

    severity: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    reason: { type: String, default: "" },

    source: { type: String, default: "anomaly" },
    status: { type: String, default: "active" }, // active, resolved
    is_deleted: { type: Boolean, default: false }
  },
  { timestamps: true }
);

OwnerAlertSchema.index({ room_id: 1, date: 1, title: 1 }, { unique: true });

module.exports = mongoose.model("OwnerAlert", OwnerAlertSchema, "owner_alerts");
