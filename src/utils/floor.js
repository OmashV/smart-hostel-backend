function getFloorIdFromRoomId(roomId) {
  if (!roomId || typeof roomId !== "string") return "Unknown";

  const cleaned = roomId.trim().toUpperCase();
  const blockMatch = cleaned.match(/^[A-Z]/);
  const digitsMatch = cleaned.match(/\d+/);

  if (!blockMatch || !digitsMatch) return "Unknown";

  const block = blockMatch[0];
  const digits = digitsMatch[0];
  const floorNumber = digits.charAt(0);

  return `${block}-Floor-${floorNumber}`;
}

module.exports = { getFloorIdFromRoomId };
