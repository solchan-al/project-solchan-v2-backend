import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { env } from "../config/env.js";

const root = path.resolve(process.cwd(), env.STORAGE_ROOT);

export function evidenceDocumentsDir(organizationId: string, requestId: string) {
  return path.join(
    root,
    "evidence",
    "organizations",
    organizationId,
    "requests",
    requestId,
    "documents"
  );
}

export function evidenceManifestsDir(organizationId: string, requestId: string) {
  return path.join(
    root,
    "evidence",
    "organizations",
    organizationId,
    "requests",
    requestId,
    "manifests"
  );
}

export async function storeUploadedFile(
  tempPath: string,
  organizationId: string,
  requestId: string,
  originalName: string
) {
  const directory = evidenceDocumentsDir(organizationId, requestId);
  await mkdir(directory, { recursive: true });

  const extension = safeExtension(originalName);
  const storedFilename = `${randomUUID()}${extension}`;
  const absolutePath = path.join(directory, storedFilename);

  await rename(tempPath, absolutePath);

  return {
    absolutePath,
    storedFilename,
    storagePath: path.relative(root, absolutePath)
  };
}

export async function storeManifest(
  organizationId: string,
  requestId: string,
  manifestHash: string,
  canonicalManifest: string
) {
  const directory = evidenceManifestsDir(organizationId, requestId);
  await mkdir(directory, { recursive: true });

  const absolutePath = path.join(directory, `${manifestHash}.json`);
  await writeFile(absolutePath, canonicalManifest, "utf8");

  return path.relative(root, absolutePath);
}

function safeExtension(filename: string) {
  const extension = path.extname(filename).toLowerCase();
  if (!extension || extension.length > 12) {
    return "";
  }
  return extension.replace(/[^a-z0-9.]/g, "");
}

