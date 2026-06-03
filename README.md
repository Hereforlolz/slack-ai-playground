# Slack Role Onboard Agent

A stateful AI-powered onboarding agent for Slack. When a new member joins a workspace, the agent detects their role, searches workspace history in real time, and generates a personalised briefing using LLaMA 3.3 via Groq.

## Features
- Detects new members joining channels
- Role-aware onboarding (Engineer, PM, Designer)
- Real-time Slack workspace search
- AI-generated personalised briefing
- Stateful context — tracks what each user has been told and never repeats it
- `/ask` slash command for follow-up questions anytime

## Tech Stack
- Slack Bolt for JavaScript
- Groq API (LLaMA 3.3 70B)
- Slack Real-time Search API
- Socket Mode (no public URL needed)
- In-memory context store (Redis-pattern)

## Setup
1. Clone the repo
2. Run `npm install`
3. Create a `.env` file with:
        SLACK_BOT_TOKEN=xoxb-...
        SLACK_USER_TOKEN=xoxp-...
        SLACK_SIGNING_SECRET=...
        SLACK_APP_TOKEN=xapp-...
        GROQ_API_KEY=...
        PORT=3000
4. Run `node index.js`

## Hackathon
Built for the Slack Agent Builder Challenge 2026.
