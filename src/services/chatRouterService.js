const { generateOwnerReply } = require("./ownerChatService");

async function chatByRole({ role, message, dashboardState }) {
  switch (role) {
    case "owner":
      return generateOwnerReply({ message, dashboardState });

    case "warden":
    case "student":
    case "security":
      return {
        reply: `${role} chatbot is not implemented yet. Owner chatbot is currently available.`,
        actions: []
      };

    default:
      return {
        reply: "Unknown role provided.",
        actions: []
      };
  }
}

module.exports = {
  chatByRole
};
