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

// ── Search workspace ──────────────────────────────────────
async function searchWorkspace(query) {
  try {
    const res = await axios.get('https://slack.com/api/search.messages', {
      headers: { Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}` },
      params: { query, count: 10, sort: 'timestamp' },
    });
    const matches = res.data?.messages?.matches || [];
    return matches
      .map((m) => `[#${m.channel.name}] ${m.text.slice(0, 200)}`)
      .join('\n---\n');
  } catch (err) {
    console.error('Search error:', err.message);
    return '';
  }
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

  const searchResults = await searchWorkspace(role);

  const prompt = `You are an intelligent onboarding assistant for a new ${roleLabel} joining a Slack workspace.

Based on the following recent Slack messages, create a personalised onboarding briefing.

Recent workspace activity:
${searchResults || 'No recent messages found yet.'}

Write a briefing that includes:
1. A 2-3 sentence summary of what's currently happening relevant to a ${roleLabel}
2. 2-3 specific topics or projects they should know about
3. 2-3 types of people they should introduce themselves to (by role, not name)
4. 2-3 channels they should join
5. One piece of advice for their first week

Keep it warm, concise, and actionable. Use Slack markdown (bold with *asterisks*, bullets with •).`;

  try {
    const briefing = await askGroq(prompt);

    updateContext(userId, {
      briefingSent: true,
      topicsCovered: [role, 'initial briefing'],
    });

    await client.chat.postMessage({
      channel: userId,
      text: briefing,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `🧠 *Your personalised briefing:*\n\n${briefing}` },
        },
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
        },
      ],
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

  await client.chat.postMessage({
    channel: userId,
    text: `🔍 Searching the workspace for: "${question}"...`,
  });

  const searchResults = await searchWorkspace(question);

  const prompt = `You are an onboarding assistant for a new ${ctx.roleLabel || 'team member'} in a Slack workspace.

Their context:
- Role: ${ctx.roleLabel || 'Unknown'}
- Topics already covered: ${ctx.topicsCovered.join(', ') || 'None yet'}
- Previous questions: ${ctx.questionsAsked.slice(0, -1).join(', ') || 'None yet'}

Their question: "${question}"

Relevant workspace messages:
${searchResults || 'No relevant messages found.'}

Answer concisely. Do NOT repeat topics already covered. Use Slack markdown. End with one follow-up suggestion.`;

  try {
    const answer = await askGroq(prompt, 512);

    ctx.topicsCovered.push(question.slice(0, 50));
    updateContext(userId, { topicsCovered: ctx.topicsCovered });

    await client.chat.postMessage({
      channel: userId,
      text: answer,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: answer } },
      ],
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
  console.log('⚡ Stateful Role Onboard Agent is running!');
})();