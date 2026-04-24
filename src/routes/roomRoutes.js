const express = require("express");
const {
  getLatestReading,
  getAvailableFloors,
  getAvailableRooms,
  getFloorOverview,
  getOwnerKpis,
  getOwnerAnomalies,
  getOwnerPatterns,
  getOwnerForecasts,
  getOwnerRoomsOverview,
  getOwnerAlerts,
  getOwnerWeekdayPatterns,
  deleteOwnerAlert,
  resolveOwnerAlert,
  getDailyEnergyHistory,
  getEnergyForecast,
  getWardenSummary,
  getWardenRoomsStatus,
  getWardenNoiseIssues,
  getWardenInspectionQueue,
  getWardenNoiseTrend,
  getWardenFeatureImportance,
  getWardenAnomalies,
  getWardenPatterns,
  getWardenForecasts,
  getWardenHistory,
  getWardenMlAlerts,
  getSecuritySummary,
  getSecuritySuspiciousRooms,
  getSecurityDoorEvents,
  getSecurityTrend,
  getSecurityAnomalies,
  getStudentOverview,
  getStudentEnergyHistory,
  getStudentRecentAlerts
} = require("../controllers/roomController");

const router = express.Router();

// shared
router.get("/available-floors", getAvailableFloors);
router.get("/available-rooms", getAvailableRooms);
router.get("/floors/overview", getFloorOverview);
router.get("/:roomId/latest-reading", getLatestReading);

// owner
router.get("/owner/rooms-overview", getOwnerRoomsOverview);
router.get("/owner/alerts", getOwnerAlerts);
router.get("/owner/anomalies", getOwnerAnomalies);
router.patch("/owner/alerts/:alertId/resolve", resolveOwnerAlert);
router.delete("/owner/alerts/:alertId", deleteOwnerAlert);
router.get("/owner/weekday-patterns", getOwnerWeekdayPatterns);
router.get("/:roomId/owner-kpis", getOwnerKpis);
router.get("/:roomId/energy/history", getDailyEnergyHistory);
router.get("/:roomId/energy/forecast", getEnergyForecast);
router.get("/owner/patterns", getOwnerPatterns);
router.get("/owner/forecasts", getOwnerForecasts);

// warden
router.get("/warden/summary", getWardenSummary);
router.get("/warden/rooms-status", getWardenRoomsStatus);
router.get("/warden/noise-issues", getWardenNoiseIssues);
router.get("/warden/inspection-queue", getWardenInspectionQueue);
router.get("/warden/noise-trend", getWardenNoiseTrend);
router.get("/warden/feature-importance", getWardenFeatureImportance);
router.get("/warden/anomalies", getWardenAnomalies);
router.get("/warden/patterns", getWardenPatterns);
router.get("/warden/forecasts", getWardenForecasts);
router.get("/warden/history", getWardenHistory);
router.get("/warden/ml-alerts", getWardenMlAlerts);

// security
router.get("/security/summary", getSecuritySummary);
router.get("/security/suspicious-rooms", getSecuritySuspiciousRooms);
router.get("/security/door-events", getSecurityDoorEvents);
router.get("/security/trend", getSecurityTrend);
router.get("/security/anomalies", getSecurityAnomalies);

// student
router.get("/student/:roomId/overview", getStudentOverview);
router.get("/student/:roomId/energy/history", getStudentEnergyHistory);
router.get("/student/:roomId/alerts", getStudentRecentAlerts);

module.exports = router;
