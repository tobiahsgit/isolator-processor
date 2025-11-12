import express from "express";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ──────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;
const PROCESSOR_TOKEN = process.env.PROCESSOR_TOKEN || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";    // set in Render
const DROPBOX_TOKEN   = process.env.DROPBOX_TOKEN   || "";    // set in Render
const DROPBOX_FOLDER  = (process.env.DROPBOX_FOLDER || "/Isolator").replace(/\/+$/,"");

// capture raw body for HMAC verification
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ──────────────────────────────────────────────────────────
// Small utils
// ──────────────────────────────────────────────────────────
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
async function slackPost(payload) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("SLACK POST ERROR", e);
  }
}
function safeName(s) {
  return (s || "untitled")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ──────────────────────────────────────────────────────────
// External commands
// ──────────────────────────────────────────────────────────
function run(cmd, args, opts={}) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { env: process.env, ...opts }, (err, stdout, stderr) => {
      if (err) {
        console.error(`CMD FAIL: ${cmd} ${args.join(" ")}`);
        console.error(stderr || stdout || err);
        reject(err);
        return;
      }
      console.log(stdout || stderr || `${cmd} done`);
      resolve({ stdout, stderr });
    });
  });
}

// ──────────────────────────────────────────────────────────
async function downloadAudio(url, outFile) {
  console.log("YT_DLP START", { url, outFile });
  await run("python3", ["-m", "yt_dlp",
    "-f", "bestaudio/best",
    "-x", "--audio-format", "m4a",
    "-o", outFile, url
  ]);
  console.log("DOWNLOADED", outFile);
  return outFile;
}

async function demucsTwoStems(srcFile, outRoot="/tmp/out", model="htdemucs_ft") {
  // two stems: vocals / no_vocals
  console.log("DEMUCS START", { srcFile, outRoot, model });
  await run("python3", ["-m", "demucs",
    "--two-stems=vocals",
    "-n", model,
    "-o", outRoot,
    srcFile
  ]);
  // Demucs output path pattern: /tmp/out/<model>/<basename>/{vocals.wav,no_vocals.wav}
  const base = path.parse(srcFile).name;
  const outDir = path.join(outRoot, model, base);
  const vocalOut = path.join(outDir, "vocals.wav");
  const instrOut = path.join(outDir, "no_vocals.wav");
  console.log("DEMUCS DONE", { outDir, vocalOut, instrOut });
  return { outDir, vocalOut, instrOut };
}

async function dropboxUpload(localPath, remotePath) {
  if (!DROPBOX_TOKEN) throw new Error("DROPBOX_TOKEN missing");
  const content = await fs.promises.readFile(localPath);
  const arg = {
    path: remotePath,
    mode: "overwrite",
    autorename: false,
    mute: true,
    strict_conflict: false
  };
  const up = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DROPBOX_TOKEN}`,
      "Dropbox-API-Arg": JSON.stringify(arg),
      "Content-Type": "application/octet-stream"
    },
    body: content
  });
  const upJson = await up.json();
  if (!up.ok) throw new Error(`Dropbox upload failed: ${JSON.stringify(upJson)}`);
  return upJson;
}

async function dropboxLink(remotePath) {
  // Try to create link, else fetch existing
  const create = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DROPBOX_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path: remotePath, settings: { requested_visibility: "public" } })
  });
  let j = await create.json();
  if (create.ok) {
    // make direct-download url
    return j.url.replace("?dl=0", "?dl=1");
  }
  if (j?.error?.[".tag"] === "shared_link_already_exists") {
    const list = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${DROPBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path: remotePath, direct_only: true })
    });
    const lj = await list.json();
    const url = lj?.links?.[0]?.url;
    if (!url) throw new Error(`No existing link for ${remotePath}`);
    return url.replace("?dl=0", "?dl=1");
  }
  throw new Error(`Dropbox link failed: ${JSON.stringify(j)}`);
}

// ──────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/", async (req, res) => {
  if (!isAuthorized(req)) {
    console.log("AUTH FAIL");
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const { mode, url, title, channel, thread_ts } = req.body || {};
  console.log("INTAKE", { mode, url, title, channel, thread_ts });

  // ACK fast
  res.json({ ok: true, intake: true, mode, url, title });

  // Guardrails
  if (!url) return;

  try {
    // 1) Download
    const src = "/tmp/source.m4a";
    await downloadAudio(url, src);

    // 2) Separate (2-stem vocals/no_vocals)
    const { vocalOut, instrOut } = await demucsTwoStems(src);

    // 3) Upload to Dropbox
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseTitle = safeName(title) || "split";
    const remoteVoc = `${DROPBOX_FOLDER}/${baseTitle}_${stamp}_vocals.wav`;
    const remoteIns = `${DROPBOX_FOLDER}/${baseTitle}_${stamp}_instrumental.wav`;

    await dropboxUpload(vocalOut, remoteVoc);
    await dropboxUpload(instrOut, remoteIns);

    const linkVoc = await dropboxLink(remoteVoc);
    const linkIns = await dropboxLink(remoteIns);

    console.log("UPLOAD DONE", { remoteVoc, remoteIns });

    // 4) Notify Slack (optional)
    if (channel && thread_ts) {
      await slackPost({
        channel,
        thread_ts,
        text: "✅ Stems ready.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*✅ Stems ready* (vocals / instrumental)" } },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Vocals:*\n<${linkVoc}|Download>` },
              { type: "mrkdwn", text: `*Instrumental:*\n<${linkIns}|Download>` }
            ]
          }
        ]
      });
    }

  } catch (e) {
    console.error("PROCESS ERROR", e);
    if (channel && thread_ts) {
      await slackPost({
        channel,
        thread_ts,
        text: "❌ Processor error — check logs."
      });
    }
  }
});

// Start
app.listen(PORT, () => {
  console.log(`processor up on ${PORT}`);
});
