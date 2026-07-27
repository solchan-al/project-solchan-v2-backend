import { Router } from "express";
import { z } from "zod";

import { pool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { UuidParamsSchema } from "../schemas/common.js";
import { canonicalJson } from "../services/canonical-json.js";
import { sha256Text } from "../services/hash.js";
import { storeManifest } from "../services/storage.js";

export const accreditationRouter = Router();

const OnchainUpdateSchema = z.object({
  accreditationRequestPda: z.string().min(32).max(64).optional(),
  evidenceManifestHash: z.string().min(32).max(128).optional(),
  metadataUri: z.string().max(500).optional(),
  metadataHash: z.string().min(32).max(128).optional(),
  onchainSignature: z.string().min(32).max(128)
});

accreditationRouter.post("/:id/manifest", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);

  const requestResult = await pool.query(
    `
      select ar.*, o.name as organization_name, o.wallet_address
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
      select id, original_filename, storage_path, mime_type, byte_size, sha256_hash, created_at
      from evidence_documents
      where accreditation_request_id = $1
      order by created_at asc, id asc
    `,
    [id]
  );

  if (!documentsResult.rows.length) {
    throw new HttpError(400, "Cannot create manifest without evidence documents");
  }

  const manifest = {
    accreditationRequestId: id,
    criteriaBundleHash: accreditationRequest.criteria_bundle_hash,
    documents: documentsResult.rows,
    organization: {
      id: accreditationRequest.organization_id,
      name: accreditationRequest.organization_name,
      organizationPda: accreditationRequest.organization_pda,
      walletAddress: accreditationRequest.wallet_address
    },
    schema: "solchan.evidence-manifest.v1"
  };

  const canonicalManifest = canonicalJson(manifest);
  const manifestHash = sha256Text(canonicalManifest);
  const manifestStoragePath = await storeManifest(
    accreditationRequest.organization_id,
    id,
    manifestHash,
    canonicalManifest
  );

  const client = await pool.connect();
  try {
    await client.query("begin");

    const manifestResult = await client.query(
      `
        insert into evidence_manifests (
          organization_id,
          accreditation_request_id,
          manifest_json,
          manifest_hash,
          manifest_storage_path
        )
        values ($1, $2, $3, $4, $5)
        on conflict (manifest_hash) do update
        set manifest_json = excluded.manifest_json
        returning *
      `,
      [
        accreditationRequest.organization_id,
        id,
        JSON.parse(canonicalManifest),
        manifestHash,
        manifestStoragePath
      ]
    );

    await client.query(
      `
        update accreditation_requests_offchain
        set evidence_manifest_id = $1,
            evidence_manifest_hash = $2,
            status = 'manifest_created',
            updated_at = now()
        where id = $3
      `,
      [manifestResult.rows[0].id, manifestHash, id]
    );

    await client.query("commit");
    response.status(201).json({
      evidenceManifest: manifestResult.rows[0],
      evidenceHash: manifestHash,
      metadataUri: `/storage/${manifestStoragePath}`
    });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
});

accreditationRouter.patch("/:id/onchain", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);
  const parsed = OnchainUpdateSchema.parse(request.body);

  const result = await pool.query(
    `
      update accreditation_requests_offchain
      set accreditation_request_pda = coalesce($2, accreditation_request_pda),
          evidence_manifest_hash = coalesce($3, evidence_manifest_hash),
          metadata_uri = coalesce($4, metadata_uri),
          metadata_hash = coalesce($5, metadata_hash),
          onchain_signature = $6,
          status = 'submitted_onchain',
          submitted_at = coalesce(submitted_at, now()),
          updated_at = now()
      where id = $1
      returning *
    `,
    [
      id,
      parsed.accreditationRequestPda ?? null,
      parsed.evidenceManifestHash ?? null,
      parsed.metadataUri ?? null,
      parsed.metadataHash ?? null,
      parsed.onchainSignature
    ]
  );

  if (!result.rows[0]) {
    throw new HttpError(404, "Accreditation request not found");
  }

  response.json({ accreditationRequest: result.rows[0] });
});

