import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Set test data dir before importing modules
process.env.GOTO_DATA_DIR = "tests/data";

import { saveUpload, getUpload, UPLOADS_DIR, ALLOWED_IMAGE_TYPES } from "../src/uploads.js";

describe("uploads", () => {
  beforeEach(() => {
    if (fs.existsSync(UPLOADS_DIR)) {
      fs.rmSync(UPLOADS_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(UPLOADS_DIR)) {
      fs.rmSync(UPLOADS_DIR, { recursive: true });
    }
  });

  it("saveUpload stores a file and returns metadata", () => {
    const buffer = Buffer.from("fake-image-data");
    const result = saveUpload(buffer, "test.png", "image/png");

    expect(result.fileId).toBeTruthy();
    expect(result.filename).toBe("test.png");
    expect(result.mimeType).toBe("image/png");
    expect(result.size).toBe(buffer.length);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it("getUpload retrieves a saved file", () => {
    const buffer = Buffer.from("fake-image-data");
    const meta = saveUpload(buffer, "photo.jpg", "image/jpeg");

    const result = getUpload(meta.fileId);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("photo.jpg");
    expect(result!.mimeType).toBe("image/jpeg");
    expect(result!.data.equals(buffer)).toBe(true);
  });

  it("getUpload returns null for unknown fileId", () => {
    const result = getUpload("nonexistent-id");
    expect(result).toBeNull();
  });

  it("ALLOWED_IMAGE_TYPES contains expected types", () => {
    expect(ALLOWED_IMAGE_TYPES).toContain("image/jpeg");
    expect(ALLOWED_IMAGE_TYPES).toContain("image/png");
    expect(ALLOWED_IMAGE_TYPES).toContain("image/gif");
    expect(ALLOWED_IMAGE_TYPES).toContain("image/webp");
    expect(ALLOWED_IMAGE_TYPES).not.toContain("application/pdf");
  });
});
