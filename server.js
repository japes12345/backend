require("dotenv").config();

const crypto = require("node:crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { google } = require("googleapis");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const twilio = require("twilio");

const app = express();
const port = process.env.PORT || 3000;
const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;

const required = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.warn(`Donna is missing optional runtime configuration: ${missing.join(", ")}`);
}

const supabase = createClient(process.env.SUPABASE_URL || "http://localhost", process.env.SUPABASE_SERVICE_ROLE_KEY || "missing");
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
app.use(express.static("public"));

function googleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

function getGoogleAuthUrl() {
  const state = crypto.randomBytes(24).toString("hex");
  const client = googleOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state,
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
  });
}

async function getGoogleProfile(auth) {
  const oauth2 = google.oauth2({ version: "v2", auth });
  const { data } = await oauth2.userinfo.get();
  return data;
}

async function upsertUser(profile, tokens) {
  const { data, error } = await supabase
    .from("users")
    .upsert({
      google_id: profile.id,
      email: profile.email,
      full_name: profile.name,
      avatar_url: profile.picture,
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token,
      google_token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "google_id" })
    .select("id,email,full_name")
    .single();

  if (error) throw error;
  return data;
}

async function getUpcomingMeetings(user) {
  const auth = googleOAuthClient();
  auth.setCredentials({ refresh_token: user.google_refresh_token, access_token: user.google_access_token });
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const inSixMinutes = new Date(now.getTime() + 6 * 60 * 1000);
  const { data } = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: inSixMinutes.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 10,
  });

  return (data.items || []).filter((event) => {
    const start = new Date(event.start?.dateTime || event.start?.date);
    const minutesUntil = (start.getTime() - now.getTime()) / 60000;
    return minutesUntil >= 4 && minutesUntil <= 6 && (event.attendees || []).some((attendee) => attendee.email !== user.email);
  });
}

async function fetchPriorEmailSummary(user, attendeeEmail) {
  const auth = googleOAuthClient();
  auth.setCredentials({ refresh_token: user.google_refresh_token, access_token: user.google_access_token });
  const gmail = google.gmail({ version: "v1", auth });
  const query = `(from:${attendeeEmail} OR to:${attendeeEmail}) newer_than:3y`;
  const { data } = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 10 });
  const messages = await Promise.all((data.messages || []).slice(0, 10).map(async (message) => {
    const detail = await gmail.users.messages.get({ userId: "me", id: message.id, format: "metadata", metadataHeaders: ["Subject", "Date"] });
    const headers = detail.data.payload?.headers || [];
    return {
      subject: headers.find((header) => header.name === "Subject")?.value || "(no subject)",
      date: headers.find((header) => header.name === "Date")?.value || "",
      snippet: detail.data.snippet || "",
    };
  }));

  if (!messages.length) return "No prior email history found in the last 3 years.";
  return messages.map((message) => `- ${message.date}: ${message.subject} — ${message.snippet}`).join("\n");
}

function attendeeName(attendee) {
  return attendee.displayName || attendee.email?.split("@")[0]?.replace(/[._-]/g, " ") || "Meeting guest";
}

async function buildBrief({ user, event, attendee, emailSummary }) {
  const person = attendeeName(attendee);
  const prompt = `Create a concise SMS meeting-prep brief for a salesperson/executive.\nMeeting: ${event.summary || "Untitled"}\nPerson: ${person} <${attendee.email}>\nPrior email context:\n${emailSummary}\n\nReturn plain text under 1200 characters with:\n- First Last\n- Age: estimate if unknown\n- Profession\n- Prior communication summary\n- Background bullets\n- Commercial estimate: business/funding/revenue/online relevance, clearly mark estimates\n- 3 questions to ask`;

  if (!openai) {
    return `Donna AI prep\n${person}\nAge: Unknown (estimate unavailable)\nProfession: Review LinkedIn/company before meeting\nPrior communication: ${emailSummary.split("\n").slice(0, 2).join(" ")}\nBackground: Calendar attendee ${attendee.email}\nCommercial estimate: Add OpenAI key for enriched estimates.\nQuestions: 1) What outcome would make this meeting useful? 2) What changed recently in your business? 3) Where can we remove friction?`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return response.choices[0]?.message?.content?.trim() || "Donna could not generate a brief for this meeting.";
}

async function sendSms(to, body) {
  if (!twilioClient || !process.env.TWILIO_FROM_NUMBER) {
    console.log(`SMS skipped for ${to}:\n${body}`);
    return { skipped: true };
  }

  return twilioClient.messages.create({ to, from: process.env.TWILIO_FROM_NUMBER, body });
}

app.get("/api/config", (_req, res) => {
  res.json({ googleAuthUrl: getGoogleAuthUrl(), supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY });
});

app.get("/auth/google", (_req, res) => {
  res.redirect(getGoogleAuthUrl());
});

app.get("/auth/google/callback", async (req, res, next) => {
  try {
    const client = googleOAuthClient();
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);
    const profile = await getGoogleProfile(client);
    const user = await upsertUser(profile, tokens);
    res.redirect(`/onboarding.html?user=${encodeURIComponent(user.id)}`);
  } catch (error) {
    next(error);
  }
});

app.post("/api/users/:id/preferences", async (req, res, next) => {
  try {
    const { phone, timezone = "UTC" } = req.body;
    if (!phone) return res.status(400).json({ error: "phone is required" });
    const { data, error } = await supabase
      .from("users")
      .update({ phone, timezone, subscription_status: "trialing", updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select("id,email,phone,timezone,subscription_status")
      .single();
    if (error) throw error;
    res.json({ user: data });
  } catch (error) {
    next(error);
  }
});

app.all("/api/cron/meeting-briefs", async (req, res, next) => {
  try {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const { data: users, error } = await supabase
      .from("users")
      .select("*")
      .not("phone", "is", null)
      .in("subscription_status", ["active", "trialing"]);
    if (error) throw error;

    const sent = [];
    for (const user of users || []) {
      const meetings = await getUpcomingMeetings(user);
      for (const event of meetings) {
        const attendees = (event.attendees || []).filter((attendee) => attendee.email && attendee.email !== user.email);
        const attendee = attendees[0];
        if (!attendee) continue;
        const dedupeKey = `${user.id}:${event.id}:${attendee.email}`;
        const { data: existing } = await supabase.from("brief_logs").select("id").eq("dedupe_key", dedupeKey).maybeSingle();
        if (existing) continue;
        const emailSummary = await fetchPriorEmailSummary(user, attendee.email);
        const brief = await buildBrief({ user, event, attendee, emailSummary });
        await sendSms(user.phone, brief);
        await supabase.from("brief_logs").insert({ user_id: user.id, event_id: event.id, attendee_email: attendee.email, dedupe_key: dedupeKey, body: brief });
        sent.push({ user: user.email, event: event.summary, attendee: attendee.email });
      }
    }

    res.json({ sent });
  } catch (error) {
    next(error);
  }
});

app.get("/hello", (_req, res) => res.send("Hello from Donna AI."));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Internal Server Error" });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Donna AI server running at ${baseUrl}`);
  });
}

module.exports = app;
