import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";

export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export interface UploadMeta {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
}

export function saveUpload(
  buffer: Buffer,
  filename: string,
  mimeType: string
): UploadMeta {
  const fileId = crypto.randomUUID();
  const dir = path.join(UPLOADS_DIR, fileId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, path.basename(filename));
  fs.writeFileSync(filePath, buffer);
  return { fileId, filename, mimeType, size: buffer.length, path: filePath };
}

export function getUpload(
  fileId: string
): { data: Buffer; filename: string; mimeType: string } | null {
  const dir = path.join(UPLOADS_DIR, fileId);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir);
  if (files.length === 0) return null;

  const filename = files[0];
  const filePath = path.join(dir, filename);
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  const mimeType = mimeMap[ext] || "application/octet-stream";
  return { data, filename, mimeType };
}
