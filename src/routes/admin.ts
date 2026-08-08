import { Router } from "express";
import path from "node:path";
import { z } from "zod";

import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { UuidParamsSchema, WalletAddressSchema } from "../schemas/common.js";
import { canonicalJson } from "../services/canonical-json.js";
import { sha256File, sha256Text } from "../services/hash.js";
import { storeAdminMetadata } from "../services/storage.js";

export const adminRouter = Router();

adminRouter.post("/metadata-documents", async (request, response) => {
  const BodySchema = z.object({
    recordType: z.enum(["taxonomy", "criteria"]),
    recordKind: z.string().min(1).max(80),
    recordKey: z.string().min(1).max(120),
    recordVersion: z.number().int().positive().optional(),
    content: z.record(z.unknown()),
    createdByWallet: WalletAddressSchema.optional()
  });
  const parsed = BodySchema.parse(request.body);
  const canonicalContent = canonicalJson(parsed.content);
  const contentHash = sha256Text(canonicalContent);
  const storagePath = await storeAdminMetadata(
    parsed.recordType,
    parsed.recordKind,
    parsed.recordKey,
    contentHash,
    canonicalContent
  );

  const result = await pool.query(
    `
      insert into admin_metadata_documents (
        record_type,
        record_kind,
        record_key,
        record_version,
        content_json,
        canonical_json,
        content_hash,
        storage_path,
        created_by_wallet
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (content_hash) do update
      set content_json = excluded.content_json,
          canonical_json = excluded.canonical_json
      returning *
    `,
    [
      parsed.recordType,
      parsed.recordKind,
      parsed.recordKey,
      parsed.recordVersion ?? null,
      parsed.content,
      canonicalContent,
      contentHash,
      storagePath,
      parsed.createdByWallet ?? null
    ]
  );

  response.status(201).json({
    metadataDocument: result.rows[0],
    metadataHash: contentHash,
    metadataUri: `/storage/${storagePath}`
  });
});

adminRouter.get("/accreditation-requests", async (_request, response) => {
  const result = await pool.query(`
    select
      ar.*,
      o.name as organization_name,
      o.wallet_address,
      count(ed.id)::integer as evidence_document_count
    from accreditation_requests_offchain ar
    join organizations_offchain o on o.id = ar.organization_id
    left join evidence_documents ed on ed.accreditation_request_id = ar.id
    group by ar.id, o.id
    order by ar.created_at desc
  `);

  response.json({ accreditationRequests: result.rows });
});

adminRouter.get("/accreditation-requests/:id", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);

  const requestResult = await pool.query(
    `
      select ar.*, o.name as organization_name, o.wallet_address, o.metadata_json
      from accreditation_requests_offchain ar
      join organizations_offchain o on o.id = ar.organization_id
      where ar.id = $1
    `,
    [id]
  );

  const accreditationRequest = requestResult.rows[0];
  if (!accreditationRequest) {
    throw new HttpError(404, "Accreditation request not found");
  }

  const documentsResult = await pool.query(
    `
      select *
      from evidence_documents
      where accreditation_request_id = $1
      order by created_at asc
    `,
    [id]
  );

  const manifestResult = await pool.query(
    `
      select *
      from evidence_manifests
      where accreditation_request_id = $1
      order by created_at desc
      limit 1
    `,
    [id]
  );

  const notesResult = await pool.query(
    `
      select *
      from admin_review_notes
      where accreditation_request_id = $1
      order by created_at desc
    `,
    [id]
  );

  const documents = await Promise.all(
    documentsResult.rows.map(async (document) => ({
      ...document,
      integrity: await verifyStoredHash(document.storage_path, document.sha256_hash)
    }))
  );
  const evidenceManifest = manifestResult.rows[0]
    ? {
        ...manifestResult.rows[0],
        integrity: await verifyStoredHash(
          manifestResult.rows[0].manifest_storage_path,
          manifestResult.rows[0].manifest_hash
        )
      }
    : null;

  response.json({
    accreditationRequest,
    documents,
    evidenceManifest,
    notes: notesResult.rows
  });
});

adminRouter.post("/accreditation-requests/:id/notes", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);
  const BodySchema = z.object({
    adminWallet: WalletAddressSchema,
    note: z.string().min(1).max(4000)
  });
  const parsed = BodySchema.parse(request.body);

  const result = await pool.query(
    `
      insert into admin_review_notes (accreditation_request_id, admin_wallet, note)
      values ($1, $2, $3)
      returning *
    `,
    [id, parsed.adminWallet, parsed.note]
  );

  response.status(201).json({ note: result.rows[0] });
});

async function verifyStoredHash(storagePath: string, expectedHash: string) {
  try {
    const storageRoot = path.resolve(process.cwd(), env.STORAGE_ROOT);
    const absolutePath = path.resolve(storageRoot, storagePath);

    if (!absolutePath.startsWith(`${storageRoot}${path.sep}`)) {
      return {
        currentHash: null,
        error: "Storage path is outside storage root.",
        matches: false
      };
    }

    const currentHash = await sha256File(absolutePath);

    return {
      currentHash,
      error: null,
      matches: currentHash === expectedHash
    };
  } catch (error) {
    return {
      currentHash: null,
      error: error instanceof Error ? error.message : "Could not verify stored file.",
      matches: false
    };
  }
}
