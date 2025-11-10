import express from "express";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 10000;
const PROCESSOR_TOKEN = process.env.PROCESSOR_TOKEN || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";

// tiny Slack helper (safe if token missing)
async function slackPost(token, payload){
  if(!token) return;
  await fetch("https://slack.com/api/chat.postMessage", {
    method:"POST",
    headers:{ "Authorization": `Bearer ${token}`, "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  });
}


// Capture raw body so HMAC matches the Worker’s exact JSON string
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

function hmacHex(key, msgUtf8) {
  return crypto.createHmac("sha256", key).update(msgUtf8, "utf8").digest("hex");
}

function timingSafeEq(a, b) {
  try {
    const A = Buffer.from(a);
    const B = Buffer.from(b);
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch { return false; }
}

function isAuthorized(req) {
  // Option 1: Bearer token
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearer && bearer === PROCESSOR_TOKEN) return true;

  // Option 2: HMAC header (raw hex, no v0=)
  const sig = req.headers["x-isolator-signature"];
  if (sig && req.rawBody && PROCESSOR_TOKEN) {
    const want = hmacHex(PROCESSOR_TOKEN, req.rawBody.toString("utf8"));
    if (timingSafeEq(String(sig), want)) return true;
  }
  return false;
}

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Intake (root path "/")
app.post("/", async (req, res) => {
  if (!isAuthorized(req)) {
    console.log("AUTH FAIL");
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const { mode, url, title, channel, thread_ts } = req.body || {};
  console.log("INTAKE", { mode, url, title, channel, thread_ts });

  // Fast ACK so Worker can show 200
  res.json({ ok: true, intake: true, mode, url, title });

  // ↓ Do your actual processing after ACK (don’t await)
  try {
    // Example: download audio via yt_dlp (python module)
    const outFile = "/tmp/source.m4a";
    await new Promise((resolve, reject) => {
      const p = execFile("python3", ["-m", "yt_dlp",
        "-f", "bestaudio/best",
        "-x", "--audio-format", "m4a",
        "-o", outFile, url
      ], { env: process.env }, (err, stdout, stderr) => {
        if (err) { console.error(err); reject(err); return; }
        console.log(stdout || stderr || "yt_dlp done");
        resolve();
      });
    });

    console.log("DOWNLOADED", outFile);

    // TODO: run Demucs here as you already wired up
    // log something visible so you know it’s moving:
    console.log("DEMUX START", outFile);

  // === after demucs completes and you know where the files are ===
  // Placeholder paths until Demucs output wiring is finished:
  const outDir = "/tmp"; // change to your real Demucs output dir
  const vocalOut = path.join(outDir, "vocals.wav");
  const instrOut = path.join(outDir, "no_vocals.wav");

  // Log for Render
  console.log("DEMUX DONE", { vocalOut, instrOut });

  // Optional: notify Slack thread if channel/thread_ts were provided
  if (SLACK_BOT_TOKEN && channel && thread_ts) {
    await slackPost(SLACK_BOT_TOKEN, {
      channel,
      thread_ts,
      text: "✅ Split complete. Uploading stems…"
    });
  }

  // TODO: your Dropbox upload here; after upload, ping Slack with the links.
  // await uploadToDropbox(vocalOut, …); await uploadToDropbox(instrOut, …);

  // Final Slack confirmation (comment out if you only want links)
  if (SLACK_BOT_TOKEN && channel && thread_ts) {
    await slackPost(SLACK_BOT_TOKEN, {
      channel,
      thread_ts,
      text: "✅ Stems ready (vocals / instrumental)."
    });
  }

  } catch (e) {
    console.error("PROCESS ERROR", e);
  }
});

// Start
app.listen(PORT, () => {
  console.log(`processor up on ${PORT}`);
});
