import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { loadConversation, saveConversation, type ConversationMessage } from "../db.js";
import { getSystemPrompt } from "./systemPrompt.js";
import { toolDefinitions, runTool } from "./tools.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MAX_TOOL_ITERATIONS = 5;

/**
 * Runs one turn of the concierge agent for a given guest phone number:
 * loads their conversation history, sends the new message to Claude along
 * with the booking tools, executes any tool calls Claude makes, and returns
 * the final text reply to send back over SMS.
 */
export async function runAgent(phone: string, incomingText: string): Promise<string> {
  const history = loadConversation(phone);
  const messages: Anthropic.MessageParam[] = [
    ...(history as Anthropic.MessageParam[]),
    { role: "user", content: incomingText },
  ];

  let finalText = "Sorry, I'm having trouble right now — someone from our team will follow up shortly.";
  const channel: "sms" | "web" = phone.startsWith("web:") ? "web" : "sms";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: config.claudeModel,
      max_tokens: 1024,
      system: getSystemPrompt(channel),
      tools: toolDefinitions,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      // For an SMS conversation, `phone` (the channel id this function was
      // called with) already IS the guest's real number — force it onto the
      // tool input so the model can't hallucinate or mistype it. For the
      // web widget, `phone` is just "web:<uuid>", not a real number, so
      // leave whatever actual phone number the model collected from the
      // guest during the conversation untouched — that's the one that gets
      // texted the payment/booking confirmation.
      const input =
        (block.name === "start_booking" || block.name === "flag_for_human") && channel !== "web"
          ? { ...(block.input as any), phone }
          : block.input;
      const result = await runTool(block.name, input, phone);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  saveConversation(phone, messages as unknown as ConversationMessage[]);
  return finalText || "Got it, thanks! Let me get back to you on that.";
}
