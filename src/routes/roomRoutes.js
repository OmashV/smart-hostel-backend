const express = require("express");
const {
  getLatestReading,
  getOwnerKpis,
  getOwnerFeatureImportance,
  getOwnerAnomalies,
  getOwnerPatterns,
  getOwnerForecasts,
  getOwnerRoomsOverview,
  getOwnerAlerts,
  getDailyEnergyHistory,
  getTopWasteDays,
  getEnergyForecast,
  getWardenSummary,
  getWardenRoomsStatus,
  getWardenNoiseIssues,
  getSecuritySummary,
  getSecuritySuspiciousRooms,
  getSecurityDoorEvents,
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentRecentAlerts
} = require("../controllers/roomController");

const router = express.Router();

// shared
router.get("/:roomId/latest-reading", getLatestReading);

// owner
router.get("/:roomId/owner-kpis", getOwnerKpis);
router.get("/:roomId/energy/history", getDailyEnergyHistory);
router.get("/:roomId/energy/top-waste-days", getTopWasteDays);
router.get("/:roomId/energy/forecast", getEnergyForecast);
router.get("/owner/feature-importance", getOwnerFeatureImportance);
router.get("/owner/anomalies", getOwnerAnomalies);
router.get("/owner/patterns", getOwnerPatterns);
router.get("/owner/forecasts", getOwnerForecasts);
router.get("/owner/rooms-overview", getOwnerRoomsOverview);
router.get("/owner/alerts", getOwnerAlerts);

// warden
router.get("/warden/summary", getWardenSummary);
router.get("/warden/rooms-status", getWardenRoomsStatus);
router.get("/warden/noise-issues", getWardenNoiseIssues);

// security
router.get("/security/summary", getSecuritySummary);
router.get("/security/suspicious-rooms", getSecuritySuspiciousRooms);
router.get("/security/door-events", getSecurityDoorEvents);

// student
router.get("/student/:roomId/overview", getStudentOverview);
router.get("/student/:roomId/energy/history", getStudentEnergyHistory);
router.get("/student/:roomId/alerts", getStudentRecentAlerts);

module.exports = router;