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
  // Persist MIME type so getUpload() can return it accurately
  fs.writeFileSync(path.join(dir, ".mimetype"), mimeType);
  return { fileId, filename, mimeType, size: buffer.length, path: filePath };
}

/** Look up upload metadata (filename + MIME type) without reading file data. */
export function getUploadMeta(
  fileId: string
): { filename: string; mimeType: string } | null {
  const dir = path.join(UPLOADS_DIR, fileId);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir);
  if (files.length === 0) return null;

  const filename = files.find((f) => f !== ".mimetype");
  if (!filename) return null;

  // Read persisted MIME type, fall back to extension-based detection
  const mimeTypeFile = path.join(dir, ".mimetype");
  let mimeType: string;
  if (fs.existsSync(mimeTypeFile)) {
    mimeType = fs.readFileSync(mimeTypeFile, "utf-8").trim();
  } else {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };
    mimeType = mimeMap[ext] || "application/octet-stream";
  }
  return { filename, mimeType };
}

/** Extract the file ID from an upload path (.../uploads/{fileId}/{filename}). */
export function extractFileId(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 2];
}

/** Format a consistent upload reference for embedding in prompts. */
export function formatUploadRef(fileId: string, filename: string, mimeType: string): string {
  return `[Attached file: upload:${fileId} (${filename}, ${mimeType})]`;
}

export function getUpload(
  fileId: string
): { data: Buffer; filename: string; mimeType: string } | null {
  const meta = getUploadMeta(fileId);
  if (!meta) return null;
  const filePath = path.join(UPLOADS_DIR, fileId, meta.filename);
  const data = fs.readFileSync(filePath);
  return { data, filename: meta.filename, mimeType: meta.mimeType };
}
