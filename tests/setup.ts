import fs from "node:fs";
import path from "node:path";

export default function setup() {
  const testDataDir = path.join(process.cwd(), "tests/data");
  if (!fs.existsSync(testDataDir)) {
    fs.mkdirSync(testDataDir, { recursive: true });
  }
}
