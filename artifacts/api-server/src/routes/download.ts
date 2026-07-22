import { Router } from "express";
import * as fs from "fs";
import * as path from "path";

const router = Router();

const WORKSPACE = "/home/runner/workspace";

function getLatestVersionedZip(): { filePath: string; fileName: string } | null {
  let latest = 0;
  for (let v = 100; v >= 1; v--) {
    const p = path.join(WORKSPACE, `copilot-extension-v${v}.zip`);
    if (fs.existsSync(p)) {
      latest = v;
      break;
    }
  }
  if (!latest) return null;
  return {
    filePath: path.join(WORKSPACE, `copilot-extension-v${latest}.zip`),
    fileName: `copilot-extension-v${latest}.zip`,
  };
}

router.get("/download/extension", (_req, res) => {
  const latest = getLatestVersionedZip();
  if (latest) {
    res.download(latest.filePath, latest.fileName);
  } else {
    const fallback = path.join(WORKSPACE, "copilot-extension-replit.zip");
    res.download(fallback, "copilot-extension-replit.zip");
  }
});

router.get("/download/extension/:version", (req, res) => {
  const v = req.params.version?.replace(/[^0-9]/g, "");
  if (!v) {
    res.status(400).json({ error: "Invalid version" });
    return;
  }
  const filePath = path.join(WORKSPACE, `copilot-extension-v${v}.zip`);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: `v${v} not found` });
    return;
  }
  res.download(filePath, `copilot-extension-v${v}.zip`);
});

export default router;
