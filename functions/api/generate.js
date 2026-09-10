// Cloudflare Pages Function — POST /api/generate
// Calls the Claude API server-side so ANTHROPIC_API_KEY never reaches the browser.
//
// This uses raw fetch() against the Messages API instead of the Anthropic SDK:
// Pages Functions here run with no build step / no package.json, so there's
// nothing to `npm install`. If this project ever grows a build step, switching
// to the official SDK (`@anthropic-ai/sdk`) would be a reasonable upgrade.

const MODEL = "claude-sonnet-5";

const PHYSICAL_GUIDANCE = `This is a physical, shippable item. The description can reference size, dimensions, and materials if the notes mention them. Lean the suggested_attributes toward material, primary_color, and size-relevant fields.`;

const DIGITAL_GUIDANCE = `This is a digital download — nothing is shipped. The description should mention instant download / file delivery where relevant. Also note in your own awareness (not required in the JSON) that Etsy digital listings don't support variations and must be listed separately from any physical version of the same design.`;

const SYSTEM_PROMPT = `You are an expert Etsy SEO copywriter. You will usually be shown a product photo along with free-text notes from the seller, but a photo won't always be provided — sometimes you'll only get text notes. When there's no photo, do not mention or assume you saw one; generate the best possible listing from the notes alone, inferring reasonable details only where the notes support it and leaving suggested_attributes fields null where you genuinely don't know.

Follow current Etsy guidance:
- Title: hard cap of 140 characters. Favor a short, clear, buyer-readable title over old-style keyword-stuffing. Put the most important keyword first. Don't repeat keywords. Don't pad the title to 140 characters just because you can.
- Tags: up to 13 tags, each hard-capped at 20 characters including spaces. Tags may include letters, numbers, spaces, apostrophes, hyphens, and accented characters. No word may repeat across the 13 tags (case-insensitive), ignoring common stopwords like "and", "for", "the", "with", "a", "an", "of". Each tag should target a distinct search phrase or word combination so the full tag set maximizes unique keyword coverage — do not use near-duplicate tags that just reorder or slightly reword the same idea.
  Example of what NOT to do: "handmade leather wallet" and "leather wallet for men" both repeat "leather" and "wallet" — that's a violation even though the phrases differ. Fix it by making the second tag target a different angle entirely, e.g. "mens bifold gift" or "fathers day gift".
  Before finalizing your output, mentally list all 13 tags together as a single set and scan them word-by-word for any word (other than a stopword) that shows up in more than one tag. If you find one, rewrite one of the offending tags to cover new ground instead.
- Description structure: open with 1-2 sentences stating what the item is and who it's for, working the primary keyword in naturally — this opening also doubles as the Google search snippet, so it has to read well completely on its own. Then, in short paragraphs, address what it's made of, its size or dimensions, and shipping or delivery timing. Weave keyword variations naturally through the body instead of repeating the title or tags verbatim. Save any warmth or personality for near the end, after the practical details are covered. Close with a brief, natural call to action, like inviting the buyer to message with questions before ordering.

Writing style (applies to both title and description) — write like a real seller describing their own product, not like ad copy generated from a template:
  - Never use em dashes.
  - Avoid generic marketing filler phrases like "elevate your space," "perfect for any occasion," or "look no further."
  - Don't stack three or more adjectives in a row.
  - Vary sentence length and structure — don't fall into a repetitive rhythm where every sentence has the same shape.

Example (fake product, for pattern reference only — don't reuse its wording or details):
  title: "Walnut Cutting Board with Juice Groove, Handmade Wood Serving Board for Kitchen"
  description: "This walnut cutting board brings a warm, natural centerpiece to any kitchen counter, built for home cooks who want something sturdy enough for daily chopping and nice enough to double as a serving board.\n\nEach board is hand-sanded from a single slab of black walnut, about 16 by 10 inches and just under an inch thick, so it has real heft without being awkward to lift one-handed. A shallow juice groove runs along one edge to catch drips from raw meat or citrus.\n\nBoards ship within 2 to 3 business days in a padded box, and each one gets a coat of food-safe mineral oil before it goes out so it's ready to use right away.\n\nNo two boards look quite alike since the grain pattern depends on where the wood was cut, which is part of what makes each one feel personal. Message me before ordering if you'd like to see the specific board's grain first."

Return STRICT JSON only. No markdown code fences, no preamble, no trailing commentary — just the JSON object, matching exactly this shape:

{
  "title": "string, under 140 characters",
  "description": "string, buyer-facing, concrete product facts in the first sentences",
  "tags": ["array of up to 13 strings, each under 20 characters"],
  "suggested_category": "string, best-guess Etsy category path, e.g. 'Home & Living > Storage & Organization'",
  "suggested_attributes": {
    "material": "string or null",
    "primary_color": "string or null",
    "who_its_for": "string or null",
    "occasion": "string or null",
    "style": "string or null"
  }
}`;

const TAG_DUPLICATE_STOPWORDS = new Set(["and", "for", "the", "with", "a", "an", "of"]);
const MAX_TAG_FIX_ATTEMPTS = 2;

function tagWords(tag) {
  return tag
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word && !TAG_DUPLICATE_STOPWORDS.has(word));
}

// Returns the list of words (excluding stopwords) that appear in more than
// one tag, case-insensitive. Empty array means the tag set is clean.
function findDuplicateTagWords(tags) {
  const tagCounts = new Map();
  for (const tag of tags) {
    for (const word of new Set(tagWords(tag))) {
      tagCounts.set(word, (tagCounts.get(word) || 0) + 1);
    }
  }
  return [...tagCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([word]) => word);
}

// Defensive: the prompt asks for raw JSON with no code fences, but models
// sometimes wrap it in ```json ... ``` anyway. Strip that before parsing.
function stripCodeFences(text) {
  let trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```[a-zA-Z]*\n?/, "");
    if (trimmed.endsWith("```")) {
      trimmed = trimmed.slice(0, -3);
    }
    trimmed = trimmed.trim();
  }
  return trimmed;
}

// Defensive: LLM output can look like valid JSON but still fail to parse
// because of raw control characters sitting unescaped inside string values
// (the most common cause of "looks valid but won't parse" JSON). Extract the
// { ... } body and strip anything in that range before handing it to
// JSON.parse.
function extractAndSanitizeJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = start !== -1 && end !== -1 && end > start ? text.slice(start, end + 1) : text;

  let result = "";
  let inString = false;
  let escaped = false;

  for (const char of candidate) {
    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
      } else if (char === "\\") {
        result += char;
        escaped = true;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else if (char === "\n") {
        result += "\\n";
      } else if (char === "\r") {
        result += "\\r";
      } else if (char === "\t") {
        result += "\\t";
      } else if (char.charCodeAt(0) < 0x20) {
        // other stray control chars inside a string — drop them
      } else {
        result += char;
      }
    } else {
      if (char === '"') inString = true;
      result += char;
    }
  }

  return result;
}

class ClaudeCallError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Sends `messages` to the Anthropic API and returns { listing, rawText }.
// Throws a ClaudeCallError (with an HTTP status) on any failure mode.
async function callClaudeForListing(env, messages) {
  let anthropicResponse;
  try {
    anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        output_config: { effort: "medium" },
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
  } catch {
    throw new ClaudeCallError("Couldn't reach Claude. Please try again.", 502);
  }

  if (!anthropicResponse.ok) {
    const errText = await anthropicResponse.text().catch(() => "");
    console.error("Anthropic API error:", anthropicResponse.status, errText);
    throw new ClaudeCallError("Claude couldn't generate a listing right now. Please try again.", 502);
  }

  const anthropicData = await anthropicResponse.json();

  if (anthropicData.stop_reason === "refusal") {
    throw new ClaudeCallError("Claude declined to generate copy for this image. Try a different photo or notes.", 422);
  }

  const textBlock = (anthropicData.content || []).find((block) => block.type === "text");
  if (!textBlock) {
    throw new ClaudeCallError("Claude returned an unexpected response. Please try again.", 502);
  }

  let listing;
  try {
    listing = JSON.parse(extractAndSanitizeJson(stripCodeFences(textBlock.text)));
  } catch (err) {
    console.error("Failed to parse Claude JSON:", err.message, textBlock.text);
    // TODO: remove the raw text + parse error from this response once the
    // fence-stripping / sanitization is confirmed reliable.
    throw new ClaudeCallError(`Claude's response wasn't valid JSON (${err.message}): ${textBlock.text}`, 502);
  }

  return { listing, rawText: textBlock.text };
}

export async function onRequestPost({ request, env }) {
  // NOTE: no per-user rate limiting yet — this endpoint is protected only by
  // Cloudflare Access. If usage/abuse becomes a concern, this is the place to
  // add throttling (e.g. Cloudflare Rate Limiting rules, or a KV-backed
  // per-IP/per-user counter checked at the top of this function).

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  const { image, notes, productType } = body;
  const hasImage = typeof image === "string" && image.startsWith("data:");
  const trimmedNotes = typeof notes === "string" ? notes.trim() : "";

  if (!hasImage && !trimmedNotes) {
    return jsonError("A product photo or some notes are required.", 400);
  }
  if (productType !== "physical" && productType !== "digital") {
    return jsonError("Product type must be 'physical' or 'digital'.", 400);
  }

  const userContent = [];

  if (hasImage) {
    const match = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/s);
    if (!match) {
      return jsonError("Couldn't read that image. Please try a different file.", 400);
    }
    const [, mediaType, base64Data] = match;
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64Data },
    });
  }

  const guidance = productType === "digital" ? DIGITAL_GUIDANCE : PHYSICAL_GUIDANCE;
  const notesText = trimmedNotes || "(no additional notes provided)";

  userContent.push({
    type: "text",
    text: `${guidance}\n\nSeller's notes:\n${notesText}\n\nReturn the JSON object described in your instructions, and nothing else.`,
  });

  if (!env.ANTHROPIC_API_KEY) {
    return jsonError("Server is missing its Anthropic API key.", 500);
  }

  const messages = [{ role: "user", content: userContent }];

  let listing;
  let rawText;
  try {
    ({ listing, rawText } = await callClaudeForListing(env, messages));

    // Safety net: the prompt asks Claude to keep tag words unique, but that
    // instruction isn't followed 100% reliably. Validate server-side and, if
    // duplicates slip through, ask Claude to fix just the tags array.
    for (let attempt = 0; attempt < MAX_TAG_FIX_ATTEMPTS; attempt++) {
      const duplicates = findDuplicateTagWords(Array.isArray(listing.tags) ? listing.tags : []);
      if (duplicates.length === 0) break;

      messages.push({ role: "assistant", content: rawText });
      messages.push({
        role: "user",
        content: `Your "tags" array repeats these word(s) across more than one tag: ${duplicates.join(", ")}. Rewrite ONLY the "tags" array so no word (other than a common stopword) repeats across any tag — keep every other field exactly as before. Return the full JSON object in the same strict format described earlier, and nothing else.`,
      });

      ({ listing, rawText } = await callClaudeForListing(env, messages));
    }
    // If duplicates still remain after MAX_TAG_FIX_ATTEMPTS, we just return
    // the last listing we got rather than looping forever.
  } catch (err) {
    if (err instanceof ClaudeCallError) {
      return jsonError(err.message, err.status);
    }
    throw err;
  }

  return new Response(JSON.stringify(listing), {
    headers: { "content-type": "application/json" },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
