const mongoose = require("mongoose");

const OwnerFeatureImportanceSchema = new mongoose.Schema(
  {
    feature: { type: String, required: true },
    importance: { type: Number, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "OwnerFeatureImportance",
  OwnerFeatureImportanceSchema,
  "owner_feature_importance"
);