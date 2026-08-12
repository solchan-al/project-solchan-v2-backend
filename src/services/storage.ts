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

export function adminMetadataDir(recordType: string, recordKind: string, recordKey: string) {
  return path.join(
    root,
    "admin-metadata",
    safePathSegment(recordType),
    safePathSegment(recordKind),
    safePathSegment(recordKey)
  );
}

export function userEndorsementEvidenceDocumentsDir(userProfileAccount: string, requestPda: string) {
  return path.join(
    root,
    "evidence",
    "users",
    safePathSegment(userProfileAccount),
    "endorsement-requests",
    safePathSegment(requestPda),
    "documents"
  );
}

export function userEndorsementEvidenceManifestsDir(userProfileAccount: string, requestPda: string) {
  return path.join(
    root,
    "evidence",
    "users",
    safePathSegment(userProfileAccount),
    "endorsement-requests",
    safePathSegment(requestPda),
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

export async function storeUserEndorsementEvidenceFile(
  tempPath: string,
  userProfileAccount: string,
  requestPda: string,
  originalName: string
) {
  const directory = userEndorsementEvidenceDocumentsDir(userProfileAccount, requestPda);
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

export async function storeUserEndorsementEvidenceManifest(
  userProfileAccount: string,
  requestPda: string,
  manifestHash: string,
  canonicalManifest: string
) {
  const directory = userEndorsementEvidenceManifestsDir(userProfileAccount, requestPda);
  await mkdir(directory, { recursive: true });

  const absolutePath = path.join(directory, `${manifestHash}.json`);
  await writeFile(absolutePath, canonicalManifest, "utf8");

  return path.relative(root, absolutePath);
}

export async function storeAdminMetadata(
  recordType: string,
  recordKind: string,
  recordKey: string,
  contentHash: string,
  canonicalContent: string
) {
  const directory = adminMetadataDir(recordType, recordKind, recordKey);
  await mkdir(directory, { recursive: true });

  const absolutePath = path.join(directory, `${contentHash}.json`);
  await writeFile(absolutePath, canonicalContent, "utf8");

  return path.relative(root, absolutePath);
}

function safeExtension(filename: string) {
  const extension = path.extname(filename).toLowerCase();
  if (!extension || extension.length > 12) {
    return "";
  }
  return extension.replace(/[^a-z0-9.]/g, "");
}

function safePathSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}
