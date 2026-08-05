/**
 * Publish copilot-extension/ to the Chrome Web Store. Zips the folder (files
 * at the archive root, same as the self-host release), uploads it, and
 * submits for publish — replacing the manual Developer Dashboard steps that
 * let the Store version drift behind self-host (it happened once already:
 * stuck at 1.0.86 while self-host reached 1.0.92).
 *
 * Needs CHROME_WEBSTORE_CLIENT_ID / CHROME_WEBSTORE_CLIENT_SECRET /
 * CHROME_WEBSTORE_REFRESH_TOKEN / CHROME_WEBSTORE_EXTENSION_ID in the VPS .env.
 * Google reviews every update before it goes live — this submits it, it
 * doesn't make it instantly live.
 */
import { execSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../");
const EXT_DIR = resolve(ROOT, "copilot-extension");
const ZIP_PATH = resolve(ROOT, "copilot-extension-store-upload.zip");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in env`);
    process.exit(1);
  }
  return v;
}

const CLIENT_ID = requireEnv("CHROME_WEBSTORE_CLIENT_ID");
const CLIENT_SECRET = requireEnv("CHROME_WEBSTORE_CLIENT_SECRET");
const REFRESH_TOKEN = requireEnv("CHROME_WEBSTORE_REFRESH_TOKEN");
const EXTENSION_ID = requireEnv("CHROME_WEBSTORE_EXTENSION_ID");

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function main() {
  console.log("Zipping copilot-extension/ ...");
  if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);
  execSync(`cd "${EXT_DIR}" && zip -r -X "${ZIP_PATH}" . -x ".*"`, { stdio: "inherit" });

  const manifest = JSON.parse(readFileSync(resolve(EXT_DIR, "manifest.json"), "utf-8")) as { version: string };
  console.log(`Publishing version ${manifest.version} to Chrome Web Store (${EXTENSION_ID}) ...`);

  const accessToken = await getAccessToken();

  console.log("Uploading...");
  const zipBuffer = readFileSync(ZIP_PATH);
  const uploadRes = await fetch(
    `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${EXTENSION_ID}?uploadType=media`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "x-goog-api-version": "2" },
      body: zipBuffer,
    },
  );
  const uploadData = (await uploadRes.json()) as { uploadState?: string };
  if (!uploadRes.ok || uploadData.uploadState !== "SUCCESS") {
    throw new Error(`Upload failed: ${JSON.stringify(uploadData)}`);
  }
  console.log("Upload OK:", uploadData);

  console.log("Submitting for publish...");
  const publishRes = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${EXTENSION_ID}/publish`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "x-goog-api-version": "2", "Content-Length": "0" },
    },
  );
  const publishData = await publishRes.json();
  if (!publishRes.ok) {
    throw new Error(`Publish failed: ${JSON.stringify(publishData)}`);
  }
  console.log("Publish submitted:", publishData);
  console.log("Google now reviews this before it goes live for users — not instant.");

  rmSync(ZIP_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
