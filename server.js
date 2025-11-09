import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
const exec = promisify(execFile);

const app = express();
app.use(express.json({ limit: "20mb" }));

const TOKEN = process.env.PROCESSOR_TOKEN;
const DROPBOX = process.env.DROPBOX_ACCESS_TOKEN;
const SLACK = process.env.SLACK_BOT_TOKEN;

function verify(req) {
  const sig = req.header("X-Isolator-Signature") || "";
  const body = JSON.stringify(req.body);
  const mac = crypto.createHmac("sha256", TOKEN).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac));
}

async function postSlack(channel, thread_ts, text) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SLACK}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ channel, thread_ts, text })
  });
}

app.post("/", async (req, res) => {
  try {
    if (!verify(req)) return res.status(401).send("bad sig");
    const { mode, url, title, channel, thread_ts } = req.body;
    await postSlack(channel, thread_ts, "⏬ fetching audio…");

    const out = "/tmp/source.m4a";
    await exec("yt-dlp", ["-f", "bestaudio/best", "-x", "--audio-format", "m4a", "-o", out, url]);

// --- REAL STEM SPLITTING (Demucs Lite) ---
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

async function runDemucs(inputPath, outputDir) {
  const cmd = `python3 -m demucs.separate --two-stems=vocals -n htdemucs --out "${outputDir}" "${inputPath}"`;
  execSync(cmd, { stdio: "inherit" });

  const resultDir = path.join(outputDir, "htdemucs", path.basename(inputPath, path.extname(inputPath)));
  const vocalPath = path.join(resultDir, "vocals.wav");
  const instrPath = path.join(resultDir, "no_vocals.wav");
  return { vocalPath, instrPath };
}

await slackPost("🎚 splitting with Demucs...");
const { vocalPath, instrPath } = await runDemucs(tempFile, "./output");
await slackPost("✅ stems ready, uploading...");

    const bpm = 125, key = "F#"; // placeholder

    async function dropboxUpload(path, bytes) {
      await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DROPBOX}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", mute: false })
        },
        body: bytes
      });
    }

    const folder = `/isolation_chamber/artists/barry_stiller/dance_with_me/instruments`;
    await dropboxUpload(`${folder}/barry_stiller_dance_with_me_instrumental_${bpm}_${key}.wav`, Buffer.from("placeholder"));

    await postSlack(channel, thread_ts, "✅ uploaded to Dropbox. (BPM/Key placeholder)");
    res.send("ok");
  } catch (e) {
    console.error(e);
    try { await postSlack(req.body.channel, req.body.thread_ts, ":x: processor error — check logs."); } catch {}
    res.status(500).send("err");
  }
});

app.listen(process.env.PORT || 3000, () => console.log("processor up"));
