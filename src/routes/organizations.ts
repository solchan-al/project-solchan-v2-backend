import { Router } from "express";
import { z } from "zod";

import { pool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { upload } from "../http/upload.js";
import { OptionalPublicKeySchema, UuidParamsSchema, WalletAddressSchema } from "../schemas/common.js";
import { sha256File, sha256Text } from "../services/hash.js";
import { storeUploadedFile } from "../services/storage.js";

export const organizationRouter = Router();

const CreateOrganizationSchema = z.object({
  walletAddress: WalletAddressSchema,
  organizationPda: OptionalPublicKeySchema,
  name: z.string().min(1).max(160),
  legalName: z.string().max(200).optional(),
  websiteUrl: z.string().url().optional(),
  description: z.string().max(2000).optional(),
  primaryOrganizationType: z.string().max(120).optional(),
  metadata: z.record(z.unknown()).default({})
});

const CreateAccreditationRequestSchema = z.object({
  organizationPda: OptionalPublicKeySchema,
  accreditationRequestPda: OptionalPublicKeySchema,
  criteriaBundleId: z.string().uuid().optional(),
  criteriaBundleHash: z.string().min(32).max(128).optional(),
  metadataUri: z.string().max(500).optional(),
  metadataHash: z.string().min(32).max(128).optional()
});

organizationRouter.post("/", async (request, response) => {
  const parsed = CreateOrganizationSchema.parse(request.body);
  const metadataHash = sha256Text(JSON.stringify(parsed.metadata));

  const result = await pool.query(
    `
      insert into organizations_offchain (
        wallet_address,
        organization_pda,
        name,
        legal_name,
        website_url,
        description,
        primary_organization_type,
        metadata_json,
        metadata_hash
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning *
    `,
    [
      parsed.walletAddress,
      parsed.organizationPda ?? null,
      parsed.name,
      parsed.legalName ?? null,
      parsed.websiteUrl ?? null,
      parsed.description ?? null,
      parsed.primaryOrganizationType ?? null,
      parsed.metadata,
      metadataHash
    ]
  );

  response.status(201).json({ organization: result.rows[0] });
});

organizationRouter.get("/:id", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);

  const result = await pool.query("select * from organizations_offchain where id = $1", [id]);
  const organization = result.rows[0];

  if (!organization) {
    throw new HttpError(404, "Organization not found");
  }

  response.json({ organization });
});

organizationRouter.post("/:id/accreditation-requests", async (request, response) => {
  const { id } = UuidParamsSchema.parse(request.params);
  const parsed = CreateAccreditationRequestSchema.parse(request.body);

  const organization = await pool.query("select * from organizations_offchain where id = $1", [id]);
  if (!organization.rows[0]) {
    throw new HttpError(404, "Organization not found");
  }

  const result = await pool.query(
    `
      insert into accreditation_requests_offchain (
        organization_id,
        organization_pda,
        accreditation_request_pda,
        criteria_bundle_id,
        criteria_bundle_hash,
        metadata_uri,
        metadata_hash
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      returning *
    `,
    [
      id,
      parsed.organizationPda ?? organization.rows[0].organization_pda,
      parsed.accreditationRequestPda ?? null,
      parsed.criteriaBundleId ?? null,
      parsed.criteriaBundleHash ?? null,
      parsed.metadataUri ?? null,
      parsed.metadataHash ?? null
    ]
  );

  response.status(201).json({ accreditationRequest: result.rows[0] });
});

organizationRouter.post(
  "/:id/evidence-documents",
  upload.array("documents", 10),
  async (request, response) => {
    const { id } = UuidParamsSchema.parse(request.params);
    const BodySchema = z.object({
      accreditationRequestId: z.string().uuid(),
      uploadedByWallet: WalletAddressSchema
    });
    const parsed = BodySchema.parse(request.body);
    const files = request.files as Express.Multer.File[] | undefined;

    if (!files?.length) {
      throw new HttpError(400, "At least one document is required");
    }

    const requestResult = await pool.query(
      `
        select *
        from accreditation_requests_offchain
        where id = $1 and organization_id = $2
      `,
      [parsed.accreditationRequestId, id]
    );

    if (!requestResult.rows[0]) {
      throw new HttpError(404, "Accreditation request not found");
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const documents = [];
      for (const file of files) {
        const stored = await storeUploadedFile(
          file.path,
          id,
          parsed.accreditationRequestId,
          file.originalname
        );
        const hash = await sha256File(stored.absolutePath);

        const documentResult = await client.query(
          `
            insert into evidence_documents (
              organization_id,
              accreditation_request_id,
              original_filename,
              stored_filename,
              storage_path,
              mime_type,
              byte_size,
              sha256_hash,
              uploaded_by_wallet
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            returning *
          `,
          [
            id,
            parsed.accreditationRequestId,
            file.originalname,
            stored.storedFilename,
            stored.storagePath,
            file.mimetype,
            file.size,
            hash,
            parsed.uploadedByWallet
          ]
        );
        documents.push(documentResult.rows[0]);
      }

      await client.query(
        `
          update accreditation_requests_offchain
          set status = 'evidence_uploaded', updated_at = now()
          where id = $1
        `,
        [parsed.accreditationRequestId]
      );

      await client.query("commit");
      response.status(201).json({ documents });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
);

