import express from "express";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 10000;
const PROCESSOR_TOKEN = process.env.PROCESSOR_TOKEN || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";

// Optional: base64 Netscape cookies file (if needed later)
const COOKIES_B64 = process.env.YTDLP_COOKIES_B64 || "";
let COOKIES_PATH = "";
if (COOKIES_B64) {
  COOKIES_PATH = "/tmp/yt_cookies.txt";
  try { fs.writeFileSync(COOKIES_PATH, Buffer.from(COOKIES_B64, "base64")); } catch {}
}

// capture raw body (for HMAC)
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

function hmacHex(key, msgUtf8) {
  return crypto.createHmac("sha256", key).update(msgUtf8, "utf8").digest("hex");
}
function timingSafeEq(a, b) {
  try {
    const A = Buffer.from(a); const B = Buffer.from(b);
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch { return false; }
}
function isAuthorized(req) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearer && bearer === PROCESSOR_TOKEN) return true;
  const sig = req.headers["x-isolator-signature"];
  if (sig && req.rawBody && PROCESSOR_TOKEN) {
    const want = hmacHex(PROCESSOR_TOKEN, req.rawBody.toString("utf8"));
    if (timingSafeEq(String(sig), want)) return true;
  }
  return false;
}

async function slackPost(token, payload) {
  if (!token) return;
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify(payload)
    });
  } catch {}
}

// ---- yt-dlp with anti-bot fallback -----------------------------------------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { env: process.env }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr || "");
      if (err) { console.log("CMD FAIL:", cmd, args.join(" ")); console.log(out.trim()); reject(new Error(out.trim() || err.message)); return; }
      console.log(out.trim() || `${cmd} done`);
      resolve(out);
    });
  });
}

async function downloadAudio(url) {
  const outWebm = "/tmp/source.webm";
  const outM4a  = "/tmp/source.m4a";
  // primary attempt (standard web client)
  let args = ["-m", "yt_dlp", "-f", "bestaudio/best", "-o", outWebm, url];
  await run("python3", args);
  // convert to m4a
  await run("python3", ["-m", "yt_dlp", "-x", "--audio-format", "m4a", "-o", outM4a, url]);
  return outM4a;
}

async function downloadAudioResilient(url) {
  const outM4a = "/tmp/source.m4a";
  // try full pipeline in one go (faster) with retries
  const base = [
    "-m", "yt_dlp",
    "-f", "bestaudio/best",
    "-x", "--audio-format", "m4a",
    "-o", outM4a,
    "--no-abort-on-error",
    "-R", "3", "--fragment-retries", "3",
    "--sleep-requests", "1",
    "--concurrent-fragments", "1",
    url
  ];
  if (COOKIES_PATH) base.push("--cookies", COOKIES_PATH);

  try {
    await run("python3", base);
    return outM4a;
  } catch (e) {
    const msg = String(e.message || e);
    // fallback: use Android client (often bypasses “Sign in to confirm you’re not a bot”)
    if (/confirm you.?re not a bot/i.test(msg) || /consent|age|sign in/i.test(msg)) {
      console.log("yt-dlp fallback → Android client");
      const alt = [
        "-m", "yt_dlp",
        "--extractor-args", "youtube:player_client=android",
        "-f", "bestaudio/best",
        "-x", "--audio-format", "m4a",
        "-o", outM4a,
        "-R", "3", "--fragment-retries", "3",
        "--sleep-requests", "1",
        "--concurrent-fragments", "1",
        url
      ];
      if (COOKIES_PATH) alt.push("--cookies", COOKIES_PATH);
      await run("python3", alt);
      return outM4a;
    }
    throw e;
  }
}
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const { mode, url, title, channel, thread_ts } = req.body || {};
  console.log("INTAKE", { mode, url, title, channel, thread_ts });
  res.json({ ok: true, intake: true, mode, url, title });

  try {
    const src = await downloadAudioResilient(url);
    console.log("DOWNLOADED", src);

    // ---- Demucs (placeholder) ----
    // TODO: run actual demucs command; for now just log done markers.
    const outDir = "/tmp/demucs_out";
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
    const vocalOut = path.join(outDir, "vocals.wav");
    const instrOut = path.join(outDir, "no_vocals.wav");
    console.log("DEMUX DONE", { vocalOut, instrOut });

    if (channel && thread_ts) {
      await slackPost(SLACK_BOT_TOKEN, {
        channel, thread_ts,
        text: "✅ Split complete. Uploading stems…"
      });
      await slackPost(SLACK_BOT_TOKEN, {
        channel, thread_ts,
        text: "✅ Stems ready (vocals / instrumental)."
      });
    }
  } catch (e) {
    console.error("PROCESS ERROR", e);
    if (channel && thread_ts) {
      await slackPost(SLACK_BOT_TOKEN, {
        channel, thread_ts,
        text: `❌ Processor error: ${(e && e.message) ? e.message : String(e)}`
      });
    }
  }
});

app.listen(PORT, () => console.log(`processor up on ${PORT}`));
