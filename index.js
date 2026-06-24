require('dotenv').config();
const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');

// ── Clients ──────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── In-memory context store ───────────────────────────────
const contextStore = {};

function getContext(userId) {
  if (!contextStore[userId]) {
    contextStore[userId] = {
      userId,
      role: null,
      roleLabel: null,
      joinedAt: new Date().toISOString(),
      topicsCovered: [],
      questionsAsked: [],
      briefingSent: false,
    };
  }
  return contextStore[userId];
}

function updateContext(userId, updates) {
  contextStore[userId] = { ...getContext(userId), ...updates };
}

// ── Role selection buttons ────────────────────────────────
const roleButtons = [
  { text: '⚙️ Engineer', value: 'engineer', action_id: 'role_engineer' },
  { text: '📋 Product Manager', value: 'pm', action_id: 'role_pm' },
  { text: '🎨 Designer', value: 'designer', action_id: 'role_designer' },
  { text: '📊 Other', value: 'other', action_id: 'role_other' },
];

function buildRoleBlock(headerText) {
  return {
    text: headerText,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: headerText },
      },
      {
        type: 'actions',
        block_id: 'role_selection',
        elements: roleButtons.map((r) => ({
          type: 'button',
          text: { type: 'plain_text', text: r.text },
          value: r.value,
          action_id: r.action_id,
        })),
      },
    ],
  };
}

// ── Role → search expansion ───────────────────────────────
// RTS supports the OR operator natively. Expanding a bare role into
// related terms gives the search far better recall than the literal
// role word alone, and is a real (not cosmetic) use of RTS query syntax.
const roleSearchTerms = {
  engineer: 'engineering OR backend OR infrastructure OR deployment OR architecture',
  pm: 'roadmap OR product OR launch OR prioritization OR planning',
  designer: 'design OR UX OR figma OR prototype OR user research',
  other: 'onboarding OR team OR projects OR goals',
};

// Turn a raw query into a natural-language question when it isn't
// already one. RTS triggers semantic search only when the query begins
// with a question word or ends in "?" — bare keyword queries always
// fall back to keyword search. This nudges /ask toward semantic retrieval
// when it's likely to help, without forcing it on queries that are
// already well-formed keyword/OR searches.
function asSemanticQuery(raw) {
  const trimmed = raw.trim();
  const looksLikeQuestion =
    /^(what|who|where|when|why|how|did|does|is|are|can|could|should)\b/i.test(trimmed) ||
    trimmed.endsWith('?');
  const hasOrOperator = /\bOR\b/.test(trimmed);

  if (looksLikeQuestion || hasOrOperator) return trimmed;
  return `What is the latest on ${trimmed}?`;
}

// ── Real-time Search API (assistant.search.context) ──────
// Uses the xoxp- user token. User-token calls do not require an
// action_token (bot-token calls do, and /ask as a slash command has
// no event-sourced action_token available, so user token is the
// correct choice here, not just the simpler one).
const RTS_URL = 'https://slack.com/api/assistant.search.context';

async function rtsSearch({ query, contentTypes = ['messages'], limit = 10, includeContext = false }) {
  try {
    const res = await axios.post(
      RTS_URL,
      {
        query,
        content_types: contentTypes,
        channel_types: ['public_channel', 'private_channel'],
        include_context_messages: includeContext,
        limit,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
      }
    );

    if (!res.data.ok) {
      console.error('RTS error:', res.data.error);
      return null;
    }
    return res.data.results;
  } catch (err) {
    console.error('RTS request failed:', err.response?.data || err.message);
    return null;
  }
}

// Formats message results into prompt-ready text AND keeps permalinks
// separately so we can cite sources back to the user — Slack's own
// guidelines call out sourcing/citations as expected behavior for
// RTS-backed apps.
function formatMessageResults(messages = []) {
  if (!messages.length) return { promptText: 'No relevant messages found.', sources: [] };

  const sources = [];
  const blocks = messages.map((m, i) => {
    sources.push({ channel: m.channel_name, permalink: m.permalink });

    let entry = `[${i + 1}] #${m.channel_name} — ${m.author_name}: ${m.content}`;

    if (m.context_messages?.before?.length) {
      const before = m.context_messages.before
        .map((c) => `    (before) ${c.author_name}: ${c.text}`)
        .join('\n');
      entry += `\n${before}`;
    }
    if (m.context_messages?.after?.length) {
      const after = m.context_messages.after
        .map((c) => `    (after) ${c.author_name}: ${c.text}`)
        .join('\n');
      entry += `\n${after}`;
    }
    return entry;
  });

  return { promptText: blocks.join('\n---\n'), sources };
}

function formatSourcesBlock(sources) {
  if (!sources.length) return null;
  const lines = sources
    .slice(0, 5)
    .map((s, i) => `${i + 1}. <${s.permalink}|#${s.channel}>`)
    .join('\n');
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `📎 *Sources:*\n${lines}` }],
  };
}

// Real people/channel discovery — replaces the LLM-guessed "types of
// people to meet" with actual users and channels surfaced by RTS.
// NOTE: in sparse sandboxes (few members, little channel topic/activity
// history) this can legitimately return empty arrays even when message
// search works fine for the same query — this is expected RTS behavior,
// not a bug. The downstream prompt is built to handle that gracefully.
async function discoverPeopleAndChannels(roleLabel) {
  const results = await rtsSearch({
    query: roleSearchTerms[Object.keys(roleSearchTerms).find(
      (k) => roleLabel.toLowerCase().includes(k)
    ) || 'other'],
    contentTypes: ['users', 'channels'],
    limit: 8,
  });

  if (!results) return { users: [], channels: [] };
  return {
    users: results.users || [],
    channels: results.channels || [],
  };
}

// ── Ask Groq ──────────────────────────────────────────────
async function askGroq(prompt, maxTokens = 1024) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.choices[0].message.content;
}

// ── Step 1: New member joined ─────────────────────────────
app.event('member_joined_channel', async ({ event, client }) => {
  const userId = event.user;
  const ctx = getContext(userId);
  if (ctx.briefingSent) return;

  try {
    await client.chat.postMessage({
      channel: userId,
      ...buildRoleBlock(
        `👋 *Welcome to the workspace!*\n\nI'm your onboarding assistant. I'll learn what you need to know and make sure you're not told the same thing twice.\n\n*First — what's your role?*`
      ),
    });
  } catch (err) {
    console.error('Welcome DM error:', err.message);
  }
});

// ── Step 2: Role selected → generate briefing ─────────────
async function handleRoleSelection(role, roleLabel, body, client) {
  const userId = body.user.id;
  updateContext(userId, { role, roleLabel });

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `Got it — you're a *${roleLabel}*! Pulling together your briefing... ⏳`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Got it — you're a *${roleLabel}*! Pulling together your briefing... ⏳`,
        },
      },
    ],
  });

  const searchTerms = roleSearchTerms[role] || roleSearchTerms.other;

  const [messageResults, discovery] = await Promise.all([
    rtsSearch({ query: searchTerms, contentTypes: ['messages'], limit: 10, includeContext: true }),
    discoverPeopleAndChannels(roleLabel),
  ]);

  const { promptText, sources } = formatMessageResults(messageResults?.messages);

  const peopleList = discovery.users
    .slice(0, 5)
    .map((u) => `${u.full_name}${u.title ? ` (${u.title})` : ''}`)
    .join(', ') || 'No specific matches found yet';

  const channelList = discovery.channels
    .slice(0, 5)
    .map((c) => `#${c.name}`)
    .join(', ') || 'No specific matches found yet';

  const prompt = `You are an intelligent onboarding assistant for a new ${roleLabel} joining a Slack workspace.

Based on the following recent Slack messages (with surrounding context where available), create a personalised onboarding briefing.

Recent workspace activity:
${promptText}

Real people relevant to this role, found via workspace search: ${peopleList}
Real channels relevant to this role, found via workspace search: ${channelList}

Write a briefing that includes:
1. A 2-3 sentence summary of what's currently happening relevant to a ${roleLabel}
2. 2-3 specific topics or projects they should know about, grounded in the messages above
3. Name-check 2-3 of the real people listed above and why they're worth introducing yourself to (use the actual names given, do not invent people)
4. Recommend 2-3 of the real channels listed above (use the actual channel names given, do not invent channels)
5. One piece of advice for their first week

Keep it warm, concise, and actionable. Use Slack markdown (bold with *asterisks*, bullets with •). If no real people/channels were found, say so honestly instead of making something up.`;

  try {
    const briefing = await askGroq(prompt);

    updateContext(userId, {
      briefingSent: true,
      topicsCovered: [role, 'initial briefing'],
    });

    const sourcesBlock = formatSourcesBlock(sources);
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🧠 *Your personalised briefing:*\n\n${briefing}` },
      },
    ];
    if (sourcesBlock) blocks.push(sourcesBlock);
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `💬 Use \`/ask\` anytime to search the workspace. Example: \`/ask what's the engineering team working on?\``,
        },
      },
      {
        type: 'actions',
        block_id: 'followup_actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔄 Refresh my briefing' },
            value: 'refresh',
            action_id: 'refresh_briefing',
          },
        ],
      }
    );

    await client.chat.postMessage({
      channel: userId,
      text: briefing,
      blocks,
    });
  } catch (err) {
    console.error('Briefing error:', err.message);
  }
}

// ── Step 3: /ask slash command ────────────────────────────
app.command('/ask', async ({ command, ack, client }) => {
  await ack();

  const userId = command.user_id;
  const question = command.text?.trim();
  const ctx = getContext(userId);

  if (!question) {
    await client.chat.postMessage({
      channel: userId,
      text: `Please include a question. Example: \`/ask what is the engineering team working on?\``,
    });
    return;
  }

  ctx.questionsAsked.push(question);
  updateContext(userId, { questionsAsked: ctx.questionsAsked });

  const semanticQuery = asSemanticQuery(question);

  await client.chat.postMessage({
    channel: userId,
    text: `🔍 Searching the workspace for: "${question}"...`,
  });

  const results = await rtsSearch({
    query: semanticQuery,
    contentTypes: ['messages'],
    limit: 10,
    includeContext: true,
  });

  const { promptText, sources } = formatMessageResults(results?.messages);

  const prompt = `You are an onboarding assistant for a new ${ctx.roleLabel || 'team member'} in a Slack workspace.

Their context:
- Role: ${ctx.roleLabel || 'Unknown'}
- Topics already covered: ${ctx.topicsCovered.join(', ') || 'None yet'}
- Previous questions: ${ctx.questionsAsked.slice(0, -1).join(', ') || 'None yet'}

Their question: "${question}"

Relevant workspace messages (numbered, with surrounding context where available):
${promptText}

Answer concisely. Reference message numbers like [1] when you draw on a specific result. Do NOT repeat topics already covered. Use Slack markdown. End with one follow-up suggestion.`;

  try {
    const answer = await askGroq(prompt, 512);

    ctx.topicsCovered.push(question.slice(0, 50));
    updateContext(userId, { topicsCovered: ctx.topicsCovered });

    const sourcesBlock = formatSourcesBlock(sources);
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: answer } }];
    if (sourcesBlock) blocks.push(sourcesBlock);

    await client.chat.postMessage({
      channel: userId,
      text: answer,
      blocks,
    });
  } catch (err) {
    console.error('/ask error:', err.message);
  }
});

// ── Refresh briefing button ───────────────────────────────
app.action('refresh_briefing', async ({ ack, body, client }) => {
  await ack();
  updateContext(body.user.id, { briefingSent: false, topicsCovered: [] });
  await client.chat.postMessage({
    channel: body.user.id,
    ...buildRoleBlock(`🔄 *Let's refresh your briefing!*\n\nWhat's your role?`),
  });
});

// ── Role button handlers ──────────────────────────────────
const roleMap = {
  role_engineer: ['engineer', 'Engineer'],
  role_pm: ['product manager', 'Product Manager'],
  role_designer: ['design', 'Designer'],
  role_other: ['general onboarding', 'New Member'],
};

Object.entries(roleMap).forEach(([actionId, [role, roleLabel]]) => {
  app.action(actionId, async ({ body, client, ack }) => {
    await ack();
    await handleRoleSelection(role, roleLabel, body, client);
  });
});

// ── Start ─────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('⚡ TeamTrail is running!');
})();