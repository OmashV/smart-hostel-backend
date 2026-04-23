const groq = require("./groqClient");
const {
  getFloorOverview,
  getRoomsOverview,
  getTopWasteRoomsToday,
  getRoomDetail
} = require("./ownerChatTools");

const TOOL_IMPL = {
  get_floor_overview: getFloorOverview,
  get_rooms_overview: getRoomsOverview,
  get_top_waste_rooms_today: getTopWasteRoomsToday,
  get_room_detail: getRoomDetail
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_floor_overview",
      description:
        "Get latest floor-wise energy and waste comparison for the owner dashboard.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Optional summary date in YYYY-MM-DD format"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_rooms_overview",
      description:
        "Get latest room-wise overview for all rooms or for a selected floor.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          },
          date: {
            type: "string",
            description: "Optional summary date in YYYY-MM-DD format"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_top_waste_rooms_today",
      description:
        "Find the highest wasted-energy rooms for the latest summary date, optionally filtered by floor.",
      parameters: {
        type: "object",
        properties: {
          floorId: {
            type: "string",
            description: 'Floor id like "A-Floor-1" or "all"'
          },
          limit: {
            type: "number",
            description: "Number of rooms to return"
          },
          date: {
            type: "string",
            description: "Optional summary date in YYYY-MM-DD format"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_room_detail",
      description:
        "Get detailed history, alerts, anomalies, and forecast for one room.",
      parameters: {
        type: "object",
        properties: {
          roomId: {
            type: "string",
            description: "Room id like A101 or A202"
          }
        },
        required: ["roomId"]
      }
    }
  }
];

function systemPrompt() {
  return `
You are a Smart Hostel dashboard analytics assistant for the OWNER role.

Your job:
1. Answer natural language questions about the dashboard data.
2. Help the user explore the dashboard.
3. Explain trends, comparisons, anomalies, and forecasts.
4. Support decision-oriented questions using the provided tool results.

Rules:
- Always use tools when data is needed.
- Never claim that only one room exists unless the tool result actually shows only one room.
- Never invent values.
- If navigation would help, include action lines exactly like:
ACTION: switch_floor=A-Floor-1
ACTION: switch_room=A201
- Ignore null or missing IDs in navigation suggestions.
- Be clear and practical.
`;
}

async function generateOwnerReply({ message, dashboardState }) {
  const floorId = dashboardState?.floorId || "all";
  const roomId = dashboardState?.roomId || "all";

  const messages = [
    {
      role: "system",
      content: systemPrompt()
    },
    {
      role: "user",
      content: `Current dashboard state:
floorId=${floorId}
roomId=${roomId}

User question:
${message}`
    }
  ];

  const firstResponse = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0.1,
    messages,
    tools: TOOLS,
    tool_choice: "auto"
  });

  const assistantMessage = firstResponse.choices?.[0]?.message;

  if (!assistantMessage) {
    return {
      reply: "I could not generate a response.",
      context_used: {}
    };
  }

  if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
    return {
      reply: assistantMessage.content || "I could not generate a response.",
      context_used: {}
    };
  }

  messages.push(assistantMessage);

  const toolResults = {};

  for (const toolCall of assistantMessage.tool_calls) {
    const toolName = toolCall.function.name;
    const rawArgs = toolCall.function.arguments || "{}";
    let parsedArgs = {};

    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      parsedArgs = {};
    }

    if (toolName === "get_rooms_overview" && !parsedArgs.floorId) {
      parsedArgs.floorId = floorId;
    }

    if (toolName === "get_top_waste_rooms_today" && !parsedArgs.floorId) {
      parsedArgs.floorId = floorId;
    }

    if (toolName === "get_room_detail" && !parsedArgs.roomId && roomId !== "all") {
      parsedArgs.roomId = roomId;
    }

    const impl = TOOL_IMPL[toolName];
    if (!impl) continue;

    const result = await impl(parsedArgs);
    toolResults[toolName] = result;

    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(result)
    });
  }

  const finalResponse = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0.2,
    messages
  });

  return {
    reply:
      finalResponse.choices?.[0]?.message?.content ||
      "I could not generate a response.",
    context_used: toolResults
  };
}

module.exports = {
  generateOwnerReply
};
