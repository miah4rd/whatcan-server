import { Router } from "express";
import * as fs from "fs";
import * as path from "path";

const router = Router();

// dist/index.mjs (bundled output) -> repo_root/artifacts/landing/public
const EXTENSION_DIR = path.resolve(__dirname, "../../landing/public");

function getLatestVersionedZip(): { filePath: string; fileName: string } | null {
  let latest = 0;
  for (let v = 200; v >= 1; v--) {
    const p = path.join(EXTENSION_DIR, `ext${v}.zip`);
    if (fs.existsSync(p)) {
      latest = v;
      break;
    }
  }
  if (!latest) return null;
  return {
    filePath: path.join(EXTENSION_DIR, `ext${latest}.zip`),
    fileName: `ext${latest}.zip`,
  };
}

router.get("/download/extension", (_req, res) => {
  const latest = getLatestVersionedZip();
  if (!latest) {
    res.status(404).json({ error: "No extension zip found" });
    return;
  }
  res.download(latest.filePath, latest.fileName);
});

router.get("/download/extension/:version", (req, res) => {
  const v = req.params.version?.replace(/[^0-9]/g, "");
  if (!v) {
    res.status(400).json({ error: "Invalid version" });
    return;
  }
  const filePath = path.join(EXTENSION_DIR, `ext${v}.zip`);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: `v${v} not found` });
    return;
  }
  res.download(filePath, `ext${v}.zip`);
});

export default router;
