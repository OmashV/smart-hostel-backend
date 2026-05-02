const mongoose = require("mongoose");

const SecurityPatternSchema = new mongoose.Schema(
  {
    room_id: { type: String, required: true, index: true },
    captured_at: { type: Date, required: true, index: true },
    behavior_profile: { type: String, default: null },
    cluster_label: { type: Number, default: null },
    door_stable_min: { type: Number, default: null },
    hour: { type: Number, default: null },
    is_after_hours: { type: Boolean, default: false },
    is_empty: { type: Boolean, default: false },
    model_name: { type: String, default: null },
    motion_count: { type: Number, default: null },
    pattern_name: { type: String, default: null }
  },
  { timestamps: true }
);

SecurityPatternSchema.index({ room_id: 1, captured_at: 1 }, { unique: true });

module.exports = mongoose.model("SecurityPattern", SecurityPatternSchema, "security_patterns");
