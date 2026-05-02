const { generateOwnerReply } = require("./ownerChatService");
const { generateSecurityReply } = require("./securityChatService");

async function chatByRole({ role, message, dashboardState }) {
  switch (role) {
    case "owner":
      return generateOwnerReply({ message, dashboardState });

    case "security":
      return generateSecurityReply({ message, dashboardState });

    case "warden":
    case "student":
      return {
        reply: `${role} chatbot is not implemented yet. Owner and security chatbots are currently available.`,
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
