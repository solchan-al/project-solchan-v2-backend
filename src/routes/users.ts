import { Router, type NextFunction } from "express";
import path from "node:path";
import { z } from "zod";

import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { upload } from "../http/upload.js";
import { WalletAddressSchema } from "../schemas/common.js";
import { canonicalJson } from "../services/canonical-json.js";
import { assertWalletCanRegisterAs, getActorRegistration } from "../services/actor-identity.js";
import { sha256File, sha256Text } from "../services/hash.js";
import {
  storeAdminMetadata,
  storeUserEndorsementEvidenceFile,
  storeUserEndorsementEvidenceManifest
} from "../services/storage.js";

export const userRouter = Router();

userRouter.get("/profiles/:account", async (request, response, next: NextFunction) => {
  const ParamsSchema = z.object({
    account: z.string().min(32).max(120)
  });
  try {
    const { account } = ParamsSchema.parse(request.params);

    const result = await pool.query(
      `
        select
          id,
          record_key as user_profile_account,
          content_json,
          content_hash,
          storage_path,
          created_by_wallet,
          created_at::text as created_at
        from admin_metadata_documents
        where record_type = 'user'
          and record_kind = 'profile'
          and record_key = $1
        order by created_at desc
        limit 1
      `,
      [account]
    );

    if (!result.rows[0]) {
      throw new HttpError(404, "User profile metadata not found");
    }

    response.json({ profile: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

userRouter.post("/metadata-documents", async (request, response, next: NextFunction) => {
  const BodySchema = z.object({
    content: z.record(z.unknown()),
    createdByWallet: WalletAddressSchema,
    recordKey: z.string().min(1).max(120)
  });
  try {
    const parsed = BodySchema.parse(request.body);
    await assertWalletCanRegisterAs(pool, parsed.createdByWallet, "user");

    const canonicalContent = canonicalJson(parsed.content);
    const contentHash = sha256Text(canonicalContent);
    const storagePath = await storeAdminMetadata(
      "user",
      "profile",
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
          content_json,
          canonical_json,
          content_hash,
          storage_path,
          created_by_wallet
        )
        values ('user', 'profile', $1, $2, $3, $4, $5, $6)
        on conflict (content_hash) do update
        set content_json = excluded.content_json,
            canonical_json = excluded.canonical_json
        returning *
      `,
      [
        parsed.recordKey,
        parsed.content,
        canonicalContent,
        contentHash,
        storagePath,
        parsed.createdByWallet
      ]
    );

    response.status(201).json({
      metadataDocument: result.rows[0],
      metadataHash: contentHash,
      metadataUri: `/storage/${storagePath}`
    });
  } catch (error) {
    next(error);
  }
});

userRouter.patch("/profiles/:account/metadata-documents", async (request, response, next: NextFunction) => {
  const ParamsSchema = z.object({
    account: z.string().min(32).max(120)
  });
  const BodySchema = z.object({
    content: z.record(z.unknown()),
    updatedByWallet: WalletAddressSchema
  });

  try {
    const { account } = ParamsSchema.parse(request.params);
    const parsed = BodySchema.parse(request.body);

    const existingResult = await pool.query(
      `
        select content_hash, created_by_wallet
        from admin_metadata_documents
        where record_type = 'user'
          and record_kind = 'profile'
          and record_key = $1
        order by created_at desc
        limit 1
      `,
      [account]
    );
    const existing = existingResult.rows[0];

    if (!existing) {
      throw new HttpError(404, "User profile metadata not found");
    }

    if (existing.created_by_wallet !== parsed.updatedByWallet) {
      throw new HttpError(403, "Only the wallet that created this user profile can update its display metadata.");
    }

    const content = {
      ...parsed.content,
      previousMetadataHash: existing.content_hash,
      schema: "solchan.user-profile-display-metadata.v1",
      updatedAt: new Date().toISOString(),
      userProfile: account,
      walletAddress: parsed.updatedByWallet
    };
    const canonicalContent = canonicalJson(content);
    const contentHash = sha256Text(canonicalContent);
    const storagePath = await storeAdminMetadata(
      "user",
      "profile",
      account,
      contentHash,
      canonicalContent
    );

    const result = await pool.query(
      `
        insert into admin_metadata_documents (
          record_type,
          record_kind,
          record_key,
          content_json,
          canonical_json,
          content_hash,
          storage_path,
          created_by_wallet
        )
        values ('user', 'profile', $1, $2, $3, $4, $5, $6)
        on conflict (content_hash) do update
        set content_json = excluded.content_json,
            canonical_json = excluded.canonical_json
        returning *
      `,
      [
        account,
        content,
        canonicalContent,
        contentHash,
        storagePath,
        parsed.updatedByWallet
      ]
    );

    response.status(201).json({
      metadataDocument: result.rows[0],
      metadataHash: contentHash,
      metadataUri: `/storage/${storagePath}`
    });
  } catch (error) {
    next(error);
  }
});

userRouter.post("/endorsement-evidence-documents", async (request, response, next: NextFunction) => {
  const BodySchema = z.object({
    content: z.record(z.unknown()),
    createdByWallet: WalletAddressSchema,
    endorsementRequestPda: z.string().min(32).max(120)
  });

  try {
    const parsed = BodySchema.parse(request.body);
    const registration = await getActorRegistration(pool, parsed.createdByWallet);

    if (registration.status !== "registered" || registration.registration.actorType !== "user") {
      throw new HttpError(403, "Only a registered user wallet can create endorsement evidence.");
    }

    const content = {
      ...parsed.content,
      createdByWallet: parsed.createdByWallet,
      endorsementRequestPda: parsed.endorsementRequestPda,
      schema: "solchan.user-endorsement-evidence.v1"
    };
    const canonicalContent = canonicalJson(content);
    const contentHash = sha256Text(canonicalContent);
    const storagePath = await storeAdminMetadata(
      "user",
      "endorsement-evidence",
      parsed.endorsementRequestPda,
      contentHash,
      canonicalContent
    );

    const result = await pool.query(
      `
        insert into admin_metadata_documents (
          record_type,
          record_kind,
          record_key,
          content_json,
          canonical_json,
          content_hash,
          storage_path,
          created_by_wallet
        )
        values ('user', 'endorsement-evidence', $1, $2, $3, $4, $5, $6)
        on conflict (content_hash) do update
        set content_json = excluded.content_json,
            canonical_json = excluded.canonical_json
        returning *
      `,
      [
        parsed.endorsementRequestPda,
        content,
        canonicalContent,
        contentHash,
        storagePath,
        parsed.createdByWallet
      ]
    );

    response.status(201).json({
      evidenceDocument: result.rows[0],
      evidenceHash: contentHash,
      evidenceUri: `/storage/${storagePath}`
    });
  } catch (error) {
    next(error);
  }
});

userRouter.post(
  "/endorsement-evidence-packages",
  upload.array("documents", 10),
  async (request, response, next: NextFunction) => {
    const BodySchema = z.object({
      contextDescription: z.string().min(20).max(4000),
      contextHash: z.string().min(32).max(128),
      createdByWallet: WalletAddressSchema,
      criteriaBundleHash: z.string().min(32).max(128),
      endorsementRequestPda: z.string().min(32).max(120),
      evidenceText: z.string().min(1).max(4000),
      organization: z.string().min(32).max(120),
      requestedEndorsementKind: z.string().min(32).max(120),
      requestedUserType: z.string().min(32).max(120),
      userProfile: z.string().min(32).max(120)
    });

    try {
      const parsed = BodySchema.parse(request.body);
      const files = request.files as Express.Multer.File[] | undefined;

      if (!files?.length) {
        throw new HttpError(400, "At least one evidence document is required.");
      }

      const registration = await getActorRegistration(pool, parsed.createdByWallet);
      if (registration.status !== "registered" || registration.registration.actorType !== "user") {
        throw new HttpError(403, "Only a registered user wallet can create endorsement evidence.");
      }

      const storedDocuments = [];
      for (const file of files) {
        const stored = await storeUserEndorsementEvidenceFile(
          file.path,
          parsed.userProfile,
          parsed.endorsementRequestPda,
          file.originalname
        );
        const hash = await sha256File(stored.absolutePath);
        storedDocuments.push({
          byte_size: file.size,
          created_at: new Date().toISOString(),
          mime_type: file.mimetype,
          original_filename: file.originalname,
          sha256_hash: hash,
          storage_path: stored.storagePath,
          stored_filename: stored.storedFilename
        });
      }

      const manifest = {
        contextDescription: parsed.contextDescription,
        contextHash: parsed.contextHash,
        createdAt: new Date().toISOString(),
        createdByWallet: parsed.createdByWallet,
        criteriaBundleHash: parsed.criteriaBundleHash,
        documents: storedDocuments.map(({ stored_filename: _storedFilename, ...document }) => document),
        endorsementRequestPda: parsed.endorsementRequestPda,
        evidenceText: parsed.evidenceText,
        organization: parsed.organization,
        referenceLinks: extractLinks(parsed.evidenceText),
        requestedEndorsementKind: parsed.requestedEndorsementKind,
        requestedUserType: parsed.requestedUserType,
        schema: "solchan.user-endorsement-evidence-manifest.v1",
        userProfile: parsed.userProfile
      };
      const canonicalManifest = canonicalJson(manifest);
      const manifestHash = sha256Text(canonicalManifest);
      const manifestStoragePath = await storeUserEndorsementEvidenceManifest(
        parsed.userProfile,
        parsed.endorsementRequestPda,
        manifestHash,
        canonicalManifest
      );

      const client = await pool.connect();
      try {
        await client.query("begin");

        const packageResult = await client.query(
          `
            insert into user_endorsement_evidence_packages (
              endorsement_request_pda,
              user_profile_account,
              organization_pda,
              requested_user_type,
              requested_endorsement_kind,
              context_hash,
              criteria_bundle_hash,
              evidence_text,
              manifest_json,
              manifest_hash,
              manifest_storage_path,
              uploaded_by_wallet
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            on conflict (manifest_hash) do update
            set manifest_json = excluded.manifest_json
            returning *
          `,
          [
            parsed.endorsementRequestPda,
            parsed.userProfile,
            parsed.organization,
            parsed.requestedUserType,
            parsed.requestedEndorsementKind,
            parsed.contextHash,
            parsed.criteriaBundleHash,
            parsed.evidenceText,
            JSON.parse(canonicalManifest),
            manifestHash,
            manifestStoragePath,
            parsed.createdByWallet
          ]
        );

        const documents = [];
        for (const document of storedDocuments) {
          const documentResult = await client.query(
            `
              insert into user_endorsement_evidence_documents (
                evidence_package_id,
                original_filename,
                stored_filename,
                storage_path,
                mime_type,
                byte_size,
                sha256_hash,
                uploaded_by_wallet
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8)
              on conflict (storage_path) do nothing
              returning *
            `,
            [
              packageResult.rows[0].id,
              document.original_filename,
              document.stored_filename,
              document.storage_path,
              document.mime_type,
              document.byte_size,
              document.sha256_hash,
              parsed.createdByWallet
            ]
          );
          if (documentResult.rows[0]) {
            documents.push(documentResult.rows[0]);
          }
        }

        await client.query("commit");
        response.status(201).json({
          documents,
          evidenceHash: manifestHash,
          evidencePackage: packageResult.rows[0],
          evidenceUri: `/storage/${manifestStoragePath}`
        });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

userRouter.get("/endorsement-evidence/:hash", async (request, response, next: NextFunction) => {
  const ParamsSchema = z.object({
    hash: z.string().min(32).max(128)
  });

  try {
    const { hash } = ParamsSchema.parse(request.params);
    const packageResult = await pool.query(
      `
        select
          id,
          endorsement_request_pda,
          user_profile_account,
          organization_pda,
          requested_user_type,
          requested_endorsement_kind,
          context_hash,
          criteria_bundle_hash,
          evidence_text,
          manifest_json,
          manifest_hash,
          manifest_storage_path,
          uploaded_by_wallet,
          created_at::text as created_at
        from user_endorsement_evidence_packages
        where manifest_hash = $1
        order by created_at desc
        limit 1
      `,
      [hash]
    );

    if (packageResult.rows[0]) {
      const documentsResult = await pool.query(
        `
          select
            id,
            original_filename,
            stored_filename,
            storage_path,
            mime_type,
            byte_size::text as byte_size,
            sha256_hash,
            uploaded_by_wallet,
            created_at::text as created_at
          from user_endorsement_evidence_documents
          where evidence_package_id = $1
          order by created_at asc, id asc
        `,
        [packageResult.rows[0].id]
      );

      const documents = await Promise.all(
        documentsResult.rows.map(async (document) => ({
          ...document,
          integrity: await verifyStoredHash(document.storage_path, document.sha256_hash)
        }))
      );

      response.json({
        evidence: {
          ...packageResult.rows[0],
          documents,
          kind: "package"
        }
      });
      return;
    }

    const result = await pool.query(
      `
        select
          id,
          record_key as endorsement_request_pda,
          content_json,
          content_hash,
          storage_path,
          created_by_wallet,
          created_at::text as created_at
        from admin_metadata_documents
        where record_type = 'user'
          and record_kind = 'endorsement-evidence'
          and content_hash = $1
        order by created_at desc
        limit 1
      `,
      [hash]
    );

    if (!result.rows[0]) {
      throw new HttpError(404, "User endorsement evidence not found");
    }

    response.json({ evidence: { ...result.rows[0], kind: "legacy_document" } });
  } catch (error) {
    next(error);
  }
});

function extractLinks(value: string) {
  return Array.from(value.matchAll(/https?:\/\/[^\s]+/g)).map((match) => match[0]);
}

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
