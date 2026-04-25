// utils/securityReadingSource.js
const SensorReading       = require("../models/SensorReading");
const DemoSecurityReading = require("../models/DemoSecurityReading");

const REAL_ROOM = "A101";   // only this room uses real sensorreadings

/**
 * Returns the right model and an optional roomId filter
 * based on whether the requested room is real or demo.
 *
 * Usage:
 *   const { model, query } = getSecuritySource(roomId);
 *   await model.find(query)
 */
function getSecuritySource(roomId) {
  // Specific room requested
  if (roomId) {
    return {
      model:   roomId === REAL_ROOM ? SensorReading : DemoSecurityReading,
      roomFilter: { room_id: roomId }
    };
  }

  // "All rooms" — need to query both and merge
  return { model: null, roomFilter: null, isMerged: true };
}

module.exports = { getSecuritySource, REAL_ROOM };